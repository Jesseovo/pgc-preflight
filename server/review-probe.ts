import type { Browser } from 'puppeteer-core';
import { RESOURCE_HOSTS, resourceAllowed } from './policy';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const FRAMES = [{ ratio: '9:16', width: 360, height: 640 }, { ratio: '9:19.5', width: 360, height: 780 }, { ratio: '9:21', width: 360, height: 840 }];
const labelResource = (raw: string) => { try { const url = new URL(raw); return `${url.hostname}${url.pathname}`.slice(0, 160); } catch { return raw.slice(0, 160); } };

// This function is serialized into the isolated game page before its scripts.
function installReviewProbe() {
  const state = { errors: [] as string[], contexts: [] as AudioContext[], starts: 0 };
  const note = (value: unknown) => { if (state.errors.length < 20) state.errors.push(String(value).slice(0, 300)); };
  addEventListener('error', event => note(event.message));
  addEventListener('unhandledrejection', event => note(event.reason?.message || event.reason));
  for (const key of ['AudioContext', 'webkitAudioContext']) {
    const original = (window as any)[key];
    if (!original) continue;
    (window as any)[key] = new Proxy(original, { construct(target, args) {
      const context = Reflect.construct(target, args) as AudioContext; state.contexts.push(context); return context;
    } });
  }
  if (typeof AudioScheduledSourceNode !== 'undefined') {
    const original = AudioScheduledSourceNode.prototype.start;
    AudioScheduledSourceNode.prototype.start = function (...args: Parameters<typeof original>) { state.starts++; return original.apply(this, args); };
  }
  (window as any).__reviewObservation = () => ({
    errors: [...state.errors], title: document.title, domText: (document.body?.innerText || '').slice(0, 2500),
    canvases: [...document.querySelectorAll('canvas')].slice(0, 20).map(canvas => {
      const rect = canvas.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, bufferWidth: canvas.width, bufferHeight: canvas.height };
    }),
    audio: { contextStates: state.contexts.map(context => context.state), sourceStarts: state.starts,
      media: [...document.querySelectorAll('audio,video')].slice(0, 10).map(node => {
        const media = node as HTMLMediaElement;
        return { paused: media.paused, muted: media.muted, volume: media.volume, currentTime: media.currentTime, readyState: media.readyState };
      }), measuredListening: false },
  });
}

/** Capture the browser viewport, including DOM, CSS, WebGL and every canvas layer. */
export async function captureReview(browser: Browser, html: string) {
  const context = await browser.createBrowserContext();
  let expired = false;
  const deadline = setTimeout(() => { expired = true; void context.close().catch(() => {}); }, 65000);
  const sources = [...RESOURCE_HOSTS].map(host => `https://${host}`).join(' ');
  try {
    const frames = [];
    let shotNumber=0;
    // Chromium touch gestures share browser input state. Run viewports in order
    // so simultaneous touchStart/touchEnd sequences cannot interfere.
    for (const spec of FRAMES) {
      const origin = `https://game-${crypto.randomUUID()}.invalid`;
      const page = await context.newPage();
      const resources = { missing: [] as string[], restricted: [] as string[], failed: [] as string[] };
      let loadError = '';
      await page.setViewport({ width: spec.width, height: spec.height, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
      // tsx/esbuild may annotate local function names; keep the serialized
      // initializer self-contained in both local and Worker builds.
      await page.evaluateOnNewDocument(`(() => { const __name = value => value; (${installReviewProbe.toString()})(); })()`);
      await page.setRequestInterception(true);
      page.on('request', request => {
        const url = request.url();
        if (url === `${origin}/index.html` && request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          void request.respond({ status: 200, contentType: 'text/html; charset=utf-8', headers: {
            'Content-Security-Policy': `default-src 'self' data: blob: ${sources}; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: ${sources}; style-src 'self' 'unsafe-inline' ${sources}; connect-src ${sources}; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-same-origin`,
            'Referrer-Policy': 'no-referrer',
          }, body: html }).catch(() => {});
        } else if (url.startsWith(`${origin}/`)) {
          if (!url.endsWith('/favicon.ico')) resources.missing.push(labelResource(url));
          void request.abort().catch(() => {});
        } else if (request.isNavigationRequest() || !resourceAllowed(url)) {
          resources.restricted.push(labelResource(url)); void request.abort().catch(() => {});
        } else void request.continue().catch(() => {});
      });
      page.on('response', response => { if (response.status() >= 400) resources.failed.push(`${response.status()} ${labelResource(response.url())}`); });
      page.on('requestfailed', request => { if (resourceAllowed(request.url()) && !request.url().startsWith(origin)) resources.failed.push(labelResource(request.url())); });
      page.on('console', message => {
        if (/content security policy/i.test(message.text())) {
          const url = message.text().match(/https?:\/\/[^\s'"<>]+/)?.[0];
          if (url && !url.startsWith(origin)) resources.restricted.push(labelResource(url));
        }
      });
      page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
      page.on('popup', popup => { if (popup) void popup.close().catch(() => {}); });
      try { await page.goto(`${origin}/index.html`, { waitUntil: 'load', timeout: 12000 }); }
      catch (error) { loadError = String(error instanceof Error ? error.message : error).slice(0, 180); }
      await pause(1000);
      const shots: { label: string; data: string;id:string;capturedAt:string;source:string;actionRefs:string[] }[] = [];
      const observations: any[] = [];
      const capture = async (stage: string, elapsedMs: number) => {
        const label = `${spec.ratio} ${stage}`;
        const data = await page.screenshot({ type: 'jpeg', quality: 80, encoding: 'base64' });
        const observation = await page.evaluate(() => (window as any).__reviewObservation());
        const capturedAt=new Date().toISOString(),id=`baseline-${++shotNumber}`,actionRefs=stage==='首次触摸前'?[]:[`baseline-${spec.ratio}-tap`];
        shots.push({id,capturedAt,source:'isolated-chromium',actionRefs,label,data:`data:image/jpeg;base64,${data}`});
        observations.push({id,label,capturedAt,actionRefs,elapsedMs,...observation});
      };
      if (spec.ratio === '9:19.5') await capture('首次触摸前', 0);
      const point = { x: spec.width / 2, y: Math.round(spec.height * 0.6) };
      const target = await page.evaluate(({ x, y }) => {
        const element = document.elementFromPoint(x, y);
        return { tag: element?.tagName || '', text: (element?.textContent || '').slice(0, 100) };
      }, point);
      const tappedAt = Date.now();
      await page.touchscreen.tap(point.x, point.y);
      if (spec.ratio === '9:19.5') { await pause(3000); await capture('首次触摸后约 3 秒', Date.now() - tappedAt); }
      else { await pause(10000); await capture('首次触摸后约 10 秒', Date.now() - tappedAt); }
      const final = await page.evaluate(() => (window as any).__reviewObservation());
      frames.push({ spec, shots, observations, final, loadError, resources: Object.fromEntries(Object.entries(resources).map(([key, values]) => [key, [...new Set(values)].slice(0, 12)])),
        action: { id:`baseline-${spec.ratio}-tap`,startedAt:new Date(tappedAt).toISOString(),ratio: spec.ratio, type: 'tap', ...point, target, count: 1, note: '浏览器触摸事件；仅记录执行动作，未确认游戏已开局。此后未再操作。' } });
      await page.close();
    }
    return {
      shots: frames.flatMap(frame => frame.shots),
      probe: {
        captureMethod: 'browser-viewport-v1',
        loaded: Object.fromEntries(frames.map(frame => [frame.spec.ratio, !frame.loadError])),
        errors: [...new Set(frames.flatMap(frame => frame.final.errors))],
        observations: frames.flatMap(frame => frame.observations),
        actions: frames.map(frame => frame.action),
        resources: Object.fromEntries(frames.map(frame => [frame.spec.ratio, frame.resources])),
        loadErrors: frames.filter(frame => frame.loadError).map(frame => ({ ratio: frame.spec.ratio, error: frame.loadError })),
        note: '图片为 Chromium 完整视口截图，包含 DOM、CSS 和所有 Canvas。每种比例仅触摸一次，未验证手感、随机/挂机策略、完整胜负循环或 30–60 秒节奏；音频仅采集节点和媒体状态，没有录音或听感。Canvas 尺寸仅是单个图层，不能用于判定整屏留白。受限资源可能源于审核环境，需区分环境与作品故障。',
      },
    };
  } catch (error) {
    throw new Error(expired ? '浏览器画面采集超时，本次尚未评分，请重试。' : `浏览器画面采集未完成：${error instanceof Error ? error.message : '运行失败'}`);
  } finally { clearTimeout(deadline); await context.close().catch(() => {}); }
}
