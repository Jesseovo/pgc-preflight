import { activateProfile, authorized, login, modelProfiles, publicConfig, saveConfig, saveRoutes, validateModelFields, decryptKey, deleteProfile, profileId } from './settings';
import type { AppSecrets, ConfigStore, ModelConfig } from './settings';
import { modelTransport } from './model';
import { inferenceOptions } from '../src/model-options';
import type { ModelThrottleDatabase } from './model-throttle';
import {createMember,updateMember,publicMember} from './members';
import type {MemberStore} from './members';
import {adminWorkspaceApi} from './admin-workspace-api';
import {reviewActivity} from './review-usage';
import {modelQuota} from './model-quota';
import {adminDashboardApi} from './admin-dashboard-api';

export async function adminApi(request:Request,store:ConfigStore,secrets:AppSecrets,members:MemberStore,DB?:ModelThrottleDatabase,runtime?:Record<string,unknown>):Promise<Response|null> {
  const url=new URL(request.url);
  const view=async(config:ModelConfig|null)=>{const data=publicConfig(config);for(const[id,p]of Object.entries(modelProfiles(config))){if(p?.encryptedKey)try{const key=await decryptKey(p.encryptedKey,secrets.SETTINGS_KEY);data.profiles[id].keySuffix=key.length>4?key.slice(-4):'';}catch{data.profiles[id].keySuffix='';}}return data;};
  if(request.headers.has('Authorization'))return Response.json({error:'设备凭据不能访问管理接口。'},{status:403});
  if(!url.pathname.startsWith('/api/admin/'))return null;
  const json=(value:unknown,status=200,headers:Record<string,string>={})=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
  if(!secrets.ADMIN_PASSWORD||!secrets.SETTINGS_KEY)return json({error:'管理员凭据尚未初始化，请在部署环境中配置。'},503);
  if(request.method!=='GET'&&request.headers.get('Origin')!==url.origin)return json({error:'请求来源不匹配。'},403);
  const secure=url.protocol==='https:'?'; Secure':'';
  const sessionCookie=(value:string,maxAge:number)=>`pgc_admin=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
  try {
    if(url.pathname==='/api/admin/login'&&request.method==='POST'){
      const body=await smallJson(request) as {password?:unknown};
      if(typeof body.password!=='string'||body.password.length>500)return json({error:'请输入管理密码。'},400);
      const token=await login(body.password,secrets);
      if(!token)return json({error:'管理密码不正确。'},401);
      return json({ok:true},200,{'Set-Cookie':sessionCookie(token,8*60*60)});
    }
    if(!await authorized(request.headers.get('Cookie'),secrets))return json({error:'请先登录管理页。'},401);
    const dashboard=await adminDashboardApi(request,{...secrets,DB,modelStore:store,...runtime});if(dashboard)return dashboard;
    const workspace=await adminWorkspaceApi(request,{...secrets,DB,modelStore:store,...runtime});if(workspace)return workspace;
    if(url.pathname==='/api/admin/logout'&&request.method==='POST')return json({ok:true},200,{'Set-Cookie':sessionCookie('',0)});
    if(url.pathname==='/api/admin/review-activity'&&request.method==='GET'){
      if(!DB)return json({error:'审核记录服务尚未就绪。'},503);
      return json(await reviewActivity(DB,url.searchParams));
    }
    if(url.pathname==='/api/admin/members'){
      if(request.method==='GET'){
        const people=await members.list();
        // Content activity is independent from account and permission edits.
        const activity=DB?await (DB.prepare(`SELECT owner_id,MAX(last_activity) AS last_activity FROM (
          SELECT owner_id,MAX(updated_at) AS last_activity FROM topics GROUP BY owner_id
          UNION ALL SELECT owner_id,MAX(updated_at) AS last_activity FROM games GROUP BY owner_id
          UNION ALL SELECT owner_id,MAX(updated_at) AS last_activity FROM forge_tasks GROUP BY owner_id
          UNION ALL SELECT owner_id,MAX(updated_at) AS last_activity FROM review_jobs GROUP BY owner_id
        ) GROUP BY owner_id`).bind() as any).all():{results:[]};
        const times=new Map<string,string>((activity.results||[]).map((row:any)=>[row.owner_id,row.last_activity]));
        return json({members:people.map(member=>({...publicMember(member),lastActivity:times.get(member.id)||null}))});
      }
      if(request.method==='POST')return json(publicMember(await createMember(await smallJson(request),members)),201);
    }
    const memberId=url.pathname.match(/^\/api\/admin\/members\/([a-f0-9-]+)$/)?.[1];
    if(memberId&&request.method==='PATCH')return json(publicMember(await updateMember(memberId,await smallJson(request),members)));
    if(url.pathname==='/api/admin/config'){
      if(request.method==='GET')return json(await view(await store.get()));
      if(request.method==='PUT')return json(await view(await saveConfig(await smallJson(request),store,secrets.SETTINGS_KEY)));
    }
    if(url.pathname==='/api/admin/quota'&&request.method==='GET')return json(await modelQuota(store,secrets.SETTINGS_KEY,url.searchParams.get('profile')));
    if(url.pathname==='/api/admin/config/active'&&request.method==='POST'){
      const body=await smallJson(request) as {profile?:unknown};
      return json(await view(await activateProfile(body.profile,store)));
    }
    if(url.pathname==='/api/admin/config/routes'&&request.method==='POST')return json(await view(await saveRoutes(await smallJson(request),store)));
    if(url.pathname==='/api/admin/config/profile'&&request.method==='DELETE'){
      const body=await smallJson(request) as {profile?:unknown};
      return json(await view(await deleteProfile(body.profile,store)));
    }
    if(url.pathname==='/api/admin/runs'&&request.method==='GET'){
      if (!DB) return json({runs:[]});
      const result=await (DB.prepare('SELECT profile_id,model,purpose,status,effort,max_tokens,input_tokens,output_tokens,reasoning_tokens,first_text_ms,elapsed_ms,characters,finish_reason,error,created_at FROM model_runs ORDER BY created_at DESC LIMIT 30').bind() as any).all();
      return json({runs:result.results || []});
    }
    if(url.pathname==='/api/admin/test'&&request.method==='POST'){
      const raw=await smallJson(request) as Record<string, unknown>;
      const fields=validateModelFields(raw);
      const previous=await store.get();
      const savedProfile=modelProfiles(previous)[profileId(raw.profile ?? 'deepseek')];
      if(!fields.apiKey&&savedProfile&&(fields.baseUrl!==savedProfile.baseUrl||fields.protocol!==(savedProfile.protocol||'openai')))return json({error:'更换接口地址或协议时，请重新填写 API Key。'},400);
      const apiKey=fields.apiKey||(savedProfile?.encryptedKey?await decryptKey(savedProfile.encryptedKey,secrets.SETTINGS_KEY):'');
      if(!apiKey)return json({error:'请先填写 API Key。'},400);
      const inference=inferenceOptions(fields,'test');
      const transport=modelTransport({...fields,effort:'auto',apiKey},{DB,maxTokens:inference.maxTokens,purpose:'test'});
      const started=Date.now();
      // Text first: a connection that works but cannot take images is still
      // usable for creation, or for review with screenshots turned off.
      const text=await transport([{role:'user',content:[{type:'text',text:'这是模型接口测试。请只回复 READY。'}]}]);
      const durationMs=Date.now()-started;
      let vision:boolean|null=true,visionError='';
      try{await transport([{role:'user',content:[{type:'text',text:'这是图片输入测试。请只回复 READY。'},{type:'image_url',image_url:{url:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeklEQVR4nO3PUQkAIBTAwBfPXCY1iiH8OITBAtxm7fN1wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWPHYBVNChh70khwUAAAAASUVORK5CYII='}}]}]);}
      catch(error){visionError=(error instanceof Error?error.message:String(error)).slice(0,200);vision=/image.*(not supported|unsupported)|不支持.*图|invalid.*image|vision.*not supported/i.test(visionError)?false:null;}
      return json({ok:true,durationMs,message:text.slice(0,150),vision,visionError});
    }
    return json({error:'接口不存在。'},404);
  }catch(error){return json({error:error instanceof Error?error.message:'操作未完成，请重试。'},400);}
}
async function smallJson(request:Request):Promise<unknown>{
  if(!request.headers.get('Content-Type')?.includes('application/json'))throw new Error('请使用 JSON 格式。');
  if(Number(request.headers.get('Content-Length'))>16000)throw new Error('配置内容过大。');
  const text=await request.text();
  if(new TextEncoder().encode(text).length>16000)throw new Error('配置内容过大。');
  return JSON.parse(text);
}
