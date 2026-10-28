import { modelCapabilities, type InferenceOptions } from './model-options';
type Profile = InferenceOptions & { name?: string; baseUrl: string; model: string; protocol: 'openai' | 'anthropic'; enabled: boolean; vision?: boolean; hasKey: boolean;keySuffix?:string; updatedAt: string };
export type ModelView = { activeProfile: string; profiles: Record<string, Profile>; routes: Record<string, string>; effective: Record<string, string> };
const escape = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const steps = [
  ['review','AI 审核','游戏模拟评分与评分复核'],
  ['create','其他功能','选题扩写、简报、样板图、美术资产等；游戏制作固定使用 Opus 5.5'],
] as const;
export function mountModelPanel(root: HTMLElement, initial: ModelView, api: (path: string, method?: string, body?: unknown) => Promise<any>, onSaved: (value: any) => void) {
  let config = initial, selected = initial.activeProfile, draft: Profile | undefined, busy = false, editorOpen=false;
  const quotas=new Map<string,{value?:any;error?:string;loading?:boolean}>();
  const riffle=(p:Profile)=>p.hasKey&&/^https:\/\/riffle-api\.pages\.dev(?:\/|$)/i.test(p.baseUrl)&&/^claude-opus-5-5$/i.test(p.model);
  const money=(v:unknown)=>v===null?'未设上限':typeof v==='number'?'¥'+v.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2}):'未提供';
  const name = (id: string) => config.profiles[id]?.name || config.profiles[id]?.model || id;
  const update = (value: ModelView) => { config = value; onSaved(value); };
  const input = (id: string) => root.querySelector<HTMLInputElement>('#' + id)!;
  const message = (text: string, success = false) => { const el = root.querySelector('#config-message')!; el.textContent = text; el.classList.toggle('success', success); };
  const options = (value: string) => Object.entries(config.profiles).map(([id, p]) => '<option value="' + escape(id) + '" ' + (id === value ? 'selected ' : '') + (!p.hasKey || !p.enabled ? 'disabled' : '') + '>' + escape(name(id)) + (!p.hasKey ? ' · 未配置' : !p.enabled ? ' · 已停用' : '') + '</option>').join('');
  async function action(fn: () => Promise<void>, errorTarget = '#config-message') {
    if (busy) return; busy = true;
    root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select').forEach(el => { el.dataset.wasDisabled = String(el.disabled); el.disabled = true; });
    try { await fn(); } catch (error) { const el = root.querySelector(errorTarget); if (el) { el.textContent = error instanceof Error ? error.message : '操作失败，请重试。'; el.classList.remove('success'); } }
    finally { busy = false; root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('[data-was-disabled]').forEach(el => { el.disabled = el.dataset.wasDisabled === 'true'; delete el.dataset.wasDisabled; }); paintSwitchRows(); }
  }
  function paintSwitchRows(){
    for(const row of root.querySelectorAll<HTMLElement>('[data-model-row]')){
      const id=row.dataset.modelRow!,p=config.profiles[id],q=quotas.get(id);
      const create=(config.effective.create||config.activeProfile)===id,review=(config.effective.review||config.activeProfile)===id;
      row.classList.toggle('in-use',create||review);
      row.querySelector('.provider-usage')!.textContent=[create?'创作首选':'',review?'审核使用中':'',riffle(p)&&p.enabled?'制作池':''].filter(Boolean).join(' · ');
      for(const button of row.querySelectorAll<HTMLButtonElement>('[data-use]')){const active=button.dataset.use==='create'?create:review;button.disabled=busy||!p.enabled||!p.hasKey||active;button.textContent=active?(button.dataset.use==='create'?'创作首选':'审核使用中'):(button.dataset.use==='create'?'用于创作':'用于审核');}
      const el=row.querySelector<HTMLElement>('.provider-balance')!;
      el.classList.toggle('quota-error',!!q?.error);
      el.textContent=!riffle(p)?(p.hasKey?'余额暂不支持':'尚未配置 Key'):q?.value?`可用 ${money(q.value.available)} · 总剩余 ${money(q.value.total.remaining)}${q.error?' · 刷新失败':q.loading?' · 刷新中':''}`:q?.loading?'正在查询余额…':q?.error||'余额待查询';
      el.title=q?.value?`查询时间：${new Date(q.value.queriedAt).toLocaleString('zh-CN')}；当前可用已扣除在途预占。${q.error||''}`:q?.error||'';
    }
  }
  async function refreshQuotas(force=false){
    for(const[id,p]of Object.entries(config.profiles)){
      if(!riffle(p))continue;
      const last=quotas.get(id);if(last?.loading||(!force&&last))continue;
      quotas.set(id,{...last,loading:true});paintSwitchRows();
      try{const value=await api('quota?profile='+encodeURIComponent(id));quotas.set(id,{value});}
      catch(error){quotas.set(id,{value:last?.value,error:error instanceof Error?error.message:'余额查询失败'});}
      paintSwitchRows();
    }
  }
  function render() {
    const p = draft || config.profiles[selected];
    root.innerHTML = '<section class="model-library settings-card"><div class="settings-heading"><div><span class="eyebrow">MODEL LIBRARY</span><h2>模型与 Key</h2><p class="model-intro">添加、编辑模型配置，保存后即可在上方选择。</p></div><span class="config-status connected">' + Object.values(config.profiles).filter(p => p.hasKey).length + ' 个已配置</span></div>' +
      '<div class="model-editor-layout"><aside class="model-directory"><div class="model-directory-title"><b>模型配置</b><button class="text-button" id="add-model" type="button">＋ 添加</button></div><div class="model-profile-list">' +
      Object.entries(config.profiles).map(([id, v]) => '<button type="button" class="model-profile-item ' + (selected === id ? 'selected' : '') + '" data-profile="' + escape(id) + '"><span class="model-profile-symbol">' + (v.protocol === 'anthropic' ? 'A' : 'O') + '</span><span><b>' + escape(name(id)) + '</b><small>' + escape(v.model) + '</small><em>' + (v.hasKey ? v.enabled ? 'Key 已保存' : '已停用' : '待配置') + '</em></span></button>').join('') +
      (draft ? '<div class="model-draft-label">＋ 正在添加新模型</div>' : '') + '</div><p class="model-key-note">一个配置对应一个 Key。<br>同一模型可添加多份配置，分别使用不同 Key。</p></aside>' +
      '<form id="model-form" class="model-editor"><div class="model-editor-heading"><h3>' + (draft ? '添加模型' : escape(name(selected))) + '</h3><span>' + (p.hasKey ? 'Key •••• '+escape(p.keySuffix||'未能读取') : '等待配置') + '</span></div>' +
      '<div class="model-field-pair"><div class="field"><label for="profile-name">显示名称</label><input id="profile-name" required maxlength="60" value="' + escape(p.name || '') + '" placeholder="例如 Opus · 游戏制作"/></div><div class="field"><label for="model-protocol">接口协议</label><select id="model-protocol"><option value="openai" ' + (p.protocol === 'openai' ? 'selected' : '') + '>OpenAI Chat Completions</option><option value="anthropic" ' + (p.protocol === 'anthropic' ? 'selected' : '') + '>Anthropic Messages</option></select></div></div>' +
      '<div class="field"><label for="base-url">接口地址</label><input id="base-url" type="url" required value="' + escape(p.baseUrl) + '" placeholder="https://api.example.com/v1" autocomplete="off"/><p>填写服务商提供的 HTTPS 接口地址。</p></div>' +
      '<div class="field"><label for="model-name">模型 ID</label><input id="model-name" required maxlength="150" value="' + escape(p.model) + '" placeholder="服务商提供的精确模型名称"/></div>' +
      '<div class="model-field-pair"><div class="field"><label for="model-effort">思考强度</label><select id="model-effort"></select></div><div class="field"><label for="model-output-limit">单次输出上限（Token）</label><input id="model-output-limit" type="number" min="0" step="1" value="' + (p.maxOutputTokens || 0) + '"/><p>0 为自动，按任务分配额度。</p></div></div><p class="model-routing-note" id="inference-help"></p>' +
      '<div class="field"><label for="api-key">API Key <span>' + (p.hasKey ? '留空保留当前 Key' : '新配置必填') + '</span></label><div class="key-field"><input id="api-key" type="password" autocomplete="new-password" maxlength="2000" ' + (p.hasKey ? '' : 'required') + ' placeholder="' + (p.hasKey ? '已保存，不会回显' : '粘贴该配置使用的 Key') + '"/><button class="icon-button" id="toggle-key" type="button" aria-label="显示或隐藏 Key">显示</button></div></div>' +
      '<div class="model-capabilities"><label class="enable-toggle"><input id="model-enabled" type="checkbox" ' + (p.enabled ? 'checked' : '') + '/><span><b>启用</b><small>允许新任务使用此配置</small></span></label><label class="enable-toggle"><input id="model-vision" type="checkbox" ' + (p.vision !== false ? 'checked' : '') + '/><span><b>支持图片</b><small>审核时接收真实游戏截图</small></span></label></div>' +
      (p.hasKey && /^https:\/\/riffle-api\.pages\.dev(?:\/|$)/i.test(p.baseUrl) && /^claude-opus-5-5$/i.test(p.model) ? '<section class="model-quota"><div class="model-quota-heading"><b>Opus Key 预算</b><button type="button" class="subtle-button" id="refresh-quota">查询余额</button></div><div id="quota-result" role="status" aria-live="polite">查询已保存 Key 的人民币预算与在途预占。</div></section>' : '') +
      '<div class="form-actions"><button type="button" class="subtle-button" id="test-model">测试连接与图片</button><div class="model-action-group">' + (p.hasKey ? '<button type="button" class="text-button model-delete" id="delete-model">删除配置</button>' : '') + '<button type="submit" class="primary-button" id="save-model">保存模型</button></div></div><p id="config-message" class="form-message" role="status" aria-live="polite"></p></form></div></section>' +
      '<section class="settings-card model-routing"><div class="settings-heading"><div><span class="eyebrow">MODEL SELECTION</span><h2>AI 审核和其他功能，分开选择。</h2><p class="model-intro">各选一个模型，保存后用于新的任务。</p></div></div><div class="model-route-list">' +
      steps.map(([id,title,desc], i) => '<label class="model-route-row"><span class="model-route-index">' + String(i+1).padStart(2,'0') + '</span><span class="model-route-copy"><b>' + title + '</b><small>' + desc + '</small></span><select data-route="' + id + '" aria-label="' + title + '模型">' + options(config.effective[id] || config.activeProfile) + '</select><span class="model-route-effective">当前：' + escape(name(config.effective[id] || config.activeProfile)) + '</span></label>').join('') +
      '</div><p class="model-routing-note">AI 审核建议选择支持图片的模型，以便结合游戏截图评分。</p><div class="form-actions"><span id="routes-message" class="form-message" role="status"></span><button type="button" class="primary-button" id="save-routes">保存选择</button></div></section>';
    root.prepend(root.querySelector('.model-routing')!);
    const library=root.querySelector<HTMLElement>('.model-library')!;
    library.hidden=!editorOpen;
    root.querySelector('.model-directory')!.remove();
    root.querySelector<HTMLElement>('.model-editor-layout')!.style.display='block';
    root.insertAdjacentHTML('afterbegin','<section class="settings-card provider-switcher"><div class="settings-heading"><div><span class="eyebrow">MODEL SWITCH</span><h2>模型与余额</h2><p>选择用途即可切换。已启用的 Opus Key 自动分担制作任务，每把最多同时运行 2 个请求。</p></div><div class="provider-toolbar"><button class="subtle-button" type="button" id="refresh-balances">刷新余额</button><button class="primary-button" type="button" id="add-model">＋ 添加模型</button></div></div><div class="provider-rows">'+Object.entries(config.profiles).map(([id,p])=>'<article class="provider-row" data-model-row="'+escape(id)+'"><div class="provider-symbol">'+(p.protocol==='anthropic'?'A':'D')+'</div><div class="provider-copy"><b>'+escape(name(id))+'</b><small>'+escape(p.model)+' · '+escape(p.baseUrl||'未填写地址')+' · Key •••• '+escape(p.keySuffix||'—')+'</small><span class="provider-balance" aria-live="polite"></span></div><div class="provider-actions"><span class="provider-usage"></span><div><button class="subtle-button" type="button" data-use="create">用于创作</button><button class="subtle-button" type="button" data-use="review">用于审核</button><button class="text-button" type="button" data-profile="'+escape(id)+'">编辑</button></div></div></article>').join('')+'</div><p id="switch-message" class="form-message" role="status"></p></section>');
    root.querySelector<HTMLButtonElement>('#refresh-balances')!.onclick=()=>void refreshQuotas(true);
    root.querySelectorAll<HTMLButtonElement>('[data-use]').forEach(button=>button.onclick=()=>void action(async()=>{
      const id=button.closest<HTMLElement>('[data-model-row]')!.dataset.modelRow!,group=button.dataset.use!;
      update(await api('config/routes','POST',{[group]:id,...(group==='create'?{activeProfile:id}:{})}));
      const route=root.querySelector<HTMLSelectElement>(`[data-route="${group}"]`)!;route.value=id;route.closest('.model-route-row')!.querySelector('.model-route-effective')!.textContent='当前：'+name(id);
      root.querySelector('#switch-message')!.textContent=`${group==='create'?'创作':'审核'}已切换为 ${name(id)}，新的任务开始使用。`;
      root.querySelector('#switch-message')!.classList.add('success');
    },'#switch-message'));
    paintSwitchRows();void refreshQuotas();
    root.insertAdjacentHTML('beforeend','<section class="settings-card"><div class="settings-heading"><div><span class="eyebrow">RECENT REQUESTS</span><h2>最近模型调用</h2><p>记录耗时、输出额度与结束原因，帮助定位卡顿；不保存提示词或思考正文。</p></div><button id="refresh-runs" class="subtle-button" type="button">刷新记录</button></div><div id="model-runs" class="model-run-list">点击刷新，查看最近 30 次调用。</div></section>');
    root.querySelector<HTMLButtonElement>('#refresh-runs')!.onclick = () => void action(async () => {
      const result = await api('runs');
      const titles:Record<string,string> = {review:'审核初评',review_verify:'评分复核',expand:'选题扩写',brief:'制作简报',preview:'样板图',assets:'美术资产',game:'游戏制作',tags:'打标',vocab:'补充词库'};
      root.querySelector('#model-runs')!.innerHTML = result.runs.length ? result.runs.map((r:any) => '<article class="model-run"><b>' + escape(titles[r.purpose] || r.purpose) + ' · ' + escape(r.model) + '</b><span>' + (r.status === 'ok' ? '已完整接收' : '未完成') + ' · ' + Math.round(r.elapsed_ms/1000) + 's · 首字 ' + (r.first_text_ms === null ? '—' : Math.round(r.first_text_ms/1000) + 's') + '</span><small>强度 ' + escape(r.effort) + ' · 输入 ' + (r.input_tokens ?? '未提供') + ' · 输出 ' + (r.output_tokens ?? '未提供') + ' / ' + r.max_tokens + ' · ' + escape(r.finish_reason || '未正常结束') + '</small>' + (r.error ? '<small>' + escape(r.error) + '</small>' : '') + '</article>').join('') : '暂无调用记录，后续任务会自动记录。';
    });
    const fields = () => ({profile:selected, name:input('profile-name').value, protocol:input('model-protocol').value, baseUrl:input('base-url').value, model:input('model-name').value, apiKey:input('api-key').value, enabled:input('model-enabled').checked, vision:input('model-vision').checked, effort:input('model-effort').value, maxOutputTokens:Number(input('model-output-limit').value)});
    function updateInference(value = 'auto') {
      const cap = modelCapabilities({baseUrl:input('base-url').value,model:input('model-name').value,protocol:input('model-protocol').value});
      const select = root.querySelector<HTMLSelectElement>('#model-effort')!;
      const labels:Record<string,string> = {low:'低 · 优先稳定交付',medium:'中',high:'高',xhigh:'很高',max:'最高'};
      select.innerHTML = '<option value="auto">自动 · 推荐</option>' + cap.efforts.map(v => '<option value="' + v + '">' + labels[v] + '</option>').join('');
      select.value = [...select.options].some(o => o.value === value) ? value : 'auto';
      input('model-output-limit').max = String(cap.maxOutput);
      root.querySelector('#inference-help')!.textContent = cap.kind === 'default' ? '此接口的思考控制尚未验证，使用服务商默认。自动输出上限 24,000 Token。' : '思考与正文共用输出额度。自动模式为审核 24k、简报 24k、资产 64k、制作 32k；接口标示上限 ' + cap.maxOutput.toLocaleString('en-US') + '。更高强度通常更慢，不能保证画面或玩法更好。游戏制作固定使用 Opus 5.5。';
    }
    updateInference(p.effort);
    ['base-url','model-name','model-protocol'].forEach(id => input(id).addEventListener('change',() => updateInference(input('model-effort').value)));
    root.querySelectorAll<HTMLButtonElement>('[data-profile]').forEach(b => b.onclick = () => { selected = b.dataset.profile!; draft = undefined; editorOpen=true; render(); root.querySelector('#model-form')!.scrollIntoView({block:'nearest'}); });
    root.querySelector<HTMLButtonElement>('#add-model')!.onclick = () => {
      if (Object.values(config.profiles).filter(v => v.hasKey).length >= 24) { message('最多保存 24 个模型配置。'); return; }
      selected = 'model-' + crypto.randomUUID(); editorOpen=true; draft = {name:'',baseUrl:p.baseUrl,model:p.model,protocol:p.protocol,hasKey:false,vision:p.vision,effort:p.effort,maxOutputTokens:p.maxOutputTokens,enabled:true,updatedAt:''}; render(); input('profile-name').focus();
    };
    root.querySelector<HTMLButtonElement>('#toggle-key')!.onclick = () => { input('api-key').type = input('api-key').type === 'password' ? 'text' : 'password'; };
    root.querySelector<HTMLButtonElement>('#refresh-quota')?.addEventListener('click',()=>void action(async()=>{
      const q=await api('quota?profile='+encodeURIComponent(selected));
      const money=(v:unknown)=>v===null?'未设上限':typeof v==='number'?'¥'+v.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2}):'未提供';
      const time=(v:string)=>v?new Date(v).toLocaleString('zh-CN',{hour12:false}):'未提供';
      root.querySelector('#quota-result')!.innerHTML='<div class="quota-values"><div><small>当前可用</small><strong>'+money(q.available)+'</strong></div><div><small>今日剩余 / 上限</small><b>'+money(q.daily.remaining)+' / '+money(q.daily.limit)+'</b></div><div><small>总剩余 / 上限</small><b>'+money(q.total.remaining)+' / '+money(q.total.limit)+'</b></div></div><p>今日已用 '+money(q.daily.used)+' · 累计已用 '+money(q.total.used)+' · 在途预占 '+money(q.reservations.amount)+'（'+escape(q.reservations.requests??'—')+' 笔）</p><p>请求限制 '+escape(q.requestsPerMinute??'未提供')+' 次/分钟 · 每日重置 '+escape(time(q.daily.resetAt))+'</p><small>查询时间 '+escape(time(q.queriedAt))+' · 当前可用已扣除在途预占，未结算用量可能使余额变化。'+(q.pendingReviewRequests?' 待核算请求 '+escape(q.pendingReviewRequests)+' 笔。':'')+'</small>';
    },'#quota-result'));
    root.querySelector<HTMLFormElement>('#model-form')!.onsubmit = e => { e.preventDefault(); const body = fields(); void action(async () => { update(await api('config','PUT',body)); quotas.delete(selected); draft = undefined; render(); message('模型已保存，可以在上方选择用途。',true); }); };
    root.querySelector<HTMLButtonElement>('#test-model')!.onclick = () => {
      if (!root.querySelector<HTMLFormElement>('#model-form')!.reportValidity()) return;
      const body = fields();
      void action(async () => { const result = await api('test','POST',body); if (result.vision === false) input('model-vision').checked = false; message(result.vision === false ? '文字连接成功，图片输入不可用，已取消图片选项；请保存。' : result.vision === null ? '文字连接成功，图片测试暂未完成，请重试；已保留图片选项。' : '文字与图片输入均连接成功。',true); });
    };
    root.querySelector<HTMLButtonElement>('#delete-model')?.addEventListener('click', () => void action(async () => { update(await api('config/profile','DELETE',{profile:selected})); selected = config.activeProfile; render(); message('配置已删除。',true); }));
    root.querySelector<HTMLButtonElement>('#save-routes')!.onclick = () => {
      const routes = Object.fromEntries([...root.querySelectorAll<HTMLSelectElement>('[data-route]')].map(s => [s.dataset.route, s.value]));
      void action(async () => {
        // Save the two groups atomically; the other-functions model is also the legacy default.
        update(await api('config/routes','POST',{...routes,activeProfile:routes.create}));
        const editor = fields(); render();
        // Routing changes must not discard an unsaved key or editor changes.
        input('profile-name').value=editor.name; input('base-url').value=editor.baseUrl; input('model-name').value=editor.model; input('api-key').value=editor.apiKey; input('model-protocol').value=editor.protocol; input('model-enabled').checked=editor.enabled; input('model-vision').checked=editor.vision; updateInference(editor.effort); input('model-output-limit').value=String(editor.maxOutputTokens);
        root.querySelector('#routes-message')!.textContent = '已保存，AI 审核和其他功能将分别使用所选模型。';
        root.querySelector('#routes-message')!.classList.add('success');
      }, '#routes-message');
    };
  }
  render();
}
