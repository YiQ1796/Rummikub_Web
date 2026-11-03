import test from 'node:test';
import assert from 'node:assert/strict';
import { newRoom, reserveSeat, startRoom, viewForSeat, applyGuestTurn,
  disconnectSeat, reclaimDisconnectedSeatAsAi, secureRoomCode } from '../src/online-core.js';
import { checkTileIntegrity, analyzeMeld } from '../src/rules.js';

const token1 = '11111111111111111111111111111111';
const token2 = '22222222222222222222222222222222';

function preparedRoom() {
  const room = newRoom({ code: '123456', seats: 4, hostName: '三毛' });
  reserveSeat(room, token1, '朋友甲');
  reserveSeat(room, token2, '朋友乙');
  startRoom(room, () => 0.31);
  return room;
}

test('unique room code, fixed four seats only, and sanitized names', () => {
  assert.equal(secureRoomCode(() => new Uint8Array(4).fill(1)).length, 6);
  assert.throws(() => newRoom({ code: 'abc', seats: 4 }));
  for(const seats of [2, 3, 5]) assert.throws(
    () => newRoom({ code: '123456', seats }), /固定四位/
  );
  const room = newRoom({ code: '123456', seats: 4 });
  reserveSeat(room, token1, '<script>長名字超過十六字元的玩家名稱');
  assert.ok(room.members[1].name.length <= 16 && !room.members[1].name.includes('<'));
  reserveSeat(room, token2, '好友乙');
  reserveSeat(room, '33333333333333333333333333333333', '好友丙');
  assert.throws(() => reserveSeat(room, '44444444444444444444444444444444', '房間已滿'), /房間已滿/);
});

test('1 host + 2 guests + AI fallback; reconnect keeps seat and not duplicate member', () => {
  const room = preparedRoom();
  assert.deepEqual(room.match.players.map(p => p.isAi), [false, false, false, true]);
  disconnectSeat(room, 1);
  assert.equal(reserveSeat(room, token1, '朋友甲'), 1);
  assert.equal(room.members.length, 3);
  assert.throws(() => reserveSeat(room, '33333333333333333333333333333333', '陌生人'));
  assert.ok(checkTileIntegrity(room.match));
});

test('privacy: every viewer receives only own hand, no pool order or draft', () => {
  const room = preparedRoom();
  for (const seat of [0, 1, 2]) {
    const v = viewForSeat(room, seat);
    assert.equal(v.game.players[seat].hand.length, 14);
    assert.equal(v.game.players.filter((p, i) => i !== seat).every(p => p.hand.length === 0), true);
    assert.equal(v.game.pool, undefined);
    assert.equal(v.game.draft, undefined);
    assert.ok(v.game.players.every(p => typeof p.handCount === 'number'));
  }
});

test('guest draws only on own seat, version increments and next seat progresses', () => {
  const room = preparedRoom();
  room.match.currentSeat = 1;
  room.match.draft = null;
  const revision = room.revision;
  assert.throws(() => applyGuestTurn(room, 2, { action: 'draw', revision }));
  const handCount = room.match.players[1].hand.length;
  applyGuestTurn(room, 1, { action: 'draw', revision });
  assert.equal(room.match.players[1].hand.length, handCount + 1);
  assert.equal(room.match.currentSeat, 2);
  assert.equal(room.revision, revision + 1);
  assert.ok(checkTileIntegrity(room.match));
  assert.throws(() => applyGuestTurn(room, 1, { action: 'draw', revision }));
});

test('foreign tile IDs, duplicate tiles, stale revision and malformed drafts are rejected', () => {
  const room = preparedRoom();
  room.match.currentSeat = 1;
  room.match.draft = null;
  const hand = room.match.players[1].hand.map(t => t.id);
  const board = room.match.board.map(m => m.map(t => t.id));
  const bad = ids => ({ action: 'confirm', revision: room.revision, draft: { hand: ids, board, staging: [] } });
  assert.throws(() => applyGuestTurn(room, 1, bad([...hand.slice(1), 'hacker-tile'])), /無權使用/);
  assert.throws(() => applyGuestTurn(room, 1, bad([...hand.slice(1), hand[0], hand[0]])), /重複或遺失/);
  assert.throws(() => applyGuestTurn(room, 1, { action: 'draw', revision: room.revision - 1 }), /已更新/);
  assert.ok(checkTileIntegrity(room.match));
});

test('AI can take over only a disconnected human, not an active guest', () => {
  const room = preparedRoom();
  assert.throws(() => reclaimDisconnectedSeatAsAi(room, 1), /已離線/);
  disconnectSeat(room, 1);
  reclaimDisconnectedSeatAsAi(room, 1);
  assert.equal(room.match.players[1].isAi, true);
  assert.ok(room.members.every(m => m.seat !== 1));
  assert.ok(checkTileIntegrity(room.match));
});

test('no turn deadline fields exist in projected online state', () => {
  const room = preparedRoom();
  const guest = viewForSeat(room, 2);
  assert.equal(JSON.stringify(guest).includes('deadline'), false);
  assert.equal(JSON.stringify(guest).includes('timer'), false);
});

test('guest makes a valid 30-point opening using their own tiles, host accepts', () => {
  const room = preparedRoom();
  const all = [...room.match.pool, ...room.match.players.flatMap(p => p.hand)];
  const chosenIds = ['red-10-1', 'red-11-1', 'red-12-1'];
  const chosen = chosenIds.map(id => all.find(t => t.id === id));
  const others = all.filter(t => !chosenIds.includes(t.id));
  const seat1 = [...chosen, ...others.splice(0, 11)];
  const seat0 = others.splice(0, 14);
  const seat2 = others.splice(0, 14);
  const seat3 = others.splice(0, 14);
  room.match.players[0].hand = seat0;
  room.match.players[1].hand = seat1;
  room.match.players[2].hand = seat2;
  room.match.players[3].hand = seat3;
  room.match.pool = others;
  room.match.board = [];
  room.match.currentSeat = 1;
  room.match.draft = null;
  assert.ok(checkTileIntegrity(room.match));
  assert.equal(analyzeMeld(chosen)?.points, 33);
  const before = room.revision;
  const reply = applyGuestTurn(room, 1, { revision: before, action: 'confirm', draft: {
    hand: seat1.slice(3).map(t=>t.id), staging: [], board: [chosenIds]
  }});
  assert.equal(reply.ok, true);
  assert.equal(room.match.players[1].opened, true);
  assert.equal(room.match.players[1].hand.length, 11);
  assert.equal(room.match.board[0].length, 3);
  assert.equal(room.match.currentSeat, 2);
  assert.ok(checkTileIntegrity(room.match));
});

test('disconnected guest before start is replaced with AI', () => {
  const room = newRoom({ code: '123456', seats: 4, hostName: '房主' });
  reserveSeat(room, token1, '離線者');
  disconnectSeat(room, 1);
  startRoom(room, () => 0.25);
  assert.equal(room.match.players[1].isAi, true);
  assert.equal(room.match.players.length, 4);
  assert.equal(room.match.players.filter(p => p.isAi).length, 3);
  assert.equal(room.members.length, 1);
});
