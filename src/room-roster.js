import { FIXED_PLAYER_COUNT } from './fixed-game-config.js';

/** Build a display-only seat list from the trusted room roster (never modifies room state). */
export function describeRoomRoster({ members = [], seats, viewerSeat = 0 } = {}) {
  if (seats !== FIXED_PLAYER_COUNT || !Array.isArray(members)) {
    return { ready: false, slots: [], realPlayers: 0, futureAi: 0, capacity: 0 };
  }
  const memberBySeat = new Map();
  for (const member of members) {
    if (!Number.isInteger(member?.seat) || member.seat < 0 || member.seat >= seats
        || memberBySeat.has(member.seat)) continue;
    memberBySeat.set(member.seat, member);
  }
  const slots = Array.from({ length: seats }, (_, seat) => {
    const member = memberBySeat.get(seat);
    const isHost = seat === 0;
    const isYou = Boolean(member && seat === viewerSeat);
    if (!member) {
      return {
        seat, role: '等待加入', name: '等待玩家加入', state: 'open',
        status: '開局由 AI 補位', isHost: false, isYou: false
      };
    }
    const connected = member.connected === true;
    return {
      seat,
      role: isHost ? '房主' : '真人玩家',
      name: String(member.name || `玩家 ${seat + 1}`),
      state: connected ? 'online' : 'offline',
      status: connected ? '已連線' : '已離線 · 開局由 AI 補位',
      isHost, isYou
    };
  });
  const realPlayers = slots.filter(slot => slot.state === 'online').length;
  return { ready: true, slots, capacity: seats, realPlayers, futureAi: seats - realPlayers };
}
