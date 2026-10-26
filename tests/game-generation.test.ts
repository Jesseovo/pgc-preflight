import { describe, expect, it } from 'vitest';
import { cleanGameHtml, gameUser } from '../server/game-generation';

const page = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="https://example.invalid/game.css"><script src="https://example.invalid/game.js"></script></head><body><img src="https://example.invalid/hero.png"><script>document.body.textContent="Playable"</script></body></html>';

describe('Opus 游戏成品', () => {
  it('只保留完整单文件游戏并清除引用的远程资源', () => {
    const html = cleanGameHtml(page);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html.endsWith('</html>')).toBe(true);
    expect(html).toContain('name="viewport"');
    expect(html).toContain('document.body.textContent');
    expect(html).not.toMatch(/example\.invalid|<link|<script src/i);
  });

  it('拒绝截断输出、缺少 viewport 或缺少脚本', () => {
    expect(() => cleanGameHtml(page.slice(0, -20))).toThrow('完整的 HTML');
    expect(() => cleanGameHtml(page.replace(/<meta[^>]*viewport[^>]*>/i, ''))).toThrow('viewport');
    expect(() => cleanGameHtml(page.replace(/<script[^>]*>document\.body[^<]*<\/script>/i, ''))).toThrow('可运行脚本');
  });

  it('生成指令包含选题简报与已生成的美术资产脚本', () => {
    const topic = { data: { title: 'Leaf Dodge', logline: 'Dodge falling seeds.' } };
    const brief = '## F. Build a 2D game';
    const assets = '<script id="game-assets">const GAME_ASSETS={draw(){}};</script>';
    const prompt = gameUser(topic, brief, assets);
    expect(prompt).toContain('Leaf Dodge');
    expect(prompt).toContain(brief);
    expect(prompt).toContain('const GAME_ASSETS');
  });
});
