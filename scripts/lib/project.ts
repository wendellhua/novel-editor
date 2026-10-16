import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface PackageInfo {
  name: string;
  productName: string;
  version: string;
}

export function readPackageInfo(): PackageInfo {
  const raw: unknown = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  if (typeof raw !== 'object' || raw === null) throw new Error('package.json 格式错误');
  const { name, productName, version } = raw as Record<string, unknown>;
  if (typeof name !== 'string' || typeof productName !== 'string' || typeof version !== 'string') {
    throw new Error('package.json 缺少 name / productName / version');
  }
  return { name, productName, version };
}

export const DIST = join(ROOT, 'dist');
export const RELEASE = join(ROOT, 'release');
export const CACHE = join(ROOT, '.cache');
