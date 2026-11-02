import { COLORS, analyzeMeld, checkTileIntegrity } from './rules.js';
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

function save() {
  try {
    if (match) localStorage.setItem(SAVE_KEY, JSON.stringify(match));
  } catch (error) {
    showError('瀏覽器無法保存進度，重新整理後可能會遺失此局。');
  }
}

function showError(message) {
  const status = $('game-message');
  status.textContent = message;
  status.classList.add('error');
}

function withAction(operation) {
  try {
    operation();
    selected.clear();
    targetMeld = null;
    $('game-message').classList.remove('error');
    save();
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
    if (!match || match.currentSeat !== 0 || match.status !== 'playing') return;
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
  meld.forEach(tile => tiles.append(makeTile(tile, `牌桌第 ${index + 1} 組`)));
  container.append(tiles);
  return container;
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
    count.textContent = `${player.hand.length} 張${player.opened ? ' · 已破冰' : ' · 未破冰'}`;
    box.append(title, count);
    players.append(box);
  });
}

function render() {
  $('lobby').classList.toggle('hidden', Boolean(match));
  $('game').classList.toggle('hidden', !match);
  if (!match) return;
  renderPlayers();
  const stats = gameStats(match);
  $('pool-count').textContent = String(stats.inPool);
  $('table-count').textContent = String(stats.onTable);
  $('round-count').textContent = String(match.round);
  $('turn-label').textContent = match.status === 'finished' ? '本局結束' : match.currentSeat === 0 ? '你的回合 · 無時間限制' : `${match.players[match.currentSeat].name} 思考中`;
  $('game-message').textContent = match.message;

  const isHumanTurn = match.status === 'playing' && match.currentSeat === 0;
  const draft = isHumanTurn ? match.draft : null;
  const board = draft ? draft.board : match.board;
  const hand = draft ? draft.hand : match.players[0].hand;
  const staging = draft ? draft.staging : [];
  $('hand-count').textContent = `（${hand.length} 張）`;
  $('opening-hint').textContent = match.players[0].opened
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
  $('hand-tiles').replaceChildren(...hand.map(tile => makeTile(tile, '你的手牌')));
  $('selection-hint').textContent = `目前選取 ${selected.size} 張牌${targetMeld === null ? '；尚未指定目標組合。' : `；目標為第 ${targetMeld + 1} 組。`}`;
  ['create-meld', 'append-meld', 'stage-tiles', 'return-hand', 'sort-number', 'sort-color', 'reset-draft', 'draw-tile', 'confirm-turn'].forEach(id => { $(id).disabled = !isHumanTurn; });
  $('append-meld').disabled = !isHumanTurn || targetMeld === null;
  if (match.status === 'finished') {
    const scores = match.players.map((p, i) => `${p.name} ${match.scores[i] > 0 ? '+' : ''}${match.scores[i]} 分`).join('　｜　');
    $('game-message').textContent = `${match.message}　${scores}`;
  }
}

function edit(action) {
  withAction(() => editDraft(match, { action, ids: [...selected], targetIndex: targetMeld }));
}

$('start-game').addEventListener('click', () => {
  withAction(() => { match = newMatch({ seats: Number($('seat-count').value) }); });
});
$('create-meld').addEventListener('click', () => edit('new-meld'));
$('append-meld').addEventListener('click', () => edit('append'));
$('stage-tiles').addEventListener('click', () => edit('stage'));
$('return-hand').addEventListener('click', () => edit('to-hand'));
$('sort-number').addEventListener('click', () => withAction(() => match.draft.hand.sort((a, b) => (a.number ?? 14) - (b.number ?? 14) || COLORS.indexOf(a.color) - COLORS.indexOf(b.color))));
$('sort-color').addEventListener('click', () => withAction(() => match.draft.hand.sort((a, b) => COLORS.indexOf(a.color) - COLORS.indexOf(b.color) || (a.number ?? 14) - (b.number ?? 14))));
$('reset-draft').addEventListener('click', () => withAction(() => resetDraft(match)));
$('confirm-turn').addEventListener('click', () => {
  if (!match) return;
  const report = inspectDraft(match);
  if (!report.ok) {
    showError(report.error);
    if (window.confirm(`${report.error}\n\n要依失誤規則還原桌面，並罰抽最多 3 張結束回合嗎？\n按「取消」可繼續整理牌面。`)) {
      withAction(() => drawAndEndHumanTurn(match, true));
    }
    return;
  }
  withAction(() => commitHumanTurn(match));
});
$('draw-tile').addEventListener('click', () => {
  if (!match) return;
  const changed = JSON.stringify(match.draft.board) !== JSON.stringify(match.board) || match.draft.staging.length;
  if (changed && !window.confirm('你已經移動了牌。要放棄本回合的排牌、抽牌並結束嗎？')) return;
  withAction(() => drawAndEndHumanTurn(match));
});
$('new-game').addEventListener('click', () => {
  if (!window.confirm('確定放棄目前這局，重新選擇玩家人數嗎？')) return;
  try { localStorage.removeItem(SAVE_KEY); } catch (_) { /* Storage can be disabled. */ }
  match = null;
  selected.clear();
  render();
});

function scheduleAi() {
  if (pendingAi || !match || match.status !== 'playing' || match.currentSeat === 0) return;
  pendingAi = true;
  // A short animation pause is NOT a turn timer. Human thinking is unrestricted.
  setTimeout(() => {
    pendingAi = false;
    if (!match || match.status !== 'playing' || match.currentSeat === 0) return;
    withAction(() => runAiTurn(match));
  }, 420);
}

try {
  const saved = localStorage.getItem(SAVE_KEY);
  if (saved) {
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
