import {describe,expect,it} from 'vitest';
import {forgeApi} from '../server/forge-api';
import {login} from '../server/settings';
import type {MemberStore} from '../server/members';

const secrets={ADMIN_PASSWORD:'test-only-admin',SETTINGS_KEY:'test-only-secret'};
const members:MemberStore={list:async()=>[],byId:async()=>null,byUsername:async()=>null,save:async()=>{}};
function env(brief='# Test\n\nComplete brief.\n'){
  return {...secrets,modelStore:{get:async()=>null,set:async()=>{}},DB:{prepare:()=>({bind:()=>({first:async()=>({id:9,data:JSON.stringify({title:'Test "Title"'}),brief_md:brief})})})}};
}

describe('简报文件下载',()=>{
  it('管理员取得完整 Markdown 附件，文件名经过处理且不缓存',async()=>{
    const token=await login(secrets.ADMIN_PASSWORD,secrets);
    const response=await forgeApi(new Request('https://pgc.example/api/forge/topics/9/brief',{headers:{Cookie:`pgc_admin=${token}`}}),env(),['topics','9','brief'],members);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/markdown');
    expect(response.headers.get('Content-Disposition')).toContain("filename*=UTF-8''Test-Title--brief.md");
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await response.text()).toBe('# Test\n\nComplete brief.\n');
  });
  it('未登录或尚无简报时不返回伪文件',async()=>{
    const request=new Request('https://pgc.example/api/forge/topics/9/brief');
    expect((await forgeApi(request,env(),['topics','9','brief'],members)).status).toBe(401);
    const token=await login(secrets.ADMIN_PASSWORD,secrets);
    expect((await forgeApi(new Request(request,{headers:{Cookie:`pgc_admin=${token}`}}),env(''),['topics','9','brief'],members)).status).toBe(409);
  });
});
