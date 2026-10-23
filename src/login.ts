import { createIcons, icons } from 'lucide';
import './style.css';
import './admin.css';
import { catWalk, quietCorner } from './artwork';

const icon = (name: string) => `<i data-lucide="${name}" aria-hidden="true"></i>`;
document.body.classList.add('auth-page');
document.querySelector('#app')!.innerHTML = `
  <header class="header"><div class="header-inner">
    <a class="brand" href="/"><img src="/favicon.svg" alt="" width="32" height="32"/><span>PGC <b>Preflight</b></span></a>
    <span class="header-caption">A little check. A better game.</span>
  </div></header>
  <main class="auth-main">
    <section class="auth-sheet" aria-labelledby="welcome-title">
      <div class="sheet-label"><span class="pixel-mark"></span>CREATOR'S LITTLE CORNER<span class="sheet-tag">MEMBERS ONLY</span></div>
      <div class="auth-welcome"><div class="welcome-heading"><h1 id="welcome-title">Hi there, creator<span>.</span></h1>${catWalk}</div><p>好游戏，准备出发。登录后开始你的游戏基础体检。</p></div>
      <section class="login-card member-login-card" aria-labelledby="login-title">
        <div class="login-card-heading"><div class="login-symbol">${icon('gamepad-2')}</div><div><h2 id="login-title">欢迎回来</h2><p>登录你的团队账号</p></div></div>
        <form id="member-login" class="auth-form">
          <div class="auth-field"><label for="username">登录账号</label><input id="username" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="输入你的账号" required maxlength="32"/></div>
          <div class="auth-field"><label for="password">密码</label><input id="password" type="password" autocomplete="current-password" placeholder="输入密码" required maxlength="128"/></div>
          <button class="primary-button" type="submit"><span>进入检查台</span>${icon('arrow-right')}</button>
          <p class="form-message" id="login-message" role="status" aria-live="polite"></p>
        </form>
        <div class="login-foot">${icon('user-round-check')}没有账号？联系管理员开通。</div>
      </section>
      <div class="auth-bottom"><span>Making good games. Keeping it playful.</span>${quietCorner}</div>
    </section>
    <footer><span>PGC Preflight <span class="footer-separator">/</span> For your next good game</span><span>模型检查，人工终审</span></footer>
  </main>`;
createIcons({ icons, attrs: { 'stroke-width': 1.7 } });

document.querySelector('#member-login')!.addEventListener('submit', async event => {
  event.preventDefault();
  const button = document.querySelector<HTMLButtonElement>('#member-login button')!;
  const message = document.querySelector('#login-message')!;
  button.disabled = true;
  message.textContent = '正在登录…';
  try {
    const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: document.querySelector<HTMLInputElement>('#username')!.value.trim(), password: document.querySelector<HTMLInputElement>('#password')!.value }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '登录失败。');
    location.replace('/');
  } catch (error) { message.textContent = error instanceof Error ? error.message : '登录失败，请重试。'; }
  finally { button.disabled = false; }
});
void fetch('/api/auth/me', { cache: 'no-store' }).then(response => { if (response.ok) location.replace('/'); }).catch(() => {});
