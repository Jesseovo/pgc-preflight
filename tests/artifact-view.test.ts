import {describe,it,expect} from 'vitest';
import {briefDocument,versionDocument} from '../public/forge/artifact-view.js';

describe('生成内容的可读预览',()=>{
  it('简报先展示本款设计，通用规范折叠；模型文本不能注入页面',()=>{
    const html=briefDocument('# 通用模板\n## A. 平台要求\n固定要求\n\n## F. 本款游戏设计\n### F1. 一句话\n**月光小兔**\n<script>window.injected=true</script>\n\n| 参数 | 数值 |\n| --- | --- |\n| speed | `<img onerror=alert(1)>` |');
    expect(html.indexOf('本款游戏设计')).toBeLessThan(html.indexOf('通用制作规范'));
    expect(html).toContain('<strong>月光小兔</strong>');expect(html).toContain('<table>');expect(html).not.toContain('<script>');expect(html).not.toContain('<img onerror');expect(html).toContain('&lt;script&gt;');
  });
  it('游戏历史版本使用不可变版本的隔离预览，不把 HTML 展示成源码',()=>{
    const html=versionDocument({kind:'game',id:'version-1',content:'<!doctype html><script>privateSource()</script>'},9);
    expect(html).toContain('sandbox="allow-scripts"');expect(html).toContain('/topics/9/versions/version-1/preview');expect(html).not.toContain('allow-same-origin');expect(html).not.toContain('privateSource');
  });
  it('选题版本只展示实际有内容的字段',()=>{
    const html=versionDocument({kind:'expand',content:JSON.stringify({title:'云朵',controls:'点击',risks:''})},9);
    expect(html).toContain('云朵');expect(html).toContain('点击');expect(html).not.toContain('风险');expect(html).not.toContain('undefined');
  });
});
