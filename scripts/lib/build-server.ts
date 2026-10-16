import { join } from 'node:path';
import { build } from 'esbuild';
import { ROOT, readPackageInfo } from './project.ts';

export interface BuildServerOptions {
  outfile: string;
}

/** 把服务端打成单个 CJS 文件：SEA 默认只能 require 内置模块（调研 F2 / ADR-002）。 */
export async function buildServer({ outfile }: BuildServerOptions): Promise<void> {
  const { version } = readPackageInfo();
  await build({
    entryPoints: [join(ROOT, 'src', 'server', 'main.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    define: { __APP_VERSION__: JSON.stringify(version) },
    legalComments: 'none',
    sourcemap: false,
    logLevel: 'warning',
  });
}
