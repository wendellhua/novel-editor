import { mkdirSync } from 'node:fs';
import { posix, resolve, win32 } from 'node:path';
import { APP_NAME } from '../../shared/constants';

export interface DataDirInput {
  override: string | null;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homedir: string;
  cwd: string;
}

/** 数据目录（§5.2）：显式指定 > 平台默认。Linux 仅用于开发和测试。 */
export function resolveDataDir({ override, platform, env, homedir, cwd }: DataDirInput): string {
  if (override !== null && override.trim() !== '') return resolve(cwd, override);
  if (platform === 'win32') {
    const appData = env.APPDATA ?? win32.join(homedir, 'AppData', 'Roaming');
    return win32.join(appData, APP_NAME);
  }
  if (platform === 'darwin') return posix.join(homedir, 'Library', 'Application Support', APP_NAME);
  return posix.join(env.XDG_DATA_HOME ?? posix.join(homedir, '.local', 'share'), APP_NAME);
}

export interface DataPaths {
  root: string;
  works: string;
  trash: string;
  backups: string;
  skills: string;
  logs: string;
  config: string;
  llm: string;
  instance: string;
}

export function dataPaths(root: string): DataPaths {
  const join = (...parts: string[]): string => resolve(root, ...parts);
  return {
    root,
    works: join('works'),
    trash: join('trash'),
    backups: join('backups'),
    skills: join('skills'),
    logs: join('logs'),
    config: join('config.json'),
    llm: join('llm.json'),
    instance: join('instance.json'),
  };
}

export function ensureDataDirs(paths: DataPaths): void {
  for (const dir of [paths.root, paths.works, paths.trash, paths.backups, paths.skills, paths.logs]) {
    mkdirSync(dir, { recursive: true });
  }
}
