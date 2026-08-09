import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

const aliases = {
  '@gw2cc/core': path.resolve('packages/core/src/index.ts'),
  '@gw2cc/gw2': path.resolve('packages/gw2/src/index.ts'),
  '@gw2cc/llm': path.resolve('packages/llm/src/index.ts'),
  '@gw2cc/protocol': path.resolve('packages/protocol/src/index.ts'),
  '@gw2cc/storage': path.resolve('packages/storage/src/index.ts'),
  '@gw2cc/tools': path.resolve('packages/tools/src/index.ts'),
  '@gw2cc/web': path.resolve('packages/web/src/index.ts')
};

export default defineConfig({
  main: {
    resolve: { alias: aliases },
    build: {
      rollupOptions: {
        input: path.resolve('apps/desktop/electron/main.ts'),
        external: ['electron', 'better-sqlite3']
      }
    }
  },
  preload: {
    resolve: { alias: aliases },
    build: {
      rollupOptions: {
        input: path.resolve('apps/desktop/electron/preload.ts'),
        external: ['electron'],
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    root: path.resolve('apps/desktop/renderer'),
    resolve: { alias: aliases },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: path.resolve('apps/desktop/renderer/index.html')
      }
    }
  }
});
