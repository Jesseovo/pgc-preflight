// Commit a prepared page, its navigation state and scroll position together.
// No view snapshot is held while network requests are pending.
export function createPageNavigation(root) {
  const status=document.createElement('div');
  status.className='workspace-route-status';status.setAttribute('role','status');status.hidden=true;
  document.body.append(status);
  let active,animation;
  const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
  reducedMotion.addEventListener('change',()=>{if(reducedMotion.matches)animation?.cancel();});
  const navigator={
    get pending(){return !!active&&!active.committed;},
    begin({alive,scrollTop=0,label='正在打开页面',onCommit=()=>{}}){
      active?.cancel();animation?.cancel();
      const height=root.getBoundingClientRect().height;
      const previousMinHeight=root.style.minHeight;
      root.style.minHeight=height+'px';root.inert=true;root.setAttribute('aria-busy','true');
      const timer=setTimeout(()=>{if(alive()){status.textContent=label+'…';status.hidden=false;}},250);
      const entry={committed:false,cancel(){clearTimeout(timer);status.hidden=true;root.style.minHeight=previousMinHeight;}};
      active=entry;
      return {
        async commit(update){
          if(!alive())return;
          const change=async()=>{
            if(!alive())return;
            await update();
            if(!alive())return;
            onCommit();root.style.minHeight=previousMinHeight;
            // Capture the destination before loading; intermediate layout scroll
            // events must never replace this destination in history.state.
            window.scrollTo({top:scrollTop,behavior:'instant'});
            entry.committed=true;root.inert=false;root.removeAttribute('aria-busy');
            clearTimeout(timer);status.hidden=true;
          };
          const entering=!!root.childElementCount;
          await change();
          // Animate live content: snapshot-based transitions suppress hit testing
          // on the captured subtree and can swallow a quick second click.
          if(alive()&&entering&&!document.hidden&&!reducedMotion.matches){
            animation=root.animate([{opacity:.9},{opacity:1}],{duration:100,easing:'ease-out'});
          }
        },
        finish(){if(active!==entry)return;clearTimeout(timer);status.hidden=true;root.style.minHeight=previousMinHeight;root.inert=false;root.removeAttribute('aria-busy');active=undefined;},
      };
    },
  };
  return navigator;
}

// These reads belong to the requested page. Reuse each response exactly once
// during mounting; later polling and explicit refresh always hit the API.
export async function prepareReviewReads(api){
  const paths=['review/worker-status','reviews','review/jobs'];
  const results=await Promise.allSettled(paths.map(path=>api('GET',path)));
  const first=new Map(paths.map((path,i)=>[path,results[i]]));
  return (method,path,...args)=>{
    if(method==='GET'&&first.has(path)){
      const result=first.get(path);first.delete(path);
      return result.status==='fulfilled'?Promise.resolve(result.value):Promise.reject(result.reason);
    }
    return api(method,path,...args);
  };
}
