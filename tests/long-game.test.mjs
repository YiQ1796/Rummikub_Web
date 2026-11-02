import test from 'node:test';
import assert from 'node:assert/strict';
import { newMatch, runAiTurn } from '../src/game.js';
import { checkTileIntegrity, validateBoard } from '../src/rules.js';

test('AI regression: 10 complete 4-player matches maintain tile integrity and legal table', () => {
  for (let game = 0; game < 10; game += 1) {
    const state = newMatch({seats:4});
    state.players[0].isAi = true; // Automated QA only: fill human seat with AI.
    state.draft = null;
    let turns = 0;
    while (state.status === 'playing' && turns < 500) {
      runAiTurn(state);
      assert.ok(checkTileIntegrity(state),`Game ${game}, turn ${turns}`);
      assert.ok(validateBoard(state.board).ok,`Game ${game}, turn ${turns}`);
      turns += 1;
    }
    assert.equal(state.status,'finished',`Game ${game} did not finish`);
    assert.ok(turns < 500);
    assert.equal(state.scores.reduce((a,b)=>a+b,0),0);
  }
});
