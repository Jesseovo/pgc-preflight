let modules;
export function prepareSquare() {
  if (!modules) {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = '/square/workspace.css';
    const css = new Promise((resolve, reject) => {
      link.onload = resolve;
      link.onerror = () => reject(new Error('广场样式加载失败，请重试'));
      document.head.append(link);
    });
    modules = Promise.all([import('/square/workspace.js'), import('/square/template.js'), css])
      .catch(error => { link.remove(); modules = undefined; throw error; });
  }
  return modules;
}
export async function renderSquare(root,user,alive,commit=async update=>update()) {
  const [workspace,template]=await prepareSquare();
  if(!alive())return;
  const initialData=await workspace.prepareSquareList(user);
  if(!alive())return;
  let cleanup;
  await commit(()=>{
    const surface=document.createElement('section');
    surface.className='square-surface';surface.innerHTML=template.squareTemplate;
    root.replaceChildren(surface);
    cleanup=workspace.mountSquare({root:surface,user,alive,initialData});
  });
  // Stop active work immediately, retaining the old layout until replacement.
  return ()=>cleanup?.();
}
