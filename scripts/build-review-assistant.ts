import {build} from 'esbuild';
import {mkdir,copyFile} from 'node:fs/promises';
await mkdir('public/agent',{recursive:true});
await build({entryPoints:['scripts/review-agent.ts'],outfile:'public/agent/review-agent.mjs',bundle:true,platform:'node',format:'esm',target:'node22',banner:{js:"import{createRequire as __pgcCreateRequire}from'node:module';const require=__pgcCreateRequire(import.meta.url);"}});
await copyFile('docs/agent-integration.md','public/agent.md');
console.log('Built Agent protocol and on-demand client; no manual package installation.');

