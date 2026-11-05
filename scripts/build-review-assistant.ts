import {build} from 'esbuild';
import {mkdir,copyFile} from 'node:fs/promises';
await mkdir('public/agent',{recursive:true});
const banner={js:"import{createRequire as __pgcCreateRequire}from'node:module';const require=__pgcCreateRequire(import.meta.url);"};
await build({entryPoints:['scripts/review-agent.ts'],outfile:'public/agent/review-agent.mjs',bundle:true,platform:'node',format:'esm',target:'node22',banner});
await build({entryPoints:['scripts/forge-agent.ts'],outfile:'public/agent/forge-agent.mjs',bundle:true,platform:'node',format:'esm',target:'node22',banner});
await copyFile('docs/agent-integration.md','public/agent.md');
await copyFile('docs/forge-agent-integration.md','public/forge-agent.md');
console.log('Built Agent protocol and on-demand client; no manual package installation.');

