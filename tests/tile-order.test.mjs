import test from 'node:test';
import assert from 'node:assert/strict';
import { orderMeldTiles, orderRackTiles } from '../src/tile-order.js';

const tile = (number, color = 'red', copy = 1) => ({ id: `${color}-${number}-${copy}`, number, color, joker: false });
const joker = (id = 'joker-a') => ({ id, number: null, color: null, joker: true });

test('number display fixes 4 2 3 1; does not mutate the saved hand', () => {
  const hand = [tile(4), tile(2), tile(3), tile(1)];
  const ids = hand.map(x => x.id);
  assert.deepEqual(orderRackTiles(hand).map(x => x.number), [1, 2, 3, 4]);
  assert.deepEqual(hand.map(x => x.id), ids);
});

test('color mode remains usable and a subsequent number mode still works', () => {
  const hand = [tile(4, 'red'), tile(2, 'blue'), tile(3, 'red'), tile(1, 'blue')];
  assert.deepEqual(orderRackTiles(hand, 'color').map(x => x.id), ['red-3-1', 'red-4-1', 'blue-1-1', 'blue-2-1']);
  assert.deepEqual(orderRackTiles(hand, 'number').map(x => x.number), [1, 2, 3, 4]);
});

test('valid run is displayed ascending, including Joker in its missing position', () => {
  const before = [tile(13), tile(10), joker(), tile(12)];
  assert.deepEqual(orderMeldTiles(before).map(x => x.joker ? 'J' : x.number), [10, 'J', 12, 13]);
  assert.equal(before[0].number, 13);
});

test('group with mixed colors is presented predictably', () => {
  const group = [tile(11, 'yellow'), tile(11, 'blue'), joker()];
  const result = orderMeldTiles(group);
  assert.equal(result.length, 3);
  assert.deepEqual(new Set(result.map(x => x.id)), new Set(group.map(x => x.id)));
});

test('invalid, incomplete meld still displays all physical tiles exactly once', () => {
  const tiles = [tile(4), tile(2), tile(3), tile(1)];
  assert.deepEqual(orderMeldTiles(tiles).map(x => x.number), [1, 2, 3, 4]);
});
