import test from 'node:test';
import assert from 'node:assert/strict';
import { describeMatchResult, formatSignedScore } from '../src/match-result.js';
const finished = {status:'finished',round:77,winnerSeat:0,
  players:[{name:'你'},{name:'AI 1'},{name:'好友'},{name:'AI 3'}],
  scores:[124,-40,-45,-39],message:'你 出完手牌，獲勝！'};
test('solo winner and correctly ranked score table',()=>{
 const r=describeMatchResult(finished,0);
 assert.equal(r.headline,'恭喜你，獲勝！');
 assert.deepEqual(r.ranking.map(p=>p.seat),[0,3,1,2]);
 assert.equal(formatSignedScore(r.ranking[0].score),'+124 分');
});
test('remote participant sees same winner and their own designation',()=>{
 const r=describeMatchResult(finished,2);
 assert.equal(r.winnerSeat,0); assert.equal(r.youWon,false);
 assert.equal(r.headline,'你 獲勝！');
 assert.deepEqual(r.ranking.map(p=>p.isYou),[false,false,false,true]);
});
test('duplicated multiplayer snapshot does not change result identity',()=>{
 assert.equal(describeMatchResult(finished,1).key,describeMatchResult(structuredClone(finished),1).key);
});
test('another round results in a fresh announcement identity',()=>{
 assert.notEqual(describeMatchResult(finished).key,describeMatchResult({...finished,round:78}).key);
});
test('ongoing / invalid results do not open dialog',()=>{
 for(const x of [null,{...finished,status:'playing'},{...finished,scores:null},{...finished,winnerSeat:9},{...finished,scores:[1,2,3,NaN]}])assert.equal(describeMatchResult(x),null);
});
test('AI winner and signed scores',()=>{
 const r=describeMatchResult({status:'finished',round:100,winnerSeat:1,players:[{name:'房主'},{name:'AI 1'}],scores:[-8,8],message:'AI 1 獲勝'},0);
 assert.equal(r.headline,'AI 1 獲勝！'); assert.equal(formatSignedScore(-8),'-8 分');
 assert.equal(formatSignedScore(0),'0 分'); assert.deepEqual(r.ranking.map(p=>p.name),['AI 1','房主']);
});
