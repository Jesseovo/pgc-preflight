import { startTask } from '/forge/progress.js';

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const playIcon = '<svg aria-hidden="true" viewBox="0 0 16 16"><path d="M5 3 13 8 5 13Z"></path></svg>';
const scoreIcon = '<svg aria-hidden="true" viewBox="0 0 16 16"><path d="m8 1.5 2 4.1 4.5.6-3.2 3.2.7 4.6-4-2.2-4 2.2.7-4.6L1.5 6.2l4.5-.6Z"></path></svg>';
const url = new URL(location.href);
const state = { user: null, query: (url.searchParams.get('q') || '').slice(0, 200), page: Math.max(1, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1), manage: false, items: [], listController: null, listTask: null };
const player = $('#player');
let playerController, playerTask, currentGame, playerTrigger, toastTimer;
let previousOverflow = '';

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
  if (response.status === 401) {
    location.assign('/login');
    throw new Error('登录已过期，请重新登录。');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = response.status === 404 ? '这款游戏暂时无法试玩，可能已被下架。' : response.status === 403 ? '当前账号无法执行此操作。' : '请求未完成，请稍后重试。';
    throw new Error(message);
  }
  if (!data) throw new Error('服务返回了无效内容，请重试。');
  return data;
}

function dateLabel(value) {
  if (!value) return '时间未提供';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未提供' : new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Shanghai' }).format(date).replaceAll('/', '.');
}

function scoreLabel(score) {
  return typeof score === 'number' && Number.isFinite(score) ? `<span class="score">${scoreIcon}真人终审 <b>${escape(score)}</b><span>/ 9</span></span>` : '<span class="score no-score">真人评分未提供</span>';
}

function errorState(title, message, action, label = '重试') {
  return `<div class="error-state"><h2>${escape(title)}</h2><p>${escape(message)}</p><button type="button" class="secondary-button" data-action="${action}">${label}</button></div>`;
}

function notify(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4000);
}

function syncUrl() {
  const next = new URL(location.href);
  if (state.query) next.searchParams.set('q', state.query); else next.searchParams.delete('q');
  if (state.page > 1) next.searchParams.set('page', String(state.page)); else next.searchParams.delete('page');
  history.replaceState(null, '', next);
}

function coverMarkup(game, index) {
  let cover;
  try {
    const candidate = new URL(game.cover, location.origin);
    if (game.cover && candidate.origin === location.origin && !candidate.username && !candidate.password) cover = candidate.href;
  } catch {}
  return `<div class="game-art" data-tone="${index % 5}">${cover ? `<img class="cover" src="${escape(cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<img class="placeholder-art" src="/artwork/pixel-console.svg" alt="" width="90" height="72">'}${game.visible === false ? `<span class="status-label">${game.hidden ? '已下架' : '暂不可见'}</span>` : `<span class="play-hint">${playIcon}点击试玩</span>`}</div>`;
}

function renderGames(data) {
  state.items = Array.isArray(data.items) ? data.items : [];
  const total = Number(data.total) || 0;
  state.page = Number(data.page) || state.page;
  const pageSize = Number(data.pageSize) || 12;
  $('#result-count').innerHTML = `${state.query ? `“${escape(state.query)}” · ` : state.manage ? '管理全部作品 · ' : '全部作品 · '}<strong>${total}</strong> 款游戏`;
  if (!state.items.length) {
    $('#results').innerHTML = `<div class="empty-state"><img src="/artwork/pixel-console.svg" alt=""><h2>${state.query ? '没有找到相关游戏' : '好作品，正在路上'}</h2><p>${state.query ? '换一个标题或作者试试。' : state.manage ? '这里会显示已收录的游戏作品。' : '真人终审通过的游戏会出现在这里。'}</p>${state.query ? '<button type="button" class="secondary-button" data-action="clear">查看全部游戏</button>' : ''}</div>`;
  } else {
    $('#results').innerHTML = `<div class="game-grid">${state.items.map((game, index) => `<article class="game-card ${game.visible === false ? 'unavailable' : ''}"><button type="button" class="card-play" data-play="${escape(game.id)}" ${game.visible === false ? 'disabled' : ''} aria-label="${game.visible === false ? '暂不可试玩：' : '试玩：'}${escape(game.title || '未命名游戏')}">${coverMarkup(game, index)}<div class="game-info"><h2 class="game-title" title="${escape(game.title)}">${escape(game.title || '未命名游戏')}</h2><p class="game-author">创作 · <span>${escape(game.author || '成员')}</span></p><div class="game-meta">${scoreLabel(game.score)}<span>${dateLabel(game.approvedAt)}</span></div></div></button>${state.manage ? `<div class="card-management"><span>${game.hidden ? '已手动下架' : game.visible === false ? '当前不满足公开条件' : '广场可见'}</span><button type="button" data-visibility="${escape(game.id)}">${game.hidden ? '取消下架' : '下架'}</button></div>` : ''}</article>`).join('')}</div>`;
    $('#results').querySelectorAll('img.cover').forEach(image => image.addEventListener('error', () => { image.className = 'placeholder-art'; image.src = '/artwork/pixel-console.svg'; }, { once: true }));
  }
  const pages = Math.max(1, Math.ceil(total / pageSize));
  $('#pagination').hidden = pages <= 1;
  $('#page-label').textContent = `第 ${state.page} / ${pages} 页`;
  $('#previous').disabled = state.page <= 1;
  $('#next').disabled = !data.hasMore;
  syncUrl();
}

async function loadGames() {
  state.listController?.abort();
  state.listTask?.dismiss();
  const controller = new AbortController();
  state.listController = controller;
  const task = startTask('正在读取游戏广场', { detail: state.query ? '正在搜索标题与作者…' : '正在读取作品列表…', compact: true });
  state.listTask = task;
  $('#results').setAttribute('aria-busy', 'true');
  $('#results').innerHTML = '<div class="loading-state"></div>';
  task.attach($('#results .loading-state'));
  $('#result-count').textContent = '正在读取…';
  $('#pagination').hidden = true;
  try {
    const query = new URLSearchParams({ q: state.query, page: String(state.page) });
    if (state.manage) query.set('scope', 'manage');
    const data = await api(`/api/square/games?${query}`, { signal: controller.signal });
    if (!controller.signal.aborted) renderGames(data);
  } catch (error) {
    if (controller.signal.aborted) return;
    $('#result-count').textContent = '暂时无法读取';
    $('#results').innerHTML = errorState('游戏列表加载失败', error.message, 'reload');
  } finally {
    task.dismiss();
    if (state.listController === controller) $('#results').setAttribute('aria-busy', 'false');
  }
}

function search(query) {
  state.query = query.trim();
  state.page = 1;
  $('#search').value = state.query;
  void loadGames();
}

function setView(mode) {
  $('#game-viewport').dataset.mode = mode;
  $('#view-phone').setAttribute('aria-pressed', String(mode === 'phone'));
  $('#view-fit').setAttribute('aria-pressed', String(mode === 'fit'));
}

function clearPlayerWork() {
  playerController?.abort();
  playerController = null;
  playerTask?.dismiss();
  playerTask = null;
  $('#game-viewport').replaceChildren();
  $('#player-restart').disabled = true;
}

function stopPlayer() {
  clearPlayerWork();
  currentGame = null;
  document.body.style.overflow = previousOverflow;
  if (playerTrigger?.isConnected) playerTrigger.focus(); else $('#search').focus();
  playerTrigger = null;
}

async function loadPlayer(id) {
  clearPlayerWork();
  const controller = new AbortController();
  playerController = controller;
  const task = startTask('正在打开游戏', { detail: '正在确认作品可试玩…', compact: true });
  playerTask = task;
  $('#player-state').hidden = false;
  $('#player-state').replaceChildren();
  task.attach($('#player-state'));
  try {
    const game = await api(`/api/square/games/${encodeURIComponent(id)}`, { signal: controller.signal });
    if (controller.signal.aborted || !player.open) return;
    if (game.visible === false) throw new Error('这款游戏暂时无法试玩，可能已被下架。');
    currentGame = game;
    $('#player-title').textContent = game.title || '未命名游戏';
    $('#player-meta').textContent = `${game.author || '成员'} · ${typeof game.score === 'number' ? `真人终审 ${game.score} / 9` : '真人评分未提供'}`;
    task.update({ detail: '正在确认游戏文件可用…' });
    const previewUrl = `/api/square/games/${encodeURIComponent(id)}/preview`;
    const preview = await fetch(previewUrl, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
    if (preview.status === 401) {
      location.assign('/login');
      throw new Error('登录已过期，请重新登录。');
    }
    if (!preview.ok) throw new Error(preview.status === 404 ? '这款游戏暂时无法试玩，可能已被下架。' : '游戏文件暂时无法载入，请稍后重试。');
    if (!preview.headers.get('Content-Type')?.toLowerCase().startsWith('text/html')) throw new Error('游戏文件暂时不可用，请稍后重试。');
    if (controller.signal.aborted || !player.open) return;
    task.update({ detail: '正在载入游戏画面…' });
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = `${game.title || '未命名游戏'} · 试玩`;
    frame.addEventListener('load', () => {
      if (controller.signal.aborted || !player.open) return;
      task.dismiss();
      $('#player-state').hidden = true;
      $('#player-restart').disabled = false;
    }, { once: true });
    frame.addEventListener('error', () => {
      if (controller.signal.aborted || !player.open) return;
      task.dismiss();
      $('#game-viewport').replaceChildren();
      $('#player-state').innerHTML = errorState('游戏画面加载失败', '请检查网络后重新打开。', 'retry-player', '重新打开');
      $('#player-state').hidden = false;
    }, { once: true });
    frame.src = previewUrl;
    $('#game-viewport').append(frame);
  } catch (error) {
    task.dismiss();
    if (controller.signal.aborted) return;
    $('#player-state').innerHTML = errorState('暂时无法试玩', error.message, 'retry-player', '重新打开');
  }
}

function openPlayer(game, trigger) {
  playerTrigger = trigger;
  currentGame = game;
  $('#player-title').textContent = game.title || '未命名游戏';
  $('#player-meta').textContent = game.author || '成员';
  previousOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  setView('phone');
  player.showModal();
  $('#player-close').focus();
  void loadPlayer(game.id);
}

async function toggleVisibility(game, button) {
  button.disabled = true;
  const task = startTask(game.hidden ? '正在取消下架' : '正在下架游戏', { detail: '正在保存可见状态…', compact: true });
  try {
    await api(`/api/square/games/${encodeURIComponent(game.id)}/visibility`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hidden: !game.hidden }) });
    notify(game.hidden ? '已取消手动下架，公开状态以当前终审结论为准。' : '游戏已下架。');
    await loadGames();
  } catch (error) { notify(error.message); }
  finally { task.dismiss(); button.disabled = false; }
}

$('#search-form').addEventListener('submit', event => { event.preventDefault(); search($('#search').value); });
$('#search').addEventListener('search', () => { if (!$('#search').value) search(''); });
$('#manage').addEventListener('change', () => { state.manage = $('#manage').checked; state.page = 1; void loadGames(); });
$('#previous').addEventListener('click', () => { state.page = Math.max(1, state.page - 1); void loadGames(); $('#catalog').scrollIntoView({ block: 'start' }); });
$('#next').addEventListener('click', () => { state.page += 1; void loadGames(); $('#catalog').scrollIntoView({ block: 'start' }); });
$('#results').addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.action === 'reload') void loadGames();
  if (button.dataset.action === 'clear') search('');
  if (button.dataset.play) {
    const game = state.items.find(item => item.id === button.dataset.play);
    if (game && game.visible !== false) openPlayer(game, button);
  }
  if (button.dataset.visibility && state.user?.role === 'admin') {
    const game = state.items.find(item => item.id === button.dataset.visibility);
    if (game) void toggleVisibility(game, button);
  }
});
$('#player-close').addEventListener('click', () => player.close());
player.addEventListener('close', stopPlayer);
player.addEventListener('cancel', event => { event.preventDefault(); player.close(); });
$('#view-phone').addEventListener('click', () => setView('phone'));
$('#view-fit').addEventListener('click', () => setView('fit'));
$('#player-restart').addEventListener('click', () => { if (currentGame) void loadPlayer(currentGame.id); });
$('#player-state').addEventListener('click', event => { if (event.target.closest('[data-action="retry-player"]') && currentGame) void loadPlayer(currentGame.id); });
window.addEventListener('pagehide', clearPlayerWork);

async function boot() {
  const task = startTask('正在进入游戏广场', { detail: '正在确认登录状态…', compact: true });
  task.attach($('#session-state'));
  try {
    state.user = await api('/api/auth/me');
    $('#workspace-link').href = state.user.role === 'admin' ? '/admin' : state.user.star ? '/forge/' : '/';
    $('#member-name').textContent = state.user.displayName || state.user.display_name || state.user.username || '团队成员';
    $('#manage-toggle').hidden = state.user.role !== 'admin';
    $('#search').value = state.query;
    $('#session-state').hidden = true;
    $('#catalog').hidden = false;
    await loadGames();
  } catch (error) {
    $('#session-state').innerHTML = errorState('暂时无法进入广场', error.message, 'boot');
  } finally { task.dismiss(); }
}
$('#session-state').addEventListener('click', event => { if (event.target.closest('[data-action="boot"]')) void boot(); });
void boot();
