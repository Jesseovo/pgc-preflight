import {describe,expect,it} from 'vitest';
import {activeModelProfile,activateProfile,publicConfig,saveConfig,saveRoutes} from '../server/settings';
import type {ModelConfig,ConfigStore} from '../server/settings';
import {withoutImages,routedModel} from '../server/forge-llm';

const SECRET='test-only-encryption-key';
async function twoProfiles(){
  let current:ModelConfig|null=null;
  const store:ConfigStore={get:async()=>current,set:async config=>{current=config;}};
  await saveConfig({profile:'deepseek',baseUrl:'https://deepseek.example/v1',model:'deepseek-chat',apiKey:'deepseek-key',vision:false},store,SECRET);
  await saveConfig({profile:'opus',protocol:'anthropic',baseUrl:'https://riffle-api.pages.dev',model:'claude-opus-5-5',apiKey:'opus-key'},store,SECRET);
  return {store,get:()=>current};
}

describe('模型按用途分配',()=>{
  it('未分配的用途跟随全局模型，分配后审核和创作各用各的',async()=>{
    const {store,get}=await twoProfiles();
    expect(activeModelProfile(get(),'review')?.id).toBe('deepseek');
    expect(activeModelProfile(get(),'create')?.id).toBe('deepseek');
    await saveRoutes({review:'deepseek',create:'opus'},store);
    expect(activeModelProfile(get(),'review')?.id).toBe('deepseek');
    expect(activeModelProfile(get(),'create')?.id).toBe('opus');
    expect(routedModel(get(),'create')).toBe('claude-opus-5-5');
    expect(publicConfig(get()).effective).toEqual({review:'deepseek',create:'opus'});
    expect(JSON.stringify(publicConfig(get()))).not.toMatch(/deepseek-key|opus-key/);
  });
  it('切换全局模型和重新保存配置都不会丢失用途分配',async()=>{
    const {store,get}=await twoProfiles();
    await saveRoutes({create:'opus'},store);
    await activateProfile('opus',store);
    await saveConfig({profile:'deepseek',baseUrl:'https://deepseek.example/v1',model:'deepseek-chat',apiKey:'',vision:false},store,SECRET);
    expect(get()?.routes).toEqual({create:'opus'});
    expect(activeModelProfile(get(),'review')?.id).toBe('opus');
  });
  it('没有密钥的模型不能分配，非法值被拒绝，空值回到跟随全局',async()=>{
    let current:ModelConfig|null=null;
    const store:ConfigStore={get:async()=>current,set:async config=>{current=config;}};
    await saveConfig({profile:'deepseek',baseUrl:'https://deepseek.example/v1',model:'deepseek-chat',apiKey:'k'},store,SECRET);
    await expect(saveRoutes({create:'opus'},store)).rejects.toThrow('还没有保存 API Key');
    await expect(saveRoutes({review:'gpt'},store)).rejects.toThrow('不正确');
    const saved=await saveRoutes({review:''},store);
    expect(saved.routes).toBeUndefined();
  });
  it('能否看图片跟随每个模型保存，默认可以',async()=>{
    const {get}=await twoProfiles();
    expect(get()?.profiles?.deepseek?.vision).toBe(false);
    expect(publicConfig(get()).profiles.opus.vision).toBe(true);
  });
});

describe('不能看图片的审核模型',()=>{
  it('去掉截图和它们的说明，加一句提示，其余内容保留',()=>{
    const parts=[{type:'text',text:'截图：9:16 开局前'},{type:'image',data:'data:image/jpeg;base64,AAA'},{type:'text',text:'截图：9:21'},{type:'image',data:'data:image/jpeg;base64,BBB'},{type:'text',text:'【源码】…'}];
    const out=withoutImages(parts) as Array<Record<string,string>>;
    expect(out.some(p=>p.type==='image')).toBe(false);
    expect(out.some(p=>p.text?.startsWith('截图：'))).toBe(false);
    expect(out[0].text).toContain('2 张截图没有发送');
    expect(out.at(-1)?.text).toBe('【源码】…');
    expect(withoutImages('纯文本')).toBe('纯文本');
  });
});
