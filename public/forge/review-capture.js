export async function probeGame(html, box, log) {
  log('浏览器正在运行三种手机比例并采集完整画面…');
  const response = await fetch('/api/forge/review/probe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ html }),
    signal: AbortSignal.timeout(90000),
  });
  let output;
  try { output = await response.json(); } catch { throw new Error('画面采集服务暂时无响应，请重试；本次尚未评分。'); }
  if (!response.ok) throw new Error(output.error || '画面采集未完成，请重试。');
  if (!Array.isArray(output.shots) || output.shots.length !== 4 || output.probe?.captureMethod !== 'browser-viewport-v1') throw new Error('画面证据不完整，请重新采集；本次尚未评分。');
  log('已采集 3 种比例、4 张完整画面', 4, 4);
  return output;
}

export function probeChecks(probe) {
  const notes = [];
  const add = text => notes.push({ level: 'warn', text });
  if (probe.captureMethod === 'browser-viewport-v1') {
    notes.push({ level: 'ok', text: '浏览器完整视口截图，包含 DOM、CSS 和所有 Canvas 图层。' });
    add('每种比例只执行了一次触摸，没有确认完整通关、操作手感和长期节奏。');
  } else add('旧版截图可能漏掉 DOM/CSS 和其他图层；历史评分未重新计算，建议重新上传审核。');
  for (const [ratio, loaded] of Object.entries(probe.loaded || {})) add(`${ratio}：${loaded ? '页面加载事件已完成' : '页面未在采集时限内完成加载'}`);
  if (probe.errors?.length) add(`采集到的运行日志：${probe.errors.slice(0, 3).join('；')}`);
  add('音频节点不是听感，未验证响度、音质或背景音乐是否可听。');
  for (const [ratio, resources] of Object.entries(probe.resources || {})) {
    for (const [kind, urls] of Object.entries(resources)) if (urls.length) add(`${ratio} ${ {missing:'本地资源未提供', restricted:'审核环境限制的资源', failed:'资源请求失败'}[kind] || kind }：${urls.join('；')}`);
  }
  return notes;
}
