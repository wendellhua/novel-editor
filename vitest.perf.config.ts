import { defineConfig } from 'vitest/config';
import { readPackageInfo } from './scripts/lib/project.ts';

const { version } = readPackageInfo();

/** 性能测试单独运行（npm run test:perf）：数据量大，不放进日常 npm test。 */
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  test: {
    include: ['tests/perf/**/*.perf.ts'],
    environment: 'node',
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
