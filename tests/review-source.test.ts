import {describe,expect,it} from 'vitest';
import {reviewSource} from '../server/review-source';
describe('审核源码表示',()=>{
  it('只省略媒体编码，保留同一长行中的操作、碰撞与重开逻辑',()=>{
    const payload='ABcd0123+/'.repeat(15000);
    const source=`<img src="data:image/png;base64,${payload}"><script>function restart(){alive=true}addEventListener('pointerdown',restart);if(hitTest())alive=false;</script>`;
    const compact=reviewSource(source,120000);
    expect(compact.length).toBeLessThan(500);expect(compact).toContain('data:image/png;base64,');expect(compact).toContain('function restart(){alive=true}');expect(compact).toContain('if(hitTest())');expect(compact).toContain('编码素材已省略');
  });
  it('多行素材与字体可缩减；内嵌脚本、普通长行和小图保持完整',()=>{
    const compact=reviewSource(`<style>@font-face{src:url('data:font/woff2;charset=utf-8;base64,${'AAAB\n'.repeat(1000)}')}</style>`);
    expect(compact).toContain('data:font/woff2;');expect(compact.length).toBeLessThan(300);
    const logic=`<script>${'let x=0;'.repeat(500)}addEventListener('pointerup',()=>restart())</script><script src="data:text/javascript;base64,${'A'.repeat(500)}"></script><img src="data:image/png;base64,AA==">`;
    expect(reviewSource(logic)).toBe(logic);
  });
  it('真实逻辑超长时明确标示缺失区间并保留尾部控制，不切断Unicode',()=>{
    const text=`function init(){}${'测试🐈'.repeat(1000)}function restart(){}`;
    const compact=reviewSource(text,1000);
    expect(compact).toContain('function init(){}');expect(compact).toContain('function restart(){}');expect(compact).toContain('中间');
    expect(compact).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});
