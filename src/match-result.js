/** Display-only game results, derived from the host-validated match state. */
export function describeMatchResult(state, viewerSeat = 0) {
  if (state?.status !== 'finished' || !Array.isArray(state.players)
      || !Number.isInteger(state.winnerSeat) || !Array.isArray(state.scores)
      || state.winnerSeat < 0 || state.winnerSeat >= state.players.length
      || state.scores.length !== state.players.length
      || !state.scores.every(Number.isFinite)) return null;

  const winnerSeat = state.winnerSeat;
  const winnerName = String(state.players[winnerSeat]?.name || `玩家 ${winnerSeat + 1}`);
  const youWon = winnerSeat === viewerSeat;
  const ranking = state.players.map((player, seat) => ({
    seat, name: String(player.name || `玩家 ${seat + 1}`),
    score: state.scores[seat], isWinner: seat === winnerSeat, isYou: seat === viewerSeat
  })).sort((a, b) => Number(b.isWinner) - Number(a.isWinner) || b.score - a.score || a.seat - b.seat);

  const key = JSON.stringify([state.round, winnerSeat, state.players.map(p => p.name), state.scores]);
  return {key, winnerSeat, winnerName, youWon, ranking,
    headline: youWon ? '恭喜你，獲勝！' : `${winnerName} 獲勝！`,
    detail: String(state.message || `${winnerName} 贏得這一局。`)};
}

export function formatSignedScore(score) {
  return `${score > 0 ? '+' : ''}${score} 分`;
}
