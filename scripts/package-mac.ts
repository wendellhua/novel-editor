import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatBytes, listFilesRecursive } from './lib/fs-utils.ts';
import { LAUNCHER_SCRIPT, MAC_README, infoPlist } from './lib/mac-bundle.ts';
import { NODE_RUNTIME_VERSION, ensureNodeBinary } from './lib/node-runtime.ts';
import { DIST, RELEASE, ROOT, readPackageInfo } from './lib/project.ts';
import { readTarGz, writeTarGz, type TarInput } from './lib/tar.ts';

for (const required of [join(DIST, 'server.cjs'), join(DIST, 'web', 'index.html')]) {
  if (!existsSync(required)) {
    console.error(`缺少 ${required}，请先执行 npm run build`);
    process.exit(1);
  }
}

const { version } = readPackageInfo();
const nodeBin = await ensureNodeBinary('darwin-arm64');

const APP = 'NovelEditor.app';
const DIR_MODE = 0o755;
const EXEC_MODE = 0o755;
const FILE_MODE = 0o644;
const entries: TarInput[] = [];
const dirs = new Set<string>();

const addDir = (path: string): void => {
  const parts = path.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const d = parts.slice(0, i).join('/');
    if (!dirs.has(d)) {
      dirs.add(d);
      entries.push({ name: d, type: 'dir', mode: DIR_MODE });
    }
  }
};
const addFile = (path: string, data: Uint8Array | string, mode = FILE_MODE): void => {
  const parent = path.split('/').slice(0, -1).join('/');
  if (parent !== '') addDir(parent);
  entries.push({ name: path, type: 'file', mode, data: typeof data === 'string' ? Buffer.from(data, 'utf8') : data });
};

addFile('README-mac.txt', MAC_README);
addFile('USER_GUIDE.md', readFileSync(join(ROOT, 'docs', 'USER_GUIDE.md')));
addFile(`${APP}/Contents/Info.plist`, infoPlist(version));
addFile(`${APP}/Contents/MacOS/NovelEditor`, LAUNCHER_SCRIPT, EXEC_MODE);
addFile(`${APP}/Contents/Resources/node`, readFileSync(nodeBin), EXEC_MODE);
addFile(`${APP}/Contents/Resources/app/server.cjs`, readFileSync(join(DIST, 'server.cjs')));
for (const dir of ['web', 'builtin-skills']) {
  for (const rel of listFilesRecursive(join(DIST, dir))) {
    addFile(`${APP}/Contents/Resources/app/${dir}/${rel}`, readFileSync(join(DIST, dir, ...rel.split('/'))));
  }
}

mkdirSync(RELEASE, { recursive: true });
const output = join(RELEASE, 'NovelEditor-mac-arm64.tar.gz');
const archive = writeTarGz(entries);
writeFileSync(output, archive);

const check = readTarGz(archive);
const modeOf = (name: string): number | undefined => check.find((e) => e.name === name)?.mode;
for (const exec of [`${APP}/Contents/MacOS/NovelEditor`, `${APP}/Contents/Resources/node`]) {
  if (modeOf(exec) !== EXEC_MODE) throw new Error(`${exec} 权限不是 0755`);
}
if (LAUNCHER_SCRIPT.includes('\r')) throw new Error('启动脚本含 CRLF');

console.log(`完成：${output}（${formatBytes(statSync(output).size)}，Node ${NODE_RUNTIME_VERSION} darwin-arm64，${check.length} 个条目）`);
