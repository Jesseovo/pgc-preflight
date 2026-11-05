import {WorkerEntrypoint} from 'cloudflare:workers';
import {HarnessHost,authorizeHarnessTask} from './harness-host';
import {handleHarnessModelRequest} from './harness-gateway';
import {configStore} from './storage';
import {scopeHarnessOutbound} from './harness-outbound-scope';
export {default,ReviewControlPlane,ReviewRunner,ForgeRunner,CreatorFeedbackRunner} from './worker';
export class HarnessRunner extends HarnessHost {}
export class HarnessOutbound extends WorkerEntrypoint<any,{taskId:string;generation:string;lease:string;stageDeadlineAt:number;requestIdPrefix:string}> {
  async fetch(request:Request){
    const url=new URL(request.url),props=this.ctx.props;
    const forwarded=scopeHarnessOutbound(request,props);
    if(!forwarded)return new Response('Outbound denied',{status:403});
    if(url.pathname==='/v1/tools'){
      const stub=this.env.HARNESS_RUNNER.get(this.env.HARNESS_RUNNER.idFromName(props.taskId));
      return stub.fetch(new Request('http://harness/tools',forwarded));
    }
    return handleHarnessModelRequest(forwarded,{DB:this.env.DB,settingsKey:this.env.SETTINGS_KEY,deadlineAt:props.stageDeadlineAt,requestIdPrefix:props.requestIdPrefix,loadConfig:()=>configStore(this.env.DB).get(),authorizeRun:run=>authorizeHarnessTask(this.env,run),waitUntil:p=>this.ctx.waitUntil(p)});
  }
}
