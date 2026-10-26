import {describe,expect,it} from 'vitest';
import {forgeApi,cleanAssetsHtml,composeBrief,sameGame} from '../server/forge-api';
import {login} from '../server/settings';
import type {MemberStore} from '../server/members';

const secrets={ADMIN_PASSWORD:'test-only-admin',SETTINGS_KEY:'test-only-secret'};
const members:MemberStore={list:async()=>[],byId:async()=>null,byUsername:async()=>null,save:async()=>{}};
const GOOD='<!doctype html><html><head><title>A</title></head><body><canvas></canvas><script id="game-assets">const GAME_ASSETS={sprites:{}};window.GAME_ASSETS=GAME_ASSETS;</script></body></html>';

function env(topic:Record<string,unknown>){
  const row={id:9,data:JSON.stringify({title:'Test "Title"'}),brief_md:'',assets_html:null,brief_status:'',assets_status:'',...topic};
  return {...secrets,modelStore:{get:async()=>null,set:async()=>{}},DB:{prepare:()=>({bind:()=>({first:async()=>row,all:async()=>({results:[]}),run:async()=>({meta:{changes:1}})})})}};
}
async function call(path:string,route:string[],topic:Record<string,unknown>,method='GET'){
  const token=await login(secrets.ADMIN_PASSWORD,secrets);
  return forgeApi(new Request(`https://pgc.example/api/forge/${path}`,{method,headers:{Cookie:`pgc_admin=${token}`}}),env(topic) as any,route,members);
}

describe('美术资产 HTML',()=>{
  it('去掉代码块标记和外部资源，保留资产脚本',()=>{
    const html=cleanAssetsHtml('好的：\n```html\n'+GOOD.replace('<head>','<head><link rel="stylesheet" href="https://cdn.example/x.css"><script src="https://cdn.example/x.js"></script><base href="https://evil.example/">')+'\n```');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html.endsWith('</html>')).toBe(true);
    expect(html).not.toMatch(/cdn\.example|<base|<link/);
    expect(html).toContain('id="game-assets"');
  });
  it('输出被截断或缺少 GAME_ASSETS 时报错，不保存半成品',()=>{
    expect(()=>cleanAssetsHtml(GOOD.slice(0,-20))).toThrow('截断');
    expect(()=>cleanAssetsHtml('<!doctype html><html><body><canvas></canvas></body></html>')).toThrow('game-assets');
  });
  it('有资产时简报追加 H 节，没有时原样返回',()=>{
    expect(composeBrief({brief_md:'# B\n'})).toBe('# B\n');
    const withAssets=composeBrief({brief_md:'# B\n',assets_html:GOOD});
    expect(withAssets).toContain('## H. 美术资产');
    expect(withAssets).toContain('GAME_ASSETS');
    expect(composeBrief({brief_md:''})).toBe('');
  });
});

describe('审核校准样本排除被审游戏本身',()=>{
  it('同名、大小写和副标题都算同一款，短词不误伤',()=>{
    expect(sameGame('UMBRA','UMBRA — Shadow Theatre')).toBe(true);
    expect(sameGame("DON'T BLINK","Don't Blink")).toBe(true);
    expect(sameGame('Tongue Tied','tongue_tied')).toBe(true);
    expect(sameGame('Up','UPSIDE RUN')).toBe(false);
    expect(sameGame('Flatline','Dead Pixel')).toBe(false);
    expect(sameGame('','x')).toBe(false);
  });
});

describe('资产接口',()=>{
  it('下载为附件并在沙箱策略下返回',async()=>{
    const res=await call('topics/9/assets',['topics','9','assets'],{brief_md:'# B',assets_html:GOOD});
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(res.headers.get('Content-Disposition')).toContain("filename*=UTF-8''Test-Title--assets.html");
    expect(res.headers.get('Content-Security-Policy')).toBe('sandbox');
    expect(await res.text()).toBe(GOOD);
  });
  it('还没生成时下载返回 409',async()=>{
    expect((await call('topics/9/assets',['topics','9','assets'],{brief_md:'# B'})).status).toBe(409);
  });
  it('没有简报时不能生成资产',async()=>{
    const res=await call('topics/9/assets',['topics','9','assets'],{brief_md:''},'POST');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('先生成简报');
  });
  it('简报下载在有资产时带上 H 节',async()=>{
    const res=await call('topics/9/brief',['topics','9','brief'],{brief_md:'# B\n',assets_html:GOOD});
    expect(await res.text()).toContain('## H. 美术资产');
  });
});
