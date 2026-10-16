import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import * as sea from 'node:sea';

/** 静态资源统一读取入口（§7.6）：SEA 中读内嵌资源，否则读 appRoot 下的文件。路径一律用 / 分隔。 */
export interface AssetReader {
  readonly mode: 'sea' | 'disk';
  read(relPath: string): Buffer | null;
  list(prefix: string): string[];
}

/** 只接受「相对、无 ..、无反斜杠、无空段」的路径，杜绝目录穿越。 */
export function isSafeRelPath(p: string): boolean {
  if (p === '' || p.includes('\0') || p.includes('\\') || p.startsWith('/')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function createSeaReader(): AssetReader {
  const keys = new Set(sea.getAssetKeys());
  const cache = new Map<string, Buffer>();
  return {
    mode: 'sea',
    read(relPath) {
      if (!isSafeRelPath(relPath) || !keys.has(relPath)) return null;
      let buf = cache.get(relPath);
      if (buf === undefined) {
        buf = Buffer.from(sea.getAsset(relPath));
        cache.set(relPath, buf);
      }
      return buf;
    },
    list(prefix) {
      return [...keys].filter((k) => k.startsWith(prefix)).sort();
    },
  };
}

function createDiskReader(appRoot: string): AssetReader {
  const root = resolve(appRoot);
  return {
    mode: 'disk',
    read(relPath) {
      if (!isSafeRelPath(relPath)) return null;
      const full = resolve(root, relPath);
      if (!full.startsWith(root + sep)) return null;
      if (!existsSync(full) || !statSync(full).isFile()) return null;
      return readFileSync(full);
    },
    list(prefix) {
      const out: string[] = [];
      const walk = (dir: string): void => {
        if (!existsSync(dir)) return;
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else out.push(relative(root, full).split(sep).join('/'));
        }
      };
      // 只遍历前缀所在的目录，避免 appRoot 是仓库根目录时扫描 node_modules
      const base = prefix.slice(0, prefix.lastIndexOf('/') + 1);
      if (base !== '' && !isSafeRelPath(base.slice(0, -1))) return [];
      walk(base === '' ? root : resolve(root, base));
      return out.filter((k) => k.startsWith(prefix)).sort();
    },
  };
}

export function createAssetReader(appRoot: string): AssetReader {
  return sea.isSea() ? createSeaReader() : createDiskReader(appRoot);
}
