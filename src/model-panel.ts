type Profile = { name?: string; baseUrl: string; model: string; protocol: 'openai' | 'anthropic'; enabled: boolean; vision?: boolean; hasKey: boolean; updatedAt: string };
export type ModelView = { activeProfile: string; profiles: Record<string, Profile>; routes: Record<string, string>; effective: Record<string, string> };
const escape = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const steps = [
  ['review','审核初评','结合游戏画面、源码和校准样本评分'],
  ['review_verify','评分复核','复核初评依据，检查误扣分和矛盾建议'],
  ['expand','选题扩写','将抽取的组合扩写成游戏概念'],
  ['brief','制作简报','生成完整的游戏制作文档'],
  ['preview','样板图','生成选题的视觉预览'],
  ['assets','美术资产','生成可供游戏使用的绘制资产'],
  ['game','游戏制作','生成可试玩的单文件 HTML'],
  ['tags','作品打标','整理作品维度与标签'],
  ['vocab','词库补充','补充题材与美术媒介'],
] as const;
export function mountModelPanel(root: HTMLElement, initial: ModelView, api: (path: string, method?: string, body?: unknown) => Promise<any>, onSaved: (value: any) => void) {
  let config = initial, selected = initial.activeProfile, draft: Profile | undefined, busy = false;
  const name = (id: string) => config.profiles[id]?.name || config.profiles[id]?.model || id;
  const update = (value: ModelView) => { config = value; onSaved(value); };
  const input = (id: string) => root.querySelector<HTMLInputElement>('#' + id)!;
  const message = (text: string, success = false) => { const el = root.querySelector('#config-message')!; el.textContent = text; el.classList.toggle('success', success); };
  const options = (value: string, fallback: string) => '<option value="">' + escape(fallback) + '</option>' + Object.entries(config.profiles).map(([id, p]) => '<option value="' + escape(id) + '" ' + (id === value ? 'selected ' : '') + (!p.hasKey || !p.enabled ? 'disabled' : '') + '>' + escape(name(id)) + (!p.hasKey ? ' · 未配置' : !p.enabled ? ' · 已停用' : '') + '</option>').join('');
  async function action(fn: () => Promise<void>, errorTarget = '#config-message') {
    if (busy) return; busy = true;
    root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select').forEach(el => { el.dataset.wasDisabled = String(el.disabled); el.disabled = true; });
    try { await fn(); } catch (error) { const el = root.querySelector(errorTarget); if (el) { el.textContent = error instanceof Error ? error.message : '操作失败，请重试。'; el.classList.remove('success'); } }
    finally { busy = false; root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('[data-was-disabled]').forEach(el => { el.disabled = el.dataset.wasDisabled === 'true'; delete el.dataset.wasDisabled; }); }
  }
  function render() {
    const p = draft || config.profiles[selected];
    root.innerHTML = '<section class="model-library settings-card"><div class="settings-heading"><div><span class="eyebrow">MODEL LIBRARY</span><h2>让合适的模型，做合适的事。</h2><p class="model-intro">保存多个模型与 Key，再为每个环节独立分配。</p></div><span class="config-status connected">' + Object.values(config.profiles).filter(p => p.hasKey).length + ' 个已配置</span></div>' +
      '<div class="model-editor-layout"><aside class="model-directory"><div class="model-directory-title"><b>模型配置</b><button class="text-button" id="add-model" type="button">＋ 添加</button></div><div class="model-profile-list">' +
      Object.entries(config.profiles).map(([id, v]) => '<button type="button" class="model-profile-item ' + (selected === id ? 'selected' : '') + '" data-profile="' + escape(id) + '"><span class="model-profile-symbol">' + (v.protocol === 'anthropic' ? 'A' : 'O') + '</span><span><b>' + escape(name(id)) + '</b><small>' + escape(v.model) + '</small><em>' + (id === config.activeProfile ? '默认 · ' : '') + (v.hasKey ? v.enabled ? 'Key 已保存' : '已停用' : '待配置') + '</em></span></button>').join('') +
      (draft ? '<div class="model-draft-label">＋ 正在添加新模型</div>' : '') + '</div><p class="model-key-note">一个配置对应一个 Key。<br>同一模型可添加多份配置，分别使用不同 Key。</p></aside>' +
      '<form id="model-form" class="model-editor"><div class="model-editor-heading"><h3>' + (draft ? '添加模型' : escape(name(selected))) + '</h3><span>' + (p.hasKey ? 'Key 已加密保存' : '等待配置') + '</span></div>' +
      '<div class="model-field-pair"><div class="field"><label for="profile-name">显示名称</label><input id="profile-name" required maxlength="60" value="' + escape(p.name || '') + '" placeholder="例如 Opus · 游戏制作"/></div><div class="field"><label for="model-protocol">接口协议</label><select id="model-protocol"><option value="openai" ' + (p.protocol === 'openai' ? 'selected' : '') + '>OpenAI Chat Completions</option><option value="anthropic" ' + (p.protocol === 'anthropic' ? 'selected' : '') + '>Anthropic Messages</option></select></div></div>' +
      '<div class="field"><label for="base-url">接口地址</label><input id="base-url" type="url" required value="' + escape(p.baseUrl) + '" placeholder="https://api.example.com/v1" autocomplete="off"/><p>填写服务商提供的 HTTPS 接口地址。</p></div>' +
      '<div class="field"><label for="model-name">模型 ID</label><input id="model-name" required maxlength="150" value="' + escape(p.model) + '" placeholder="服务商提供的精确模型名称"/></div>' +
      '<div class="field"><label for="api-key">API Key <span>' + (p.hasKey ? '留空保留当前 Key' : '新配置必填') + '</span></label><div class="key-field"><input id="api-key" type="password" autocomplete="new-password" maxlength="2000" ' + (p.hasKey ? '' : 'required') + ' placeholder="' + (p.hasKey ? '已保存，不会回显' : '粘贴该配置使用的 Key') + '"/><button class="icon-button" id="toggle-key" type="button" aria-label="显示或隐藏 Key">显示</button></div></div>' +
      '<div class="model-capabilities"><label class="enable-toggle"><input id="model-enabled" type="checkbox" ' + (p.enabled ? 'checked' : '') + '/><span><b>启用</b><small>允许新任务使用此配置</small></span></label><label class="enable-toggle"><input id="model-vision" type="checkbox" ' + (p.vision !== false ? 'checked' : '') + '/><span><b>支持图片</b><small>审核时接收真实游戏截图</small></span></label></div>' +
      '<div class="form-actions"><button type="button" class="subtle-button" id="test-model">测试连接与图片</button><div class="model-action-group">' + (p.hasKey ? '<button type="button" class="text-button model-delete" id="delete-model">删除配置</button>' : '') + '<button type="submit" class="primary-button" id="save-model">保存模型</button></div></div><p id="config-message" class="form-message" role="status" aria-live="polite"></p></form></div></section>' +
      '<section class="settings-card model-routing"><div class="settings-heading"><div><span class="eyebrow">WORKFLOW ROUTING</span><h2>每个环节，单独选择。</h2><p class="model-intro">仅影响后续发起的调用；已生成的报告和成品保持原样。</p></div></div><div class="model-defaults"><label class="field"><span>默认模型</span><select id="default-model">' + Object.entries(config.profiles).map(([id,v]) => '<option value="' + escape(id) + '" ' + (id === config.activeProfile ? 'selected ' : '') + (!v.enabled || !v.hasKey ? 'disabled' : '') + '>' + escape(name(id)) + '</option>').join('') + '</select></label><label class="field"><span>创作环节的统一默认</span><select data-route="create">' + options(config.routes.create || '', '跟随默认模型') + '</select></label></div><div class="model-route-list">' +
      steps.map(([id,title,desc], i) => '<label class="model-route-row"><span class="model-route-index">' + String(i+1).padStart(2,'0') + '</span><span class="model-route-copy"><b>' + title + '</b><small>' + desc + '</small></span><select data-route="' + id + '" aria-label="' + title + '模型">' + options(config.routes[id] || '', id === 'review_verify' ? '跟随审核初评' : id === 'review' ? '跟随默认模型' : '跟随创作默认') + '</select><span class="model-route-effective">当前：' + escape(name(config.effective[id] || config.activeProfile)) + '</span></label>').join('') +
      '</div><p class="model-routing-note">不支持图片的配置会使用源码与运行记录审核；初评和复核建议选择支持图片的模型。模型请求按各 Key 的限流队列执行。</p><div class="form-actions"><span id="routes-message" class="form-message" role="status"></span><button type="button" class="primary-button" id="save-routes">保存环节分配</button></div></section>';
    const fields = () => ({profile:selected, name:input('profile-name').value, protocol:input('model-protocol').value, baseUrl:input('base-url').value, model:input('model-name').value, apiKey:input('api-key').value, enabled:input('model-enabled').checked, vision:input('model-vision').checked});
    root.querySelectorAll<HTMLButtonElement>('[data-profile]').forEach(b => b.onclick = () => { selected = b.dataset.profile!; draft = undefined; render(); });
    root.querySelector<HTMLButtonElement>('#add-model')!.onclick = () => {
      if (Object.values(config.profiles).filter(v => v.hasKey).length >= 24) { message('最多保存 24 个模型配置。'); return; }
      selected = 'model-' + crypto.randomUUID(); draft = {name:'',baseUrl:p.baseUrl,model:p.model,protocol:p.protocol,hasKey:false,vision:p.vision,enabled:true,updatedAt:''}; render(); input('profile-name').focus();
    };
    root.querySelector<HTMLButtonElement>('#toggle-key')!.onclick = () => { input('api-key').type = input('api-key').type === 'password' ? 'text' : 'password'; };
    root.querySelector<HTMLFormElement>('#model-form')!.onsubmit = e => { e.preventDefault(); const body = fields(); void action(async () => { update(await api('config','PUT',body)); draft = undefined; render(); message('模型已保存，可以在下方分配给各个环节。',true); }); };
    root.querySelector<HTMLButtonElement>('#test-model')!.onclick = () => {
      if (!root.querySelector<HTMLFormElement>('#model-form')!.reportValidity()) return;
      const body = fields();
      void action(async () => { const result = await api('test','POST',body); if (result.vision === false) input('model-vision').checked = false; message(result.vision === false ? '文字连接成功，图片输入不可用，已取消图片选项；请保存。' : '文字与图片输入均连接成功。',true); });
    };
    root.querySelector<HTMLButtonElement>('#delete-model')?.addEventListener('click', () => void action(async () => { update(await api('config/profile','DELETE',{profile:selected})); selected = config.activeProfile; render(); message('配置已删除。',true); }));
    root.querySelector<HTMLButtonElement>('#save-routes')!.onclick = () => {
      const active = input('default-model').value;
      const routes = Object.fromEntries([...root.querySelectorAll<HTMLSelectElement>('[data-route]')].map(s => [s.dataset.route, s.value]));
      void action(async () => {
        // Save defaults and all stage assignments atomically.
        update(await api('config/routes','POST',{...routes,activeProfile:active}));
        const editor = fields(); render();
        // Routing changes must not discard an unsaved key or editor changes.
        input('profile-name').value=editor.name; input('base-url').value=editor.baseUrl; input('model-name').value=editor.model; input('api-key').value=editor.apiKey; input('model-protocol').value=editor.protocol; input('model-enabled').checked=editor.enabled; input('model-vision').checked=editor.vision;
        root.querySelector('#routes-message')!.textContent = '已保存，新的调用会按以上分配执行。';
        root.querySelector('#routes-message')!.classList.add('success');
      }, '#routes-message');
    };
  }
  render();
}
