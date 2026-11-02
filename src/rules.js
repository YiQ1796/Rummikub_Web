/** Pure Rummikub tile and meld rules. No DOM or network side effects. */
export const COLORS = Object.freeze(['red', 'blue', 'yellow', 'black']);
export const TILE_COUNT = 106;
export const INITIAL_HAND_SIZE = 14;
export const OPENING_POINTS = 30;

export function createDeck() {
  const tiles = [];
  for (const color of COLORS) {
    for (let number = 1; number <= 13; number += 1) {
      for (let copy = 1; copy <= 2; copy += 1) {
        tiles.push({ id: `${color}-${number}-${copy}`, color, number, joker: false });
      }
    }
  }
  tiles.push({ id: 'joker-a', color: null, number: null, joker: true });
  tiles.push({ id: 'joker-b', color: null, number: null, joker: true });
  return tiles;
}

/** A valid group has 3–4 tiles, equal numbers and mutually distinct colors. */
function analyzeGroup(tiles, regular, jokers) {
  if (tiles.length < 3 || tiles.length > 4 || !regular.length) return null;
  const number = regular[0].number;
  if (!regular.every(tile => tile.number === number)) return null;
  const usedColors = new Set(regular.map(tile => tile.color));
  if (usedColors.size !== regular.length) return null;
  const freeColors = COLORS.filter(color => !usedColors.has(color));
  if (freeColors.length < jokers.length) return null;
  const jokerValues = Object.fromEntries(jokers.map((tile, index) => [tile.id, { number, color: freeColors[index] }]));
  return { kind: 'group', points: number * tiles.length, jokerValues };
}

/** Find a 1–13 consecutive run whose length equals the complete meld. */
function analyzeRun(tiles, regular, jokers) {
  if (tiles.length < 3 || tiles.length > 13 || !regular.length) return null;
  const color = regular[0].color;
  if (!regular.every(tile => tile.color === color)) return null;
  const numbers = regular.map(tile => tile.number);
  if (new Set(numbers).size !== numbers.length) return null;
  const length = tiles.length;
  for (let start = 1; start <= 14 - length; start += 1) {
    if (!numbers.every(number => number >= start && number < start + length)) continue;
    const present = new Set(numbers);
    const missing = Array.from({ length }, (_, index) => start + index).filter(number => !present.has(number));
    if (missing.length !== jokers.length) continue;
    const jokerValues = Object.fromEntries(jokers.map((tile, index) => [tile.id, { number: missing[index], color }]));
    const points = (length * (2 * start + length - 1)) / 2;
    return { kind: 'run', points, jokerValues };
  }
  return null;
}

export function analyzeMeld(tiles) {
  if (!Array.isArray(tiles) || tiles.length < 3 || tiles.length > 13) return null;
  const ids = tiles.map(tile => tile.id);
  if (new Set(ids).size !== ids.length) return null;
  const regular = tiles.filter(tile => !tile.joker);
  const jokers = tiles.filter(tile => tile.joker);
  if (jokers.length > 2 || !regular.length) return null;
  if (!regular.every(tile => Number.isInteger(tile.number) && tile.number >= 1 && tile.number <= 13 && COLORS.includes(tile.color))) return null;
  return analyzeGroup(tiles, regular, jokers) || analyzeRun(tiles, regular, jokers);
}

export function validateBoard(board) {
  if (!Array.isArray(board)) return { ok: false, error: '牌桌資料格式不正確。' };
  for (let i = 0; i < board.length; i += 1) {
    if (!analyzeMeld(board[i])) return { ok: false, error: `第 ${i + 1} 組不是合法的群組或順組。` };
  }
  return { ok: true };
}

export function handPenalty(tiles) {
  return tiles.reduce((sum, tile) => sum + (tile.joker ? 30 : tile.number), 0);
}

/** Check that each physical tile ID appears once across all locations. */
export function checkTileIntegrity({ pool, players, board, staging = [] }) {
  const all = [...pool, ...players.flatMap(player => player.hand), ...board.flat(), ...staging];
  const ids = all.map(tile => tile.id);
  const expected = new Set(createDeck().map(tile => tile.id));
  return ids.length === TILE_COUNT && new Set(ids).size === TILE_COUNT && ids.every(id => expected.has(id));
}
