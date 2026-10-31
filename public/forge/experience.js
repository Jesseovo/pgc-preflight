// Session-only metadata reads. No persisted credentials, reports or game source.
export function createReadCache({ ttl = 30000, capacity = 80 } = {}) {
  const entries = new Map(); let epoch = 0;
  const clear = () => { epoch++; entries.clear(); };
  async function read(key, load, { fresh = false, signal = /** @type {AbortSignal | undefined} */ (undefined) } = {}) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    let entry = entries.get(key);
    if (!entry || (!entry.pending && (fresh || Date.now() >= entry.expires))) {
      const generation = epoch;
      entry = { pending: null, expires: 0, value: undefined };
      const current = entry;
      current.pending = Promise.resolve().then(load).then(value => {
        if (epoch === generation && entries.get(key) === current) { current.value = structuredClone(value); current.expires = Date.now() + ttl; current.pending = null; }
        return value;
      }, error => { if (entries.get(key) === current) entries.delete(key); throw error; });
      entries.set(key, current);
      while (entries.size > capacity) entries.delete(entries.keys().next().value);
    }
    const result = entry.pending || Promise.resolve(entry.value);
    if (!signal) return structuredClone(await result);
    return new Promise((resolve, reject) => {
      const abort = () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')); };
      const cleanup = () => signal.removeEventListener('abort', abort);
      signal.addEventListener('abort', abort, { once: true });
      result.then(value => { cleanup(); if (!signal.aborted) resolve(structuredClone(value)); }, error => { cleanup(); reject(error); });
    });
  }
  return { read, clear, get size() { return entries.size; } };
}
export function waitVisible(ms) {
  return new Promise(resolve => setTimeout(() => {
    if (!document.hidden) { resolve(); return; }
    const resume = () => { if (!document.hidden) { document.removeEventListener('visibilitychange', resume); resolve(); } };
    document.addEventListener('visibilitychange', resume);
  }, ms));
}

// Reconcile the existing tree so unchanged players, inputs and focus survive updates.
export function patchHtml(root, html) {
  const template = root.ownerDocument.createElement('template'); template.innerHTML = html;
  const key = node => node.nodeType === 1 ? node.id || node.getAttribute('data-id') || node.getAttribute('data-job') : null;
  const sync = (parent, desired) => {
    const keyed = new Map();
    for (const node of parent.childNodes) { const id = key(node); if (id) keyed.set(node.nodeName + ':' + id, node); }
    let cursor = parent.firstChild;
    for (const next of [...desired.childNodes]) {
      let current = cursor;
      const id = key(next);
      if (id) { const lookup = next.nodeName + ':' + id; current = keyed.get(lookup) || null; keyed.delete(lookup); }
      if (!current || current.nodeType !== next.nodeType || current.nodeName !== next.nodeName || (key(current) && key(current) !== id)) {
        current = next.cloneNode(true); parent.insertBefore(current, cursor);
      } else {
        if (current !== cursor) parent.insertBefore(current, cursor);
        if (!current.isEqualNode(next)) {
          if (current.nodeType === 1) {
            for (const attr of [...current.attributes]) if (!next.hasAttribute(attr.name)) current.removeAttribute(attr.name);
            for (const attr of [...next.attributes]) if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
            sync(current, next);
          } else if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
        }
      }
      cursor = current.nextSibling;
    }
    while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
  };
  sync(root, template.content);
}

// One demand-driven batch timer for all creation observers in this page.
export function createTaskReader(loadBatch, loadOne) {
  const pending = new Map(); const seen = new Map();
  let timer, running = false, nextAt = 0, failures = 0;
  const schedule = () => {
    if (timer || running || !pending.size || document.hidden) return;
    timer = setTimeout(flush, Math.max(0, nextAt - Date.now()));
  };
  async function flush() {
    timer = undefined;
    if (document.hidden || !pending.size) return;
    running = true;
    const batch = [...pending.entries()];pending.clear();
    try {
      const rows = await loadBatch();
      for (const row of rows) seen.set(row.id, row.executor);
      while(seen.size>200)seen.delete(seen.keys().next().value);
      // Limit fallback reads for older tasks that fell outside the bounded list.
      let cursor = 0;
      await Promise.all(Array.from({length:Math.min(4,batch.length)},async()=>{
        while(cursor<batch.length){const [id,listeners]=batch[cursor++];try{const row=rows.find(row=>row.id===id)||await loadOne(id);seen.set(id,row.executor);listeners.forEach(item=>item.resolve(row));}catch(error){listeners.forEach(item=>item.reject(error));}}
      }));
      failures = 0;
    } catch(error) {failures=Math.min(3,failures+1);for(const [,listeners]of batch)listeners.forEach(item=>item.reject(error));}
    finally {
      const agentOnly=batch.every(([id])=>seen.get(id)==='agent');
      nextAt=Date.now()+Math.min(60000,(agentOnly?60000:10000)*2**failures);
      running=false;schedule();
    }
  }
  document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimeout(timer);timer=undefined;}else{nextAt=0;schedule();}});
  return {read(id){return new Promise((resolve,reject)=>{if(!seen.has(id)){seen.set(id,undefined);nextAt=0;clearTimeout(timer);timer=undefined;}const list=pending.get(id)||[];list.push({resolve,reject});pending.set(id,list);schedule();});}};
}
