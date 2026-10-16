import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DIST, RELEASE, readPackageInfo } from './lib/project.ts';
import { formatSmokeReport, runSmoke, type SmokeTarget } from './lib/smoke-runner.ts';

const useWin = process.argv.includes('--win');
const target: SmokeTarget = useWin
  ? { label: 'NovelEditor.exe（SEA）', command: join(RELEASE, 'NovelEditor.exe'), args: [] }
  : {
      label: 'dist/server.cjs',
      command: process.execPath,
      args: ['--disable-warning=ExperimentalWarning', join(DIST, 'server.cjs')],
    };

const entry = useWin ? target.command : join(DIST, 'server.cjs');
if (!existsSync(entry)) {
  console.error(`找不到 ${entry}，请先执行 ${useWin ? 'npm run build && npm run package:win' : 'npm run build'}`);
  process.exit(1);
}

const dataDir = mkdtempSync(join(tmpdir(), 'ne-smoke-'));
console.log(`冒烟目标：${target.label}\n临时数据目录：${dataDir}\n`);
const report = await runSmoke({ target, dataDir, expectVersion: readPackageInfo().version });
console.log(formatSmokeReport(report));
rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
process.exit(report.ok ? 0 : 1);
