import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatBytes, listFilesRecursive } from './lib/fs-utils.ts';
import { NODE_RUNTIME_VERSION, ensureNodeBinary } from './lib/node-runtime.ts';
import { DIST, RELEASE, ROOT } from './lib/project.ts';
import { WIN_README } from './lib/user-guide.ts';

if (process.platform !== 'win32') {
  console.error('Windows 安装包需要在 Windows 上构建（SEA 注入使用同版本的 node.exe）');
  process.exit(1);
}
for (const required of [join(DIST, 'server.cjs'), join(DIST, 'web', 'index.html')]) {
  if (!existsSync(required)) {
    console.error(`缺少 ${required}，请先执行 npm run build`);
    process.exit(1);
  }
}

const nodeExe = await ensureNodeBinary('win-x64');

const assets: Record<string, string> = {};
for (const dir of ['web', 'builtin-skills']) {
  for (const rel of listFilesRecursive(join(DIST, dir))) assets[`${dir}/${rel}`] = join(DIST, dir, ...rel.split('/'));
}

mkdirSync(RELEASE, { recursive: true });
const output = join(RELEASE, 'NovelEditor.exe');
rmSync(output, { force: true });
const configPath = join(DIST, 'sea-config.json');
writeFileSync(
  configPath,
  JSON.stringify(
    {
      main: join(DIST, 'server.cjs'),
      mainFormat: 'commonjs',
      output,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
      execArgv: ['--disable-warning=ExperimentalWarning'],
      assets,
    },
    null,
    2,
  ),
);

console.log(`生成 SEA：Node ${NODE_RUNTIME_VERSION}，内嵌 ${Object.keys(assets).length} 个资源`);
const result = spawnSync(nodeExe, ['--build-sea', configPath], { stdio: 'inherit' });
if (result.status !== 0 || !existsSync(output)) {
  console.error(`SEA 构建失败（退出码 ${String(result.status)}）`);
  process.exit(1);
}
// 随附说明：简明版（SmartScreen、数据目录、备份与恢复）与完整的使用说明
writeFileSync(join(RELEASE, 'README-win.txt'), `\uFEFF${WIN_README.replace(/\n/g, '\r\n')}`);
copyFileSync(join(ROOT, 'docs', 'USER_GUIDE.md'), join(RELEASE, 'USER_GUIDE.md'));
console.log(`完成：${output}（${formatBytes(statSync(output).size)}），附 README-win.txt、USER_GUIDE.md`);
