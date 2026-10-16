import { defineConfig } from 'vitest/config';
import { readPackageInfo } from './scripts/lib/project.ts';

const { version } = readPackageInfo();

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['tests/global-setup.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
