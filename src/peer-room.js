/** Small PeerJS/WebRTC signaling wrapper. Game rules stay outside the transport. */
import { validRoomCode } from './online-core.js';

const PREFIX = 'sanmao-rummi-v1-';
const RETRY_DELAYS = [800, 1500, 3000, 5000, 8000, 12000];
const MAX_MESSAGE_BYTES = 80000;

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
  close() {
    this.stopped = true;
    this.generation += 1;
    clearTimeout(this.retryHandle);
    this.connection?.close();
    for (const conn of this.connections) conn.close();
    this.connections.clear();
    this.peer?.destroy();
    this.connection = null;
    this.peer = null;
    this.mode = null;
    this.detachListeners();
  }
  async host(code) {
    if (!validRoomCode(code)) throw new Error('房號必須是 6 位數字。');
    this.close();
    this.stopped = false;
    this.attachListeners();
    this.mode = 'host';
    this.code = code;
    const generation = this.generation;
    const peer = this.makePeer(PREFIX + code);
    this.peer = peer;
    return new Promise((resolve, reject) => {
      let settled = false;
      peer.on('open', () => {
        if (this.generation !== generation) return;
        settled = true;
        this.emitStatus('connected', '房間已開放加入');
        resolve();
      });
      peer.on('connection', conn => {
        if (this.generation !== generation) { conn.close(); return; }
        if (this.connections.size >= 8) { conn.close(); return; }
        this.connections.add(conn);
        conn.on('data', msg => {
          if (checkMessage(msg)) this.handlers.onHostMessage?.(msg, conn);
          else conn.close();
        });
        conn.on('close', () => {
          this.connections.delete(conn);
          this.handlers.onConnectionClosed?.(conn);
        });
        conn.on('error', () => { conn.close(); });
      });
      peer.on('error', error => {
        const message = error.type === 'unavailable-id' ? '房號已被使用，請重新建立房間。' : `房主連線錯誤：${error.type || '未知'}`;
        this.emitStatus('error', message);
        if (!settled) { settled = true; reject(new Error(message)); }
      });
      peer.on('disconnected', () => {
        this.emitStatus('reconnecting', '房主訊號中斷，正在嘗試恢復');
        if (!peer.destroyed) { try { peer.reconnect(); } catch { /* User can restore session by reloading. */ } }
      });
    });
  }
  async join(code) {
    if (!validRoomCode(code)) throw new Error('請輸入 6 位數字房號。');
    this.close();
    this.stopped = false;
    this.attachListeners();
    this.mode = 'guest';
    this.code = code;
    this.retries = 0;
    return this.connectGuest();
  }
  async connectGuest() {
    if (this.stopped || this.mode !== 'guest') return;
    const generation = ++this.generation;
    const peer = this.makePeer();
    this.peer?.destroy();
    this.peer = peer;
    this.connection = null;
    this.emitStatus('connecting', '正在連線至房主');
    peer.on('open', () => {
      if (this.stopped || this.generation !== generation) return;
      const conn = peer.connect(PREFIX + this.code, { reliable: true, serialization: 'json' });
      this.connection = conn;
      conn.on('open', () => {
        if (this.stopped || this.generation !== generation) return;
        this.retries = 0;
        this.emitStatus('connected', '已連上房主，正在加入房間');
        this.handlers.onGuestOpen?.();
      });
      conn.on('data', msg => {
        if (this.generation === generation && checkMessage(msg)) this.handlers.onGuestMessage?.(msg);
      });
      conn.on('close', () => {
        if (this.stopped || this.generation !== generation) return;
        this.connection = null;
        this.emitStatus('reconnecting', '與房主斷線，正在重連');
        this.scheduleRetry();
      });
      conn.on('error', () => {
        if (this.generation === generation) this.scheduleRetry();
      });
    });
    peer.on('error', error => {
      if (this.generation !== generation) return;
      this.emitStatus('reconnecting', `連線失敗：${error.type || '未知'}`);
      this.scheduleRetry();
    });
    peer.on('disconnected', () => {
      if (this.generation === generation) this.scheduleRetry();
    });
  }
  scheduleRetry(force = false) {
    if (this.stopped || this.mode !== 'guest') return;
    if (this.retryHandle && !force) return;
    clearTimeout(this.retryHandle);
    if (this.retries >= RETRY_DELAYS.length) {
      this.emitStatus('error', '自動重連已達上限，請按「重新連線」。');
      return;
    }
    const ms = RETRY_DELAYS[this.retries++];
    this.retryHandle = setTimeout(() => {
      this.retryHandle = null;
      this.connectGuest();
    }, force ? 0 : ms);
  }
  reconnect() {
    if (this.mode !== 'guest') return;
    this.retries = 0;
    clearTimeout(this.retryHandle);
    this.retryHandle = null;
    this.connectGuest();
  }
  sendHost(conn, msg) {
    if (!conn?.open || !checkMessage(msg)) return false;
    conn.send(msg);
    return true;
  }
  sendGuest(msg) {
    if (!this.connection?.open || !checkMessage(msg)) return false;
    this.connection.send(msg);
    return true;
  }
}
