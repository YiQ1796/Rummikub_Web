/** Clear, testable distinction between connecting, joined and failed states. */
export function describeRoomJoin({ active=false, isHost=false, connected=false,
  seat=0, phase='lobby', lastStatus='' } = {}) {
  if (!active) return { kind:'idle', seatLabel:'', notice:'', canRetry:false };
  if (isHost) return {
    kind:'ready', seatLabel:'｜你是房主', canRetry:false,
    notice: phase === 'lobby'
      ? '✅ 房間已建立。好友進房後，由你按「開始多人對局（空位補 AI）」。'
      : '✅ 多人對局已開始。'
  };
  if (!connected) {
    const problem = /錯誤|失敗|無法|拒絕|上限|斷線|中斷|timeout|error/i.test(lastStatus);
    return {
      kind: problem ? 'problem' : 'waiting',
      seatLabel:'｜正在確認座位', canRetry:true,
      notice: problem
        ? `⚠️ ${lastStatus}。請按下方「重新連線」，必要時請房主保持房間頁面開啟。`
        : '⏳ 正在連線房主，尚未完成加入。若長時間沒有回應，可按「重新連線」。'
    };
  }
  return {
    kind:'ready', seatLabel:`｜第 ${seat + 1} 位玩家`, canRetry:false,
    notice: phase === 'lobby'
      ? '✅ 已成功加入房間！不用再按「加入房間」。請等待房主按「開始多人對局」，遊戲才會開始。'
      : '✅ 已連上房主，正在參與多人對局。'
  };
}
