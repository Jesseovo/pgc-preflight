import {mountSquare} from './workspace.js';
import {mountMemberShell} from '/forge/member-shell.js';

try {
  const response = await fetch('/api/auth/me', {cache:'no-store'});
  if (!response.ok) location.replace('/login');
  else {
    const user = await response.json();
    document.querySelector('#workspace-link').href = user.role === 'admin' ? '/admin' : user.star ? '/forge/' : '/';
    document.querySelector('#member-name').textContent = user.displayName || user.username;
    mountMemberShell(user, 'square');
    mountSquare({root:document,user});
  }
} catch {
  const state = document.querySelector('#session-state');
  state.innerHTML = '<div class="error-state"><h2>暂时无法连接游戏广场</h2><p>请检查网络后重试。</p><button class="secondary-button" type="button">重新读取</button></div>';
  state.querySelector('button').onclick = () => location.reload();
}
