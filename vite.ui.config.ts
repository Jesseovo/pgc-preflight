import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import {resolve} from 'node:path';
export default defineConfig({plugins:[react(),tailwind()],resolve:{alias:{'@':resolve('src/ui/vendor/looseleaf')}},server:{port:8790,strictPort:true},build:{outDir:'dist-ui',target:'es2022',rollupOptions:{input:'ui.html',output:{chunkFileNames:chunk=>{
  const ids=[chunk.facadeModuleId||'',...chunk.moduleIds].map(id=>id.replaceAll('\\','/'));
  const role=ids.some(id=>id.includes('/src/ui/pages/admin/'))?'admin-':ids.some(id=>id.includes('/src/ui/pages/creator/'))?'creator-':'';
  return `assets/ui-${role}[name]-[hash].js`;
},assetFileNames:'assets/ui-[name]-[hash][extname]'}}}});
