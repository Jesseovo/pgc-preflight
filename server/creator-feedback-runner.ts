import {runFeedbackSync} from './creator-feedback-sync';

export interface CreatorFeedbackBinding {
  idFromName(name:string):unknown;
  get(id:unknown):{fetch(request:Request):Promise<Response>};
}
export type CreatorFeedbackEnv={DB:any;CREATOR_FEEDBACK_ENABLED?:string;CREATOR_FEEDBACK_TOKEN?:string;CREATOR_FEEDBACK_RUNNER?:CreatorFeedbackBinding};
export const feedbackEnabled=(env:CreatorFeedbackEnv)=>env.CREATOR_FEEDBACK_ENABLED==='true'&&!!env.CREATOR_FEEDBACK_TOKEN?.trim();

export async function scheduleCreatorFeedback(env:CreatorFeedbackEnv){
  if(!feedbackEnabled(env)||!env.CREATOR_FEEDBACK_RUNNER)return {scheduled:false};
  const binding=env.CREATOR_FEEDBACK_RUNNER;
  const response=await binding.get(binding.idFromName('creator-feedback-v1')).fetch(new Request('https://creator-feedback.internal/wake',{method:'POST'}));
  if(!response.ok)throw new Error('Feedback scheduler unavailable');
  return {scheduled:true};
}

// Separate singleton alarms keep bounded source reads off the UI control plane.
export class CreatorFeedbackRunner {
  constructor(private state:any,private env:CreatorFeedbackEnv){}
  private async disable(){
    try{await runFeedbackSync({...this.env,CREATOR_FEEDBACK_ENABLED:'false'});await this.state.storage.deleteAlarm();}
    catch{await this.state.storage.setAlarm(Date.now()+120000);}
  }
  async fetch(request:Request){
    if(request.method!=='POST'||request.url!=='https://creator-feedback.internal/wake')return new Response('Not found',{status:404});
    if(!feedbackEnabled(this.env)){await this.disable();return Response.json({scheduled:false});}
    // A wake never shortens the engine's durable Retry-After/backoff checkpoint.
    if(await this.state.storage.getAlarm()==null)await this.state.storage.setAlarm(Date.now()+100);
    return Response.json({scheduled:true});
  }
  async alarm(){
    if(!feedbackEnabled(this.env)){await this.disable();return;}
    await this.state.storage.setAlarm(Date.now()+120000);
    try{
      const result=await runFeedbackSync(this.env);
      if(result.nextRunAt==null){await this.state.storage.deleteAlarm();return;}
      await this.state.storage.setAlarm(Math.max(Date.now()+5000,result.nextRunAt));
    }catch{
      // No provider body or private opinion is logged. Failed DB writes leave
      // the cursor intact and retain this recovery alarm.
      await this.state.storage.setAlarm(Date.now()+120000);
    }
  }
}
