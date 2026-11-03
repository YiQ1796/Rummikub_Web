import test from 'node:test';
import assert from 'node:assert/strict';
import { describeRoomRoster } from '../src/room-roster.js';

test('host plus guest are prominent real seats and remaining slots display AI fallback',()=>{
  const view=describeRoomRoster({ seats:4, viewerSeat:1, members:[
    { seat:0, name:'房主', connected:true },
    { seat:1, name:'好友', connected:true }
  ]});
  assert.equal(view.ready,true);
  assert.equal(view.realPlayers,2);
  assert.equal(view.futureAi,2);
  assert.deepEqual(view.slots.map(s=>s.state),['online','online','open','open']);
  assert.equal(view.slots[0].role,'房主');
  assert.equal(view.slots[1].isYou,true);
  assert.equal(view.slots[2].status,'開局由 AI 補位');
});
test('different seat counts 2-4 never invent extra cards',()=>{
  for(const seats of [2,3,4]) {
    const view=describeRoomRoster({seats,members:[{seat:0,name:'房主',connected:true}]});
    assert.equal(view.slots.length,seats);
    assert.equal(view.futureAi,seats-1);
    assert.equal(view.slots[seats-1].seat,seats-1);
  }
});
test('disconnected guest is not counted as connected and is marked to AI-fill on start',()=>{
  const view=describeRoomRoster({seats:3,members:[
    {seat:0,name:'房主',connected:true},{seat:2,name:'離線好友',connected:false}
  ]});
  assert.equal(view.realPlayers,1);
  assert.equal(view.futureAi,2);
  assert.equal(view.slots[2].state,'offline');
  assert.match(view.slots[2].status,/開局由 AI 補位/);
});
test('no ghost seat on pending handshake or malformed room data',()=>{
  assert.equal(describeRoomRoster({seats:null,members:[]}).ready,false);
  assert.equal(describeRoomRoster({seats:5,members:[]}).ready,false);
  assert.equal(describeRoomRoster({seats:2,members:null}).ready,false);
});
test('repeated or out-of-range entries do not overwrite valid player seats',()=>{
  const view=describeRoomRoster({seats:2,viewerSeat:1,members:[
    {seat:0,name:'房主',connected:true},{seat:1,name:'好友',connected:true},
    {seat:1,name:'偽造',connected:false},{seat:3,name:'越界',connected:true}
  ]});
  assert.equal(view.realPlayers,2);
  assert.equal(view.slots[1].name,'好友');
  assert.equal(view.slots[1].isYou,true);
});
test('display model never modifies the original host roster',()=>{
  const members=[{seat:0,name:'房主',connected:true}];
  describeRoomRoster({seats:4,members});
  assert.deepEqual(members,[{seat:0,name:'房主',connected:true}]);
});
