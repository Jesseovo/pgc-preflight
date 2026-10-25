import {describe,expect,it} from 'vitest';
import {activateProfile,authorized,login,encryptKey,decryptKey,resolveModel,saveConfig,publicConfig,validateModelFields} from '../server/settings';
import type {ModelConfig,ConfigStore} from '../server/settings';
import {parseDecision} from '../server/model';

describe('管理与密钥',()=>{
  const secrets={ADMIN_PASSWORD:'test-only-admin-password',SETTINGS_KEY:'test-only-encryption-key'};
  it('登录签名不能被篡改，错误密码不能登录',async()=>{
    expect(await login('wrong',secrets)).toBe(null);
    const token=await login(secrets.ADMIN_PASSWORD,secrets);
    expect(await authorized(`pgc_admin=${token}`,secrets)).toBe(true);
    expect(await authorized(`pgc_admin=${token}x`,secrets)).toBe(false);
    expect(await authorized(`pgc_admin=1.${token?.split('.')[1]}`,secrets)).toBe(false);
    expect(await authorized(null,secrets)).toBe(false);
  });
  it('加密密钥不以明文保存且无法用错误主密钥解密',async()=>{
    const encrypted=await encryptKey('test-only-api-key',secrets.SETTINGS_KEY);
    expect(encrypted).not.toContain('test-only-api-key');
    expect(await decryptKey(encrypted,secrets.SETTINGS_KEY)).toBe('test-only-api-key');
    await expect(decryptKey(encrypted,'wrong-secret')).rejects.toThrow();
  });
  it('配置回读不泄漏密钥，更换服务商必须重新填写密钥',async()=>{
    let current:ModelConfig|null=null;
    const store:ConfigStore={get:async()=>current,set:async config=>{current=config;}};
    const config=await saveConfig({baseUrl:'https://provider.example/v1/chat/completions',model:'vision-model',apiKey:'test-only-api-key'},store,secrets.SETTINGS_KEY);
    expect(config.baseUrl).toBe('https://provider.example/v1');
    expect(JSON.stringify(publicConfig(config))).not.toContain('test-only-api-key');
    expect(publicConfig(config).hasKey).toBe(true);
    await expect(saveConfig({baseUrl:'https://other.example/v1',model:'vision-model',apiKey:''},store,secrets.SETTINGS_KEY)).rejects.toThrow('重新填写');
  });
  it('保留 DeepSeek 与 Opus 两套密钥，并可切换当前模型',async()=>{
    let current:ModelConfig|null=null;
    const store:ConfigStore={get:async()=>current,set:async config=>{current=config;}};
    await saveConfig({profile:'deepseek',baseUrl:'https://deepseek.example/v1',model:'deepseek-chat',apiKey:'deepseek-key'},store,secrets.SETTINGS_KEY);
    await saveConfig({profile:'opus',protocol:'anthropic',baseUrl:'https://riffle-api.pages.dev',model:'claude-opus-5-5',apiKey:'opus-key'},store,secrets.SETTINGS_KEY);
    expect(publicConfig(current).activeProfile).toBe('deepseek');
    expect(publicConfig(current).profiles.opus.hasKey).toBe(true);
    expect(JSON.stringify(publicConfig(current))).not.toContain('opus-key');
    await activateProfile('opus',store);
    await expect(resolveModel(current,secrets.SETTINGS_KEY)).resolves.toMatchObject({protocol:'anthropic',model:'claude-opus-5-5',apiKey:'opus-key'});
  });
  it('拒绝带凭据、内网或非 HTTPS 的模型地址',()=>{
    for(const baseUrl of ['http://provider.example','https://user:pass@provider.example','https://127.0.0.1/v1','https://192.168.0.1/v1'])expect(()=>validateModelFields({baseUrl,model:'test'})).toThrow();
  });
});
describe('模型协议',()=>{
  it('接受模型动作和结论，保持模型的审核结果',()=>{
    expect(parseDecision('{"action":{"type":"tap","x":120,"y":200},"reason":"开始"}')).toHaveProperty('action.type','tap');
    const result=parseDecision(JSON.stringify({report:{title:'test',status:'review',findings:[{category:'runtime',status:'review',title:'需确认',detail:'由模型判断'}],uncovered:[]}}));
    expect(result).toHaveProperty('report.status','review');
  });
  it('拒绝损坏或不完整的模型报告，不伪造通过',()=>{
    expect(()=>parseDecision('not json')).toThrow();
    expect(()=>parseDecision('{"report":{"status":"pass","findings":[]}}')).toThrow();
    expect(()=>parseDecision('{"action":{"type":"fetch-secret"}}')).toThrow();
  });
});
