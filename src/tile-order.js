/** Presentation-only ordering. Never mutates the authoritative game state. */
import { COLORS, analyzeMeld } from './rules.js';

function colorRank(color) {
  const rank = COLORS.indexOf(color);
  return rank < 0 ? COLORS.length : rank;
}

function compareTiles(a, b, numberOf, colorOf) {
  return numberOf(a) - numberOf(b)
    || colorRank(colorOf(a)) - colorRank(colorOf(b))
    || a.id.localeCompare(b.id);
}

/** Number first is the default even after draws, reloads and draft edits. */
export function orderRackTiles(tiles, mode = 'number') {
  const sorted = [...tiles];
  if (mode === 'color') {
    return sorted.sort((a, b) => colorRank(a.color) - colorRank(b.color)
      || (a.number ?? 99) - (b.number ?? 99)
      || a.id.localeCompare(b.id));
  }
  return sorted.sort((a, b) => compareTiles(
    a, b, tile => tile.number ?? 99, tile => tile.color
  ));
}

/** A Joker in a valid run is displayed at its inferred numeric position. */
export function orderMeldTiles(tiles) {
  const analysis = analyzeMeld(tiles);
  const valueOf = tile => tile.joker ? analysis?.jokerValues[tile.id] : tile;
  return [...tiles].sort((a, b) => compareTiles(
    a, b,
    tile => valueOf(tile)?.number ?? 99,
    tile => valueOf(tile)?.color
  ));
}
