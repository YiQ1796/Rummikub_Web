import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDeck, analyzeMeld, validateBoard, handPenalty, checkTileIntegrity,
  COLORS, TILE_COUNT
} from '../src/rules.js';
const deck = createDeck();
const get = (color, number, copy = 1) => deck.find(t => t.id === `${color}-${number}-${copy}`);
const joker = deck.find(t => t.id === 'joker-a');

test('106 tiles, exactly 2 copies of 1–13 in four colors, two Jokers', () => {
  assert.equal(deck.length, TILE_COUNT);
  assert.equal(new Set(deck.map(t => t.id)).size, TILE_COUNT);
  assert.equal(deck.filter(t => t.joker).length, 2);
  for (const color of COLORS) for (let n = 1; n <= 13; n++) assert.equal(deck.filter(t => t.color === color && t.number === n).length, 2);
});

test('group needs equal numbers and distinct colors, length 3 or 4', () => {
  assert.equal(analyzeMeld([get('red',4),get('yellow',4),get('black',4)])?.kind,'group');
  assert.equal(analyzeMeld([get('red',4),get('blue',4),get('yellow',4),get('black',4)])?.points,16);
  assert.equal(analyzeMeld([get('red',4),get('red',4,2),get('black',4)]),null);
  assert.equal(analyzeMeld([get('red',4),get('blue',4)]),null);
});

test('same-color run consecutive only; no 13→1 wrap', () => {
  assert.equal(analyzeMeld([get('red',11),get('red',12),get('red',13)])?.points,36);
  assert.equal(analyzeMeld([get('red',12),get('red',13),get('red',1)]),null);
  assert.equal(analyzeMeld([get('red',5),get('blue',6),get('red',7)]),null);
});

test('Joker fills a legitimate gap and contributes the substitute value', () => {
  const run=analyzeMeld([get('yellow',5),joker,get('yellow',7)]);
  assert.equal(run?.kind,'run');
  assert.equal(run?.points,18);
  assert.deepEqual(run?.jokerValues['joker-a'],{color:'yellow',number:6});
  const group=analyzeMeld([get('red',11),get('blue',11),joker]);
  assert.equal(group?.points,33);
  assert.equal(group?.jokerValues['joker-a'].number,11);
});

test('all malformed melds are rejected', () => {
  assert.equal(validateBoard([[get('red',2),get('red',3),get('red',5)]]).ok,false);
  assert.equal(analyzeMeld([get('red',1),get('red',2),get('red',2,2)]),null);
  assert.equal(analyzeMeld([get('red',8),get('red',8),get('red',9)]),null);
  assert.equal(analyzeMeld([joker,joker,joker]),null);
});

test('hand Joker counts as 30 penalty and generated game has physical integrity', () => {
  assert.equal(handPenalty([joker,get('red',13)]),43);
  assert.ok(checkTileIntegrity({pool:deck,players:[],board:[]}));
});
