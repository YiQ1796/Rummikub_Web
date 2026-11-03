import test from 'node:test';
import assert from 'node:assert/strict';
import { FIXED_PLAYER_COUNT, FIXED_GAME_URL, canonicalPublicPath } from '../src/fixed-game-config.js';
import { newRoom, reserveSeat, startRoom } from '../src/online-core.js';
import { newMatch } from '../src/game.js';
import { OnlineController } from '../src/online-controller.js';
import { describeRoomRoster } from '../src/room-roster.js';

test('permanent game URL strips version and tracking only', () => {
  assert.equal(FIXED_GAME_URL, 'https://yiq1796.github.io/Rummikub_Web/');
  assert.equal(canonicalPublicPath(FIXED_GAME_URL + '?v=023&utm_source=chatgpt.com'), '/Rummikub_Web/');
  assert.equal(canonicalPublicPath(FIXED_GAME_URL + '?utm_medium=social&v=023'), '/Rummikub_Web/');
});
test('invitation room code and hash survive cleanup', () => {
  const start = FIXED_GAME_URL + '?room=590565&v=023&utm_source=chatgpt.com#join';
  assert.equal(canonicalPublicPath(start), '/Rummikub_Web/?room=590565#join');
  assert.equal(canonicalPublicPath(FIXED_GAME_URL + '?room=123456'), '/Rummikub_Web/?room=123456');
});
test('solo game always defaults to one human plus three AI', () => {
  const match = newMatch();
  assert.equal(FIXED_PLAYER_COUNT,4);
  assert.equal(match.players.length, 4);
  assert.deepEqual(match.players.map(p => p.isAi), [false,true,true,true]);
  assert.equal(match.players.every(p => p.hand.length===14),true);
});
test('online room rejects 2, 3 or 5 seats and fills unused seats with AI', () => {
  for(const seats of [2,3,5])assert.throws(() => newRoom({code:'123456',seats,hostName:'房主'}),/固定四位/);
  const room = newRoom({code:'123456',seats:FIXED_PLAYER_COUNT,hostName:'房主'});
  reserveSeat(room,'11111111111111111111111111111111','朋友一');
  startRoom(room,()=>.25);
  assert.equal(room.match.players.length,4);
  assert.deepEqual(room.match.players.map(p=>p.isAi),[false,false,true,true]);
  assert.equal(describeRoomRoster({members:room.members,seats:room.seats}).futureAi,2);
});
test('host controller itself refuses a non-four-person room', async () => {
  const controller = new OnlineController({onMatch:()=>{},onStatus:()=>{}});
  await assert.rejects(controller.host(2,'房主'),/四人房間/);
  await assert.rejects(controller.host(3,'房主'),/四人房間/);
});
test('old three-person room cannot be joined by a four-person client', () => {
  let message = '';
  const guest = new OnlineController({onMatch:()=>{},onStatus:text=>{message=text;}});
  guest.mode='guest';
  guest.code='123456';
  guest.transport={sendGuest:()=>true,close:()=>{}};
  guest.receiveGuestMessage({type:'welcome',seat:1,snapshot:{seat:1,seats:3}});
  assert.equal(guest.active,false);
  assert.match(message,/舊版非四人房間/);
});
