import {
  INITIAL_HAND_SIZE, OPENING_POINTS, TILE_COUNT, analyzeMeld, validateBoard,
  createDeck, checkTileIntegrity, handPenalty
} from './rules.js';
import { planAiTurn } from './ai.js';

export const SAVE_KEY = 'sanmao-rummikub-v010';
export const SCHEMA_VERSION = 1;

function randomIndex(upperExclusive, random) {
  return Math.floor(random() * upperExclusive);
}

function shuffle(deck, random) {
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swap = randomIndex(index + 1, random);
    [deck[index], deck[swap]] = [deck[swap], deck[index]];
  }
  return deck;
}

export function newMatch({ seats = 4, random = Math.random } = {}) {
  if (!Number.isInteger(seats) || seats < 2 || seats > 4) throw new Error('玩家座位只支援 2～4 人。');
  const pool = shuffle(createDeck(), random);
  const players = Array.from({ length: seats }, (_, index) => ({
    id: index, name: index === 0 ? '你' : `AI ${index}`,
    isAi: index !== 0, opened: false,
    hand: pool.splice(0, INITIAL_HAND_SIZE)
  }));
  const state = {
    schemaVersion: SCHEMA_VERSION,
    status: 'playing', players, pool, board: [], currentSeat: 0,
    draft: null, passes: 0, round: 1, winnerSeat: null, scores: null,
    message: '你的回合。首次破冰必須以自己的手牌湊滿 30 分。'
  };
  state.draft = createDraft(state);
  return state;
}

export function createDraft(state) {
  const player = state.players[state.currentSeat];
  return {
    board: state.board.map(meld => [...meld]), hand: [...player.hand], staging: [],
    originalHandIds: player.hand.map(tile => tile.id),
    originalBoard: state.board.map(meld => meld.map(tile => tile.id))
  };
}

function requireHumanTurn(state) {
  if (state.status !== 'playing' || state.currentSeat !== 0 || !state.draft) throw new Error('目前不是你的回合。');
}

function allDraftTiles(draft) {
  return [...draft.hand, ...draft.staging, ...draft.board.flat()];
}

function takeFromDraft(draft, ids) {
  const unique = new Set(ids);
  if (unique.size !== ids.length || !ids.length) throw new Error('請先選取要操作的牌。');
  const result = allDraftTiles(draft).filter(tile => unique.has(tile.id));
  if (result.length !== ids.length) throw new Error('選取牌已不存在，請重新選牌。');
  draft.hand = draft.hand.filter(tile => !unique.has(tile.id));
  draft.staging = draft.staging.filter(tile => !unique.has(tile.id));
  draft.board = draft.board.map(meld => meld.filter(tile => !unique.has(tile.id)));
  return result;
}

/** Draft changes are reversible and never modify public board or official rack. */
export function editDraft(state, { action, ids, targetIndex = null }) {
  requireHumanTurn(state);
  const draft = state.draft;
  const chosen = allDraftTiles(draft).filter(tile => ids.includes(tile.id));
  if (new Set(ids).size !== ids.length || !ids.length || chosen.length !== ids.length) throw new Error('請先選取有效牌張。');
  if (action === 'new-meld') {
    if (ids.length < 3) throw new Error('新牌組至少需要 3 張牌。');
    const tiles = takeFromDraft(draft, ids);
    draft.board = draft.board.filter(meld => meld.length);
    draft.board.push(tiles);
  } else if (action === 'stage') {
    // takeFromDraft replaces the location arrays; capture returned tiles BEFORE pushing.
    const tiles = takeFromDraft(draft, ids);
    draft.staging.push(...tiles);
    draft.board = draft.board.filter(meld => meld.length);
  } else if (action === 'append') {
    if (!Number.isInteger(targetIndex) || !draft.board[targetIndex]) throw new Error('請先選擇要加入的桌面牌組。');
    // Keep the target by index: takeFromDraft clones every meld array.
    // Saving its old array reference would duplicate the entire meld.
    const tiles = takeFromDraft(draft, ids);
    draft.board[targetIndex].push(...tiles);
    draft.board = draft.board.filter(meld => meld.length);
  } else if (action === 'to-hand') {
    const allowed = new Set(draft.originalHandIds);
    if (chosen.some(tile => !allowed.has(tile.id))) throw new Error('桌面上原有的牌不可收進自己的牌架。');
    const tiles = takeFromDraft(draft, ids);
    draft.hand.push(...tiles);
    draft.board = draft.board.filter(meld => meld.length);
  } else {
    throw new Error('未知的排牌操作。');
  }
  return state;
}

function setEquals(left, right) {
  return left.length === right.length && left.every(value => right.includes(value));
}

export function inspectDraft(state) {
  requireHumanTurn(state);
  const { draft, players } = state;
  if (draft.staging.length) return { ok: false, error: `暫存區還有 ${draft.staging.length} 張牌沒有放回合法組合。` };
  const actual = allDraftTiles(draft);
  const before = [...players[0].hand, ...state.board.flat()];
  if (!setEquals(actual.map(tile => tile.id), before.map(tile => tile.id))) {
    return { ok: false, error: '排牌過程有重複或遺失的牌。' };
  }
  const valid = validateBoard(draft.board);
  if (!valid.ok) return valid;
  const remaining = new Set(draft.hand.map(tile => tile.id));
  const playedIds = draft.originalHandIds.filter(id => !remaining.has(id));
  if (!playedIds.length) return { ok: false, error: '本回合至少要打出一張自己的手牌。' };
  const played = new Set(playedIds);
  const onTable = new Set(draft.board.flat().map(tile => tile.id));
  if (playedIds.some(id => !onTable.has(id))) return { ok: false, error: '打出的手牌必須全部在合法牌組裡。' };
  if (!players[0].opened) {
    // During the opening, older board melds cannot be altered, split or reused.
    const originals = draft.originalBoard;
    if (draft.board.length < originals.length || originals.some((oldMeld, index) => !setEquals(oldMeld, draft.board[index].map(tile => tile.id)))) {
      return { ok: false, error: '尚未破冰，不能使用或重組桌面上的牌。' };
    }
    const newMelds = draft.board.slice(originals.length);
    if (newMelds.some(meld => meld.some(tile => !played.has(tile.id)))) {
      return { ok: false, error: '破冰只能使用自己的手牌。' };
    }
    const points = newMelds.reduce((sum, meld) => sum + analyzeMeld(meld).points, 0);
    if (points < OPENING_POINTS) return { ok: false, error: `首次出牌合計 ${points} 分，至少需要 30 分。` };
    return { ok: true, points, playedCount: playedIds.length };
  }
  return { ok: true, points: 0, playedCount: playedIds.length };
}

function finishMatch(state, winnerSeat, stalemate = false) {
  state.status = 'finished';
  state.winnerSeat = winnerSeat;
  state.draft = null;
  const penalties = state.players.map(player => handPenalty(player.hand));
  const scores = penalties.map((penalty, index) => index === winnerSeat ? 0 : (stalemate ? penalties[winnerSeat] - penalty : -penalty));
  scores[winnerSeat] = -scores.reduce((sum, value) => sum + value, 0);
  state.scores = scores;
  state.message = stalemate ? `牌池耗盡且所有玩家都無法出牌，${state.players[winnerSeat].name} 以最少扣分獲勝。` : `${state.players[winnerSeat].name} 出完手牌，獲勝！`;
}

function completeTurn(state, playerId, played) {
  if (state.players[playerId].hand.length === 0) {
    finishMatch(state, playerId);
    return;
  }
  state.passes = played ? 0 : state.passes + 1;
  if (!state.pool.length && state.passes >= state.players.length) {
    let best = 0;
    for (let index = 1; index < state.players.length; index += 1) {
      if (handPenalty(state.players[index].hand) < handPenalty(state.players[best].hand)) best = index;
    }
    finishMatch(state, best, true);
    return;
  }
  state.currentSeat = (playerId + 1) % state.players.length;
  state.round += 1;
  state.draft = state.currentSeat === 0 ? createDraft(state) : null;
}

export function commitHumanTurn(state) {
  const validation = inspectDraft(state);
  if (!validation.ok) return validation;
  state.board = state.draft.board.map(meld => [...meld]);
  state.players[0].hand = [...state.draft.hand];
  state.players[0].opened = true;
  const count = validation.playedCount;
  completeTurn(state, 0, true);
  if (state.status === 'playing') state.message = `你成功打出 ${count} 張牌。`;
  return { ok: true, playedCount: count };
}

function drawTiles(state, seat, count) {
  const drawn = state.pool.splice(0, count);
  state.players[seat].hand.push(...drawn);
  return drawn.length;
}

export function drawAndEndHumanTurn(state, penalty = false) {
  requireHumanTurn(state);
  const amount = drawTiles(state, 0, penalty ? 3 : 1);
  completeTurn(state, 0, false);
  if (state.status === 'playing') state.message = penalty
    ? `無效出牌，已還原牌桌並罰抽 ${amount} 張。`
    : amount ? '你抽取 1 張牌，回合結束。' : '牌池已空，跳過回合。';
  return amount;
}

export function resetDraft(state) {
  requireHumanTurn(state);
  state.draft = createDraft(state);
  return state;
}

/** In V0.1.0 the local AI is deterministic except for the shuffled initial deck. */
export function runAiTurn(state) {
  if (state.status !== 'playing' || !state.players[state.currentSeat].isAi) throw new Error('現在不是 AI 的回合。');
  const seat = state.currentSeat;
  const player = state.players[seat];
  const plan = planAiTurn(player.hand, state.board, player.opened);
  const ids = new Set(plan.played.map(tile => tile.id));
  if (plan.played.length && (!player.opened || validateBoard(plan.board).ok)) {
    const points = plan.board.slice(state.board.length).reduce((sum, meld) => sum + (analyzeMeld(meld)?.points || 0), 0);
    if (player.opened || points >= OPENING_POINTS) {
      state.board = plan.board;
      player.hand = player.hand.filter(tile => !ids.has(tile.id));
      player.opened = true;
      completeTurn(state, seat, true);
      if (state.status === 'playing') state.message = `${player.name} 打出了 ${ids.size} 張牌。`;
      return { playedCount: ids.size, drawn: 0 };
    }
  }
  const drawn = drawTiles(state, seat, 1);
  completeTurn(state, seat, false);
  if (state.status === 'playing') state.message = `${player.name} ${drawn ? '抽了一張牌' : '跳過回合'}。`;
  return { playedCount: 0, drawn };
}

export function isValidSavedState(value) {
  if (!value || value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.players) || value.players.length < 2 || value.players.length > 4) return false;
  if (!Array.isArray(value.pool) || !Array.isArray(value.board) || value.currentSeat < 0 || value.currentSeat >= value.players.length) return false;
  if (value.status !== 'playing' && value.status !== 'finished') return false;
  const draft = value.draft;
  if (draft && (value.currentSeat !== 0 || !Array.isArray(draft.board) || !Array.isArray(draft.hand) || !Array.isArray(draft.staging) || !Array.isArray(draft.originalHandIds) || !Array.isArray(draft.originalBoard))) return false;
  if (value.status === 'playing' && value.currentSeat === 0 && !draft) return false;
  if (value.status === 'finished' && draft) return false;
  if (!checkTileIntegrity({ pool: value.pool, players: value.players, board: value.board })) return false;
  if (draft) {
    const committedIds = new Set([...value.board.flat(), ...value.players[value.currentSeat].hand].map(tile => tile.id));
    const draftIds = [...draft.board.flat(), ...draft.hand, ...draft.staging].map(tile => tile.id);
    if (!setEquals([...committedIds], draftIds)) return false;
  }
  return true;
}

export function gameStats(state) {
  return {
    total: TILE_COUNT,
    inPool: state.pool.length,
    onTable: state.board.flat().length,
    inHands: state.players.reduce((sum, player) => sum + player.hand.length, 0)
  };
}
