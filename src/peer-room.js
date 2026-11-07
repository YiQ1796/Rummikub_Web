/** Small PeerJS/WebRTC signaling wrapper. Game rules stay outside the transport. */
import { validRoomCode } from './online-core.js';
import { createRelayHost, connectRelayGuest } from './relay-transport.js';

const PREFIX = 'sanmao-rummi-v1-';
const RETRY_DELAYS = [800, 1500, 3000, 5000, 8000, 12000];
const MAX_MESSAGE_BYTES = 80000;
const JOIN_TIMEOUT_MS = 28000;
const P2P_TIMEOUT_MS = 14000;

function checkMessage(value) {
  try { return JSON.stringify(value).length <= MAX_MESSAGE_BYTES; } catch { return false; }
}

export class PeerRoom {
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.peer = null;
    this.connection = null;
    this.connections = new Set();
    this.mode = null;
    this.code = null;
    this.generation = 0;
    this.retries = 0;
    this.retryHandle = null;
    this.stopped = false;
    this.relayHost = null;
    this.relayGuest = null;
    this.joinTimer = null;
    this.p2pTimer = null;
    this.joinConfirmed = false;
    this._resume = () => {
      if (!this.stopped && this.mode === 'guest' && (!this.connection || !this.connection.open)) this.scheduleRetry(true);
    };
    this._visibilityChange = () => { if (!document.hidden) this._resume(); };
    this.listenersAttached = false;
    this.attachListeners();
  }
  attachListeners() {
    if (typeof window === 'undefined' || this.listenersAttached) return;
    window.addEventListener('online', this._resume);
    document.addEventListener('visibilitychange', this._visibilityChange);
    this.listenersAttached = true;
  }
  detachListeners() {
    if (typeof window === 'undefined' || !this.listenersAttached) return;
    window.removeEventListener('online', this._resume);
    document.removeEventListener('visibilitychange', this._visibilityChange);
    this.listenersAttached = false;
  }
  emitStatus(status, detail = '') { this.handlers.onStatus?.(status, detail); }
  makePeer(id) {
    if (typeof window === 'undefined' || typeof window.Peer !== 'function') throw new Error('多人連線套件無法載入，請檢查網路或瀏覽器限制。');
    return id ? new window.Peer(id, { debug: 0 }) : new window.Peer({ debug: 0 });
  }
  clearGuestAttempt() {
    clearTimeout(this.joinTimer);
    clearTimeout(this.p2pTimer);
    this.joinTimer = null;
    this.p2pTimer = null;
    const conn = this.connection;
    const relay = this.relayGuest;
    const peer = this.peer;
    this.connection = null;
    this.relayGuest = null;
    this.peer = null;
    try { conn?.close(); } catch {}
    if (relay && relay !== conn) { try { relay.close(); } catch {} }
    try { peer?.destroy(); } catch {}
  }
  close() {
    this.stopped = true;
    this.generation += 1;
    clearTimeout(this.retryHandle);
    this.retryHandle = null;
    this.clearGuestAttempt();
    this.relayHost?.close();
    this.relayHost = null;
    for (const conn of this.connections) {
      try { conn.close(); } catch {}
    }
    this.connections.clear();
    this.mode = null;
    this.joinConfirmed = false;
    this.detachListeners();
  }
  registerHostConnection(conn, generation) {
    if (this.stopped || this.generation !== generation || this.mode !== 'host') {
      conn.close(); return;
    }
    if (this.connections.size >= 8) { conn.close(); return; }
    this.connections.add(conn);
    // An unfinished relay hello must not hold a connection slot forever.
    let authenticated = false;
    const admissionTimer = setTimeout(() => {
      if (!authenticated && conn.open) conn.close();
    }, 18000);
    conn.on('data', msg => {
      if (checkMessage(msg)) {
        if (msg?.type === 'hello') {
          authenticated = true;
          clearTimeout(admissionTimer);
        }
        this.handlers.onHostMessage?.(msg, conn);
      } else conn.close();
    });
    conn.on('close', () => {
      clearTimeout(admissionTimer);
      this.connections.delete(conn);
      if (!this.stopped && this.generation === generation)
        this.handlers.onConnectionClosed?.(conn);
    });
    conn.on('error', () => { try { conn.close(); } catch {} });
  }
  async startPeerHost(code, generation) {
    const peer = this.makePeer(PREFIX + code);
    this.peer = peer;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => settle(new Error('WebRTC 訊號伺服器逾時')), 9500);
      const settle = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        error ? reject(error) : resolve();
      };
      peer.on('open', () => {
        if (this.stopped || this.generation !== generation) return;
        this.emitStatus('connected', '房主 WebRTC 訊號已就緒');
        settle();
      });
      peer.on('connection', conn => this.registerHostConnection(conn, generation));
      peer.on('error', error => {
        const message = error.type === 'unavailable-id'
          ? '房號已被使用，請重新建立房間。'
          : '房主 WebRTC 訊號錯誤：' + (error.type || 'unknown');
        if (this.generation !== generation) return;
        this.emitStatus('error',message);
        settle(new Error(message));
      });
      peer.on('disconnected', () => {
        if (this.stopped || this.generation !== generation) return;
        this.emitStatus('reconnecting','房主 WebRTC 訊號中斷，加密中繼可能仍可用。');
        if (!peer.destroyed) {
          try { peer.reconnect(); } catch {}
        }
      });
    });
  }
  async startRelayHost(code, generation) {
    const relay = await createRelayHost(code,
      conn => this.registerHostConnection(conn,generation),
      detail => {
        if (!this.stopped && this.generation === generation)
          this.emitStatus('connected', detail);
      }
    );
    if (this.stopped || this.generation !== generation) { relay.close(); return; }
    this.relayHost = relay;
  }
  async host(code) {
    if (!validRoomCode(code)) throw new Error('房號必須是 6 位數字。');
    this.close();
    this.stopped = false;
    this.attachListeners();
    this.mode = 'host';
    this.code = code;
    const generation = this.generation;
    // Keep both transports available: the first ready permits the room lobby.
    try {
      await Promise.any([
        this.startPeerHost(code,generation),
        this.startRelayHost(code,generation)
      ]);
    } catch {
      this.close();
      throw new Error('WebRTC 與 WSS 中繼均無法啟動，請檢查網路後重新開房。');
    }
  }
  async join(code) {
    if (!validRoomCode(code)) throw new Error('請輸入 6 位數字房號。');
    this.close();
    this.stopped = false;
    this.attachListeners();
    this.mode = 'guest';
    this.code = code;
    this.retries = 0;
    // Actual admission requires a host 'welcome', not merely a socket connection.
    void this.connectGuest();
  }
  async connectGuest() {
    if (this.stopped || this.mode !== 'guest') return;
    this.clearGuestAttempt();
    const generation = ++this.generation;
    this.joinConfirmed = false;
    this.emitStatus('connecting',
      '優先嘗試加密 WSS 中繼（第 ' + (this.retries+1) + '/' +
      RETRY_DELAYS.length + ' 次）');
    this.joinTimer = setTimeout(() => {
      if (this.stopped || this.generation !== generation || this.joinConfirmed) return;
      this.emitStatus('reconnecting',
        '連線逾時：房主尚未確認座位，可能是行動網路阻擋或房主離線。');
      this.scheduleRetry();
    }, JOIN_TIMEOUT_MS);
    try {
      const conn = await connectRelayGuest(this.code, {
        onMessage: msg => {
          if (!this.stopped && this.generation === generation && checkMessage(msg))
            this.handlers.onGuestMessage?.(msg);
        }
      });
      if (this.stopped || this.generation !== generation) { conn.close(); return; }
      this.connection = conn;
      this.relayGuest = conn;
      conn.on('close', () => {
        if (!this.stopped && this.generation === generation) {
          this.emitStatus('reconnecting','加密 WSS 中繼已中斷，正在重連');
          this.scheduleRetry();
        }
      });
      this.emitStatus('connected','已連上加密 WSS 中繼，正在確認房主座位');
      this.handlers.onGuestOpen?.();
    } catch {
      if (this.stopped || this.generation !== generation) return;
      this.emitStatus('connecting', '公開 WSS 中繼不可用，改用 WebRTC P2P 直連');
      this.tryGuestPeer(generation);
    }
  }
  tryGuestPeer(generation) {
    let peer;
    try { peer = this.makePeer(); }
    catch (error) {
      this.emitStatus('error',error.message);
      this.scheduleRetry();
      return;
    }
    this.peer = peer;
    this.p2pTimer = setTimeout(() => {
      if (this.stopped || this.generation !== generation || this.joinConfirmed) return;
      this.emitStatus('reconnecting', 'WebRTC 直連逾時：4G／5G NAT 可能阻擋 P2P');
      this.scheduleRetry();
    }, P2P_TIMEOUT_MS);
    peer.on('open', () => {
      if (this.stopped || this.generation !== generation) return;
      const conn = peer.connect(PREFIX + this.code,
        { reliable:true, serialization:'json' });
      this.connection = conn;
      conn.on('open', () => {
        if (this.stopped || this.generation !== generation) return;
        clearTimeout(this.p2pTimer);
        this.emitStatus('connected','WebRTC P2P 已連線，正在確認座位');
        this.handlers.onGuestOpen?.();
      });
      conn.on('data', msg => {
        if (this.generation === generation && checkMessage(msg))
          this.handlers.onGuestMessage?.(msg);
      });
      conn.on('close', () => {
        if (this.stopped || this.generation !== generation) return;
        this.emitStatus('reconnecting','WebRTC 資料通道中斷，正在重連');
        this.scheduleRetry();
      });
      conn.on('error', () => {
        if (!this.stopped && this.generation === generation) this.scheduleRetry();
      });
    });
    peer.on('error', error => {
      if (this.stopped || this.generation !== generation) return;
      this.emitStatus('reconnecting','WebRTC 錯誤：' + (error.type || 'unknown'));
      this.scheduleRetry();
    });
    peer.on('disconnected', () => {
      if (!this.stopped && this.generation === generation) this.scheduleRetry();
    });
  }
  confirmJoined() {
    if (this.stopped || this.mode !== 'guest') return;
    this.joinConfirmed = true;
    this.retries = 0;
    clearTimeout(this.joinTimer);
    clearTimeout(this.p2pTimer);
    this.joinTimer = this.p2pTimer = null;
  }
  scheduleRetry(force = false) {
    if (this.stopped || this.mode !== 'guest') return;
    if (this.retryHandle && !force) return;
    this.generation += 1;
    this.clearGuestAttempt();
    clearTimeout(this.retryHandle);
    this.retryHandle = null;
    if (this.retries >= RETRY_DELAYS.length) {
      this.emitStatus('error',
        '手機連線已多次失敗：公開中繼可能不可用，或房主網路中斷。請按「重新連線」重試。');
      return;
    }
    const delay = force ? 0 : RETRY_DELAYS[this.retries];
    this.retries += 1;
    this.retryHandle = setTimeout(() => {
      this.retryHandle = null;
      void this.connectGuest();
    },delay);
  }
  reconnect() {
    if (this.mode !== 'guest') return;
    this.retries = 0;
    this.scheduleRetry(true);
  }
  sendHost(conn, msg) {
    if (!conn?.open || !checkMessage(msg)) return false;
    try { conn.send(msg); return true; } catch { return false; }
  }
  sendGuest(msg) {
    if (!this.connection?.open || !checkMessage(msg)) return false;
    try { this.connection.send(msg); return true; } catch { return false; }
  }
}
