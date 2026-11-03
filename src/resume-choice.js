/** Startup decision helpers: never mutate saved games or start a connection. */
export function chooseResumeCandidate({ solo = null, host = null, guest = null, incomingRoom = '' } = {}) {
  if (guest?.code && guest.code === incomingRoom) {
    return { type: 'guest', ...guest };
  }
  // A host's state is authoritative for the whole multiplayer room.
  if (host?.code) return { type: 'host', ...host };
  if (guest?.code) return { type: 'guest', ...guest };
  if (solo?.players?.length === 4) {
    return { type: 'solo', phase: solo.status, round: solo.round };
  }
  return null;
}
export function describeResumeCandidate(candidate) {
  if (!candidate) return '';
  if (candidate.type === 'host') {
    return `上一局是你建立的多人房間（房號 ${candidate.code}），${candidate.phase === 'playing' ? '牌局尚未結束' : candidate.phase === 'finished' ? '本局已結束' : '仍在等待玩家'}。恢復時會重新開啟房間，好友需要重新連線。`;
  }
  if (candidate.type === 'guest') {
    return `上次加入的多人房間：${candidate.code}（第 ${candidate.seat + 1} 位玩家）。恢復後會使用原座位識別碼重新連接房主；房主必須仍在線。`;
  }
  return `上一局是單機四人對局（第 ${candidate.round || 1} 回合，${candidate.phase === 'finished' ? '已結束' : '進行中'}）。`;
}
