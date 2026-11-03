import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {CreatorFeedbackRunner,scheduleCreatorFeedback,feedbackEnabled} from '../server/creator-feedback-runner';
import {runFeedbackSync} from '../server/creator-feedback-sync';
import worker from '../server/worker';
vi.mock('../server/creator-feedback-sync',async importOriginal=>({...await importOriginal<typeof import('../server/creator-feedback-sync')>(),runFeedbackSync:vi.fn()}));
const sync=vi.mocked(runFeedbackSync);
beforeEach(()=>{vi.spyOn(Date,'now').mockReturnValue(1_000_000);sync.mockReset();sync.mockResolvedValue({status:'disabled',nextRunAt:null} as any);});
afterEach(()=>{vi.restoreAllMocks();});
function setup(enabled=true){
 let alarm:number|null=null;
 const storage={getAlarm:vi.fn(async()=>alarm),setAlarm:vi.fn(async(value:number)=>{alarm=value;}),deleteAlarm:vi.fn(async()=>{alarm=null;})};
 const env:any={DB:{prepare:vi.fn(()=>{throw new Error('Unexpected maintenance');})},...(enabled?{CREATOR_FEEDBACK_ENABLED:'true',CREATOR_FEEDBACK_TOKEN:'synthetic-token'}:{})};
 return {env,storage,runner:new CreatorFeedbackRunner({storage},env),alarm:()=>alarm,existing(value:number){alarm=value;}};
}
describe('isolated CreatorFeedbackRunner alarms',()=>{
 it('is opt-in and the scheduler makes no network call when disabled or missing a secret/binding',async()=>{
  const s=setup(false),fetch=vi.fn(),binding={idFromName:vi.fn(),get:vi.fn(()=>({fetch}))};s.env.CREATOR_FEEDBACK_RUNNER=binding;
  expect(feedbackEnabled(s.env)).toBe(false);expect(await scheduleCreatorFeedback(s.env)).toEqual({scheduled:false});
  s.env.CREATOR_FEEDBACK_ENABLED='true';expect(await scheduleCreatorFeedback(s.env)).toEqual({scheduled:false});
  s.env.CREATOR_FEEDBACK_TOKEN='   ';expect(await scheduleCreatorFeedback(s.env)).toEqual({scheduled:false});
  expect(fetch).not.toHaveBeenCalled();expect(binding.get).not.toHaveBeenCalled();
  expect(await scheduleCreatorFeedback({...s.env,CREATOR_FEEDBACK_TOKEN:'synthetic-token',CREATOR_FEEDBACK_RUNNER:undefined})).toEqual({scheduled:false});
 });
 it('dispatches a fixed private POST to the singleton and rejects a scheduler failure safely',async()=>{
  const s=setup(),fetch=vi.fn(async(request:Request)=>{expect(request.url).toBe('https://creator-feedback.internal/wake');expect(request.method).toBe('POST');expect(request.headers.get('Authorization')).toBeNull();return new Response('{}');});
  const binding={idFromName:vi.fn(()=> 'synthetic-id'),get:vi.fn(()=>({fetch}))};s.env.CREATOR_FEEDBACK_RUNNER=binding;
  expect(await scheduleCreatorFeedback(s.env)).toEqual({scheduled:true});expect(binding.idFromName).toHaveBeenCalledWith('creator-feedback-v1');
  fetch.mockResolvedValueOnce(new Response('synthetic private error',{status:503}));await expect(scheduleCreatorFeedback(s.env)).rejects.toThrow('Feedback scheduler unavailable');
 });
 it('accepts only the exact internal POST endpoint and leaves storage alone on every other request',async()=>{
  const s=setup();for(const [url,method] of [['https://creator-feedback.internal/wake','GET'],['https://evil.invalid/wake','POST'],['https://creator-feedback.internal/wake?x=1','POST'],['https://creator-feedback.internal/other','POST']])expect((await s.runner.fetch(new Request(url,{method}))).status).toBe(404);
  expect(s.storage.setAlarm).not.toHaveBeenCalled();expect(sync).not.toHaveBeenCalled();
 });
 it('a private wake creates an alarm but never shortens a durable Retry-After/backoff alarm',async()=>{
  const s=setup();const wake=()=>s.runner.fetch(new Request('https://creator-feedback.internal/wake',{method:'POST'}));
  expect((await wake()).status).toBe(200);expect(s.alarm()).toBe(1_000_100);
  s.existing(1_900_000);s.storage.setAlarm.mockClear();await wake();expect(s.alarm()).toBe(1_900_000);expect(s.storage.setAlarm).not.toHaveBeenCalled();expect(sync).not.toHaveBeenCalled();
 });
 it('uses a five-second continuation floor and preserves a provider Retry-After deadline',async()=>{
  const s=setup();sync.mockResolvedValueOnce({nextRunAt:1_000_001} as any);await s.runner.alarm();expect(s.alarm()).toBe(1_005_000);
  sync.mockResolvedValueOnce({nextRunAt:1_120_000} as any);await s.runner.alarm();expect(s.alarm()).toBe(1_120_000);
  sync.mockResolvedValueOnce({nextRunAt:1_900_000} as any);await s.runner.alarm();expect(s.alarm()).toBe(1_900_000);expect(sync).toHaveBeenLastCalledWith(s.env);
 });
 it('a null halted nextRunAt removes the alarm rather than polling revoked credentials',async()=>{
  const s=setup();s.existing(1_000_100);sync.mockResolvedValueOnce({status:'auth_revoked',nextRunAt:null} as any);await s.runner.alarm();expect(s.alarm()).toBeNull();expect(s.storage.deleteAlarm).toHaveBeenCalledOnce();
 });
 it('unknown database failures retain safe two-minute recovery without leaking thrown text',async()=>{
  const s=setup();const log=vi.spyOn(console,'error').mockImplementation(()=>{});sync.mockRejectedValueOnce(new Error('synthetic-token private payload'));
  await expect(s.runner.alarm()).resolves.toBeUndefined();expect(s.alarm()).toBe(1_120_000);expect(log).not.toHaveBeenCalled();
 });
 it('disabling or removing the secret purges private cache through the disabled engine before deleting the alarm',async()=>{
  for(const variant of ['disabled','missing-secret','blank-secret']){
   const s=setup();if(variant==='missing-secret')delete s.env.CREATOR_FEEDBACK_TOKEN;else if(variant==='blank-secret')s.env.CREATOR_FEEDBACK_TOKEN='   ';else s.env.CREATOR_FEEDBACK_ENABLED='false';s.existing(1_900_000);sync.mockClear();
   await s.runner.alarm();expect(sync).toHaveBeenCalledOnce();expect(sync.mock.calls[0][0]).toMatchObject({CREATOR_FEEDBACK_ENABLED:'false'});expect(s.alarm()).toBeNull();
  }
 });
 it('a private wake while disabled cleans cache without scheduling normal polling',async()=>{
  const s=setup(false);s.existing(1_900_000);const result=await s.runner.fetch(new Request('https://creator-feedback.internal/wake',{method:'POST'}));expect(await result.json()).toEqual({scheduled:false});expect(sync).toHaveBeenCalledOnce();expect(sync.mock.calls[0][0]).toMatchObject({CREATOR_FEEDBACK_ENABLED:'false'});expect(s.alarm()).toBeNull();
 });
 it('failed disabled cleanup retains a recovery alarm instead of stranding private data',async()=>{
  const s=setup(false);sync.mockRejectedValueOnce(new Error('synthetic database unavailable'));await s.runner.alarm();expect(s.alarm()).toBe(1_120_000);
 });
});
describe('Worker cron isolation',()=>{
 it('the two-minute cron dispatches feedback only and never historical maintenance',async()=>{
  const s=setup();const feedback=vi.fn(async()=>new Response('{}')),maintenance=vi.fn(async()=>new Response('ok'));
  s.env.CREATOR_FEEDBACK_RUNNER={idFromName:vi.fn(()=> 'feedback'),get:vi.fn(()=>({fetch:feedback}))};
  s.env.CONTROL_PLANE={idFromName:vi.fn(()=> 'control'),get:vi.fn(()=>({fetch:maintenance}))};
  await worker.scheduled({cron:'*/2 * * * *'},s.env);expect(feedback).toHaveBeenCalledOnce();expect(maintenance).not.toHaveBeenCalled();expect(s.env.DB.prepare).not.toHaveBeenCalled();expect(sync).not.toHaveBeenCalled();
 });
 it('hourly maintenance retains its existing control-plane dispatch without starting feedback',async()=>{
  const s=setup(),feedback=vi.fn(),maintenance=vi.fn(async(request:Request)=>{expect(request.url).toBe('https://internal/__maintenance');expect(request.method).toBe('POST');return new Response('ok');});
  s.env.CREATOR_FEEDBACK_RUNNER={idFromName:vi.fn(),get:vi.fn(()=>({fetch:feedback}))};s.env.CONTROL_PLANE={idFromName:vi.fn(()=> 'control'),get:vi.fn(()=>({fetch:maintenance}))};
  await worker.scheduled({cron:'0 * * * *'},s.env);expect(maintenance).toHaveBeenCalledOnce();expect(feedback).not.toHaveBeenCalled();expect(s.env.DB.prepare).not.toHaveBeenCalled();
 });
});
