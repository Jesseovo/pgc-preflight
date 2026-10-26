import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { captureReview } from '../server/review-probe';
import { launchLocalBrowser } from '../server/local-browser';

// Synthetic fixtures only. These checks validate evidence, not model accuracy.
export const domFixture = `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DOM evidence fixture</title><style>
html,body{margin:0;height:100%;overflow:hidden;background:#18b665}#app{position:fixed;inset:0;display:grid;place-content:center;color:#fff;font:24px sans-serif;text-align:center}canvas{position:fixed;inset:0;pointer-events:none}button{font:20px sans-serif;padding:20px;background:#fff;color:#153727;border:0}
</style><main id="app"><h1>VISIBLE DOM GAME</h1><button id="tap">Tap 0</button></main><canvas id="fx"></canvas><canvas id="overlay"></canvas><script>
const fx=document.querySelector('#fx'),overlay=document.querySelector('#overlay');fx.width=overlay.width=innerWidth;fx.height=overlay.height=innerHeight;
const a=fx.getContext('2d'),b=overlay.getContext('2d');a.fillStyle='#f54040';a.fillRect(15,15,40,40);b.fillStyle='#2860f0';b.fillRect(innerWidth-55,15,40,40);
addEventListener('pointerdown',e=>{document.querySelector('#tap').textContent='Trusted '+e.isTrusted;document.title='Trusted '+e.isTrusted});
fetch('https://example.com/not-allowed').catch(()=>{});
</script></html>`;

async function main() {
  await mkdir('artifacts', { recursive: true });
  const browser = await launchLocalBrowser();
  try {
    const dom = await captureReview(browser, domFixture);
    assert.equal(dom.shots.length, 4);
    assert.equal(dom.probe.captureMethod, 'browser-viewport-v1');
    assert(dom.probe.observations.some(item => item.title === 'Trusted true'), 'Use trusted browser input');
    assert(dom.probe.observations.every(item => item.domText.includes('VISIBLE DOM GAME')));
    assert(dom.probe.observations.every(item => item.canvases.length === 2));
    assert(Object.values(dom.probe.loaded).every(Boolean));
    assert(Object.values(dom.probe.resources).some((resources: any) => resources.restricted.includes('example.com/not-allowed')));
    const decoder = await browser.newPage();
    for (const [index, shot] of dom.shots.entries()) {
      const pixels = await decoder.evaluate(async data => {
        const image = new Image(); image.src = data; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
        return { background: [...context.getImageData(100, 100, 1, 1).data], firstLayer: [...context.getImageData(30, 30, 1, 1).data], secondLayer: [...context.getImageData(330, 30, 1, 1).data] };
      }, shot.data);
      assert(pixels.background[1] > 140 && pixels.background[0] < 60, `DOM background missing in shot ${index}`);
      assert(pixels.firstLayer[0] > 180 && pixels.firstLayer[1] < 100, 'First canvas missing');
      assert(pixels.secondLayer[2] > 180 && pixels.secondLayer[0] < 100, 'Second canvas missing');
      await writeFile(`artifacts/evidence-dom-${index}.jpg`, Buffer.from(shot.data.split(',')[1], 'base64'));
    }
    const noCanvas = await captureReview(browser, domFixture.replace(/<canvas[^>]*><\/canvas>/g, '').replace(/<script>[\s\S]*?<\/script>/, ''));
    assert(noCanvas.probe.observations.every(item => item.canvases.length === 0 && item.domText.includes('VISIBLE DOM GAME')));
    const canvas = await captureReview(browser, '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}</style><canvas></canvas><script>const c=document.querySelector("canvas");c.width=innerWidth;c.height=innerHeight;const x=c.getContext("2d");x.fillStyle="#326bc7";x.fillRect(0,0,c.width,c.height);</script>');
    assert(canvas.probe.observations.every(item => item.canvases.length === 1));
    assert.equal((await browser.browserContexts()).length, 1, 'Capture contexts must close');
    console.log('PASS DOM + two Canvas layers: 4 viewport images and pixel checks; trusted touch; restricted resources recorded; DOM-only and Canvas-only pages; isolated contexts released.');
  } finally { await browser.close(); }
}
if (process.argv[1]?.replace(/\\/g, '/').endsWith('/verify-review-evidence.ts')) await main();
