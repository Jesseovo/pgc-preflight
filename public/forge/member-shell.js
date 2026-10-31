// One permission-aware shell; feature modules remain separately authorized.
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function mountMemberShell(user,current='review',{localTabs=false}={}){
  if(user.role==='admin')return;
  document.body.classList.add('member-shell');
  if(!document.querySelector('[data-member-shell-style]')){const link=document.createElement('link');link.rel='stylesheet';link.href='/forge/member-shell.css';link.dataset.memberShellStyle='';document.head.append(link);}
  const header=document.querySelector('header.top,header.site-header');
  const items=user.star?[['picks','我的项目'],['draw','发现选题'],['review','我的审核']]:[['review','我的审核']];
  const href=tab=>user.star?'/forge/?tab='+tab:'/';
  const item=([tab,label])=>localTabs?`<button data-tab="${tab}" class="${current===tab?'on':''}">${label}</button>`:`<a href="${href(tab)}" ${current===tab?'aria-current="page"':''}>${label}</a>`;
  header.className='top member-sidebar';
  header.innerHTML=`<a class="brand" href="${user.star?'/forge/':'/'}"><img src="/artwork/pixel-cat.png" alt="" width="30" height="30"><span>PGC <b>Preflight</b></span></a><span class="member-caption">个人工作台</span><nav id="tabs" class="member-nav" aria-label="工作台功能">${items.map(item).join('')}<a class="member-square" href="/square" ${current==='square'?'aria-current="page"':''}>游戏广场</a>${user.star?`<details class="member-tools" open><summary>更多功能</summary>${[['agent','我的 Agent'],['vocab','词库'],['settings','规则与偏好'],['games','历史导入作品']].map(item).join('')}</details>`:''}</nav><div class="member-account"><div><b>${esc(user.displayName||user.username||'我的空间')}</b><small>${user.star?'Star 创作者':'审核成员'}</small></div><div class="member-account-actions"><button data-account-password>修改密码</button><button data-account-logout>退出登录</button></div><span id="status"></span></div>`;
  header.querySelector('[data-account-logout]').onclick=async event=>{event.target.disabled=true;try{const r=await fetch('/api/auth/logout',{method:'POST'});if(!r.ok)throw Error('退出未完成，请重试');sessionStorage.removeItem('member-navigation-'+user.id);location.replace('/login');}catch(e){event.target.disabled=false;alert(e.message);}};
  header.querySelector('[data-account-password]').onclick=()=>{
    const dialog=document.createElement('dialog');dialog.className='member-password';dialog.innerHTML='<form><h2>修改密码</h2><label>原密码<input name="currentPassword" type="password" autocomplete="current-password" required></label><label>新密码<input name="newPassword" type="password" autocomplete="new-password" minlength="6" maxlength="128" required></label><p role="status"></p><div><button type="button" data-close>取消</button><button type="submit">保存新密码</button></div></form>';document.body.append(dialog);dialog.showModal();dialog.onclose=()=>dialog.remove();dialog.querySelector('[data-close]').onclick=()=>dialog.close();dialog.querySelector('form').onsubmit=async e=>{e.preventDefault();e.submitter.disabled=true;try{const r=await fetch('/api/auth/password',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});const data=await r.json();if(!r.ok)throw Error(data.error||'修改失败');location.replace('/login');}catch(error){dialog.querySelector('[role=status]').textContent=error.message;e.submitter.disabled=false;}};
  };
  const key='member-navigation-'+user.id,section=location.pathname.startsWith('/square')?'square':user.star?'forge':'review';
  const remember=()=>{try{const memory=JSON.parse(sessionStorage.getItem(key)||'{}');memory[section]={url:location.pathname+location.search,scroll:scrollY};sessionStorage.setItem(key,JSON.stringify(memory));}catch{}};
  header.addEventListener('click',event=>{const link=event.target.closest('a[href]');if(!link)return;remember();const dest=link.getAttribute('href')==='/square'?'square':null;if(dest)try{link.href=JSON.parse(sessionStorage.getItem(key)||'{}')[dest]?.url||link.href;}catch{}});
  window.addEventListener('pagehide',remember);
  return {restore(){try{const saved=JSON.parse(sessionStorage.getItem(key)||'{}')[section];if(saved?.url===location.pathname+location.search)requestAnimationFrame(()=>scrollTo(0,saved.scroll));}catch{}}};
}
