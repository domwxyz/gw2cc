import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@gw2cc/core': path.resolve('packages/core/src/index.ts'),
      '@gw2cc/gw2': path.resolve('packages/gw2/src/index.ts'),
      '@gw2cc/llm': path.resolve('packages/llm/src/index.ts'),
      '@gw2cc/protocol': path.resolve('packages/protocol/src/index.ts'),
      '@gw2cc/storage': path.resolve('packages/storage/src/index.ts'),
      '@gw2cc/tools': path.resolve('packages/tools/src/index.ts'),
      '@gw2cc/web': path.resolve('packages/web/src/index.ts')
    }
  },
  test: {
    projects: [
      {
        test: {
          name: 'packages',
          include: ['packages/**/*.test.ts', 'apps/desktop/electron/**/*.test.ts'],
          environment: 'node'
        }
      },
      {
        test: {
          name: 'renderer',
          include: ['apps/desktop/renderer/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['./apps/desktop/renderer/src/test-setup.ts']
        }
      }
    ],
    coverage: { reporter: ['text', 'html'] }
  }
});
