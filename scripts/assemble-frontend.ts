import {copyFile,cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

// Build both clients first so existing scripts, Agent bundles and fallback assets
// remain available. Worker page guards always choose the unified shell.
const shell=await readFile('dist-ui/ui.html','utf8');
if(!shell.includes('/assets/')||shell.includes('/src/ui/main.tsx'))throw new Error('Frontend shell has not been built.');
await cp('dist-ui/assets','dist/assets',{recursive:true});
await copyFile('dist-ui/ui.html','dist/_workbench.html');
for(const page of ['index.html','login.html','account.html','admin.html','admin-login.html','review.html','square.html','forge/index.html']){
  const file=`dist/${page}`;
  await mkdir(dirname(file),{recursive:true});
  await writeFile(file,shell);
}
console.log('Assembled unified frontend and preserved Agent/static assets.');
