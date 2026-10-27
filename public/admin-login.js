import { withProgress } from '/forge/progress.js';
document.querySelector('#login-form').onsubmit = async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button'); button.disabled = true;
  try {
    await withProgress('正在登录', async () => {
      const response = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: document.querySelector('#admin-password').value }) });
      const value = await response.json(); if (!response.ok) throw new Error(value.error || '登录未完成，请重试。');
    });
    location.replace('/admin');
  } catch (error) { document.querySelector('#message').textContent = error.message; }
  finally { button.disabled = false; }
};
