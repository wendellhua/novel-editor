import { statSync } from 'node:fs';
import { join } from 'node:path';
import { build as viteBuild } from 'vite';
import { buildServer } from './lib/build-server.ts';
import { copyDirIfExists, formatBytes, listFilesRecursive } from './lib/fs-utils.ts';
import { DIST, ROOT, readPackageInfo } from './lib/project.ts';
import { scanDirForExternalUrls } from './lib/url-scan.ts';

const started = performance.now();
const { version } = readPackageInfo();

await viteBuild({ configFile: join(ROOT, 'vite.config.ts'), logLevel: 'warn' });
await buildServer({ outfile: join(DIST, 'server.cjs') });
const hasBuiltinSkills = copyDirIfExists(join(ROOT, 'builtin-skills'), join(DIST, 'builtin-skills'));

const findings = scanDirForExternalUrls(join(DIST, 'web'));
if (findings.length > 0) {
  console.error('构建失败：前端产物中出现外部 URL（违反 §6.5 约束）：');
  for (const f of findings) console.error(`  ${f.file}: ${f.url}`);
  process.exit(1);
}

const webFiles = listFilesRecursive(join(DIST, 'web'));
const webBytes = webFiles.reduce((sum, rel) => sum + statSync(join(DIST, 'web', rel)).size, 0);
console.log(`NovelEditor ${version} 构建完成（${Math.round(performance.now() - started)} ms）`);
console.log(`  dist/server.cjs  ${formatBytes(statSync(join(DIST, 'server.cjs')).size)}`);
console.log(`  dist/web/        ${webFiles.length} 个文件，共 ${formatBytes(webBytes)}`);
console.log(`  dist/builtin-skills/ ${hasBuiltinSkills ? '已复制' : '（尚无内置技能）'}`);
console.log('  外部 URL 扫描：通过');
