import {afterEach,describe,expect,it,vi} from 'vitest';
import {adminApi} from '../server/admin-api';
import {login,saveConfig,type ModelConfig} from '../server/settings';
import type {MemberStore} from '../server/members';

const key='synthetic-capability-key';
const origin='https://capability.test';
const provider='https://riffle-api.pages.dev/v1/models';
const model='claude-opus-5-5';
const payload={object:'list',data:[
  {id:'another-model',max_output_tokens:999_999,description:'other source material'},
  {id:model,description:'DO_NOT_ECHO_DESCRIPTION',apiKey:key,[key]:true,max_output_tokens:65536,context_window:200000,max_input_tokens:null,
    capabilities:{supports_vision:true,thinking:{type:'adaptive',supported_efforts:['low','high','high','xhigh',key,'DO_NOT_ECHO_MODE']},
      output_config:{effort:{enum:['max',key]}},streaming:false,new_feature:{raw_value:'DO_NOT_ECHO_VALUE'}}},
]};
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

async function setup(baseUrl='https://riffle-api.pages.dev',modelName=model){
  let config:ModelConfig|null=null;
  const secrets={ADMIN_PASSWORD:'synthetic-admin-password',SETTINGS_KEY:'synthetic-settings-secret'};
  const store={get:vi.fn(async()=>config),set:vi.fn(async(value:ModelConfig)=>{config=value;})};
  await saveConfig({profile:'opus',baseUrl,protocol:'anthropic',model:modelName,apiKey:key},store,secrets.SETTINGS_KEY);
  store.set.mockClear();
  const cookie='pgc_admin='+await login(secrets.ADMIN_PASSWORD,secrets);
  const call=(options:{headers?:Record<string,string>;method?:string;profile?:string}={})=>{
    const {headers={Cookie:cookie},method='GET',profile='opus'}=options;
    const request=new Request(origin+'/api/admin/model-capabilities?profile='+encodeURIComponent(profile),{method,headers});
    return adminApi(request,store,secrets,{} as MemberStore);
  };
  return {call,cookie,store};
}

describe('saved-key Riffle model metadata',()=>{
  it('requires the administrator cookie and refuses device Authorization or a non-GET request',async()=>{
    const s=await setup(),fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    expect((await s.call({headers:{}}))?.status).toBe(401);
    expect((await s.call({headers:{Cookie:'pgc_member=fixture'}}))?.status).toBe(401);
    expect((await s.call({headers:{Cookie:s.cookie,Authorization:'Bearer fixture-device'}}))?.status).toBe(403);
    expect((await s.call({headers:{Cookie:s.cookie,Origin:origin},method:'POST'}))?.status).toBe(405);
    expect((await s.call({profile:'__proto__'}))?.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    expect(s.store.set).not.toHaveBeenCalled();
  });

  it('pins the destination and matches only the configured model, exposing safe capability values and unknown field types',async()=>{
    const s=await setup();
    const fetcher=vi.fn(async(url:string,init:RequestInit)=>{
      expect(url).toBe(provider);
      expect(init).toMatchObject({method:'GET',redirect:'manual'});
      const headers=new Headers(init.headers);
      expect(headers.get('Authorization')).toBe('Bearer '+key);
      expect(headers.has('Cookie')).toBe(false);
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return Response.json(payload);
    });vi.stubGlobal('fetch',fetcher);
    const response=await s.call();
    expect(response?.status).toBe(200);
    expect(response?.headers.get('Cache-Control')).toBe('no-store');
    const data=await response?.json() as any;
    expect(data).toMatchObject({profile:'opus',model,source:'riffle-model-list',capabilities:{
      max_output_tokens:65536,context_window:200000,'capabilities.supports_vision':true,'capabilities.thinking.type':'adaptive',
      'capabilities.thinking.supported_efforts':['low','high','xhigh'],'capabilities.output_config.effort.enum':['max'],'capabilities.streaming':false,
    }});
    expect(data.capabilities).not.toHaveProperty('max_input_tokens');
    expect(data.fields).toContainEqual({name:'max_input_tokens',type:'null'});
    expect(data.fields).toContainEqual({name:'capabilities.new_feature.raw_value',type:'string'});
    expect(JSON.stringify(data)).not.toMatch(/DO_NOT_ECHO|synthetic-capability-key|another-model|999999|apiKey/);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(s.store.set).not.toHaveBeenCalled();
  });

  it.each([['https://riffle-api.pages.dev.attacker.invalid',model],['https://riffle-api.pages.dev','claude-sonnet-4-6']])('never sends a stored key for an unsupported profile %s %s',async(address,name)=>{
    const s=await setup(address,name),fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    expect((await s.call())?.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects redirects, HTTP errors, transport failures and model mismatches without exposing upstream text',async()=>{
    const s=await setup(),fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    for(const scenario of [
      ()=>new Response(key,{status:302,headers:{Location:'https://attacker.invalid/'+key}}),
      ()=>new Response(key,{status:401}),
      ()=>{throw new Error('upstream credential '+key);},
      ()=>Response.json({data:[{id:'wrong-model',description:key}]}),
      ()=>Response.json({data:[{id:model},{id:model,description:key}]}),
    ]){
      fetcher.mockImplementationOnce(scenario);
      const response=await s.call();
      expect(response?.status).toBe(502);
      expect(await response?.text()).not.toMatch(/attacker|upstream credential|synthetic-capability-key/);
    }
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(fetcher.mock.calls.every(([url,init])=>url===provider&&init.redirect==='manual')).toBe(true);
  });

  it('cancels oversized response bodies before parsing with or without Content-Length',async()=>{
    const s=await setup(),fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    const makeStream=()=>{
      const cancel=vi.fn(),stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(70*1024));controller.enqueue(new Uint8Array(70*1024));},cancel});
      return {stream,cancel};
    };
    for(const headers of [new Headers(),new Headers({'Content-Length':String(256*1024)})]){
      const {stream,cancel}=makeStream();
      fetcher.mockResolvedValueOnce(new Response(stream,{headers}));
      const response=await s.call();
      expect(response?.status).toBe(502);
      expect(await response?.text()).toContain('安全读取上限');
      expect(cancel).toHaveBeenCalledOnce();
    }
  });

  it('cancels an in-flight body read on the full-request deadline',async()=>{
    const s=await setup(),controller=new AbortController(),cancel=vi.fn();
    const deadline=vi.spyOn(AbortSignal,'timeout').mockReturnValue(controller.signal);
    const stream=new ReadableStream({pull(){controller.abort();},cancel});
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(stream)));
    const response=await s.call();
    expect(deadline).toHaveBeenCalledWith(15_000);
    expect(response?.status).toBe(504);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
