import { join } from 'node:path';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';
import { DIST, ROOT, readPackageInfo } from './scripts/lib/project.ts';

const { version } = readPackageInfo();

export default defineConfig({
  root: join(ROOT, 'src', 'web'),
  base: '/',
  publicDir: 'public',
  plugins: [vue()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  build: {
    outDir: join(DIST, 'web'),
    emptyOutDir: true,
    assetsDir: 'assets',
    target: 'es2022',
    modulePreload: { polyfill: false },
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
});
