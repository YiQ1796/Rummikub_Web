/**
 * One shared allowlist for solo UI and P2P quick interactions.
 * Only short predefined IDs are sent across the network, never arbitrary HTML.
 */
export const QUICK_CHAT_COOLDOWN_MS = 3000;
export const QUICK_TAUNTS = Object.freeze([
  Object.freeze({ id: 't01', kind: 'taunt', text: '要等多久？我的香蕉都熟透了！🍌' }),
  Object.freeze({ id: 't02', kind: 'taunt', text: '我都快睡著了，你還在想？😴' }),
  Object.freeze({ id: 't03', kind: 'taunt', text: '這是在出牌，還是在寫論文？📚' }),
  Object.freeze({ id: 't04', kind: 'taunt', text: '慢慢來，我先去泡杯茶。🍵' }),
  Object.freeze({ id: 't05', kind: 'taunt', text: '猴三毛都等到長白頭髮了！🐵' }),
  Object.freeze({ id: 't06', kind: 'taunt', text: '你這回合是不是有時差？🌍' }),
  Object.freeze({ id: 't07', kind: 'taunt', text: '不要緊張，牌又不會咬你！😏' }),
  Object.freeze({ id: 't08', kind: 'taunt', text: '你在思考人生，還是在看牌？🤔' }),
  Object.freeze({ id: 't09', kind: 'taunt', text: '我的牌都快退休了啦！🧓' }),
  Object.freeze({ id: 't10', kind: 'taunt', text: '給你三根香蕉，快點出牌！🍌' })
]);
export const QUICK_EMOTES = Object.freeze([
  Object.freeze({ id: 'e01', kind: 'emote', text: '😂', label: '笑翻' }),
  Object.freeze({ id: 'e02', kind: 'emote', text: '😴', label: '睡著' }),
  Object.freeze({ id: 'e03', kind: 'emote', text: '🤔', label: '思考' }),
  Object.freeze({ id: 'e04', kind: 'emote', text: '🙄', label: '翻白眼' }),
  Object.freeze({ id: 'e05', kind: 'emote', text: '👏', label: '鼓掌' }),
  Object.freeze({ id: 'e06', kind: 'emote', text: '😎', label: '得意' }),
  Object.freeze({ id: 'e07', kind: 'emote', text: '🍌', label: '香蕉' }),
  Object.freeze({ id: 'e08', kind: 'emote', text: '❤️', label: '愛心' })
]);
const catalog = new Map([...QUICK_TAUNTS, ...QUICK_EMOTES].map(item => [item.id, item]));
export function getQuickInteraction(id) {
  return typeof id === 'string' ? catalog.get(id) || null : null;
}
export function canSendQuickInteraction(lastSentAt, now) {
  return Number.isFinite(now) &&
    (lastSentAt == null || (Number.isFinite(lastSentAt) && now - lastSentAt >= QUICK_CHAT_COOLDOWN_MS));
}
