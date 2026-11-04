import {describe,expect,it} from 'vitest';
import {measureFeedbackFile,parseFeedbackDeclaration} from '../server/creator-feedback-assessment';
import {digest} from '../server/review-device-state';
const declaration=()=>({jobId:'synthetic-job',requestId:crypto.randomUUID(),generation:1,status:'unverified',note:'',fileRelation:'unknown',sourceArtifactHash:null,ruleRelation:'unknown',sourceRuleId:null,pgcRuleId:null,reference:''});
describe('feedback provenance evidence boundaries',()=>{
 it('measures exact Unicode bytes, preserving an unknown input hash and never asserting a source binding',async()=>{
  const content='合成🙂\r\n<script>notExecuted()</script>';
  const request=()=>new Request('https://fixture.invalid/',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:content});
  const a=await measureFeedbackFile(request(),null);expect(a).toEqual({sha256:await digest(content),bytes:Buffer.byteLength(content),inputHash:null,inputHashMatches:null,origin:'admin-upload',sourceBindingVerified:false});
  expect((await measureFeedbackFile(request(),await digest(content.replace('\r\n','\n')))).inputHashMatches).toBe(false);
 });
 it('counts streamed bytes independently of Content-Length, cancels after the cap, and rejects empty uploads',async()=>{
  let cancelled=false;const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(8*1024*1024));c.enqueue(new Uint8Array(1));},cancel(){cancelled=true;}});
  const req=new Request('https://fixture.invalid/',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:stream,duplex:'half'} as any);
  await expect(measureFeedbackFile(req,null)).rejects.toMatchObject({status:413});expect(cancelled).toBe(true);
  await expect(measureFeedbackFile(new Request('https://fixture.invalid/',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:''}),null)).rejects.toMatchObject({status:400});
 });
 it('cannot turn submitted administrator strings into verified provenance, and bounds declaration fields',()=>{
  for(const bad of [{...declaration(),status:'verified'},{...declaration(),strictEligible:true},{...declaration(),sourceBindingVerified:true},{...declaration(),generation:-1},{...declaration(),status:'declared'},{...declaration(),reference:'x'.repeat(501)},{...declaration(),sourceRuleId:{}},{...declaration(),sourceArtifactHash:'not-a-hash'}])expect(()=>parseFeedbackDeclaration(bad)).toThrow();
  const d=parseFeedbackDeclaration({...declaration(),status:'declared',note:'Synthetic self-attested statement',sourceRuleId:0});expect(d.declaration.sourceRuleId).toBe(0);expect(Object.hasOwn(d.declaration,'strictEligible')).toBe(false);
 });
});
