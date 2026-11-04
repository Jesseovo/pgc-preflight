import type {AdminContext} from './contracts';
import './pilot-members.css';

export interface ReviewPilotMember {
  memberId:string;
  displayName:string;
  username:string;
  accountEnabled:boolean;
  pilotEnabled:boolean;
  creatorAccount:string;
  revision:number;
  enrollmentStartedAt:string|null;
  updatedAt:string|null;
  binding:{
    status:'unlinked'|'declared'|'linked'|'stale';
    sourceAuthorId:string|null;
    workId:string|null;
    versionId:string|null;
    verifiedAt:string|null;
  };
}

type PilotApi=AdminContext['api'];
const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const bindingLabels={unlinked:'未关联',declared:'仅账号声明',linked:'已关联（管理员确认）',stale:'关联待重新核对'};
const bindingLabel=(row:ReviewPilotMember)=>bindingLabels[row.binding.status]||'状态未知';

export async function readReviewPilots(api:PilotApi) {
  const data=await api<{members:ReviewPilotMember[]}>('review-pilots');
  if(!Array.isArray(data?.members))throw new Error('灰测设置暂不可用，请重新读取。');
  return new Map(data.members.map(row=>[row.memberId,row]));
}

export function reviewPilotBadges(row:ReviewPilotMember|undefined,loading:boolean) {
  if(!row)return `<span class="adm-muted">${loading?'正在读取':'状态暂不可用'}</span>`;
  const pilot=row.pilotEnabled?(row.accountEnabled?'灰测已启用':'灰测已选 · 账号停用'):'未启用灰测';
  return `<div class="adm-manage-badges"><span class="adm-badge ${row.pilotEnabled&&row.accountEnabled?'sage':'muted'}">${pilot}</span><span class="adm-badge ${row.binding.status==='linked'?'sage':''}">${bindingLabel(row)}</span></div>`;
}

export function mountReviewPilotMember(root:HTMLElement,memberId:string,api:PilotApi,live:()=>boolean) {
  let row:ReviewPilotMember|undefined;
  let busy=false;
  let retry:{payload:string;id:string}|undefined;
  const current=()=>live()&&root.isConnected;
  const status=(message:string,error=false)=>{
    const output=root.querySelector<HTMLElement>('[data-pilot-message]');
    if(!current()||!output)return;
    output.textContent=message;
    output.classList.toggle('adm-error',error);
  };
  function render() {
    if(!current())return;
    const value=row;
    const binding=value?.binding;
    root.innerHTML=`<div class="adm-pilot-heading"><h2>灰测与 Creator 账号</h2><button type="button" class="adm-button quiet" data-pilot-reload>重新读取</button></div>
      <p class="adm-manage-hint">Creator 用户名或账号 ID 供管理员识别。可用该账号的一条投稿记录核对来源作者，无需 Creator 密码或 Token。核对结果不会自动改变任务归属。</p>
      <p data-pilot-message role="status" aria-live="polite"></p>${value?`
      <div class="adm-pilot-forms"><form class="adm-manage-form" data-pilot-member><h3>灰测设置</h3>
      <label class="adm-manage-check"><input type="checkbox" name="pilotEnabled" ${value.pilotEnabled?'checked':''}><span>启用灰测</span></label>
      <label class="adm-field"><span>Creator 账号</span><input name="creatorAccount" value="${esc(value.creatorAccount)}" maxlength="120" autocomplete="off" placeholder="用户名或账号 ID"></label>
      <div class="adm-manage-form-actions"><button class="adm-button primary" type="submit">保存灰测设置</button></div></form>
      <form class="adm-manage-form" data-pilot-link><h3>核对投稿关联 <small>${bindingLabel(value)}</small></h3>
      <p class="adm-manage-hint">请填写该成员已投稿的作品与准确版本编号。人员对应由管理员确认，来源站核对作品与版本。文件内容需另行核验。</p>
      ${binding?.workId&&binding.versionId?`<dl class="adm-pilot-bound"><dt>已关联作品</dt><dd>${esc(binding.workId)}</dd><dt>准确版本</dt><dd>${esc(binding.versionId)}</dd></dl>`:''}
      <fieldset ${!value.creatorAccount?'disabled':''}><label class="adm-field"><span>来源作品 ID</span><input name="workId" required maxlength="240" autocomplete="off"></label>
      <label class="adm-field"><span>准确投稿版本 ID</span><input name="versionId" required maxlength="240" autocomplete="off"></label>
      <label class="adm-manage-check"><input type="checkbox" name="ownershipConfirmed" required><span>已确认该作品属于此成员</span></label>
      <div class="adm-manage-form-actions"><button class="adm-button" type="submit">核对并关联</button></div></fieldset>
      ${!value.creatorAccount?'<p class="adm-manage-hint">先保存 Creator 账号，再核对投稿关联。</p>':''}
      ${binding?.workId?'<button class="adm-button quiet" type="button" data-pilot-unlink>解除投稿关联</button>':''}</form></div>`:''}`;
    root.querySelector<HTMLButtonElement>('[data-pilot-reload]')!.onclick=()=>void load();
    if(!value)return;
    const settings=root.querySelector<HTMLFormElement>('[data-pilot-member]')!;
    settings.onsubmit=event=>{
      event.preventDefault();
      const input=new FormData(settings);
      void save('member',{pilotEnabled:input.has('pilotEnabled'),creatorAccount:String(input.get('creatorAccount')||'').trim()},'灰测设置已保存。');
    };
    const link=root.querySelector<HTMLFormElement>('[data-pilot-link]')!;
    link.onsubmit=event=>{
      event.preventDefault();
      const input=new FormData(link);
      const workId=String(input.get('workId')||'').trim(),versionId=String(input.get('versionId')||'').trim();
      if(!value.creatorAccount||!input.has('ownershipConfirmed')||!/^[-_A-Za-z0-9]{1,240}$/.test(workId)||!/^[-_A-Za-z0-9]{1,240}$/.test(versionId)){
        status('请填写有效的作品与版本 ID，并确认作品归属。',true);return;
      }
      void save('link',{workId,versionId,ownershipConfirmed:true},'准确投稿版本已核对并关联。');
    };
    const unlink=root.querySelector<HTMLButtonElement>('[data-pilot-unlink]');
    if(unlink)unlink.onclick=()=>void save('unlink',{},'投稿关联已解除。');
  }
  async function run(work:()=>Promise<void>,pending:string) {
    if(busy||!current())return;
    busy=true;
    const controls=[...root.querySelectorAll<HTMLInputElement|HTMLButtonElement>('input,button')].map(el=>({el,disabled:el.disabled}));
    controls.forEach(({el})=>el.disabled=true);
    root.setAttribute('aria-busy','true');
    status(pending);
    try{
      const {withProgress}=await import('../progress');
      await withProgress(pending,work,{compact:true});
    }catch(error){
      if(current())status(error instanceof Error?error.message:'操作未完成，请重试。',true);
    }finally{
      busy=false;
      root.removeAttribute('aria-busy');
      controls.forEach(({el,disabled})=>{if(el.isConnected)el.disabled=disabled;});
    }
  }
  async function load() {
    await run(async()=>{
      const next=(await readReviewPilots(api)).get(memberId);
      if(!next)throw new Error('暂未读到此成员的灰测设置，请重新读取。');
      row=next;
      render();
      status('已读取最新设置。');
    },'正在读取灰测设置…');
  }
  async function save(endpoint:'member'|'link'|'unlink',fields:Record<string,unknown>,success:string) {
    if(!row||busy||!current())return;
    const body={memberId,...fields,expectedRevision:row.revision};
    const payload=JSON.stringify([endpoint,body]);
    if(retry?.payload!==payload)retry={payload,id:crypto.randomUUID()};
    const requestId=retry.id;
    await run(async()=>{
      const result=await api<{member:ReviewPilotMember}>('review-pilots/'+endpoint,'POST',{...body,requestId});
      if(result?.member?.memberId!==memberId)throw new Error('未收到有效保存确认，请用当前内容重试。');
      row=result.member;
      retry=undefined;
      render();
      status(success);
    },endpoint==='link'?'正在核对投稿版本…':'正在保存…');
  }
  render();
  void load();
}
