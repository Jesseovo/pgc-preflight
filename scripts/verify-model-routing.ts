import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {launchLocalBrowser} from '../server/local-browser';
import {adminApi} from '../server/admin-api';
import {saveConfig,saveRoutes,decryptKey,activeModelProfile,MODEL_PURPOSES} from '../server/settings';
import type {ModelConfig,ConfigStore} from '../server/settings';
import type {MemberStore} from '../server/members';

// Actual admin API with an isolated memory store; no provider calls or team data.
const secrets={ADMIN_PASSWORD:'fixture-password',SETTINGS_KEY:'fixture-encryption-key'};
let config:ModelConfig|null=null;
const store:ConfigStore={get:async()=>config,set:async v=>{config=v;}};
const members:MemberStore={list:async()=>[],byId:async()=>null,byUsername:async()=>null,save:async()=>{}};
await saveConfig({profile:'deepseek',baseUrl:'https://fixture.example/v1',model:'deepseek-chat',apiKey:'fixture-deepseek'},store,secrets.SETTINGS_KEY);
await saveConfig({profile:'opus',protocol:'anthropic',baseUrl:'https://fixture.example',model:'claude-opus-5-5',apiKey:'fixture-opus'},store,secrets.SETTINGS_KEY);
await saveRoutes({review:'deepseek',create:'opus'},store);
const server=createServer(async(req,res)=>{
  const url=new URL(req.url!,'http://localhost');
  try {
    if(url.pathname.startsWith('/api/admin/')) {
      let body='';for await(const chunk of req)body+=chunk;
      const request=new Request(`http://${req.headers.host}${req.url}`,{method:req.method,headers:req.headers as Record<string,string>,body:['GET','HEAD'].includes(req.method!)?undefined:body});
      const result=(await adminApi(request,store,secrets,members))!;
      res.writeHead(result.status,Object.fromEntries(result.headers));res.end(await result.text());return;
    }
    if(url.pathname==='/forge/'){res.setHeader('Content-Type','text/html');res.end('<html><body>Isolated workbench fixture</body></html>');return;}
    const root=resolve(url.pathname.startsWith('/artwork/')||url.pathname.startsWith('/forge/')?'public':'dist');
    const file=resolve(root,'.'+(url.pathname==='/admin'?'/index.html':url.pathname));
    if(!file.startsWith(root+sep))throw Error('path');
    const bytes=await readFile(file);
    res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':file.endsWith('.svg')?'image/svg+xml':'image/png');res.end(bytes);
  }catch{res.writeHead(404);res.end();}
});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${(server.address() as any).port}`;
const browser=await launchLocalBrowser();
let debugPage:any;
await mkdir('artifacts',{recursive:true});
try {
  const page=await browser.newPage();debugPage=page;const errors:string[]=[];page.on('pageerror',e=>errors.push(String(e)));
  const click=async(selector:string)=>{await page.locator(selector).click();};
  await page.setViewport({width:1440,height:1050});await page.goto(origin+'/admin');await page.waitForSelector('#admin-password');
  await page.type('#admin-password',secrets.ADMIN_PASSWORD);await page.click('#login-form button[type="submit"]');await page.waitForSelector('#tab-model');await page.click('#tab-model');
  assert.equal(await page.$eval('#api-key',e=>(e as HTMLInputElement).value),'');
  await page.click('#add-model');
  await page.type('#profile-name','Studio · independent key');
  await page.$eval('#model-name',e=>(e as HTMLInputElement).value='');await page.type('#model-name','studio-model');await page.type('#api-key','fixture-studio-secret');
  await page.click('#save-model');await page.waitForFunction('document.querySelector("#config-message").textContent.includes("已保存")');
  const id=Object.keys(config!.profiles!).find(id=>id.startsWith('model-'))!;assert(id);
  assert.equal(await decryptKey(config!.profiles![id]!.encryptedKey,secrets.SETTINGS_KEY),'fixture-studio-secret');
  assert.equal(await page.$eval('#api-key',e=>(e as HTMLInputElement).value),'');
  assert.equal(await page.$$eval('[data-route]',nodes=>nodes.length),2,'Only AI review and other functions can be selected');
  await page.select('[data-route="review"]',id);await page.select('[data-route="create"]','opus');
  await page.type('#api-key','unsaved-fixture-key');
  await click('#save-routes');await page.waitForFunction('document.querySelector("#routes-message").textContent.includes("已保存")');
  assert.deepEqual(config!.routes,{review:id,create:'opus'});
  for(const purpose of MODEL_PURPOSES) assert.equal(activeModelProfile(config,purpose)?.id,purpose==='review'||purpose==='review_verify'?id:'opus');
  assert.equal(await page.$eval('#api-key',e=>(e as HTMLInputElement).value),'unsaved-fixture-key','Saving routes preserves unsaved editor input');
  assert.equal(await decryptKey(config!.profiles![id]!.encryptedKey,secrets.SETTINGS_KEY),'fixture-studio-secret');
  await page.reload();await page.waitForSelector('#tab-model');await page.click('#tab-model');
  await page.click(`[data-profile="${id}"]`);const encrypted=config!.profiles![id]!.encryptedKey;
  await page.type('#profile-name',' · saved');await page.click('#save-model');await page.waitForFunction('document.querySelector("#config-message").textContent.includes("已保存")');assert.equal(config!.profiles![id]!.encryptedKey,encrypted);
  await page.screenshot({path:'artifacts/models-desktop.png',fullPage:true});
  await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
  // Changing mobile emulation reloads Chromium; reopen the model tab.
  await page.waitForSelector('#tab-model');await click('#tab-model');
  await click(`[data-profile="${id}"]`);
  assert(await page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'),'Mobile configuration must not overflow');
  await page.screenshot({path:'artifacts/models-mobile.png',fullPage:true});
  await click('#delete-model');await page.waitForFunction('document.querySelector("#config-message").textContent.includes("正在被使用")');assert(config!.profiles![id]);
  await page.select('[data-route="review"]','deepseek');await click('#save-routes');await page.waitForFunction('document.querySelector("#routes-message").textContent.includes("已保存")');
  await click('#delete-model');await page.waitForFunction('document.querySelector("#config-message").textContent.includes("已删除")');assert(!config!.profiles![id]);
  assert.deepEqual(errors,[]);
  console.log('PASS 真实登录、添加独立 Key、仅两组模型选择、各环节正确继承、刷新持久化、空 Key 保留、未保存输入保留、在用删除保护、解除分配后删除、桌面与手机布局。');
} catch(error) { await debugPage.screenshot({path:'artifacts/model-routing-failure.png',fullPage:true});throw error;
} finally {await browser.close();await new Promise<void>(r=>server.close(()=>r()));}
