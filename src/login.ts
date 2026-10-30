import { startTask } from './progress';
import { createIcons, Gamepad2, ArrowRight, UserRoundCheck } from 'lucide';
import './style.css';
import './admin.css';
import { catWalk, quietCorner } from './artwork';

const icon = (name: string) => `<i data-lucide="${name}" aria-hidden="true"></i>`;
document.body.classList.add('auth-page');
document.querySelector('#app')!.innerHTML = `
  <header class="header"><div class="header-inner">
    <a class="brand" href="/"><img src="/favicon.svg" alt="" width="32" height="32"/><span>PGC <b>Preflight</b></span></a>
    <span class="header-caption">多一次检查，少一点遗漏。</span>
  </div></header>
  <main class="auth-main">
    <section class="auth-sheet" aria-labelledby="welcome-title">
      <div class="sheet-label"><span class="pixel-mark"></span>创作者的小天地<span class="sheet-tag">成员专属</span></div>
      <div class="auth-welcome"><div class="welcome-heading"><h1 id="welcome-title">你好，创作者<span>.</span></h1>${catWalk}</div><p>好游戏，准备出发。登录后连接自己的 Agent，开始游戏审核与创作。</p><div class="auth-bottom"><span>认真做游戏，也不忘好玩。</span>${quietCorner}</div></div>
      <section class="login-card member-login-card" aria-labelledby="login-title">
        <div class="login-card-heading"><div class="login-symbol">${icon('gamepad-2')}</div><div><h2 id="login-title">欢迎回来</h2><p>登录你的团队账号</p></div></div>
        <form id="member-login" class="auth-form">
          <div class="auth-field"><label for="username">登录账号</label><input id="username" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="输入你的账号" required maxlength="32"/></div>
          <div class="auth-field"><label for="password">密码</label><input id="password" type="password" autocomplete="current-password" placeholder="输入密码" required maxlength="128"/></div>
          <button class="primary-button" type="submit"><span>进入工作台</span>${icon('arrow-right')}</button>
          <p class="form-message" id="login-message" role="status" aria-live="polite"></p>
        </form>
        <div class="login-foot">${icon('user-round-check')}没有账号？联系管理员开通。</div>
      </section>
    </section>
    <footer><span>PGC Preflight <span class="footer-separator">/</span> 为你的下一款好游戏</span><span>模型检查，人工终审</span></footer>
  </main>`;
createIcons({ icons:{Gamepad2,ArrowRight,UserRoundCheck}, attrs: { 'stroke-width': 1.7 } });

document.querySelector('#member-login')!.addEventListener('submit', async event => {
  event.preventDefault();
  const button = document.querySelector<HTMLButtonElement>('#member-login button')!;
  const message = document.querySelector('#login-message')!;
  button.disabled = true;
  message.textContent = '正在登录…';
  const progress=startTask('登录检查台',{detail:'正在验证账号并打开工作台…'});
  try {
    const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: document.querySelector<HTMLInputElement>('#username')!.value.trim(), password: document.querySelector<HTMLInputElement>('#password')!.value }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '登录失败。');
    progress.update({detail:'登录成功，正在打开检查台…'});
    location.replace(result.role==='admin'?'/admin':result.star?'/forge/':'/');
  } catch (error) { message.textContent = error instanceof Error ? error.message : '登录失败，请重试。'; progress.fail(message.textContent); }
  finally { button.disabled = false; }
});
const sessionProgress=startTask('确认登录状态',{detail:'正在检查是否已有登录会话…'});
void fetch('/api/auth/me', { cache: 'no-store' }).then(async response => {
  if (response.ok) { const user=await response.json(); sessionProgress.update({detail:'正在打开工作台…'}); location.replace(user.role==='admin'?'/admin':user.star?'/forge/':'/'); }
  else sessionProgress.dismiss();
}).catch(() => sessionProgress.dismiss());
