import { analyzeMeld, checkTileIntegrity } from './rules.js';
import { orderMeldTiles, orderRackTiles } from './tile-order.js';
import { describeMatchResult, formatSignedScore } from './match-result.js';
import { OnlineController } from './online-controller.js';
import { validRoomCode } from './online-core.js';
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
const incomingRoom = new URLSearchParams(window.location.search).get('room');
const online = new OnlineController({
  onMatch(next) { match = next; selected.clear(); targetMeld = null; render(); scheduleAi(); },
  onStatus(message) { updateOnlineStatus(message); renderOnlineRoom(); }
});

function updateOnlineStatus(message) {
  const status = $('online-status');
  if (status) status.textContent = message;
  const gameStatus = $('online-game-status');
  if (gameStatus) gameStatus.textContent = message;
}

function renderOnlineRoom() {
  const summary = $('room-summary');
  const hasRoom = online.active;
  summary.classList.toggle('hidden', !hasRoom);
  $('start-game').disabled = hasRoom;
  $('create-room').disabled = hasRoom;
  $('join-room').disabled = hasRoom;
  if (!hasRoom) return;
  $('room-code').textContent = online.code;
  $('room-seat-label').textContent = online.isHost ? '｜你是房主' : `｜第 ${online.seat + 1} 位玩家`;
  const members = online.members.map(m => `${m.name}（${m.connected ? '在線' : '離線'}）`).join('、');
  $('room-members').textContent = `${members}｜未加入的座位會由 AI 補齊`;
  $('host-start').classList.toggle('hidden', !online.isHost || online.room?.phase !== 'lobby');
  $('room-reconnect').classList.toggle('hidden', online.isHost);
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
  withAction(() => { match = newMatch({ seats: Number($('seat-count').value) }); rackSortMode = 'number'; });
});
$('create-room').addEventListener('click', async () => {
  try { await online.host(Number($('seat-count').value), $('online-name').value); }
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
$('room-leave').addEventListener('click', () => { online.leave(); match = null; render(); updateOnlineStatus('已離開房間。'); });
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
  if (!window.confirm(online.active ? '離開多人房間？如果你是房主，所有好友會失去房間連線。' : '確定放棄目前這局，重新選擇玩家人數嗎？')) return;
  if (online.active) online.leave();
  try { localStorage.removeItem(SAVE_KEY); } catch (_) { /* Storage can be disabled. */ }
  match = null;
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

try {
  const saved = localStorage.getItem(SAVE_KEY);
  if (saved && !incomingRoom && !online.hasStoredHost) {
    const parsed = JSON.parse(saved);
    if (isValidSavedState(parsed)) match = parsed;
    else localStorage.removeItem(SAVE_KEY);
  }
} catch (_) {
  // Corrupt save / disabled storage must not prevent a new game.
}
if (match && !checkTileIntegrity(match)) match = null;
render();
scheduleAi();
if (validRoomCode(incomingRoom)) {
  $('join-code').value = incomingRoom;
  online.join(incomingRoom, $('online-name').value).catch(error => updateOnlineStatus(error.message));
} else if (!match) {
  online.restoreHost().catch(error => updateOnlineStatus(error.message));
}

