import {WorkerEntrypoint} from 'cloudflare:workers';
import {HarnessHost,authorizeHarnessTask} from './harness-host';
import {handleHarnessModelRequest} from './harness-gateway';
import {configStore} from './storage';
export {default,ReviewControlPlane,ReviewRunner,ForgeRunner,CreatorFeedbackRunner} from './worker';
export class HarnessRunner extends HarnessHost {}
export class HarnessOutbound extends WorkerEntrypoint<any,{taskId:string;generation:string;lease:string;stageDeadlineAt:number;requestIdPrefix:string}> {
  async fetch(request:Request){
    const url=new URL(request.url),props=this.ctx.props;
    if(url.origin!=='http://pgc-harness.internal'||request.method!=='POST'||!props?.taskId||!props.lease)return new Response('Outbound denied',{status:403});
    if(!['/v1/messages','/v1/chat/completions','/v1/tools'].includes(url.pathname))return new Response('Route denied',{status:403});
    const headers=new Headers(request.headers);headers.set('Authorization',`Bearer ${props.lease}`);headers.delete('x-api-key');headers.set('x-pgc-harness-task',props.taskId);headers.set('x-pgc-harness-generation',props.generation);
    const forwarded=new Request(request,{headers});
    if(url.pathname==='/v1/tools'){
      const stub=this.env.HARNESS_RUNNER.get(this.env.HARNESS_RUNNER.idFromName(props.taskId));
      return stub.fetch(new Request('http://harness/tools',forwarded));
    }
    return handleHarnessModelRequest(forwarded,{DB:this.env.DB,settingsKey:this.env.SETTINGS_KEY,deadlineAt:props.stageDeadlineAt,requestIdPrefix:props.requestIdPrefix,loadConfig:()=>configStore(this.env.DB).get(),authorizeRun:run=>authorizeHarnessTask(this.env,run),waitUntil:p=>this.ctx.waitUntil(p)});
  }
}
