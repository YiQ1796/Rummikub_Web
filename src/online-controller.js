/** Browser room orchestration. The host owns the deck, all hands, and rules. */
import { createDraft, isValidSavedState } from './game.js';
import { checkTileIntegrity } from './rules.js';
import {
  newRoom, reserveSeat, startRoom, disconnectSeat, viewForSeat, applyGuestTurn,
  reclaimDisconnectedSeatAsAi, secureRoomCode, sanitizePlayerName,
  validRoomCode, validClientToken, ROOM_PROTOCOL
} from './online-core.js';
import { PeerRoom } from './peer-room.js';
import { FIXED_PLAYER_COUNT } from './fixed-game-config.js';
import { getQuickInteraction, canSendQuickInteraction } from './quick-chat.js';

const HOST_KEY = 'sanmao-rummikub-host-room-v1';
const TOKEN_PREFIX = 'sanmao-rummikub-seat-v1-';
const LAST_GUEST_KEY = 'sanmao-rummikub-last-guest-v1';
const MAX_REQUEST_ID = 1000000000;

function randomBytes(count) {
  const bytes = new Uint8Array(count);
  crypto.getRandomValues(bytes);
  return bytes;
}
function createToken() {
  return Array.from(randomBytes(16), b => b.toString(16).padStart(2, '0')).join('');
}
function safeRead(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeWrite(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}
function safeRemove(key) {
  try { localStorage.removeItem(key); } catch { /* Browser may disable storage. */ }
}
function copyForGuest(snapshot) {
  const game = snapshot.game;
  if (!game) return null;
  const seat = snapshot.seat;
  const match = {
    ...game, pool: [], players: game.players.map(p => ({ ...p, hand: [...p.hand] })),
    draft: null, remoteRevision: snapshot.revision
  };
  if (match.status === 'playing' && match.currentSeat === seat && !match.players[seat].isAi) {
    match.draft = createDraft(match);
  }
  return match;
}

export class OnlineController {
  constructor({ onMatch, onStatus, onInteraction = () => {} }) {
    this.onMatch = onMatch;
    this.onStatus = onStatus;
    this.onInteraction = onInteraction;
    this.transport = null;
    this.room = null;
    this.view = null;
    this.mode = null;
    this.code = '';
    this.seat = 0;
    this.token = '';
    this.connected = false;
    this.pending = false;
    this.requests = new Map();
    this.connections = new Map();
    this.requestId = 0;
    this.knownRevision = -1;
    this.lastStatus = '尚未連線';
    this.name = '玩家';
    this.reactionSentAt = new Map();
    this.localReactionSentAt = null;
  }
  get active() { return this.mode === 'host' || this.mode === 'guest'; }
  get hasStoredHost() { return Boolean(this.storedHostSummary); }
  /** Safe metadata only: showing the resume prompt does not open the old room. */
  get storedHostSummary() {
    const raw = safeRead(HOST_KEY);
    if (!raw) return null;
    try {
      const room = JSON.parse(raw);
      if (room?.protocol !== ROOM_PROTOCOL || room?.seats !== FIXED_PLAYER_COUNT ||
          !validRoomCode(room.code) || !Array.isArray(room.members) ||
          !room.members.some(m => m.seat === 0) ||
          (room.match && (!isValidSavedState(room.match) || !checkTileIntegrity(room.match)))) return null;
      return { code: room.code, phase: room.match?.status || room.phase };
    } catch { return null; }
  }
  get previousGuestRoom() {
    const raw = safeRead(LAST_GUEST_KEY);
    if (!raw) return null;
    try {
      const saved = JSON.parse(raw);
      if (!validRoomCode(saved.code) || !validClientToken(safeRead(TOKEN_PREFIX + saved.code)) ||
          !Number.isInteger(saved.seat) || saved.seat < 1 || saved.seat >= FIXED_PLAYER_COUNT) return null;
      return { code: saved.code, name: sanitizePlayerName(saved.name), seat: saved.seat };
    } catch { return null; }
  }
  forgetPreviousGuest() {
    const previous = this.previousGuestRoom;
    if (previous) safeRemove(TOKEN_PREFIX + previous.code);
    safeRemove(LAST_GUEST_KEY);
  }
  /** Called only after user explicitly chooses to discard the previous session. */
  discardStoredSessions() {
    this.forgetPreviousGuest();
    safeRemove(HOST_KEY);
  }
  get isHost() { return this.mode === 'host'; }
  get members() { return this.isHost ? this.room?.members || [] : this.view?.roster || []; }
  emit(message) { this.lastStatus = message; this.onStatus(message); }
  createTransport() {
    return new PeerRoom({
      onStatus: (status, detail) => {
        if (this.mode === 'guest') {
          this.connected = status === 'connected' && !!this.view;
          if (status !== 'connected') this.pending = false;
        }
        this.emit(detail || status);
      },
      onHostMessage: (msg, conn) => this.receiveHostMessage(msg, conn),
      onConnectionClosed: conn => this.connectionClosed(conn),
      onGuestOpen: () => this.sendHello(),
      onGuestMessage: msg => this.receiveGuestMessage(msg)
    });
  }
  persistHost() {
    if (this.isHost && this.room) safeWrite(HOST_KEY, JSON.stringify(this.room));
  }
  async host(seats, name) {
    if (seats !== FIXED_PLAYER_COUNT) throw new Error('目前一律使用四人房間。');
    this.leave();
    this.mode = 'host';
    this.name = sanitizePlayerName(name);
    this.seat = 0;
    this.transport = this.createTransport();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = secureRoomCode(randomBytes);
      try {
        await this.transport.host(code);
        this.code = code;
        this.connected = true;
        this.room = newRoom({ code, seats, hostName: this.name });
        this.persistHost();
        this.emit(`已建立房間 ${code}，可邀請朋友加入。`);
        this.onMatch(null);
        return code;
      } catch (error) {
        if (!String(error.message).includes('房號已被使用') || attempt === 4) {
          this.leave();
          throw error;
        }
      }
    }
  }
  async restoreHost() {
    const raw = safeRead(HOST_KEY);
    if (!raw || this.active) return false;
    let room;
    try { room = JSON.parse(raw); } catch { safeRemove(HOST_KEY); return false; }
    if (room?.protocol !== ROOM_PROTOCOL || room?.seats !== FIXED_PLAYER_COUNT) {
      safeRemove(HOST_KEY);
      this.emit('舊版非四人房間已停用，請重新建立四人房間。');
      return false;
    }
    if (!validRoomCode(room.code) ||
      !Array.isArray(room.members) || !room.members.some(m => m.seat === 0) ||
      (room.match && (!isValidSavedState(room.match) || !checkTileIntegrity(room.match)))) return false;
    this.mode = 'host';
    this.room = room;
    this.code = room.code;
    this.seat = 0;
    this.name = room.members[0].name;
    // A refreshed host must not mark remote players as connected until they rejoin.
    room.members.forEach(member => { if (member.seat !== 0) member.connected = false; });
    room.revision += 1;
    this.transport = this.createTransport();
    try {
      await this.transport.host(room.code);
      this.connected = true;
      this.persistHost();
      this.publish();
      this.emit(`房間 ${room.code} 已恢復，請朋友重新連線。`);
      return true;
    } catch (error) {
      this.emit(`無法恢復房間：${error.message}`);
      this.transport.close();
      this.transport = null;
      this.mode = null;
      this.room = null;
      return false;
    }
  }
  async join(code, name) {
    if (!validRoomCode(code)) throw new Error('請輸入正確的 6 位數字房號。');
    this.leave();
    this.mode = 'guest';
    this.code = code;
    this.name = sanitizePlayerName(name);
    const key = TOKEN_PREFIX + code;
    const stored = safeRead(key);
    this.token = validClientToken(stored) ? stored : createToken();
    safeWrite(key, this.token);
    this.transport = this.createTransport();
    this.knownRevision = -1;
    // Emit before joining: a fast successful handshake must not be overwritten
    // by a stale "searching host" message after the join Promise resolves.
    this.emit('正在搜尋房主，請確認房號與網路連線。');
    try {
      await this.transport.join(code);
    } catch (error) {
      this.leave();
      throw error;
    }
  }
  sendHello() {
    if (!this.isHost && this.mode === 'guest') this.transport.sendGuest({ type: 'hello', protocol: ROOM_PROTOCOL, token: this.token, name: this.name });
  }
  receiveHostMessage(msg, conn) {
    if (!this.isHost || !msg || typeof msg !== 'object') return;
    if (msg.type === 'hello') {
      if (msg.protocol !== ROOM_PROTOCOL) return this.transport.sendHost(conn, { type: 'error', message: '遊戲版本不一致，請重新整理。' });
      try {
        const seat = reserveSeat(this.room, msg.token, msg.name);
        for (const [otherConn, otherSeat] of this.connections) {
          if (otherSeat === seat && otherConn !== conn) { this.connections.delete(otherConn); otherConn.close(); }
        }
        this.connections.set(conn, seat);
        this.transport.sendHost(conn, { type: 'welcome', seat, snapshot: viewForSeat(this.room, seat) });
        this.publish();
      } catch (error) {
        this.transport.sendHost(conn, { type: 'error', message: error.message });
      }
      return;
    }
    const seat = this.connections.get(conn);
    if (!Number.isInteger(seat)) return;
    if (msg.type === 'leave') {
      this.connections.delete(conn);
      if (this.room.phase === 'lobby') {
        this.room.members = this.room.members.filter(member => member.seat !== seat);
        this.room.revision += 1;
      } else disconnectSeat(this.room, seat);
      conn.close();
      this.publish();
      return;
    }
    if (msg.type === 'reaction') {
      // The seat comes from the authenticated Peer connection, not a guest payload.
      if (!this.room?.match || this.room.match.status !== 'playing' ||
          !getQuickInteraction(msg.id)) return;
      const now = Date.now();
      if (!canSendQuickInteraction(this.reactionSentAt.get(seat), now)) {
        this.transport.sendHost(conn, { type: 'reaction-error', message: '嘲諷太頻繁了，請稍等 3 秒。' });
        return;
      }
      this.reactionSentAt.set(seat, now);
      this.broadcastReaction(seat, msg.id);
      return;
    }
    if (msg.type !== 'turn' || !Number.isInteger(msg.id) || msg.id < 1 || msg.id > MAX_REQUEST_ID) return;
    if (this.requests.get(seat) === msg.id) return;
    try {
      applyGuestTurn(this.room, seat, msg.command);
      this.requests.set(seat, msg.id);
      this.publish();
    } catch (error) {
      this.transport.sendHost(conn, { type: 'rejected', id: msg.id, message: error.message, snapshot: viewForSeat(this.room, seat) });
    }
  }
  connectionClosed(conn) {
    const seat = this.connections.get(conn);
    if (!Number.isInteger(seat) || !this.room) return;
    this.connections.delete(conn);
    disconnectSeat(this.room, seat);
    this.publish();
  }
  receiveGuestMessage(msg) {
    if (this.mode !== 'guest' || !msg || typeof msg !== 'object') return;
    if (msg.type === 'error') {
      this.connected = false;
      this.pending = false;
      this.emit(msg.message || '加入房間失敗');
      return;
    }
    if (msg.type === 'rejected') {
      this.pending = false;
      this.emit(msg.message || '房主拒絕此次出牌。');
      if (msg.snapshot) this.acceptSnapshot(msg.snapshot, true);
      return;
    }
    if (msg.type === 'welcome') {
      if (msg.snapshot?.seat !== msg.seat) return;
      if (msg.snapshot?.seats !== FIXED_PLAYER_COUNT) {
        this.leave();
        this.emit('房主使用的是舊版非四人房間，請房主重新建立四人房。');
        return;
      }
      this.seat = msg.seat;
      this.connected = true;
      // An open socket alone is not successful admission.
      this.transport?.confirmJoined?.();
      safeWrite(LAST_GUEST_KEY, JSON.stringify({code: this.code, name: this.name, seat: this.seat}));
      this.acceptSnapshot(msg.snapshot, true);
      this.emit(`已進入房間 ${this.code}，你是第 ${this.seat + 1} 位玩家。`);
      return;
    }
    if (msg.type === 'reaction') {
      if (this.view?.game?.status !== 'playing' ||
          !Number.isInteger(msg.seat) || msg.seat < 0 || msg.seat >= FIXED_PLAYER_COUNT ||
          !getQuickInteraction(msg.id)) return;
      this.onInteraction({ seat: msg.seat, id: msg.id });
      return;
    }
    if (msg.type === 'reaction-error') {
      this.emit(msg.message || '表情發送失敗，請稍後重試。');
      return;
    }
    if (msg.type === 'state') this.acceptSnapshot(msg.snapshot);
  }
  acceptSnapshot(snapshot, force = false) {
    if (!snapshot || snapshot.protocol !== ROOM_PROTOCOL ||
      snapshot.seats !== FIXED_PLAYER_COUNT || snapshot.code !== this.code ||
      !Number.isInteger(snapshot.revision) || snapshot.seat !== this.seat ||
      (!force && snapshot.revision < this.knownRevision)) return;
    if (!force && snapshot.revision === this.knownRevision) return;
    this.knownRevision = snapshot.revision;
    this.view = snapshot;
    this.pending = false;
    this.onMatch(copyForGuest(snapshot));
  }
  /** Reactions are ephemeral; do not publish a full snapshot or change the turn. */
  broadcastReaction(seat, id) {
    this.onInteraction({ seat, id });
    for (const [conn] of this.connections) {
      if (conn.open) this.transport.sendHost(conn, { type: 'reaction', seat, id });
    }
  }
  sendReaction(id) {
    if (!getQuickInteraction(id)) throw new Error('無效的快捷互動。');
    const now = Date.now();
    if (this.isHost) {
      if (!this.room?.match || this.room.match.status !== 'playing')
        throw new Error('請先開始遊戲再使用快捷互動。');
      if (!canSendQuickInteraction(this.reactionSentAt.get(0), now))
        throw new Error('太快啦！請稍等 3 秒再發送。');
      this.reactionSentAt.set(0, now);
      this.broadcastReaction(0, id);
      return;
    }
    if (this.mode !== 'guest' || !this.connected || this.view?.game?.status !== 'playing')
      throw new Error('尚未連線到進行中的房間。');
    if (!canSendQuickInteraction(this.localReactionSentAt, now))
      throw new Error('太快啦！請稍等 3 秒再發送。');
    if (!this.transport.sendGuest({ type: 'reaction', id }))
      throw new Error('未能送出泡泡，請檢查連線。');
    this.localReactionSentAt = now;
  }
  sendTurn(action, draft = null) {
    if (this.mode !== 'guest' || !this.connected || this.pending || !this.view || !this.view.game) throw new Error('尚未與房主同步，不能出牌。');
    if (this.view.game.currentSeat !== this.seat) throw new Error('目前不是你的回合。');
    const command = { revision: this.view.revision, action };
    if (action === 'confirm') {
      if (!draft) throw new Error('缺少待確認的牌組。');
      command.draft = { hand: draft.hand.map(t => t.id), staging: draft.staging.map(t => t.id), board: draft.board.map(m => m.map(t => t.id)) };
    }
    const id = ++this.requestId;
    this.pending = true;
    if (!this.transport.sendGuest({ type: 'turn', id, command })) {
      this.pending = false;
      throw new Error('網路斷線，沒有送出操作。');
    }
    this.emit('已送出操作，等待房主驗證。');
  }
  start() {
    if (!this.isHost || !this.room) throw new Error('只有房主可以開始遊戲。');
    startRoom(this.room, () => { const bytes = randomBytes(4); return (bytes[0]*16777216 + bytes[1]*65536 + bytes[2]*256 + bytes[3])/4294967296; });
    this.publish();
  }
  publish() {
    if (!this.isHost || !this.room) return;
    this.persistHost();
    for (const [conn, seat] of this.connections) {
      if (conn.open) this.transport.sendHost(conn, { type: 'state', snapshot: viewForSeat(this.room, seat) });
    }
    this.view = viewForSeat(this.room, 0);
    this.onMatch(this.room.match);
  }
  announceLocalTurn() {
    if (this.isHost && this.room?.phase === 'playing') {
      this.room.revision += 1;
      this.publish();
    }
  }
  takeoverDisconnected() {
    if (!this.isHost || this.room?.phase !== 'playing') return 0;
    const disconnected = this.room.members.filter(m => m.seat !== 0 && !m.connected).map(m => m.seat);
    for (const seat of disconnected) reclaimDisconnectedSeatAsAi(this.room, seat);
    if (disconnected.length) this.publish();
    return disconnected.length;
  }
  inviteUrl() { return `${location.origin}${location.pathname}?room=${this.code}`; }
  reconnect() { if (this.mode === 'guest') { this.pending = false; this.connected = false; this.transport.reconnect(); } }
  leave() {
    if (this.mode === 'guest') this.transport?.sendGuest({ type: 'leave' });
    if (this.mode === 'host') safeRemove(HOST_KEY);
    this.transport?.close();
    this.transport = null;
    this.mode = null;
    this.room = null;
    this.view = null;
    this.connections.clear();
    this.connected = false;
    this.pending = false;
    this.knownRevision = -1;
    this.code = '';
    this.seat = 0;
    this.reactionSentAt.clear();
    this.localReactionSentAt = null;
  }
}
