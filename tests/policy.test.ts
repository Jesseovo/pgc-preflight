import { describe, expect, it } from 'vitest';
import { MAX_FILE_BYTES, resourceAllowed, validateInput, makeReportText } from '../server/policy';
import type { Finding, CheckReport } from '../src/types';

describe('上传验证', () => {
  it('接受真实 HTML 文本与大小写后缀', () => { expect(validateInput({ filename: 'Game.HTML', html: '<canvas></canvas>' }).filename).toBe('Game.HTML'); });
  it('拒绝伪装扩展名、空文件与超限内容', () => {
    expect(() => validateInput({ filename: 'game.html.exe', html: '<html>' })).toThrow();
    expect(() => validateInput({ filename: 'game.html', html: ' ' })).toThrow();
    expect(() => validateInput({ filename: 'game.html', html: '<html>' + '中'.repeat(MAX_FILE_BYTES / 3) })).toThrow();
    expect(() => validateInput({ filename: 'game.html', html: 'not a game' })).toThrow();
  });
});
describe('浏览器网络边界', () => {
  it('允许固定公共 CDN、内嵌资源，不允许其他目标', () => {
    expect(resourceAllowed('https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js')).toBe(true);
    expect(resourceAllowed('data:image/png;base64,abc')).toBe(true);
    for (const url of ['http://localhost/a','https://127.0.0.1/a','https://169.254.169.254/','file:///etc/passwd','https://cdn.jsdelivr.net.evil.test/a','https://user:secret@cdn.jsdelivr.net/a','https://cdn.jsdelivr.net:8443/a','https://example.com/a','javascript:alert(1)']) expect(resourceAllowed(url)).toBe(false);
  });
});
describe('报告展示', () => {
  const finding = (status: Finding['status']): Finding => ({ category: 'load', status, title: 'test', detail: 'test' });
  it('报告带上未覆盖范围，不虚构最终通过', () => {
    const report = { filename:'a.html',status:'review',startedAt:'2026-10-23',durationMs:1000,findings:[finding('review')],uncovered:['未到达结算'] } as CheckReport;
    expect(makeReportText(report)).toContain('需人工确认'); expect(makeReportText(report)).toContain('未到达结算'); expect(makeReportText(report)).toContain('最终审核由人工判断');
  });
});
