import { activateProfile, authorized, login, modelProfiles, publicConfig, saveConfig, validateModelFields, decryptKey } from './settings';
import type { AppSecrets, ConfigStore } from './settings';
import { modelTransport } from './model';
import {createMember,updateMember,publicMember} from './members';
import type {MemberStore} from './members';

export async function adminApi(request:Request,store:ConfigStore,secrets:AppSecrets,members:MemberStore):Promise<Response|null> {
  const url=new URL(request.url);
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
    if(url.pathname==='/api/admin/logout'&&request.method==='POST')return json({ok:true},200,{'Set-Cookie':sessionCookie('',0)});
    if(url.pathname==='/api/admin/members'){
      if(request.method==='GET')return json({members:(await members.list()).map(publicMember)});
      if(request.method==='POST')return json(publicMember(await createMember(await smallJson(request),members)),201);
    }
    const memberId=url.pathname.match(/^\/api\/admin\/members\/([a-f0-9-]+)$/)?.[1];
    if(memberId&&request.method==='PATCH')return json(publicMember(await updateMember(memberId,await smallJson(request),members)));
    if(url.pathname==='/api/admin/config'){
      if(request.method==='GET')return json(publicConfig(await store.get()));
      if(request.method==='PUT')return json(publicConfig(await saveConfig(await smallJson(request),store,secrets.SETTINGS_KEY)));
    }
    if(url.pathname==='/api/admin/config/active'&&request.method==='POST'){
      const body=await smallJson(request) as {profile?:unknown};
      return json(publicConfig(await activateProfile(body.profile,store)));
    }
    if(url.pathname==='/api/admin/test'&&request.method==='POST'){
      const raw=await smallJson(request) as Record<string, unknown>;
      const fields=validateModelFields(raw);
      const previous=await store.get();
      const profileId=raw.profile==='opus'?'opus':'deepseek';
      const savedProfile=modelProfiles(previous)[profileId];
      if(!fields.apiKey&&savedProfile&&(fields.baseUrl!==savedProfile.baseUrl||fields.protocol!==(savedProfile.protocol||'openai')))return json({error:'更换接口地址或协议时，请重新填写 API Key。'},400);
      const apiKey=fields.apiKey||(savedProfile?.encryptedKey?await decryptKey(savedProfile.encryptedKey,secrets.SETTINGS_KEY):'');
      if(!apiKey)return json({error:'请先填写 API Key。'},400);
      const transport=modelTransport({...fields,apiKey});
      const started=Date.now();
      const text=await transport([{role:'user',content:[{type:'text',text:'这是模型接口与图片输入测试。请只回复 READY。'},{type:'image_url',image_url:{url:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeklEQVR4nO3PUQkAIBTAwBfPXCY1iiH8OITBAtxm7fN1wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWPHYBVNChh70khwUAAAAASUVORK5CYII='}}]}]);
      return json({ok:true,durationMs:Date.now()-started,message:text.slice(0,150)});
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
