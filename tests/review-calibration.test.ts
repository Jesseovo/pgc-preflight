import {describe,expect,it} from 'vitest';
import {reviewSystem} from '../server/forge/prompts.js';
import {exampleSets} from '../server/forge/logic.js';
import {consistentVerdict} from '../server/forge-api';

const game=(title:string,score:number,status='approved',revisions=1,feedback='')=>({title,descr:'d',status,score,aes:3,ease:2,play:2,revisions,feedback,subject:'',medium:'',gesture:'',structure:''});

describe('审核校准样本',()=>{
  it('分出高分、刚好通过（7 分）和打回三组',()=>{
    const {positives,borderline,negatives}=exampleSets([
      game('High',9),game('Line',7),game('LineSlow',7,'approved',4,'改了好几轮'),game('Low',6,'rejected',1,'太难'),
    ]);
    expect(positives.map((g:ReturnType<typeof game>)=>g.title)).toEqual(['High']);
    expect(borderline.map((g:ReturnType<typeof game>)=>g.title)).toEqual(['Line','LineSlow']);
    expect(negatives.map((g:ReturnType<typeof game>)=>g.title)).toContain('Low');
  });
});

describe('审核提示词',()=>{
  const text=reviewSystem({redlines:'【雷区】- 有开始页或封面页。',positives:[game('High',9)],borderline:[game('Line',7)],negatives:[game('Low',6,'rejected',1,'太难')]});
  it('明确英文是平台要求，不是缺陷',()=>{
    expect(text).toContain('界面全英文是平台要求');
  });
  it('给出三项的 1–3 分锚点和真实分布，不再以 2/2/2 为默认',()=>{
    expect(text).toMatch(/美学\n- 3：/);
    expect(text).toContain('通过的游戏大多恰好 7 分');
    expect(text).not.toContain('2/2/2 是常态');
  });
  it('合规判定放在雷区之后，澄清开局手势提示、一命制和技术缺陷的扣分上限',()=>{
    expect(text.indexOf('【合规判定')).toBeGreaterThan(text.indexOf('【雷区】'));
    expect(text).toContain('叠一层手势提示，第一次触摸就开局，这是合规的');
    expect(text).toContain('最多让它所属的那一项少 1 分');
  });
  it('列出刚好通过的样本',()=>{
    expect(text).toMatch(/【校准样本：刚好通过（7 分）】\n- Line/);
  });
});

describe('结论与总分一致',()=>{
  it('与分数相符时保留原文，不符时以分数为准',()=>{
    expect(consistentVerdict('打回：缺 BGM',6)).toBe('打回：缺 BGM');
    expect(consistentVerdict('通过，但要补 BGM',7)).toBe('通过，但要补 BGM');
    expect(consistentVerdict('勉强通过（7/9）',7)).toBe('通过（7/9）。勉强通过（7/9）');
    expect(consistentVerdict('通过',6)).toBe('打回（6/9）。通过');
    expect(consistentVerdict('',8)).toBe('通过（8/9）');
  });
});
