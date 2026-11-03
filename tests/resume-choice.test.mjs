import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseResumeCandidate, describeResumeCandidate } from '../src/resume-choice.js';

const solo = { players: [{},{},{},{}], status: 'playing', round: 14 };
const host = { code: '123456', phase: 'playing' };
const guest = { code: '987654', name: '好友', seat: 2 };

test('first visit with no save has no resume prompt', () => {
  assert.equal(chooseResumeCandidate(), null);
  assert.equal(describeResumeCandidate(null), '');
});

test('solo saved state is offered rather than automatically activated', () => {
  const candidate = chooseResumeCandidate({solo});
  assert.equal(candidate.type, 'solo');
  assert.equal(candidate.round,14);
  assert.match(describeResumeCandidate(candidate), /單機四人對局/);
});

test('host multiplayer state takes priority over an older solo save', () => {
  const candidate=chooseResumeCandidate({solo,host});
  assert.equal(candidate.type,'host');
  assert.match(describeResumeCandidate(candidate),/123456/);
  assert.match(describeResumeCandidate(candidate),/重新連線/);
});

test('guest saved room is offered on root URL or matching invite',()=>{
  assert.deepEqual(chooseResumeCandidate({guest}),{type:'guest',...guest});
  assert.equal(chooseResumeCandidate({guest,host,incomingRoom:'987654'}).type,'guest');
  assert.match(describeResumeCandidate({type:'guest',...guest}),/第 3 位玩家/);
});

test('guest with older room is not silently joined when there is a new invitation',()=>{
  const result=chooseResumeCandidate({solo,guest,incomingRoom:'111111'});
  assert.equal(result.type,'guest');
  assert.equal(result.code,'987654');
});

test('legacy saved two- or three-seat game is not offered as the latest four-person match',()=>{
  for(const seats of [2,3,5]){
    assert.equal(chooseResumeCandidate({solo:{players:Array.from({length:seats},()=>({})),status:'playing'}}),null);
  }
});

test('completed game may still be viewed by choosing Restore',()=>{
  const result=chooseResumeCandidate({solo:{...solo,status:'finished'}});
  assert.match(describeResumeCandidate(result),/已結束/);
});
