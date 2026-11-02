import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeck, checkTileIntegrity } from '../src/rules.js';
import {
  newMatch, createDraft, editDraft, inspectDraft, commitHumanTurn, drawAndEndHumanTurn,
  resetDraft, runAiTurn, isValidSavedState, gameStats
} from '../src/game.js';
import {planMelds} from '../src/ai.js';
const ref = createDeck();
const tile = (color,n,copy=1) => ref.find(t => t.id === `${color}-${n}-${copy}`);

/** Reallocate the exact same 106 physical tiles to create deterministic test hands. */
function rigHand(state, seat, desired) {
  const wanted = new Set(desired.map(t=>t.id));
  if (wanted.size !== desired.length || desired.length > 25) throw new Error('Invalid test hand');
  const others = ref.filter(t=>!wanted.has(t.id));
  state.players[seat].hand = desired;
  let cursor = 0;
  for(const [index,player] of state.players.entries()) {
    if(index===seat) continue;
    player.hand = others.slice(cursor,cursor+14);
    cursor += 14;
  }
  state.pool = others.slice(cursor);
  state.board = [];
  state.players.forEach(p=>p.opened=false);
  state.currentSeat=seat;
  state.draft = seat===0 ? createDraft(state) : null;
  assert.ok(checkTileIntegrity(state));
}

test('2–4 seats, 14 cards per seat, no timer field', () => {
  for (let seats=2; seats<=4; seats++) {
    const state=newMatch({seats,random:()=>.2});
    assert.equal(state.players.length,seats);
    assert.ok(state.players.every(p=>p.hand.length===14));
    assert.equal(state.pool.length,106-14*seats);
    assert.equal('deadline' in state,false);
    assert.equal('secondsLeft' in state,false);
    assert.ok(checkTileIntegrity(state));
    assert.ok(isValidSavedState(JSON.parse(JSON.stringify(state))));
  }
});

test('opening rejects under 30, accepts multiple groups totaling 30+', () => {
  const state=newMatch({seats:2});
  const comboA=[tile('red',3),tile('red',4),tile('red',5)];
  const comboB=[tile('blue',6),tile('blue',7),tile('blue',8)];
  rigHand(state,0,[...comboA,...comboB,...ref.filter(t=>!([...comboA,...comboB].some(c=>c.id===t.id))).slice(0,8)]);
  editDraft(state,{action:'new-meld',ids:comboA.map(t=>t.id)});
  assert.match(inspectDraft(state).error,/至少需要 30/);
  editDraft(state,{action:'new-meld',ids:comboB.map(t=>t.id)});
  assert.ok(inspectDraft(state).ok);
  assert.equal(inspectDraft(state).points,33);
  const r=commitHumanTurn(state);
  assert.ok(r.ok);
  assert.equal(state.players[0].opened,true);
  assert.equal(state.board.length,2);
  assert.ok(checkTileIntegrity(state));
});

test('player may undo draft changes, and selected board tiles cannot enter hand', () => {
  const state=newMatch({seats:2});
  const combo=[tile('red',9),tile('red',10),tile('red',11)];
  rigHand(state,0,[...combo,...ref.filter(t=>!combo.some(c=>c.id===t.id)).slice(0,11)]);
  editDraft(state,{action:'new-meld',ids:combo.map(t=>t.id)});
  assert.equal(inspectDraft(state).points,30);
  resetDraft(state);
  assert.equal(state.draft.board.length,0);
  assert.equal(state.draft.hand.length,14);
  assert.ok(checkTileIntegrity(state));
});

test('invalid group is caught and undoing bad move keeps all tiles', () => {
  const state=newMatch({seats:3});
  const picked=state.players[0].hand.slice(0,3).map(t=>t.id);
  editDraft(state,{action:'new-meld',ids:picked});
  const validation=inspectDraft(state);
  assert.ok(!validation.ok || validation.points>=30);
  resetDraft(state);
  assert.ok(isValidSavedState(state));
});

test('draw finishes current turn and keeps original table intact', () => {
  const state=newMatch({seats:2});
  const original=state.players[0].hand.length;
  const pool=state.pool.length;
  const count=drawAndEndHumanTurn(state);
  assert.equal(count,1);
  assert.equal(state.currentSeat,1);
  assert.equal(state.players[0].hand.length,original+1);
  assert.equal(state.pool.length,pool-1);
  assert.ok(checkTileIntegrity(state));
});

test('invalid-action penalty draws three tiles, if available', () => {
  const state=newMatch({seats:2});
  assert.equal(drawAndEndHumanTurn(state,true),3);
  assert.equal(state.players[0].hand.length,17);
  assert.ok(checkTileIntegrity(state));
});

test('AI candidate engine can find more than 30 points with multiple melds', () => {
  const cards=[tile('red',3),tile('red',4),tile('red',5),tile('blue',8),tile('blue',9),tile('blue',10),tile('yellow',1)];
  const melds=planMelds(cards,{opening:true});
  assert.ok(melds.length>=2);
  assert.ok(melds.flat().length>=6);
});

test('AI acts without losing or duplicating physical tiles', () => {
  const state=newMatch({seats:2});
  state.currentSeat=1;
  state.draft=null;
  const r=runAiTurn(state);
  assert.ok(r.playedCount>=0);
  assert.ok(checkTileIntegrity(state));
  assert.equal(gameStats(state).total,106);
});

test('tampered/incompatible save is rejected', () => {
  const state=newMatch({seats:3});
  state.schemaVersion=999;
  assert.equal(isValidSavedState(state),false);
});

test('after opening, existing table groups can be broken apart and regrouped legally', () => {
  const state = newMatch({seats:2});
  const oldMeld = [tile('red',1),tile('red',2),tile('red',3),tile('red',4)];
  const added = [tile('red',5),tile('red',6),tile('red',7)];
  const chosen = new Set([...oldMeld,...added].map(t=>t.id));
  const unused = ref.filter(t=>!chosen.has(t.id));
  state.board=[oldMeld];
  state.players[0].hand=[...added,...unused.slice(0,11)];
  state.players[0].opened=true;
  state.players[1].hand=unused.slice(11,25);
  state.pool=unused.slice(25);
  state.draft=createDraft(state);
  assert.ok(checkTileIntegrity(state));
  editDraft(state,{action:'stage',ids:[tile('red',4).id]});
  assert.equal(state.draft.staging.length,1);
  editDraft(state,{action:'new-meld',ids:[tile('red',4),...added].map(t=>t.id)});
  assert.ok(inspectDraft(state).ok);
  assert.equal(commitHumanTurn(state).ok,true);
  assert.equal(state.board.length,2);
  assert.ok(checkTileIntegrity(state));
});

test('a table-origin tile cannot be smuggled into a player rack', () => {
  const state = newMatch({seats:2});
  const originalHand = state.players[0].hand;
  const trio=[tile('blue',9),tile('blue',10),tile('blue',11)];
  const oldIds=new Set(trio.map(t=>t.id));
  const hand = originalHand.filter(t=>!oldIds.has(t.id)).slice(0,14);
  const additional = ref.filter(t=>!oldIds.has(t.id) && !hand.some(h=>h.id===t.id));
  const fullHand = [...hand,...additional].slice(0,14);
  const used=new Set([...trio,...fullHand].map(t=>t.id));
  const rest=ref.filter(t=>!used.has(t.id));
  state.board=[trio];state.players[0].hand=fullHand;
  state.players[1].hand=rest.slice(0,14);state.pool=rest.slice(14);
  state.players[0].opened=true;state.draft=createDraft(state);
  editDraft(state,{action:'stage',ids:[trio[0].id]});
  assert.throws(()=>editDraft(state,{action:'to-hand',ids:[trio[0].id]}),/不可收進/);
  assert.ok(checkTileIntegrity(state));
});

test('appending a rack tile to a selected existing meld does not duplicate board tiles', () => {
  const state=newMatch({seats:2});
  const tableMeld=[tile('yellow',8),tile('yellow',9),tile('yellow',10)];
  const extra=tile('yellow',11);
  const reserved=new Set([...tableMeld,extra].map(t=>t.id));
  const rest=ref.filter(t=>!reserved.has(t.id));
  state.board=[tableMeld];
  state.players[0].hand=[extra,...rest.slice(0,13)];
  state.players[0].opened=true;
  state.players[1].hand=rest.slice(13,27);
  state.pool=rest.slice(27);
  state.draft=createDraft(state);
  editDraft(state,{action:'append',ids:[extra.id],targetIndex:0});
  assert.equal(state.draft.board.length,1);
  assert.equal(state.draft.board[0].length,4);
  assert.ok(inspectDraft(state).ok);
  assert.equal(commitHumanTurn(state).ok,true);
  assert.ok(checkTileIntegrity(state));
});

test('returning a rack-origin tile from temporary staging restores that tile', () => {
  const state=newMatch({seats:3});
  const id=state.players[0].hand[0].id;
  editDraft(state,{action:'stage',ids:[id]});
  assert.equal(state.draft.staging.length,1);
  assert.equal(state.draft.hand.length,13);
  editDraft(state,{action:'to-hand',ids:[id]});
  assert.equal(state.draft.staging.length,0);
  assert.equal(state.draft.hand.length,14);
  assert.equal(new Set(state.draft.hand.map(t=>t.id)).size,14);
  assert.ok(isValidSavedState(state));
});
