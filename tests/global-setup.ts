import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildServer } from '../scripts/lib/build-server.ts';
import { CACHE, ROOT } from '../scripts/lib/project.ts';

export const TEST_BUILD_DIR = join(CACHE, 'test-build');

/** 为进程级测试构建一份服务端包，配上测试用的前端资源（tests/fixtures/web）与真实的内置技能（与 dist/ 结构一致）。 */
export default async function setup(): Promise<void> {
  rmSync(TEST_BUILD_DIR, { recursive: true, force: true });
  mkdirSync(TEST_BUILD_DIR, { recursive: true });
  await buildServer({ outfile: join(TEST_BUILD_DIR, 'server.cjs') });
  cpSync(join(ROOT, 'tests', 'fixtures', 'web'), join(TEST_BUILD_DIR, 'web'), { recursive: true });
  cpSync(join(ROOT, 'builtin-skills'), join(TEST_BUILD_DIR, 'builtin-skills'), { recursive: true });
}
