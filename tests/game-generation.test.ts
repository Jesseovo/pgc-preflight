import { describe, expect, it } from 'vitest';
import { cleanGameHtml, gameUser } from '../server/game-generation';
import { gameBrief } from '../server/forge/prompts.js';
import {GAME_SYSTEM} from '../server/game-generation';

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
  it('首版提取核心操作和循环，保留完整简报原文供后续制作', () => {
    const brief = '# Production\n1200–2000 lines\n## F. Design\n### F1. Identity\nGhost tower\n### F2. Art\nPaper shadows\n### F3. Controls\nHold and release\n### F4. Core loop\nHush then jump\n### F5. Tuning\nlarge table\n### F6. Late enemies\nBosses';
    const compact = gameBrief(brief);
    expect(compact).toContain('Hold and release');expect(compact).toContain('Hush then jump');expect(compact).toContain('Paper shadows');
    expect(compact).not.toContain('large table');expect(brief).toContain('large table');
  });
  it('没有简报时保留选题概念、手势和美术媒介作为制作输入', () => {
    const prompt = gameUser({data:{title:'Misprint',logline:'Pull a printing press lever.'},gesture:'Drag',medium:'Two-color Riso'}, '', '');
    expect(prompt).toContain('Pull a printing press lever.');
    expect(prompt).toContain('Drag');
    expect(prompt).toContain('Two-color Riso');
  });
  it('沿用已有简报重新制作也必须传递最新修改要求', () => {
    const prompt = gameUser({data:{title:'Paper Garden'},note:'Add drifting petals and a gold score counter.'}, '## F. Original garden design', '');
    expect(prompt).toContain('Original garden design');
    expect(prompt).toContain('Latest requested changes');
    expect(prompt).toContain('Add drifting petals and a gold score counter.');
  });
  it('制作要求固定 9:16 舞台、等比缩放及触摸坐标换算',()=>{
    expect(GAME_SYSTEM).toContain('fixed 9:16');expect(GAME_SYSTEM).toContain('540 by 960');expect(GAME_SYSTEM).toContain('getBoundingClientRect');expect(GAME_SYSTEM).toContain('physical keyboard must not be required');
    expect(gameUser({data:{title:'Portrait'}},'','')).toContain('540x960 (9:16)');
  });
});
