import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {build} from 'esbuild';
import {resolve} from 'node:path';
import {Miniflare,Response as MockResponse} from 'miniflare';

const api='https://creator-hub-7mi.pages.dev/api/integrations/feedback/v1';
const syntheticToken='synthetic-runtime-feedback-token';
const contract={version:1,scopeRevision:3,dataset:'ordinary_games',authorScope:'all',fileVersionCount:0,idNamespace:'integration_pseudonym',historySince:null,pollingSeconds:120,snapshotsExpireHours:24,pagination:{defaultLimit:20,maxLimit:50},rateLimit:{requestsPerMinute:120}};
let runtime:Miniflare|undefined;
let status=200,location='https://redirect-target.invalid/do-not-follow';
const outbound:{url:string;method:string;authorization:string|null;cookie:string|null}[]=[];

// These requests execute the bundled production client inside actual workerd,
// including its native fetch and Request implementation. No injected client
// fetcher or global fetch mock can mask unsupported RequestInit options.
// The catch-all Miniflare outbound service is local and never delegates to the
// network, including for an accidental redirect to any other origin.
beforeAll(async()=>{
 const bundle=await build({stdin:{contents:`
  import {CreatorFeedbackClient} from ${JSON.stringify(resolve('server/creator-feedback-client.ts'))};
  export default {async fetch(){
   try{return Response.json({contract:await new CreatorFeedbackClient(${JSON.stringify(syntheticToken)},{timeoutMs:3000}).contract()});}
   catch(error){return Response.json({code:error.code,message:error.message,status:error.status},{status:502});}
  }};
 `,resolveDir:process.cwd(),sourcefile:'creator-feedback-runtime-entry.ts',loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
 runtime=new Miniflare({
  host:'127.0.0.1',port:0,cf:false,telemetry:{enabled:false},
  workers:[{
   config:{name:'creator-feedback-runtime-test',compatibilityDate:'2026-10-23',manifest:{mainModule:'index.js',modules:{'index.js':{type:'esm',contents:bundle.outputFiles[0].text}}}},
   dev:{outboundService:{type:'fetcher',handler(request){
    outbound.push({url:request.url,method:request.method,authorization:request.headers.get('Authorization'),cookie:request.headers.get('Cookie')});
    // Even a regression that follows a redirect is trapped locally here.
    if(request.url!==api+'/contract')return new MockResponse('Unexpected synthetic destination',{status:418});
    if(status>=300&&status<400)return new MockResponse('Synthetic redirect body '+syntheticToken,{status,headers:{Location:location}});
    return MockResponse.json({...contract,unexpectedCredential:syntheticToken});
   }}},
  }],
 });
 await runtime.ready;
},30_000);
afterAll(async()=>{await runtime?.dispose();},30_000);
beforeEach(()=>{status=200;location='https://redirect-target.invalid/do-not-follow';outbound.length=0;});

describe('CreatorFeedbackClient native workerd requests',()=>{
 it('constructs the request, reaches only the local mock upstream and parses the contract',async()=>{
  const response=await runtime!.dispatchFetch('https://synthetic-pgc.invalid/contract',{headers:{Cookie:'pgc_admin=synthetic-inbound-cookie',Authorization:'Bearer synthetic-inbound-device'}});
  expect(response.status).toBe(200);expect(await response.json()).toEqual({contract});
  expect(outbound).toEqual([{url:api+'/contract',method:'GET',authorization:'Bearer '+syntheticToken,cookie:null}]);
 });
 it.each([301,302,303,307,308])('rejects HTTP %i before following Location or sending Bearer to another destination',async redirect=>{
  status=redirect;
  const response=await runtime!.dispatchFetch('https://synthetic-pgc.invalid/contract');
  expect(response.status).toBe(502);expect(await response.json()).toEqual({code:'invalid_response',message:'Invalid feedback provider response.',status:0});
  expect(outbound).toHaveLength(1);expect(outbound[0]).toMatchObject({url:api+'/contract',authorization:'Bearer '+syntheticToken});
  expect(outbound.some(request=>request.url.startsWith('https://redirect-target.invalid'))).toBe(false);
 });
 it('also refuses a same-origin redirect rather than forwarding Bearer to an unintended API path',async()=>{
  status=302;location=api+'/unintended-path';
  const response=await runtime!.dispatchFetch('https://synthetic-pgc.invalid/contract');
  expect(response.status).toBe(502);expect((await response.json() as any).code).toBe('invalid_response');
  expect(outbound).toHaveLength(1);expect(outbound[0].url).toBe(api+'/contract');
 });
});
