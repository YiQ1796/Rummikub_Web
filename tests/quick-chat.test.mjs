import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QUICK_TAUNTS, QUICK_EMOTES, QUICK_CHAT_COOLDOWN_MS,
  getQuickInteraction, canSendQuickInteraction
} from '../src/quick-chat.js';

test('exactly 10 unique playful taunts exist', () => {
  assert.equal(QUICK_TAUNTS.length, 10);
  assert.deepEqual(QUICK_TAUNTS.map(x => x.id), Array.from({length:10}, (_,i) => `t${String(i+1).padStart(2,'0')}`));
  assert.ok(QUICK_TAUNTS.every(x => x.kind === 'taunt' && x.text.length >= 10));
});
test('eight different tappable emotes use catalog IDs', () => {
  assert.equal(QUICK_EMOTES.length, 8);
  assert.equal(new Set([...QUICK_TAUNTS, ...QUICK_EMOTES].map(x => x.id)).size, 18);
  assert.ok(QUICK_EMOTES.every(x => x.kind === 'emote' && x.label && x.text));
});
test('incoming messages cannot inject arbitrary text', () => {
  assert.equal(getQuickInteraction('t01').kind,'taunt');
  assert.equal(getQuickInteraction('e08').kind,'emote');
  for (const id of ['', null, 123, '<script>alert(1)</script>', 't11', 'e99', '__proto__']) {
    assert.equal(getQuickInteraction(id),null);
  }
});
test('spam rate limit is independent of turn duration', () => {
  assert.equal(QUICK_CHAT_COOLDOWN_MS, 3000);
  assert.equal(canSendQuickInteraction(null,1000),true);
  assert.equal(canSendQuickInteraction(1000,2000),false);
  assert.equal(canSendQuickInteraction(1000,3999),false);
  assert.equal(canSendQuickInteraction(1000,4000),true);
  assert.equal(canSendQuickInteraction(5000,4000),false);
});
test('catalog and its display entries are immutable', () => {
  assert.equal(Object.isFrozen(QUICK_TAUNTS),true);
  assert.equal(Object.isFrozen(QUICK_EMOTES),true);
  assert.equal(Object.isFrozen(QUICK_TAUNTS[0]),true);
});
