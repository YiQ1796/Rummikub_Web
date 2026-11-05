import { analyzeMeld, checkTileIntegrity } from './rules.js';
import { orderMeldTiles, orderRackTiles } from './tile-order.js';
import { describeMatchResult, formatSignedScore } from './match-result.js';
import { OnlineController } from './online-controller.js';
import { validRoomCode } from './online-core.js';
import { describeRoomJoin } from './room-join-status.js';
import { describeRoomRoster } from './room-roster.js';
import { FIXED_PLAYER_COUNT, canonicalPublicPath } from './fixed-game-config.js';
import { chooseResumeCandidate, describeResumeCandidate } from './resume-choice.js';
import { QUICK_TAUNTS, QUICK_EMOTES, getQuickInteraction,
  canSendQuickInteraction } from './quick-chat.js';
import {
  newMatch, editDraft, inspectDraft, commitHumanTurn,
  drawAndEndHumanTurn, resetDraft, runAiTurn, SAVE_KEY,
  isValidSavedState, gameStats
} from './game.js';

const $ = id => document.getElementById(id);
let match = null;
const selected = new Set();
let targetMeld = null;
let pendingAi = false;
const labels = { red: '紅', blue: '藍', yellow: '黃', black: '黑' };
let rackSortMode = 'number';
let lastAnnouncedResult = null;
let startupCandidate = null;
let savedSoloCandidate = null;
let startupBusy = false;
const activeBubbles = new Map();
const recentInteractions = [];
let soloLastInteractionAt = null;
// Keep one permanent public game URL. Room invite links retain ?room=123456.
const incomingRoom = new URLSearchParams(window.location.search).get('room');
const canonicalPath = canonicalPublicPath(window.location.href);
const visiblePath = window.location.pathname + window.location.search + window.location.hash;
if (canonicalPath !== visiblePath) {
  window.history.replaceState(window.history.state, '', canonicalPath);
}
const online = new OnlineController({
  onMatch(next) {
    if (!match && next) resetQuickInteractions();
    match = next;
    selected.clear();
    targetMeld = null;
    render();
    scheduleAi();
  },
  onStatus(message) { updateOnlineStatus(message); renderOnlineRoom(); },
  onInteraction(message) { showQuickInteraction(message); }
});

function readPreviousSolo() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const previous = JSON.parse(raw);
    return previous?.players?.length === FIXED_PLAYER_COUNT && isValidSavedState(previous)
      ? previous : null;
  } catch { return null; }
}

/** The previous game remains dormant until one of the two buttons is pressed. */
function showResumeDecision(candidate) {
  startupCandidate = candidate;
  $('resume-description').textContent = describeResumeCandidate(candidate);
  $('resume-error').classList.add('hidden');
  $('resume-overlay').classList.remove('hidden');
  $('resume-overlay').setAttribute('aria-hidden', 'false');
  document.body.classList.add('resume-modal-open');
  $('resume-previous').disabled = false;
  $('resume-new').disabled = false;
  $('resume-dialog').focus();
}
function closeResumeDecision() {
  $('resume-overlay').classList.add('hidden');
  $('resume-overlay').setAttribute('aria-hidden', 'true');
  document.body.classList.remove('resume-modal-open');
  startupCandidate = null;
}
async function restoreOnDemand() {
  if (!startupCandidate || startupBusy) return;
  startupBusy = true;
  $('resume-previous').disabled = true;
  $('resume-new').disabled = true;
  const candidate = startupCandidate;
  try {
    if (candidate.type === 'solo') {
      if (!savedSoloCandidate || !isValidSavedState(savedSoloCandidate))
        throw new Error('上一局存檔已損毀，請開始新局。');
      match = savedSoloCandidate;
      rackSortMode = 'number';
      closeResumeDecision();
      render();
      scheduleAi();
    } else if (candidate.type === 'host') {
      // No networking happens until the room owner explicitly clicks Restore.
      if (!(await online.restoreHost()))
        throw new Error('無法恢復原本的房間。請確認房主舊分頁已關閉，再按「恢復上一局」重試；或選擇開始新局。');
      window.history.replaceState(window.history.state, '', window.location.pathname);
      closeResumeDecision();
      render();
      scheduleAi();
    } else if (candidate.type === 'guest') {
      $('online-name').value = candidate.name;
      await online.join(candidate.code, candidate.name);
      window.history.replaceState(window.history.state, '', `${window.location.pathname}?room=${candidate.code}`);
      closeResumeDecision();
      render();
    }
  } catch (error) {
    const warning = $('resume-error');
    warning.textContent = error.message || '無法恢復上一局，請重新嘗試。';
    warning.classList.remove('hidden');
  } finally {
    startupBusy = false;
    if (startupCandidate) {
      $('resume-previous').disabled = false;
      $('resume-new').disabled = false;
    }
  }
}

function discardPreviousAndStartNew() {
  if (startupBusy) return;
  try { localStorage.removeItem(SAVE_KEY); } catch { /* Storage may be unavailable. */ }
  online.discardStoredSessions();
  savedSoloCandidate = null;
  match = null;
  resetQuickInteractions();
  selected.clear();
  targetMeld = null;
  rackSortMode = 'number';
  // Opening an old invitation must not silently reconnect after New Game.
  $('join-code').value = '';
  window.history.replaceState(window.history.state, '', window.location.pathname);
  closeResumeDecision();
  render();
  $('start-game').focus();
}

$('resume-previous').addEventListener('click', restoreOnDemand);
$('resume-new').addEventListener('click', discardPreviousAndStartNew);

/** Reactions only affect transient presentation; never modify the game or timer. */
function resetQuickInteractions() {
  activeBubbles.clear();
  recentInteractions.length = 0;
  soloLastInteractionAt = null;
  renderQuickFeed();
}
function renderQuickFeed() {
  const list = $('quick-chat-feed');
  list.replaceChildren(...recentInteractions.slice(-3).reverse().map(entry => {
    const item = document.createElement('li');
    item.textContent = `${entry.name}：${entry.text}`;
    return item;
  }));
}
function showQuickInteraction({ seat, id }) {
  const interaction = getQuickInteraction(id);
  if (!match || !interaction || !Number.isInteger(seat) || seat < 0 ||
      seat >= match.players.length) return;
  const entry = { id, text: interaction.text, name: match.players[seat].name,
    expiresAt: Date.now() + 5700 };
  activeBubbles.set(seat, entry);
  recentInteractions.push(entry);
  if (recentInteractions.length > 3) recentInteractions.shift();
  renderPlayers();
  renderQuickFeed();
  // The cleanup is cosmetic; it is not a countdown or a player turn limit.
  setTimeout(() => {
    if (activeBubbles.get(seat) === entry) {
      activeBubbles.delete(seat);
      if (match) renderPlayers();
    }
  }, 5700);
}
function setQuickFeedback(message) {
  $('quick-chat-feedback').textContent = message;
}
function sendQuickInteraction(id) {
  const interaction = getQuickInteraction(id);
  if (!match || match.status !== 'playing' || !interaction) return;
  try {
    if (online.active) {
      online.sendReaction(id);
    } else {
      const now = Date.now();
      if (!canSendQuickInteraction(soloLastInteractionAt, now))
        throw new Error('太快啦！請稍等 3 秒再發送。');
      soloLastInteractionAt = now;
      showQuickInteraction({ seat: 0, id });
      // A solo AI reacts to make quick chat useful even without friends online.
      const aiSeat = match.players.findIndex((player, seat) => seat !== 0 && player.isAi);
      const currentMatch = match;
      if (aiSeat >= 0) {
        const replies = ['e01', 'e03', 'e04', 'e05', 'e06'];
        const reply = replies[Math.floor(Math.random() * replies.length)];
        setTimeout(() => {
          if (match === currentMatch && !online.active && match.status === 'playing')
            showQuickInteraction({ seat: aiSeat, id: reply });
        }, 850);
      }
    }
    setQuickFeedback(`已送出：${interaction.text}`);
  } catch (error) {
    setQuickFeedback(error.message || '發送失敗，請重新連線再試。');
  }
}
function renderQuickOptions() {
  const makeButton = (item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = item.kind === 'emote' ? 'quick-emote' : 'quick-taunt';
    button.textContent = item.text;
    button.title = item.kind === 'emote' ? item.label : item.text;
    button.setAttribute('aria-label', `發送${item.kind === 'emote' ? '表情' : '嘲諷'}：${item.label || item.text}`);
    button.addEventListener('click', () => sendQuickInteraction(item.id));
    return button;
  };
  $('quick-emotes').replaceChildren(...QUICK_EMOTES.map(makeButton));
  $('quick-taunts').replaceChildren(...QUICK_TAUNTS.map(makeButton));
}
renderQuickOptions();

function updateOnlineStatus(message) {
  const status = $('online-status');
  if (status) status.textContent = message;
  const gameStatus = $('online-game-status');
  if (gameStatus) gameStatus.textContent = message;
}

function createRosterElement(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

/** Render each seat explicitly: host, connected guest, or waiting/AI fallback. */
function renderRoomRoster() {
  const seats = online.isHost ? online.room?.seats : online.view?.seats;
  const roster = describeRoomRoster({
    members: online.members,
    seats,
    viewerSeat: online.seat
  });
  const count = $('room-player-count');
  const hint = $('room-ai-hint');
  const list = $('room-members');
  if (!roster.ready) {
    count.textContent = '正在載入座位';
    hint.textContent = '正在向房主取得玩家名單。';
    list.replaceChildren();
    return;
  }
  count.textContent = `${roster.realPlayers} / ${roster.capacity} 位真人已連線`;
  hint.textContent = roster.futureAi
    ? `還有 ${roster.futureAi} 個位置可邀請好友；現在開局會自動補上 ${roster.futureAi} 位 AI。`
    : '真人已全數到齊，可以開始對局。';
  list.replaceChildren(...roster.slots.map(slot => {
    const card = document.createElement('li');
    card.className = `room-player-card ${slot.state}${slot.isHost ? ' host' : ''}${slot.isYou ? ' mine' : ''}`;
    const avatar = createRosterElement('span', 'room-player-avatar',
      slot.isHost ? '主' : slot.state === 'open' ? '＋' : slot.state === 'offline' ? '離' : '友');
    avatar.setAttribute('aria-hidden', 'true');
    const info = document.createElement('div');
    info.className = 'room-player-info';
    const seatNumber = createRosterElement('span', 'room-seat-number',
      `座位 ${String(slot.seat + 1).padStart(2, '0')} · ${slot.role}${slot.isYou ? ' · 你' : ''}`);
    const name = createRosterElement('strong', 'room-player-name', slot.name);
    info.append(seatNumber, name);
    const status = createRosterElement('span', 'room-player-status', slot.status);
    card.append(avatar, info, status);
    return card;
  }));
}

function renderOnlineRoom() {
  const hasRoom = online.active;
  const summary = $('room-summary');
  summary.classList.toggle('hidden', !hasRoom);
  // After joining, hide the original entry controls; a greyed-out Join button
  // looked like a failure even when the guest had already been assigned a seat.
  $('create-room').classList.toggle('hidden', hasRoom);
  $('join-room').classList.toggle('hidden', hasRoom);
  $('join-code').closest('.room-code-input').classList.toggle('hidden', hasRoom);
  $('start-game').disabled = hasRoom;
  if (!hasRoom) return;
  const phase = online.isHost ? online.room?.phase : online.view?.phase;
  const display = describeRoomJoin({
    active:hasRoom, isHost:online.isHost, connected:online.connected,
    seat:online.seat, phase, lastStatus:online.lastStatus
  });
  $('room-code').textContent = online.code;
  $('room-seat-label').textContent = display.seatLabel;
  const status = $('room-join-state');
  status.textContent = display.notice;
  status.className = `room-join-state ${display.kind}`;
  renderRoomRoster();
  $('host-start').classList.toggle('hidden', !online.isHost || online.room?.phase !== 'lobby');
  $('room-reconnect').classList.toggle('hidden', !display.canRetry);
}

async function copyInvite() {
  if (!online.active) return;
  const link = online.inviteUrl();
  try {
    await navigator.clipboard.writeText(link);
    updateOnlineStatus('已複製邀請網址，可以傳給朋友。');
  } catch {
    window.prompt('複製下面的邀請網址', link);
  }
}


function save() {
  try {
    if (online.isHost) online.persistHost();
    else if (!online.active && match) localStorage.setItem(SAVE_KEY, JSON.stringify(match));
  } catch (error) {
    showError('瀏覽器無法保存進度，重新整理後可能會遺失此局。');
  }
}

function showError(message) {
  const status = $('game-message');
  status.textContent = message;
  status.classList.add('error');
}

function withAction(operation, publishTurn = false) {
  try {
    operation();
    selected.clear();
    targetMeld = null;
    $('game-message').classList.remove('error');
    save();
    if (publishTurn && online.isHost && online.room?.phase === 'playing') online.announceLocalTurn();
    render();
    scheduleAi();
  } catch (error) {
    showError(error.message || '操作失敗，請重新嘗試。');
  }
}

function makeTile(tile, location) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `tile ${tile.joker ? 'joker' : tile.color} ${selected.has(tile.id) ? 'selected' : ''}`;
  button.dataset.tileId = tile.id;
  button.setAttribute('aria-pressed', String(selected.has(tile.id)));
  const descriptor = tile.joker ? `猴三毛鬼牌 ${tile.id.endsWith('a') ? 'A' : 'B'}` : `${labels[tile.color]}色 ${tile.number}`;
  button.setAttribute('aria-label', `${descriptor}，位於${location}`);

  if (tile.joker) {
    const slot = tile.id === 'joker-a' ? 'jokerA' : 'jokerB';
    const source = window.SANMAO_RUMMIKUB_ART?.[slot];
    if (source) {
      const img = document.createElement('img');
      img.className = 'joker-art';
      img.src = source;
      img.alt = '猴三毛頭像';
      img.onerror = () => { img.replaceWith(makeJokerPlaceholder()); };
      button.append(img);
    } else {
      button.append(makeJokerPlaceholder());
    }
    const legend = document.createElement('span');
    legend.className = 'tile-joker-label';
    legend.textContent = 'JOKER';
    button.append(legend);
  } else {
    const numeral = document.createElement('span');
    numeral.className = 'tile-number';
    numeral.textContent = tile.number;
    button.append(numeral);
  }
  button.addEventListener('click', () => {
    if (!match || match.currentSeat !== online.seat || match.status !== 'playing' || (online.active && (!online.connected || online.pending))) return;
    selected.has(tile.id) ? selected.delete(tile.id) : selected.add(tile.id);
    render();
  });
  return button;
}

function makeJokerPlaceholder() {
  const span = document.createElement('span');
  span.className = 'joker-placeholder';
  span.textContent = '三毛';
  return span;
}

function renderMeld(meld, index) {
  const container = document.createElement('div');
  container.className = `meld ${targetMeld === index ? 'target' : ''}`;
  const head = document.createElement('div');
  head.className = 'meld-head';
  const title = document.createElement('span');
  const analysis = analyzeMeld(meld);
  title.textContent = `組合 ${index + 1} · ${analysis ? (analysis.kind === 'run' ? '順組' : '群組') : '待整理'}`;
  if (!analysis) title.classList.add('invalid');
  const target = document.createElement('button');
  target.type = 'button';
  target.className = 'target-button';
  target.textContent = targetMeld === index ? '已指定' : '指定為目標';
  target.setAttribute('aria-pressed', String(targetMeld === index));
  target.addEventListener('click', () => { targetMeld = index; render(); });
  head.append(title, target);
  container.append(head);
  const tiles = document.createElement('div');
  tiles.className = 'tile-strip';
  orderMeldTiles(meld).forEach(tile => tiles.append(makeTile(tile, `牌桌第 ${index + 1} 組`)));
  container.append(tiles);
  return container;
}

/* The dialog is a view of the final score, never an additional game-state write. */
function showResultDialog(result) {
  $('result-title').textContent = result.headline;
  $('result-detail').textContent = result.detail;
  $('result-scores').replaceChildren(...result.ranking.map(entry => {
    const item = document.createElement('li');
    item.className = `result-score-row${entry.isWinner ? ' result-score-winner' : ''}`;
    const name = document.createElement('span');
    name.textContent = `${entry.isWinner ? '🏆 ' : ''}${entry.name}${entry.isYou ? '（你）' : ''}`;
    const points = document.createElement('strong');
    points.textContent = formatSignedScore(entry.score);
    item.append(name, points);
    return item;
  }));
  $('result-new-game').textContent = online.active ? '離開房間' : '重新開局';
  $('result-overlay').classList.remove('hidden');
  document.body.classList.add('result-modal-open');
  $('result-dialog').focus();
}
function hideResultDialog() {
  $('result-overlay').classList.add('hidden');
  document.body.classList.remove('result-modal-open');
}
function renderMatchResult() {
  const result = describeMatchResult(match, online.seat);
  $('result-banner').classList.toggle('hidden', !result);
  if (!result) {
    lastAnnouncedResult = null;
    hideResultDialog();
    return;
  }
  $('result-banner-text').textContent = `🏆 ${result.headline} 點選查看完整分數`;
  const key = `${online.active ? online.code : 'solo'}:${result.key}`;
  if (lastAnnouncedResult !== key) {
    lastAnnouncedResult = key;
    showResultDialog(result);
  }
}
function renderPlayers() {
  const players = $('players');
  players.replaceChildren();
  match.players.forEach((player, index) => {
    const box = document.createElement('div');
    box.className = `player-card ${match.currentSeat === index ? 'current' : ''}`;
    const title = document.createElement('strong');
    title.textContent = `${player.isAi ? '▣' : '♟'} ${player.name}`;
    const count = document.createElement('span');
    const onlineMember = online.members.find(item => item.seat === index);
    count.textContent = `${player.handCount ?? player.hand.length} 張${player.opened ? ' · 已破冰' : ' · 未破冰'}${onlineMember && !onlineMember.connected ? ' · 離線' : ''}`;
    box.append(title, count);
    const bubble = activeBubbles.get(index);
    if (bubble && bubble.expiresAt > Date.now()) {
      const message = document.createElement('span');
      message.className = 'player-quick-bubble';
      message.textContent = bubble.text;
      box.append(message);
    }
    players.append(box);
  });
}

function render() {
  renderOnlineRoom();
  $('lobby').classList.toggle('hidden', Boolean(match));
  $('game').classList.toggle('hidden', !match);
  if (!match) { renderMatchResult(); return; }
  $('online-game-bar').classList.toggle('hidden', !online.active);
  if (online.active) $('online-room-label').textContent = `房間 ${online.code} ｜座位 ${online.seat + 1}`;
  $('new-game').textContent = online.active ? '離開房間' : '重新開局';
  renderPlayers();
  // Quick interactions remain available while another player is thinking.
  const canChat = match.status === 'playing' && (!online.active || online.connected);
  for (const button of $('quick-emotes').children) button.disabled = !canChat;
  for (const button of $('quick-taunts').children) button.disabled = !canChat;
  const stats = gameStats(match);
  $('pool-count').textContent = String(match.poolCount ?? stats.inPool);
  $('table-count').textContent = String(stats.onTable);
  $('round-count').textContent = String(match.round);
  $('turn-label').textContent = match.status === 'finished' ? '本局結束' : match.currentSeat === online.seat ? '你的回合 · 無時間限制' : `${match.players[match.currentSeat].name} 思考中`;
  $('game-message').textContent = match.message;

  const isHumanTurn = match.status === 'playing' && match.currentSeat === online.seat && (!online.active || (online.connected && !online.pending));
  const draft = isHumanTurn ? match.draft : null;
  const board = draft ? draft.board : match.board;
  const hand = draft ? draft.hand : match.players[online.seat].hand;
  const staging = draft ? draft.staging : [];
  $('hand-count').textContent = `（${hand.length} 張）`;
  $('opening-hint').textContent = match.players[online.seat].opened
    ? '已破冰：可拆解並重組桌面，確認前所有牌組須合法。'
    : '尚未破冰：只能使用自己的牌，首次出牌至少 30 分。';
  const table = $('table-melds');
  table.replaceChildren();
  board.forEach((meld, index) => table.append(renderMeld(meld, index)));
  if (!board.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-message';
    empty.textContent = '目前桌面沒有牌組，請選取手牌建立新組。';
    table.append(empty);
  }
  const holding = $('staging-tiles');
  holding.replaceChildren(...staging.map(tile => makeTile(tile, '暫存區')));
  if (!staging.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-message';
    empty.textContent = '暫存區是空的。';
    holding.append(empty);
  }
  $('hand-tiles').replaceChildren(...orderRackTiles(hand, rackSortMode).map(tile => makeTile(tile, '你的手牌')));
  $('sort-number').setAttribute('aria-pressed', String(rackSortMode === 'number'));
  $('sort-color').setAttribute('aria-pressed', String(rackSortMode === 'color'));
  $('selection-hint').textContent = `目前選取 ${selected.size} 張牌${targetMeld === null ? '；尚未指定目標組合。' : `；目標為第 ${targetMeld + 1} 組。`}`;
  ['create-meld', 'append-meld', 'stage-tiles', 'return-hand', 'sort-number', 'sort-color', 'reset-draft', 'draw-tile', 'confirm-turn'].forEach(id => { $(id).disabled = !isHumanTurn; });
  $('append-meld').disabled = !isHumanTurn || targetMeld === null;
  if (match.status === 'finished') {
    const scores = match.players.map((p, i) => `${p.name} ${match.scores[i] > 0 ? '+' : ''}${match.scores[i]} 分`).join('　｜　');
    $('game-message').textContent = `${match.message}　${scores}`;
  }
  renderMatchResult();
}

function edit(action) {
  withAction(() => editDraft(match, { action, ids: [...selected], targetIndex: targetMeld }));
}

$('result-close').addEventListener('click', () => {
  hideResultDialog();
  $('result-show').focus();
});
$('result-show').addEventListener('click', () => {
  const result = describeMatchResult(match, online.seat);
  if (result) showResultDialog(result);
});
$('result-new-game').addEventListener('click', () => {
  hideResultDialog();
  $('new-game').click();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('result-overlay').classList.contains('hidden')) {
    hideResultDialog();
    $('result-show').focus();
  }
});
$('start-game').addEventListener('click', () => {
  if (online.active) return;
  withAction(() => {
    resetQuickInteractions();
    match = newMatch({ seats: FIXED_PLAYER_COUNT });
    rackSortMode = 'number';
  });
});
$('create-room').addEventListener('click', async () => {
  try {
    await online.host(FIXED_PLAYER_COUNT, $('online-name').value);
    online.forgetPreviousGuest();
  }
  catch (error) { updateOnlineStatus(error.message); }
});
$('join-room').addEventListener('click', async () => {
  try { await online.join($('join-code').value.trim(), $('online-name').value); }
  catch (error) { updateOnlineStatus(error.message); }
});
$('host-start').addEventListener('click', () => {
  try { online.start(); } catch (error) { updateOnlineStatus(error.message); }
});
$('copy-invite').addEventListener('click', copyInvite);
$('online-copy-invite').addEventListener('click', copyInvite);
$('room-reconnect').addEventListener('click', () => online.reconnect());
$('online-reconnect').addEventListener('click', () => online.reconnect());
$('room-leave').addEventListener('click', () => {
  online.leave();
  online.forgetPreviousGuest();
  match = null;
  resetQuickInteractions();
  render();
  updateOnlineStatus('已離開房間。');
});
$('online-ai-takeover').addEventListener('click', () => {
  if (!online.isHost || !window.confirm('將已斷線的真人座位交給 AI？對方將無法回到該座位。')) return;
  const count = online.takeoverDisconnected();
  updateOnlineStatus(count ? `已由 AI 接手 ${count} 位離線玩家。` : '目前沒有需要接手的離線玩家。');
  scheduleAi();
});

$('create-meld').addEventListener('click', () => edit('new-meld'));
$('append-meld').addEventListener('click', () => edit('append'));
$('stage-tiles').addEventListener('click', () => edit('stage'));
$('return-hand').addEventListener('click', () => edit('to-hand'));
$('sort-number').addEventListener('click', () => { rackSortMode = 'number'; render(); });
$('sort-color').addEventListener('click', () => { rackSortMode = 'color'; render(); });
$('reset-draft').addEventListener('click', () => withAction(() => resetDraft(match)));
$('confirm-turn').addEventListener('click', () => {
  if (!match) return;
  const report = inspectDraft(match);
  if (!report.ok) {
    showError(report.error);
    if (window.confirm(`${report.error}\n\n要依失誤規則還原桌面，並罰抽最多 3 張結束回合嗎？\n按「取消」可繼續整理牌面。`)) {
      if (online.active && !online.isHost) {
        try { online.sendTurn('penalty'); render(); } catch (error) { showError(error.message); }
      } else withAction(() => drawAndEndHumanTurn(match, true), true);
    }
    return;
  }
  if (online.active && !online.isHost) {
    try { online.sendTurn('confirm', match.draft); render(); } catch (error) { showError(error.message); }
  } else withAction(() => commitHumanTurn(match), true);
});
$('draw-tile').addEventListener('click', () => {
  if (!match) return;
  const changed = JSON.stringify(match.draft.board) !== JSON.stringify(match.board) || match.draft.staging.length;
  if (changed && !window.confirm('你已經移動了牌。要放棄本回合的排牌、抽牌並結束嗎？')) return;
  if (online.active && !online.isHost) {
    try { online.sendTurn('draw'); render(); } catch (error) { showError(error.message); }
  } else withAction(() => drawAndEndHumanTurn(match), true);
});
$('new-game').addEventListener('click', () => {
  if (!window.confirm(online.active ? '離開多人房間？如果你是房主，所有好友會失去房間連線。' : '確定放棄目前這局，返回四人對局首頁嗎？')) return;
  if (online.active) online.leave();
  online.forgetPreviousGuest();
  try { localStorage.removeItem(SAVE_KEY); } catch (_) { /* Storage can be disabled. */ }
  match = null;
  resetQuickInteractions();
  selected.clear();
  render();
});

function scheduleAi() {
  if (pendingAi || !match || match.status !== 'playing' || match.currentSeat === online.seat || (online.active && !online.isHost)) return;
  if (!match.players[match.currentSeat]?.isAi) return;
  pendingAi = true;
  // A short animation pause is NOT a turn timer. Human thinking is unrestricted.
  setTimeout(() => {
    pendingAi = false;
    if (!match || match.status !== 'playing' || match.currentSeat === online.seat || (online.active && !online.isHost)) return;
    if (!match.players[match.currentSeat]?.isAi) return;
    withAction(() => runAiTurn(match), true);
  }, 420);
}

// Read metadata only; do not activate any previous game or room automatically.
savedSoloCandidate = readPreviousSolo();
const pendingGuest = online.previousGuestRoom;
startupCandidate = chooseResumeCandidate({
  solo: savedSoloCandidate,
  host: online.storedHostSummary,
  guest: pendingGuest,
  incomingRoom
});
render();
if (startupCandidate) {
  if (validRoomCode(incomingRoom)) $('join-code').value = incomingRoom;
  showResumeDecision(startupCandidate);
} else if (validRoomCode(incomingRoom)) {
  // A brand-new explicit invitation is not an automatic resume of an old match.
  $('join-code').value = incomingRoom;
  online.join(incomingRoom, $('online-name').value).catch(error => updateOnlineStatus(error.message));
}

