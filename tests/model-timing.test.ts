import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {modelTransport} from '../server/model';
import {createModelThrottle} from '../server/model-throttle';
import {tryModelSlot} from '../server/model-capacity';
vi.mock('../server/model-throttle',async original=>({...await original<typeof import('../server/model-throttle')>(),createModelThrottle:vi.fn()}));
vi.mock('../server/model-capacity',async original=>({...await original<typeof import('../server/model-capacity')>(),tryModelSlot:vi.fn()}));
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const config={baseUrl:'https://fixture.invalid',model:'fixture',apiKey:'SYNTHETIC'};
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(100000);vi.mocked(createModelThrottle).mockReturnValue({wait:async()=>{},cooldown:async()=>{}});vi.mocked(tryModelSlot).mockResolvedValue({release:async()=>{}});});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.resetAllMocks();});
describe('transport timing and bounded noncritical updates',()=>{
 it('separates capacity, pacing and actual request; nonstream first text is a complete response',async()=>{
  vi.mocked(tryModelSlot).mockImplementation(async()=>{await sleep(80);return {release:async()=>{}};});
  vi.mocked(createModelThrottle).mockReturnValue({wait:async()=>{await sleep(50);},cooldown:async()=>{}});
  vi.stubGlobal('fetch',vi.fn(async()=>{await sleep(30);return Response.json({choices:[{message:{content:'READY'}}]});}));
  let metrics:any;const response=modelTransport(config,{onStart:async()=>{await sleep(20);},onMetrics:async m=>{metrics=m;}})([]);
  await vi.advanceTimersByTimeAsync(180);await expect(response).resolves.toBe('READY');
  expect(metrics).toMatchObject({capacityWaitMs:80,throttleWaitMs:50,retryWaitMs:0,requestMs:30,firstResponseMs:30,firstTextFromRequestMs:30,firstTextKind:'complete-response',firstTextMs:180,elapsedMs:180,attempts:1});
 });
 it('measures stream text from request dispatch separately from response headers',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>{await sleep(100);return new Response(new ReadableStream({start(c){setTimeout(()=>{c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"READY"}}]}\n\ndata: [DONE]\n\n'));c.close();},100);}}),{headers:{'content-type':'text/event-stream'}});}));
  let metrics:any;const response=modelTransport(config,{onMetrics:async m=>{metrics=m;}})([]);
  await vi.advanceTimersByTimeAsync(200);await expect(response).resolves.toBe('READY');expect(metrics).toMatchObject({requestMs:200,firstResponseMs:100,firstTextFromRequestMs:200,firstTextKind:'stream-text'});
 });
 it('reports transport backoff apart from active request time and counts actual HTTP attempts',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(new Response('',{status:429,headers:{'retry-after':'1'}})).mockImplementationOnce(async()=>{await sleep(100);return Response.json({choices:[{message:{content:'READY'}}]});});vi.stubGlobal('fetch',fetcher);
  let metrics:any;const response=modelTransport(config,{onMetrics:async m=>{metrics=m;}})([]);
  await vi.advanceTimersByTimeAsync(1100);await expect(response).resolves.toBe('READY');expect(metrics).toMatchObject({retryWaitMs:1000,requestMs:100,attempts:2,elapsedMs:1100});
 });
 it('a hung activity/progress write does not block protocol completion or cause replay',async()=>{
  const activity=vi.fn(()=>new Promise<void>(()=>{})),progress=vi.fn(()=>new Promise<void>(()=>{}));
  const fetcher=vi.fn(async()=>new Response('data: {"choices":[{"delta":{"content":"READY"}}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}}));vi.stubGlobal('fetch',fetcher);
  await expect(modelTransport(config,{onActivity:activity,onProgress:progress,timeoutMs:100})([])).resolves.toBe('READY');expect(activity).toHaveBeenCalledOnce();expect(progress).toHaveBeenCalledOnce();expect(fetcher).toHaveBeenCalledOnce();
 });
 it('only one update batch runs while a slow write is in flight; pending snapshots are coalesced',async()=>{
  let unblock!:()=>void;const activity=vi.fn(()=>new Promise<void>(r=>{unblock=r;}));
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(new ReadableStream({start(c){const send=(text:string)=>c.enqueue(new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"${text}"}}]}\n\n`));send('A');setTimeout(()=>send('B'),6000);setTimeout(()=>send('C'),12000);setTimeout(()=>{c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));c.close();},13000);}}),{headers:{'content-type':'text/event-stream'}})));
  const response=modelTransport(config,{onActivity:activity,totalTimeoutMs:20000})([]);await vi.advanceTimersByTimeAsync(12000);expect(activity).toHaveBeenCalledOnce();unblock();await vi.advanceTimersByTimeAsync(0);expect(activity).toHaveBeenCalledTimes(2);expect(activity.mock.calls[1]).toEqual(['output',3]);unblock();await vi.advanceTimersByTimeAsync(1000);await expect(response).resolves.toBe('ABC');
 });
 it('does not count a paid attempt or request duration when critical authorization fails before fetch',async()=>{
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);let metrics:any;
  await expect(modelTransport(config,{onStart:async()=>{throw new Error('synthetic permission revoked');},onMetrics:async m=>{metrics=m;}})([])).rejects.toThrow('synthetic permission revoked');
  expect(fetcher).not.toHaveBeenCalled();expect(metrics).toMatchObject({status:'error',attempts:0,requestMs:0,firstResponseMs:null,firstTextFromRequestMs:null,firstTextKind:null});
 });

});
