import { progressHtml } from './progress';
import './style.css';

if (/^\/admin\/?$/.test(location.pathname)) await import('./admin');
else if (/^\/login\/?$/.test(location.pathname)) await import('./login');
else {
  const app = document.querySelector('#app')!;
  app.innerHTML = `<div class="session-loading"><div class="pgc-inline-wait">${progressHtml({label:'正在确认登录状态',detail:'即将打开检查台…'})}</div></div>`;
  try {
    const response = await fetch('/api/auth/me', { cache: 'no-store' });
    if (response.status === 401) location.replace('/login');
    else if (!response.ok) throw new Error('session');
    else await import('./main');
  } catch {
    app.innerHTML = '<div class="session-loading"><p>暂时无法连接登录服务。</p><button class="subtle-button" id="retry-session">重新连接</button></div>';
    document.querySelector('#retry-session')!.addEventListener('click', () => location.reload());
  }
}
export {};
