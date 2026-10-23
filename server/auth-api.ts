import {identity,memberLogin,hashPassword,validatePassword} from './members';
import type {MemberStore} from './members';
import type {AppSecrets} from './settings';

export async function authApi(request:Request,store:MemberStore,secrets:AppSecrets):Promise<Response|null>{
  const url=new URL(request.url);if(!url.pathname.startsWith('/api/auth/'))return null;
  const json=(value:unknown,status=200,headers:Record<string,string>={})=>Response.json(value,{status,headers:{'Cache-Control':'no-store',...headers}});
  const cookie=(value:string,maxAge:number)=>`pgc_member=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${url.protocol==='https:'?'; Secure':''}`;
  if(request.method!=='GET'&&request.headers.get('Origin')!==url.origin)return json({error:'请求来源不匹配。'},403);
  try{
    if(url.pathname==='/api/auth/login'&&request.method==='POST'){
      const body=await readAuthBody(request);
      if(typeof body.username!=='string'||typeof body.password!=='string'||body.username.length>32||body.password.length>128)return json({error:'请输入账号与密码。'},400);
      const token=await memberLogin(body.username,body.password,store,secrets.SETTINGS_KEY);
      if(!token)return json({error:'账号或密码不正确，或账号已停用。'},401);
      return json({ok:true},200,{'Set-Cookie':cookie(token,8*60*60)});
    }
    if(url.pathname==='/api/auth/logout'&&request.method==='POST')return json({ok:true},200,{'Set-Cookie':cookie('',0)});
    const user=await identity(request.headers.get('Cookie'),store,secrets);
    if(!user)return json({error:'请先使用管理员开通的账号登录。'},401);
    if(url.pathname==='/api/auth/me'&&request.method==='GET')return json(user);
    if(url.pathname==='/api/auth/password'&&request.method==='PUT'){
      if(user.role==='admin')return json({error:'管理员密码请通过部署环境修改。'},400);
      const body=await readAuthBody(request);const member=(await store.byId(user.id))!;
      if(typeof body.currentPassword!=='string'||body.currentPassword.length>128)return json({error:'请输入原密码。'},400);
      const old=await hashPassword(body.currentPassword,member.passwordSalt);
      if(old.hash!==member.passwordHash)return json({error:'原密码不正确。'},400);
      const next=await hashPassword(validatePassword(body.newPassword));member.passwordHash=next.hash;member.passwordSalt=next.salt;member.sessionVersion++;member.updatedAt=new Date().toISOString();await store.save(member);
      return json({ok:true},200,{'Set-Cookie':cookie('',0)});
    }
    return json({error:'接口不存在。'},404);
  }catch(error){return json({error:error instanceof Error?error.message:'操作未完成。'},400);}
}
async function readAuthBody(request:Request):Promise<Record<string,unknown>>{if(!request.headers.get('Content-Type')?.includes('application/json'))throw new Error('请求格式不正确。');const text=await request.text();if(text.length>4096)throw new Error('请求内容过大。');return JSON.parse(text);}
