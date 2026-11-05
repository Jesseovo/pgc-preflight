const esc=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
type Api=(path:string,method?:string,body?:unknown)=>Promise<any>;
export function mechanismSummaryHtml(items:any[]){
  return items.length?`<div class="adm-manage-table"><table><thead><tr><th>题材</th><th>玩家动作</th><th>核心规则</th><th>结构</th></tr></thead><tbody>${items.map(item=>`<tr>${['subject','action','rule','structure'].map(k=>`<td>${esc(item[k])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`:'<p>尚未发布机制摘要。私人历史资料不会自动进入目录。</p>';
}
export async function mountCreationMechanisms(root:HTMLElement,api:Api,live:()=>boolean){
  root.innerHTML=`<h2>创作机制目录与争议复核</h2><p>新选定方案仅向有创作权限的成员共享题材、动作、规则和结构。以下历史摘要须管理员逐条确认发布，原始策划、源码和评语不随摘要共享。</p><div data-catalog></div><button type="button" class="adm-button" data-more>读取目录</button><details><summary>明确发布一条历史机制摘要</summary><form data-publish>${[['subject','题材'],['action','玩家动作'],['rule','核心规则'],['structure','玩法结构'],['reason','发布依据（仅管理员保留）']].map(([key,label])=>`<label class="adm-field"><span>${label}</span><textarea name="${key}" rows="2" required maxlength="2000"></textarea></label>`).join('')}<label class="adm-manage-check"><input type="checkbox" required><span>已检查脱敏和使用权限，确认公开以上四项摘要</span></label><button class="adm-button" type="submit">发布摘要</button><p role="status"></p></form></details><details><summary>复核一条机制查重争议</summary><form data-read><label class="adm-field"><span>成员提供的查重记录 ID</span><input name="check_id" required></label><button class="adm-button" type="submit">读取原判断</button><p role="status"></p></form><div data-resolution></div></details>`;
  let after=0,items:any[]=[];
  const run=async(form:HTMLElement,work:()=>Promise<void>)=>{
    if(form.dataset.busy)return;form.dataset.busy='true';const message=form.querySelector<HTMLElement>('[role=status]');
    try{await work();}catch(e){if(live()&&message)message.textContent=e instanceof Error?e.message:'操作失败';}finally{delete form.dataset.busy;}
  };
  root.querySelector<HTMLButtonElement>('[data-more]')!.onclick=()=>void run(root,async()=>{const page=await api(`/api/forge/mechanisms?after=${after}`);if(!live())return;items.push(...page.items);root.querySelector('[data-catalog]')!.innerHTML=mechanismSummaryHtml(items);after=page.next||0;const button=root.querySelector<HTMLButtonElement>('[data-more]')!;button.disabled=!page.next;button.textContent=page.next?'读取下一页':'已读取全部摘要';});
  const publish=root.querySelector<HTMLFormElement>('[data-publish]')!;
  publish.onsubmit=e=>{e.preventDefault();if(!publish.reportValidity())return;const data=Object.fromEntries(new FormData(publish));void run(publish,async()=>{await api('/api/forge/mechanisms/publish','POST',data);if(!live())return;publish.reset();publish.querySelector('[role=status]')!.textContent='摘要已明确发布。';after=0;items=[];const button=root.querySelector<HTMLButtonElement>('[data-more]')!;button.disabled=false;button.click();});};
  const read=root.querySelector<HTMLFormElement>('[data-read]')!;
  read.onsubmit=e=>{e.preventDefault();const id=String(new FormData(read).get('check_id')||'').trim();void run(read,async()=>{
    const check=await api(`/api/forge/mechanisms/${encodeURIComponent(id)}`);if(!live())return;
    const target=root.querySelector<HTMLElement>('[data-resolution]')!;
    target.innerHTML=`<pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(check,null,2))}</pre>${check.stale?'<p>候选或目录已更新，请成员重新查重。</p>':check.admin_resolution?'<p>已有不可覆盖的管理员裁定。</p>':!['distinct','duplicate','uncertain'].includes(check.state)?'<p>精确重复不可覆盖；待模型判断后才能复核语义争议。</p>':`<form data-resolve><label class="adm-field"><span>裁定</span><select name="verdict"><option value="uncertain">仍不能确定</option><option value="distinct">机制有实质差异</option><option value="duplicate">机制重复</option></select></label><label class="adm-field"><span>具体原因与对照依据</span><textarea name="reason" rows="4" required></textarea></label><p>裁定保留原模型判断，不允许覆盖精确相同的机制。</p><button class="adm-button" type="submit">保存不可覆盖的裁定</button><p role="status"></p></form>`}`;
    const resolve=target.querySelector<HTMLFormElement>('[data-resolve]');if(resolve)resolve.onsubmit=event=>{event.preventDefault();if(!resolve.reportValidity())return;const data=Object.fromEntries(new FormData(resolve));void run(resolve,async()=>{await api('/api/forge/mechanisms/resolve','POST',{check_id:id,...data});if(!live())return;resolve.replaceChildren(Object.assign(document.createElement('p'),{textContent:'裁定已保存，成员可重新读取本条查重结果。'}));});};
  });};
}
