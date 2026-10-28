type ReviewTask = {status:string;stage?:string;model_executor?:string;updated_at?:string;error?:string;detail?:string};
export function reviewTaskStatus(task:ReviewTask) {
  if(task.status==='done')return {label:'已完成',detail:''};
  if(task.status==='error')return {label:'未完成',detail:task.error||'本次未发布报告。'};
  if(task.model_executor==='agent'&&['queued','running'].includes(task.status)){
    const phase=task.stage==='verify'?'复核结果':task.stage==='review'?'初评结果':'采集';
    return {label:`等待 Agent ${phase}`,detail:'需要在原 Agent 对话中继续；网页停留不会执行审核。'};
  }
  if(task.status==='queued')return {label:'等待执行',detail:task.error||''};
  return {label:task.stage==='capture'?'采集画面':task.stage==='verify'?'模型复核':'模型初评',detail:task.error||''};
}
