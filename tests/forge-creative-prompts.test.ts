import {describe,expect,it} from 'vitest';
import {DEFAULT_REDLINES,DEFAULT_TEMPLATE_F} from '../server/forge/defaults.js';
import {
  ASSETS_SYSTEM_V2, CREATIVE_GUIDANCE_VERSION, GAME_BUILD_SCHEMA, GAME_POLISH_SCHEMA, GAME_REPAIR_SCHEMA,
  PREVIEW_SYSTEM_V2, assetsUserV2, briefSystemV2, briefUserV2, extractGameAssetScript,
  gameStageSystem, gameStageUser, previewUserV2,
} from '../server/forge/prompts.js';
import {withoutImages} from '../server/forge-llm';

const topic={
  subject:'Latch', requirements:'Keep the turning action', note:'Add amber highlights',
  data:{title:'Latch',controls:'Turn the dial',score:7,feedback:'PRIVATE_FEEDBACK',selfCheck:'PRIVATE_SELF_CHECK'},
};
const brief=[
  '### F1. Turn the latch',
  '### F5. Progression after one minute', 'Tuning'.repeat(1400),
  '### F8. The final jam', '### F9. Text at game over', '### F10. Crescendo for the final jam',
].join('\n');
const svg='<svg viewBox="0 0 540 960"><!--'+ 'x'.repeat(4400)+' --><path id="late-style-detail"/></svg>';
const assetBody='\n  const GAME_ASSETS = {draw(){}};\n  window.GAME_ASSETS = GAME_ASSETS;\n';
const assetHtml=`<script data-id="game-assets">not the asset</script><script id="game-assets">${assetBody}</script>`;
const html='<!doctype html><html><body><script>window.GAME_ASSETS = {};</script></body></html>';
const shots=Array.from({length:4},(_,i)=>({
  id:`build:baseline-${i+1}`,label:`viewport-${i+1}`,data:`data:image/jpeg;base64,${['AQ==','Ag==','Aw==','BA=='][i]}`,actionRefs:['build:tap'],
}));
const capture={shots,stage:'build',hash:'fixture-hash',probe:{actions:[{id:'build:tap'}]}};
const asText=(parts:ReturnType<typeof gameStageUser>)=>parts.map(part=>part.type==='text'?part.text:'').join('\n');

describe('新版创作材料',()=>{
  it('保留管理员模板，默认历史评分分布不进入策划，用户要求没有丢失',()=>{
    expect(CREATIVE_GUIDANCE_VERSION).toBe('pgc-minigame-v2');
    const customTemplate='## F. 独立管理员模板';
    const prompt=briefSystemV2({templateF:customTemplate,redlines:DEFAULT_REDLINES});
    expect(prompt).toContain(customTemplate);
    expect(prompt).not.toContain('37%');
    expect(prompt).toContain('制作需求清单');
    expect(prompt).toContain('核心改动');
    expect(briefSystemV2({templateF:DEFAULT_TEMPLATE_F,redlines:'管理员提醒：提醒层不要遮住目标。'})).toContain('提醒层不要遮住目标');
    const user=briefUserV2(topic);
    expect(user).toContain(topic.requirements);
    expect(user).toContain(topic.note);
    expect(user).not.toMatch(/PRIVATE_|"score"/);
  });

  it('样板图独立生成，完整 F 策划和已锁定样板图持续交给资产和制作',()=>{
    expect(PREVIEW_SYSTEM_V2).toContain('只输出完整 SVG');
    expect(ASSETS_SYSTEM_V2).toContain('样板图是独立的上游产物');
    expect(previewUserV2(topic,brief)).toContain(brief);
    expect(assetsUserV2(topic,brief,svg)).toContain(svg);
    const user=asText(gameStageUser('build',{topic,brief,styleSvg:svg,assetHtml}));
    expect(user).toContain(brief);
    expect(user).toContain(svg);
    expect(user).toContain(`<script id="game-assets">${assetBody}</script>`);
    expect(extractGameAssetScript(assetHtml)).toBe(assetBody);
    expect(extractGameAssetScript('<script data-id="game-assets">bad</script>')).toBe('');
    expect(gameStageSystem('build')).not.toMatch(/220 行|15KB|后期.*留/);
  });

  it('精修携带真实原图，文字模型保留运行记录并说明缺图',()=>{
    const parts=gameStageUser('polish',{topic,brief,html,capture});
    expect(parts.filter(part=>part.type==='image')).toEqual(shots.map(shot=>({type:'image',data:shot.data})));
    expect(asText(parts)).toContain(html);
    expect(asText(parts)).toContain('build:tap');
    expect(asText(parts)).toContain('build:baseline-4');
    expect(asText(parts)).not.toContain('data:image/jpeg');
    const textOnly=JSON.stringify(withoutImages(parts));
    expect(textOnly).toContain('4 张截图没有发送');
    expect(textOnly).toContain('fixture-hash');
    expect(textOnly).not.toContain('build:baseline-4');
    expect(gameStageSystem('polish')).toContain('未试听');
    expect(gameStageSystem('polish')).toContain('未测真机性能');
    expect(()=>gameStageUser('polish',{topic,brief,html,capture:{...capture,shots:shots.slice(0,3)}})).toThrow('四张');
    expect(()=>gameStageUser('repair',{topic,brief,html,capture:{...capture,shots:[...shots.slice(1),shots[1]]}})).toThrow('四张');
  });

  it.each([
    ['build',GAME_BUILD_SCHEMA],
    ['polish',GAME_POLISH_SCHEMA],
    ['repair',GAME_REPAIR_SCHEMA],
  ] as const)('%s 的输出使用准确顶层字段和可无损解码的 HTML 字符串', (stage,schema)=>{
    const system=gameStageSystem(stage);
    const keyList=system.match(/顶层字段恰好是 (.*?)。/)?.[1];
    expect(keyList?.split('、').map(key=>JSON.parse(key))).toEqual(schema.required);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.html).toMatchObject({type:'string'});
    const encodedExample=system.split('这段字符串只演示转义。\n')[1]?.split('\n')[0];
    expect(JSON.parse(encodedExample)).toBe('<canvas id="game"></canvas>\n<script>\tconst pattern = /\\d+/;</script>');
    expect(system).toContain('不要在对象外输出 Markdown 代码围栏');
    expect(system).toContain('HTML 中不要嵌入 pgc:check');
    const input=gameStageUser(stage,{topic,brief,html,capture});
    expect(input.at(-1)).toMatchObject({type:'text',text:expect.stringContaining('正确转义的 "html" 字符串')});
  });

  it.each([
    ['build',GAME_BUILD_SCHEMA],
    ['polish',GAME_POLISH_SCHEMA],
    ['repair',GAME_REPAIR_SCHEMA],
  ] as const)('%s 的平台格式将原始 HTML 与严格的 JSON 记录分开', (stage,schema)=>{
    const system=gameStageSystem(stage,'framed');
    expect(system.match(/^<\/?PGC_(?:HTML|RECORD)>$/gm)).toEqual([
      '<PGC_HTML>','</PGC_HTML>','<PGC_RECORD>','</PGC_RECORD>',
    ]);
    expect(system).toContain('<PGC_HTML>\n<!doctype html>');
    expect(system).toContain('</html>\n</PGC_HTML>\n<PGC_RECORD>');
    expect(system).toContain('直接输出 HTML 原文');
    expect(system).not.toMatch(/以 JSON 的 html 字段交付|顶层 "html" 字段|JSON\.stringify/);
    expect(system).toContain('HTML 中不要嵌入 pgc:check');
    const metadata=JSON.parse(system.split('【记录 JSON Schema】\n')[1]);
    const {html: _html,...recordProperties}=schema.properties;
    expect(metadata).toEqual({...schema,properties:recordProperties,required:schema.required.filter(name=>name!=='html')});
    const material={topic,brief,html,capture};
    const framed=gameStageUser(stage,material,'framed');
    expect(framed.at(-1)).toMatchObject({type:'text',text:expect.stringContaining('PGC_HTML 和 PGC_RECORD')});
    expect(asText(framed)).not.toContain('正确转义的 "html" 字符串');
    const agent=gameStageUser(stage,material);
    expect(agent).toEqual(gameStageUser(stage,material,'json'));
    expect(gameStageSystem(stage)).toBe(gameStageSystem(stage,'json'));
    expect(gameStageSystem(stage)).not.toMatch(/PGC_HTML|PGC_RECORD/);
    expect(framed.slice(0,-1)).toEqual(agent.slice(0,-1));
  });

  it('自检作为独立结构，返工不得要求额外返工',()=>{
    expect(GAME_BUILD_SCHEMA.required).toEqual(['html','requirements','decisions','coreChanges']);
    expect(GAME_POLISH_SCHEMA.properties.selfCheck.required).toContain('findings');
    expect(GAME_POLISH_SCHEMA.properties.selfCheck.properties.findings.items.required).toContain('evidenceRefs');
    expect(GAME_REPAIR_SCHEMA.properties.selfCheck.properties.requestRepair.enum).toEqual([false]);
    expect(gameStageSystem('repair')).toContain('不能证实就保持现状');
    expect(gameStageSystem('repair')).toContain('不能写进 HTML');
  });
});
