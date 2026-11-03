import test from 'node:test';
import assert from 'node:assert/strict';
import { describeRoomJoin } from '../src/room-join-status.js';

test('joined guest shows successful waiting-for-host state instead of a broken disabled Join', () => {
  const result=describeRoomJoin({active:true,isHost:false,connected:true,seat:1,phase:'lobby'});
  assert.equal(result.kind,'ready');
  assert.equal(result.seatLabel,'｜第 2 位玩家');
  assert.match(result.notice,/已成功加入房間/);
  assert.match(result.notice,/等待房主/);
});
test('transport pending is not described as successfully joined', () => {
  const r=describeRoomJoin({active:true,isHost:false,connected:false});
  assert.equal(r.kind,'waiting');
  assert.equal(r.canRetry,true);
  assert.match(r.notice,/尚未完成加入/);
});
test('rejected transport produces actionable warning and retry', () => {
  const r=describeRoomJoin({active:true,connected:false,lastStatus:'連線失敗：peer-unavailable'});
  assert.equal(r.kind,'problem');
  assert.match(r.notice,/重新連線/);
});
test('host gets explicit start-game guidance', () => {
  const r=describeRoomJoin({active:true,isHost:true,connected:true,phase:'lobby'});
  assert.equal(r.kind,'ready');
  assert.match(r.notice,/由你按/);
});
test('active match and no-room states are distinct', () => {
  assert.match(describeRoomJoin({active:true,connected:true,phase:'playing'}).notice,/正在參與多人對局/);
  assert.equal(describeRoomJoin({active:false}).kind,'idle');
});
