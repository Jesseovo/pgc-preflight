import{createIcons,icons}from'lucide';
import'./style.css';import'./admin.css';
const icon=(name:string)=>`<i data-lucide="${name}" aria-hidden="true"></i>`;
document.querySelector('#app')!.innerHTML=`<header class="header"><div class="header-inner"><a class="brand" href="/"><img src="/favicon.svg" alt="" width="34" height="34"/><span>PGC <b>Preflight</b></span></a><a class="back-link" href="/admin">${icon('settings-2')}管理员入口</a></div></header><main class="admin-main"><section class="intro"><div><div class="eyebrow">WELCOME, CREATOR</div><h1>好游戏，准备出发<span>。</span></h1><p>登录团队账号，开始你的游戏基础体检。</p></div></section><section class="login-card"><div class="login-symbol">${icon('gamepad-2')}</div><h2>成员登录</h2><p>请使用管理员为你开通的账号。</p><form id="member-login"><label for="username">登录账号</label><input id="username" autocomplete="username" placeholder="输入账号" required maxlength="32"/><label for="password" class="password-label">密码</label><input id="password" type="password" autocomplete="current-password" placeholder="输入密码" required maxlength="128"/><button class="primary-button" type="submit">${icon('arrow-right')}进入检查台</button><p class="form-message" id="login-message" role="status"></p></form><div class="login-foot">${icon('user-round-check')}没有账号？请联系管理员开通。</div></section><footer><span>PGC Preflight / For your next good game</span><span>模型检查，人工终审</span></footer></main>`;
createIcons({icons,attrs:{'stroke-width':1.7}});
document.querySelector('#member-login')!.addEventListener('submit',async event=>{
  event.preventDefault();const button=document.querySelector<HTMLButtonElement>('#member-login button')!;button.disabled=true;
  try{
    const response=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:document.querySelector<HTMLInputElement>('#username')!.value.trim(),password:document.querySelector<HTMLInputElement>('#password')!.value})});
    const result=await response.json();if(!response.ok)throw new Error(result.error||'登录失败。');location.replace('/');
  }catch(error){document.querySelector('#login-message')!.textContent=error instanceof Error?error.message:'登录失败，请重试。';}finally{button.disabled=false;}
});
void fetch('/api/auth/me').then(response=>{if(response.ok)location.replace('/');}).catch(()=>{});
