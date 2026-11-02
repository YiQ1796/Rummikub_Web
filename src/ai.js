import { analyzeMeld } from './rules.js';

/** Enumerates short legal melds with bounded work (including joker usage). */
export function findCandidateMelds(hand, maxCandidates = 600) {
  const candidates = [];
  const tiles = hand.slice(0, 28); // Bound combinations for unusually long racks.
  let examined = 0;
  // Every 3–5 tile combination is considered. Longer runs can be extended later.
  for (let length = 3; length <= Math.min(5, tiles.length); length += 1) {
    const indexes = Array.from({ length }, (_, index) => index);
    while (true) {
      examined += 1;
      if (examined > 75000) break;
      const pick = indexes.map(index => tiles[index]);
      const analysis = analyzeMeld(pick);
      if (analysis) candidates.push({ tiles: pick, points: analysis.points, key: pick.map(t => t.id).sort().join('|') });
      let index = length - 1;
      while (index >= 0 && indexes[index] === tiles.length - length + index) index -= 1;
      if (index < 0) break;
      indexes[index] += 1;
      for (let j = index + 1; j < length; j += 1) indexes[j] = indexes[j - 1] + 1;
      // Guard late-game exponential combinations; AI may be suboptimal.
      if (candidates.length > maxCandidates * 5) break;
    }
    if (examined > 75000) break;
  }
  const unique = new Map(candidates.map(candidate => [candidate.key, candidate]));
  return [...unique.values()]
    .sort((a, b) => b.tiles.length - a.tiles.length || b.points - a.points)
    .slice(0, maxCandidates);
}

/** Bounded beam search over disjoint candidate melds; stable and testable. */
export function planMelds(hand, { opening = false } = {}) {
  const candidates = findCandidateMelds(hand);
  let beam = [{ melds: [], used: new Set(), points: 0, count: 0 }];
  let best = null;
  for (let depth = 0; depth < 5; depth += 1) {
    const next = [];
    for (const state of beam) {
      for (const candidate of candidates) {
        if (candidate.tiles.some(tile => state.used.has(tile.id))) continue;
        const used = new Set(state.used);
        candidate.tiles.forEach(tile => used.add(tile.id));
        const newState = {
          melds: [...state.melds, candidate.tiles], used,
          count: state.count + candidate.tiles.length,
          points: state.points + candidate.points
        };
        next.push(newState);
        if ((!opening || newState.points >= 30) && (!best || newState.count > best.count || (newState.count === best.count && newState.points > best.points))) best = newState;
      }
    }
    if (!next.length) break;
    next.sort((a, b) => b.count * 100 + b.points - (a.count * 100 + a.points));
    beam = next.slice(0, 36);
  }
  return best ? best.melds : [];
}

/** AI intentionally avoids taking apart existing table groups in V0.1.0. */
export function planAiTurn(hand, existingBoard, opened) {
  if (!opened) {
    const melds = planMelds(hand, { opening: true });
    return { melds, board: [...existingBoard.map(meld => [...meld]), ...melds], played: melds.flat() };
  }
  let remaining = [...hand];
  const board = existingBoard.map(meld => [...meld]);
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (let i = 0; i < remaining.length && !progressed; i += 1) {
      for (const meld of board) {
        if (analyzeMeld([...meld, remaining[i]])) {
          meld.push(remaining[i]);
          remaining.splice(i, 1);
          progressed = true;
          break;
        }
      }
    }
  }
  const newMelds = planMelds(remaining);
  board.push(...newMelds);
  const newIds = new Set(newMelds.flat().map(tile => tile.id));
  const played = [...hand].filter(tile => newIds.has(tile.id) || !remaining.some(t => t.id === tile.id));
  return { melds: newMelds, board, played };
}
