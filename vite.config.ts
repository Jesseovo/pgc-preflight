import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { findChrome, launchLocalBrowser } from './server/local-browser';
import { inspectGame } from './server/checker';
import { captureReview } from './server/review-probe';
import { MAX_REQUEST_BYTES, validateInput } from './server/policy';
import { readFile, writeFile } from 'node:fs/promises';
import { adminApi } from './server/admin-api';
import { modelTransport } from './server/model';
import { resolveModel } from './server/settings';
import type { AppSecrets, ConfigStore, ModelConfig } from './server/settings';
import type {Member,MemberStore} from './server/members';
import {identity} from './server/members';
import {authApi} from './server/auth-api';
import {guardCheckPage} from './server/page-access';

function localCheckApi(): Plugin {
  return {
    name: 'pgc-local-check-api',
    configureServer(server) {
      const store:ConfigStore={get:async()=>{try{return JSON.parse(await readFile('.local-settings.json','utf8'))as ModelConfig;}catch{return null;}},set:async config=>{await writeFile('.local-settings.json',JSON.stringify(config,null,2));}};
      const readMembers=async():Promise<Member[]>=>{try{return JSON.parse(await readFile('.local-members.json','utf8'));}catch{return[];}};
      const members:MemberStore={list:readMembers,byUsername:async username=>(await readMembers()).find(m=>m.username.toLowerCase()===username.toLowerCase())||null,byId:async id=>(await readMembers()).find(m=>m.id===id)||null,save:async member=>{const all=await readMembers();const index=all.findIndex(m=>m.id===member.id);if(index>=0)all[index]=member;else all.push(member);await writeFile('.local-members.json',JSON.stringify(all,null,2));}};
      const secrets=async()=>{const text=await readFile('.dev.vars','utf8').catch(()=>'');return Object.fromEntries(text.split(/\r?\n/).filter(line=>line.includes('=')).map(line=>{const i=line.indexOf('=');return[line.slice(0,i),line.slice(i+1)];}))as unknown as AppSecrets;};
      server.middlewares.use(async (request, response, next) => {
        const path = new URL(request.url || '/', 'http://localhost').pathname;
        if (!['/', '/index.html'].includes(path)) { next(); return; }
        try {
          const result = await guardCheckPage(new Request(`http://${request.headers.host}${request.url}`, { method: request.method, headers: request.headers as Record<string, string> }), members, await secrets());
          if (result) { response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(); return; }
          next();
        } catch { response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('登录服务暂不可用，请刷新重试。'); }
      });
      server.middlewares.use('/api', async (request, response, next) => {
        const send = (value: unknown, status = 200) => { response.statusCode = status; response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.setHeader('Cache-Control', 'no-store'); response.end(JSON.stringify(value)); };
        if(request.url?.startsWith('/admin/')||request.url?.startsWith('/auth/')){
          try{
            const chunks:Buffer[]=[];let bytes=0;for await(const chunk of request){bytes+=chunk.length;if(bytes>16000)throw new Error('配置内容过大。');chunks.push(chunk);}
            const host=request.headers.host||'127.0.0.1:8787';
            const adminRequest=new Request(`http://${host}/api${request.url}`,{method:request.method,headers:request.headers as Record<string,string>,body:['GET','HEAD'].includes(request.method||'GET')?undefined:Buffer.concat(chunks)});
            const config=await secrets();
            const result=request.url.startsWith('/admin/')?await adminApi(adminRequest,store,config,members):await authApi(adminRequest,members,config);
            if(result){response.statusCode=result.status;result.headers.forEach((value,key)=>response.setHeader(key,value));response.end(await result.text());return;}
          }catch(error){send({error:error instanceof Error?error.message:'操作失败。'},400);return;}
        }
        if (request.url === '/health') { const config=await store.get();send({ok:!!findChrome(),configured:!!config?.enabled&&!!config?.encryptedKey,engine:'vision-model',version:'0.2.0'});return; }
        const isReviewProbe = request.url === '/forge/review/probe';
        if (request.url !== '/check' && !isReviewProbe) { next(); return; }
        if (request.method !== 'POST') { send({ error: '请使用 POST 提交游戏。' }, 405); return; }
        const user=await identity(request.headers.cookie||null,members,await secrets());
        if(!user){send({error:'请先使用管理员开通的账号登录。'},401);return;}
        if(user.role!=='admin'){send({error:'成员请通过自己的 Agent 提交本地审核。'},403);return;}
        if(!user.canReview){send({error:'当前账号未开通检查权限，请联系管理员。'},403);return;}
        let input;
        try {
          const chunks: Buffer[] = []; let size = 0;
          for await (const chunk of request) { size += chunk.length; if (size > MAX_REQUEST_BYTES) throw new Error('请求内容过大。'); chunks.push(chunk); }
          const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          input = validateInput(isReviewProbe ? { ...data, filename: 'review-probe.html' } : data);
        } catch (error) { send({ error: error instanceof Error ? error.message : '文件格式错误。' }, 400); return; }
        let browser;
        try {
          if (isReviewProbe) { browser = await launchLocalBrowser(); send(await captureReview(browser, input.html)); return; }
          const model=await resolveModel(await store.get(),(await secrets()).SETTINGS_KEY);if(!model){send({error:'管理员尚未配置审核模型，请先前往 /admin 配置。'},503);return;} browser = await launchLocalBrowser(); send(await inspectGame(browser, input,modelTransport(model)));
        }
        catch (error) { send({ error: `本地检查环境不可用：${error instanceof Error ? error.message : error}` }, 503); }
        finally { await browser?.close().catch(() => {}); }
      });
    },
  };
}
export default defineConfig({ plugins: [localCheckApi()], server: { port: 8787, strictPort: true }, build: { target: 'es2022' } });
