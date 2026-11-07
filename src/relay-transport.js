/**
 * EXPERIMENTAL encrypted MQTT-over-WSS test relay for networks where P2P ICE fails.
 * Based on the user's independent BigTwo_Web relay design, but with a Rummikub-only
 * topic namespace and PeerRoom-compatible DataConnection facade.
 * Public test brokers are untrusted and can be unavailable or actively hostile.
 * ECDH + AES-GCM protects against passive monitoring, NOT active MITM.
 * Never use this for financial data, real identities, or production hosting.
 */
export const RELAY_BROKERS = Object.freeze([
  'wss://broker.emqx.io:8084/mqtt',
  'wss://test.mosquitto.org:8081'
]);
const TOPIC_PREFIX = 'sanmao-rummikub/relay-v027/';
const LIBRARY_URLS = [
  'https://cdn.jsdelivr.net/npm/mqtt@5.14.1/dist/mqtt.min.js',
  'https://unpkg.com/mqtt@5.14.1/dist/mqtt.min.js'
];
const MAX_ENVELOPE_LENGTH = 32000;
const HEARTBEAT_INTERVAL_MS = 10000;
const DISCONNECTED_TIMEOUT_MS = 38000;
let mqttPromise = null;

function randomHex(count = 16) {
  const bytes = crypto.getRandomValues(new Uint8Array(count));
  return Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
}
function encode64(buffer) {
  let value = '';
  for (const n of new Uint8Array(buffer)) value += String.fromCharCode(n);
  return btoa(value);
}
function decode64(value) {
  if (typeof value !== 'string' || value.length > MAX_ENVELOPE_LENGTH)
    throw new Error('不正確的加密封包');
  return Uint8Array.from(atob(value), ch => ch.charCodeAt(0));
}
async function generatePair() {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
}
async function publicKey(pair) {
  return encode64(await crypto.subtle.exportKey('raw', pair.publicKey));
}
async function deriveSecret(pair, encoded) {
  if (typeof encoded !== 'string' || encoded.length > 160)
    throw new Error('交換金鑰無效');
  const key = await crypto.subtle.importKey('raw', decode64(encoded),
    { name:'ECDH', namedCurve:'P-256' }, false, []);
  return crypto.subtle.deriveKey({ name:'ECDH', public:key }, pair.privateKey,
    { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']);
}
async function encrypt(secret, message) {
  const clear = new TextEncoder().encode(JSON.stringify(message));
  if (clear.length > 20000) throw new Error('資料太長，無法透過公開測試中繼傳送');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, secret, clear);
  return { type:'secure', iv:encode64(iv), body:encode64(body) };
}
async function decrypt(secret, packet) {
  if (packet?.type !== 'secure' || typeof packet.iv !== 'string' ||
      typeof packet.body !== 'string' || packet.body.length > 30000) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name:'AES-GCM', iv:decode64(packet.iv) },
      secret, decode64(packet.body));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch { return null; }
}
function parse(raw) {
  try {
    const str = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    return str.length <= MAX_ENVELOPE_LENGTH ? JSON.parse(str) : null;
  } catch { return null; }
}
function topic(code) { return TOPIC_PREFIX + code; }
function clientOptions() {
  return { clientId:'rummi-'+randomHex(10), clean:true, protocolVersion:4,
    keepalive:20, reconnectPeriod:2300, connectTimeout:6000 };
}
function emitMessage(client, path, message) {
  if (!client?.connected) throw new Error('WSS 中繼已中斷');
  client.publish(path, JSON.stringify(message), { qos:1, retain:false });
}
function loadMqtt() {
  if (typeof window === 'undefined') return Promise.reject(new Error('需要瀏覽器 WebSocket'));
  if (window.mqtt?.connect) return Promise.resolve(window.mqtt);
  if (mqttPromise) return mqttPromise;
  mqttPromise = new Promise((resolve, reject) => {
    function next(index) {
      if (window.mqtt?.connect) { resolve(window.mqtt); return; }
      if (index >= LIBRARY_URLS.length) { mqttPromise = null; reject(new Error('WSS 模組無法載入')); return; }
      const script = document.createElement('script');
      script.async = true;
      script.src = LIBRARY_URLS[index];
      script.onload = () => next(index + 1);
      script.onerror = () => next(index + 1);
      document.head.appendChild(script);
    }
    next(0);
  });
  return mqttPromise;
}
function openClient(mqtt, url, subscription, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('已取消連線')); return; }
    const client = mqtt.connect(url, clientOptions());
    let settled = false;
    const timeout = setTimeout(() => fail(new Error('WSS 伺服器連線逾時')), 7600);
    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', aborted);
      try { client.end(true); } catch { /* closed */ }
      reject(error);
    }
    function aborted() { fail(new Error('已取消連線')); }
    signal?.addEventListener('abort', aborted, { once:true });
    client.on('connect', () => client.subscribe(subscription, { qos:1 }, error => {
      if (error) { fail(error); return; }
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', aborted);
        resolve(client);
      }
    }));
    client.on('error', error => { if (!settled) fail(error); });
  });
}
function makeEmitter() {
  const listeners = new Map();
  return {
    open:true,
    on(name, callback) {
      listeners.set(name, [...(listeners.get(name) || []), callback]);
      return this;
    },
    emit(name, value) {
      for (const callback of listeners.get(name) || []) callback(value);
    }
  };
}

/** Host may listen on 1 or 2 independent test brokers for greater coverage. */
export async function createRelayHost(code, onConnection, onStatus = () => {}) {
  const mqtt = await loadMqtt();
  const clients = [], sessions = new Map();
  let stopped = false;
  async function receive(client, address, raw) {
    if (stopped) return;
    const id = String(address).split('/').at(-1);
    if (!/^[a-f0-9]{32}$/.test(id)) return;
    const data = parse(raw), sessionKey = client.options.clientId + ':' + id;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'hello') {
      if (!/^[a-f0-9]{32}$/.test(data.session || '')) return;
      let session = sessions.get(sessionKey);
      if (!session || session.session !== data.session) {
        try {
          const pair = await generatePair();
          const secret = await deriveSecret(pair, data.pub);
          const publicPart = await publicKey(pair);
          const conn = makeEmitter();
          session = { session:data.session, secret, publicPart, conn, lastSeen:Date.now(),
            sendQueue:Promise.resolve(), receiveQueue:Promise.resolve() };
          const entry = session;
          const staleTimer = setInterval(() => {
            if (Date.now() - entry.lastSeen > DISCONNECTED_TIMEOUT_MS) conn.close();
            else if (conn.open && client.connected) {
              try { conn.send({type:'relay-heartbeat'}); } catch { conn.close(); }
            }
          }, HEARTBEAT_INTERVAL_MS);
          conn.send = payload => {
            if (!conn.open || !client.connected) throw new Error('中繼通道未連接');
            entry.sendQueue = entry.sendQueue.then(async () => {
              const packet = await encrypt(secret, payload);
              if (!stopped && conn.open)
                emitMessage(client, topic(code)+'/to/'+id, { ...packet, session:entry.session });
            }).catch(() => { conn.close(); });
          };
          conn.close = () => {
            if (!conn.open) return;
            conn.open = false;
            clearInterval(staleTimer);
            if (sessions.get(sessionKey) === entry) sessions.delete(sessionKey);
            conn.emit('close');
          };
          sessions.set(sessionKey, session);
          onConnection(conn);
        } catch { return; }
      }
      try {
        emitMessage(client, topic(code)+'/to/'+id, {
          type:'welcome', pub:session.publicPart, session:session.session
        });
      } catch { /* Another broker may still be available. */ }
      return;
    }
    const entry = sessions.get(sessionKey);
    if (!entry || !entry.conn.open || data.type !== 'secure' ||
        data.session !== entry.session) return;
    entry.receiveQueue = entry.receiveQueue.then(async () => {
      const decoded = await decrypt(entry.secret, data);
      if (!decoded || typeof decoded !== 'object') return;
      entry.lastSeen = Date.now();
      if (decoded.type === 'bye') entry.conn.close();
      else if (decoded.type !== 'heartbeat') entry.conn.emit('data', decoded);
    }).catch(() => { /* bad ciphertext is ignored */ });
  }
  const attempts = RELAY_BROKERS.map(async url => {
    const client = await openClient(mqtt, url, topic(code)+'/from/+');
    if (stopped) { client.end(true); return; }
    client.on('message', (address, raw) => { void receive(client, address, raw); });
    clients.push(client);
    onStatus('加密中繼已就緒：'+url.replace(/^wss:\/\//,''));
  });
  const results = await Promise.allSettled(attempts);
  if (stopped || !results.some(x => x.status === 'fulfilled')) {
    throw new Error('公開 WSS 中繼暫時不可用');
  }
  return {
    close() {
      stopped = true;
      for (const entry of sessions.values()) entry.conn.close();
      sessions.clear();
      for (const client of clients) { try { client.end(true); } catch {} }
      clients.length = 0;
    }
  };
}

async function guestBroker(mqtt, broker, code, handlers, signal) {
  const id = randomHex(), session = randomHex(), pair = await generatePair();
  const guestPub = await publicKey(pair);
  const outgoing = topic(code)+'/from/'+id, incoming = topic(code)+'/to/'+id;
  let client = null, secret = null, connected = false, stopped = false, lastHostSeen = Date.now();
  let sending = Promise.resolve(), receiving = Promise.resolve(), pulse = null, heartbeat = null;
  let timeout;
  const conn = makeEmitter();
  function terminate(notify = false) {
    if (stopped) return;
    stopped = true;
    conn.open = false;
    clearInterval(pulse);
    clearInterval(heartbeat);
    clearTimeout(timeout);
    signal?.removeEventListener('abort', aborted);
    try { client?.end(true); } catch {}
    if (notify) conn.emit('close');
  }
  let rejectPending = null;
  function aborted() {
    if (rejectPending) rejectPending(new Error('已取消連線'));
    else terminate(true);
  }
  if (signal?.aborted) throw new Error('已取消連線');
  signal?.addEventListener('abort', aborted, { once:true });
  return new Promise(async (resolve, reject) => {
    let settled = false;
    function failure(error) {
      if (settled) { terminate(true); return; }
      settled = true;
      terminate();
      reject(error);
    }
    rejectPending = failure;
    timeout = setTimeout(() => failure(new Error('中繼握手逾時')), 9500);
    conn.close = () => {
      if (conn.open && secret) {
        try { conn.send({ type:'bye' }); } catch {}
      }
      terminate(true);
    };
    conn.send = payload => {
      if (stopped || !secret || !client?.connected) throw new Error('中繼未連接');
      sending = sending.then(async () => {
        const packet = await encrypt(secret, payload);
        if (!stopped) emitMessage(client, outgoing, { ...packet, session });
      }).catch(() => { terminate(true); });
    };
    try {
      client = await openClient(mqtt, broker, incoming, signal);
      if (stopped) { failure(new Error('已取消連線')); return; }
      client.on('message', (address, raw) => {
        if (stopped || address !== incoming) return;
        const data = parse(raw);
        if (!data || data.session !== session) return;
        if (data.type === 'welcome' && !secret) {
          void deriveSecret(pair, data.pub).then(derived => {
            if (stopped) return;
            secret = derived;
            connected = true;
            lastHostSeen = Date.now();
            heartbeat = setInterval(() => {
              if (stopped) return;
              if (Date.now() - lastHostSeen > DISCONNECTED_TIMEOUT_MS) {
                terminate(true);
                return;
              }
              if (client?.connected && conn.open) {
                try { conn.send({type:'heartbeat'}); } catch { terminate(true); }
              }
            }, HEARTBEAT_INTERVAL_MS);
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              clearInterval(pulse);
              resolve(conn);
            }
          }).catch(error => failure(error));
          return;
        }
        if (!secret || data.type !== 'secure') return;
        receiving = receiving.then(async () => {
          const message = await decrypt(secret, data);
          if (!message || typeof message !== 'object') return;
          lastHostSeen = Date.now();
          if (message.type === 'bye') { terminate(true); return; }
          if (message.type !== 'relay-heartbeat') handlers.onMessage?.(message);
        }).catch(() => {});
      });
      client.on('offline', () => { if (connected) terminate(true); });
      client.on('close', () => { if (connected) terminate(true); });
      client.on('error', () => { if (connected) terminate(true); });
      function hello() {
        if (stopped || secret || !client?.connected) return;
        try { emitMessage(client, outgoing, { type:'hello', pub:guestPub, session }); } catch {}
      }
      hello();
      pulse = setInterval(hello, 1400);
    } catch(error) {
      failure(error);
    }
  });
}

/** Try the two brokers in parallel. Losing connection attempts are disposed. */
export async function connectRelayGuest(code, handlers = {}) {
  const mqtt = await loadMqtt();
  const controllers = RELAY_BROKERS.map(() => new AbortController());
  const results = RELAY_BROKERS.map((url, index) =>
    guestBroker(mqtt, url, code, handlers, controllers[index].signal)
  );
  let winner;
  try { winner = await Promise.any(results); }
  catch { controllers.forEach(ctrl => ctrl.abort()); throw new Error('公開 WSS 中繼不可用'); }
  controllers.forEach((ctrl, i) => {
    if (!results[i]) return;
    // Only dispose unsuccessful attempts. Promise.any resolves a successful channel;
    // identity test below is scheduled as the promise settles.
    results[i].then(conn => { if (conn !== winner) conn.close(); }).catch(() => {});
  });
  return winner;
}
