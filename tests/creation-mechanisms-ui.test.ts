import {describe,expect,it} from 'vitest';
import {mechanismSummaryHtml} from '../src/admin/creation-mechanisms';

describe('管理员机制目录呈现',()=>{
  it('只渲染四项摘要并按文本转义每项内容',()=>{
    const source='<img src=x onerror="alert(1)">&';
    const html=mechanismSummaryHtml([{id:'PRIVATE_ID',subject:source,action:source,rule:source,structure:source,
      reason:'PRIVATE_REASON',owner_id:'PRIVATE_OWNER',brief:'PRIVATE_BRIEF'}]);
    expect(html).toContain('<th>题材</th><th>玩家动作</th><th>核心规则</th><th>结构</th>');
    expect(html.match(/&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;&amp;/g)).toHaveLength(4);
    expect(html).not.toMatch(/<img|PRIVATE_/);
  });

  it('目录为空时说明历史原文没有自动公开',()=>{
    expect(mechanismSummaryHtml([])).toContain('私人历史资料不会自动进入目录');
  });
});
