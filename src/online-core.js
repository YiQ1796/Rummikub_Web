/** Host-authoritative multiplayer rules. Pure, transport-independent and testable. */
import {
  newMatch, createDraft, inspectDraft, commitHumanTurn,
  drawAndEndHumanTurn
} from './game.js';
import { checkTileIntegrity, validateBoard } from './rules.js';
import { FIXED_PLAYER_COUNT } from './fixed-game-config.js';

export const ROOM_PROTOCOL = 1;
const ROOM_CODE_RE = /^[0-9]{6}$/;
const TOKEN_RE = /^[a-f0-9]{32}$/;
const MAX_NAME_LENGTH = 16;

export function sanitizePlayerName(value) {
  const name = String(value ?? '').trim().replace(/[\x00-\x1f\x7f<>]/g, '').slice(0, MAX_NAME_LENGTH);
  return name || '玩家';
}

export function validRoomCode(code) { return ROOM_CODE_RE.test(String(code)); }
export function validClientToken(token) { return TOKEN_RE.test(String(token)); }

/** Token is retained privately in browser storage, not sent to other players. */
export function secureRoomCode(randomBytes) {
  const bytes = randomBytes(4);
  const value = (bytes[0] * 16777216 + bytes[1] * 65536 + bytes[2] * 256 + bytes[3]);
  return String(100000 + value % 900000);
}

export function newRoom({ code, seats, hostName }) {
  if (!validRoomCode(code)) throw new Error('房號不正確。');
  if (seats !== FIXED_PLAYER_COUNT) throw new Error('房間固定四位玩家，請重新建立四人房。');
  return {
    protocol: ROOM_PROTOCOL, code, seats, phase: 'lobby', revision: 0,
    members: [{ seat: 0, token: null, name: sanitizePlayerName(hostName), connected: true }],
    match: null
  };
}

export function reserveSeat(room, token, name) {
  if (!validClientToken(token)) throw new Error('玩家識別碼格式不正確。');
  const existing = room.members.find(member => member.token === token);
  if (existing) {
    if (!existing.connected) room.revision += 1;
    existing.connected = true;
    return existing.seat;
  }
  if (room.phase !== 'lobby') throw new Error('遊戲已開始，新玩家不能中途加入。');
  const occupied = new Set(room.members.map(member => member.seat));
  const seat = Array.from({ length: room.seats }, (_, i) => i).find(i => !occupied.has(i));
  if (seat === undefined) throw new Error('房間已滿。');
  room.members.push({ seat, token, name: sanitizePlayerName(name), connected: true });
  room.revision += 1;
  return seat;
}

export function disconnectSeat(room, seat) {
  const member = room.members.find(item => item.seat === seat);
  if (member && seat !== 0) { member.connected = false; room.revision += 1; }
}

export function startRoom(room, random = Math.random) {
  if (room.phase !== 'lobby') throw new Error('遊戲已開始。');
  // Disconnected lobby participants do not block AI fallback at game start.
  room.members = room.members.filter(member => member.seat === 0 || member.connected);
  const match = newMatch({ seats: room.seats, random });
  for (const player of match.players) {
    const member = room.members.find(item => item.seat === player.id);
    if (member) { player.isAi = false; player.name = member.name; }
  }
  room.match = match;
  room.phase = 'playing';
  room.revision += 1;
  return match;
}

/** Never serializes the pool order, opponents' tile IDs, or other private drafts. */
export function viewForSeat(room, seat) {
  if (!Number.isInteger(seat) || seat < 0 || seat >= room.seats) throw new Error('座位不正確。');
  const roster = room.members.map(({ seat: index, name, connected }) => ({ seat: index, name, connected }));
  if (!room.match) return { protocol: ROOM_PROTOCOL, code: room.code, phase: room.phase, revision: room.revision, seats: room.seats, roster, seat };
  const game = room.match;
  return {
    protocol: ROOM_PROTOCOL, code: room.code, phase: room.phase, revision: room.revision,
    seats: room.seats, roster, seat,
    game: {
      schemaVersion: game.schemaVersion, status: game.status, currentSeat: game.currentSeat,
      round: game.round, board: game.board, poolCount: game.pool.length,
      message: game.message, winnerSeat: game.winnerSeat, scores: game.scores,
      players: game.players.map((p, i) => ({ id: p.id, name: p.name, isAi: p.isAi, opened: p.opened,
        handCount: p.hand.length, hand: i === seat ? p.hand : [] }))
    }
  };
}

/** The guest sends only physical tile IDs. Host reconstructs canonical tile objects. */
export function rebuildGuestDraft(state, proposed) {
  if (!proposed || !Array.isArray(proposed.hand) || !Array.isArray(proposed.board) || !Array.isArray(proposed.staging) || proposed.board.length > 50) throw new Error('排牌資料格式不正確。');
  const current = state.players[state.currentSeat];
  const allowed = [...current.hand, ...state.board.flat()];
  const catalog = new Map(allowed.map(tile => [tile.id, tile]));
  const readIds = ids => {
    if (!Array.isArray(ids) || ids.length > 106) throw new Error('排牌數量不正確。');
    return ids.map(id => {
      if (typeof id !== 'string' || !catalog.has(id)) throw new Error('包含無權使用的牌。');
      return catalog.get(id);
    });
  };
  const hand = readIds(proposed.hand);
  const staging = readIds(proposed.staging);
  const board = proposed.board.map(readIds);
  const resultIds = [...hand, ...staging, ...board.flat()].map(tile => tile.id);
  if (resultIds.length !== allowed.length || new Set(resultIds).size !== allowed.length) throw new Error('牌張重複或遺失。');
  return {
    ...createDraft(state), hand, staging, board
  };
}

/** Only the authenticated connection's seat can apply a turn. */
export function applyGuestTurn(room, seat, command) {
  if (room.phase !== 'playing' || !room.match || room.match.status !== 'playing') throw new Error('遊戲沒有進行中。');
  if (!Number.isInteger(seat) || seat === 0 || room.match.currentSeat !== seat || room.match.players[seat]?.isAi) throw new Error('現在不是你的回合。');
  if (!command || command.revision !== room.revision) throw new Error('遊戲狀態已更新，請重新同步。');
  if (!['confirm', 'draw', 'penalty'].includes(command.action)) throw new Error('未知的回合操作。');
  const state = room.match;
  // In a hosted match, a guest's uncommitted draft exists only on that guest.
  state.draft = createDraft(state);
  try {
    let detail;
    if (command.action === 'confirm') {
      state.draft = rebuildGuestDraft(state, command.draft);
      const report = inspectDraft(state);
      if (!report.ok) throw new Error(report.error);
      detail = commitHumanTurn(state);
    } else {
      detail = drawAndEndHumanTurn(state, command.action === 'penalty');
    }
    if (!checkTileIntegrity(state) || !validateBoard(state.board).ok) throw new Error('回合後資料驗證失敗。');
    room.revision += 1;
    return detail;
  } finally {
    if (state.currentSeat !== 0) state.draft = null;
  }
}

export function reclaimDisconnectedSeatAsAi(room, seat) {
  const member = room.members.find(m => m.seat === seat);
  if (room.phase !== 'playing' || !member || seat === 0 || member.connected) throw new Error('只能將已離線的真人座位交給 AI。');
  if (room.match.players[seat].isAi) return;
  room.match.players[seat].isAi = true;
  room.match.players[seat].name = `AI ${seat}`;
  room.members = room.members.filter(m => m.seat !== seat);
  room.revision += 1;
}
