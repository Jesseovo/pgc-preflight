import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {inspectGame} from '../server/checker';
import {launchLocalBrowser} from '../server/local-browser';
import type {ChatMessage,ModelTransport} from '../server/model';

// Scripted model responses test the browser/model contract, not real model accuracy.
const browser=await launchLocalBrowser();
await mkdir('artifacts',{recursive:true});
const html=(body:string)=>`<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><title>测试游戏</title><body style="margin:0">${body}</body></html>`;
const observation=(messages:ChatMessage[])=>{
  const content=messages.at(-1)!.content as {type:string;text?:string}[];
  return JSON.parse(content.find(item=>item.type==='text')!.text!);
};
try{
  let turns=0;
  const interactiveModel:ModelTransport=async messages=>{
    const seen=observation(messages);
    if(turns++===0){assert(seen.observations.length===2);assert(seen.source.includes('button'));return JSON.stringify({action:{type:'tap',x:120,y:120},reason:'点击开始按钮'});}
    assert.equal(seen.observation.dom.text,'playing');
    return JSON.stringify({report:{title:'模型确认的测试游戏',status:'pass',findings:[{category:'input',status:'pass',title:'开始操作有效',detail:'模型观察到界面变为 playing。',evidenceId:'observation-2'}],uncovered:['后续关卡']}});
  };
  const result=await inspectGame(browser,{filename:'normal.html',html:html('<button style="position:absolute;left:80px;top:80px;width:150px;height:80px" onclick="document.body.innerHTML=\'playing\'">Start</button>')},interactiveModel);
  assert.equal(result.status,'pass');assert.equal(turns,2);assert.equal(result.evidence.length,3);
  await writeFile('artifacts/model-browser-contract.json',JSON.stringify(result,null,2));
  console.log('PASS 真实浏览器接收模型点击，后续观察包含实际界面变化。');

  const reviewModel:ModelTransport=async messages=>{
    const seen=observation(messages);
    assert(seen.observations[0].logs.errors.some((text:string)=>text.includes('fixture-error')));
    return JSON.stringify({report:{title:'测试',status:'review',findings:[{category:'runtime',status:'review',title:'异常影响待确认',detail:'这是模型给出的待确认结论。',evidenceId:'observation-0'}],uncovered:[]}});
  };
  const reviewed=await inspectGame(browser,{filename:'error.html',html:html('<p>测试</p><script>throw Error("fixture-error")</script>')},reviewModel);
  assert.equal(reviewed.status,'review');
  console.log('PASS 脚本异常作为原始证据交给模型；程序保留模型判断，不自行判失败。');

  const missingModel:ModelTransport=async messages=>{
    const seen=observation(messages);
    assert(seen.observations[0].logs.localResources.includes('/missing.js'));
    return JSON.stringify({report:{title:'测试',status:'issue',findings:[{category:'file',status:'issue',title:'缺少配套脚本',detail:'模型根据资源记录判断。',evidenceId:'observation-0'}],uncovered:[]}});
  };
  const missing=await inspectGame(browser,{filename:'missing.html',html:html('<p>测试</p><script src="missing.js"></script>')},missingModel);
  assert.equal(missing.status,'issue');console.log('PASS 缺失资源送入模型上下文，报告来自模型。');

  const broken=await inspectGame(browser,{filename:'invalid-model.html',html:html('<p>测试</p>')},async()=>'{bad json');
  assert.equal(broken.status,'review');assert(broken.findings[0].title.includes('未完成'));
  console.log('PASS 模型协议错误显示审核未完成，不自动判定游戏不合格。');
}finally{await browser.close();}
