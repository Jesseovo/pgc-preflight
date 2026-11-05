import {problem} from './review-device-state';

// Deployment starts with the previously enrolled pilot members. This flag
// changes only new creation workflows, never membership or locked tasks.
export async function creativeV2Available(env:any,owner:string){
  const mode=env.CREATIVE_V2_ROLLOUT;
  // The Worker supplies the pilot default. An unbound local API can exercise
  // the complete workflow; a misspelled deployed mode must stay closed.
  if(mode===undefined||mode==='all')return true;
  if(mode!=='pilot')return false;
  if(owner==='admin')return true;
  return Boolean(await env.DB.prepare('SELECT 1 FROM review_pilot_members WHERE member_id=? AND pilot_enabled=1').bind(owner).first());
}
export async function requireCreativeV2(env:any,owner:string){
  if(!await creativeV2Available(env,owner))throw problem('完整创作流程目前仅向灰测成员开放；原创作流程仍可使用。',403);
}
