import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../../scripts/lib/project.ts';

const SRC = join(ROOT, 'src');
const IMPORT_RE = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s*)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listSources(full));
    else if (/\.(ts|vue)$/.test(name)) out.push(full);
  }
  return out;
}

function importsOf(file: string): string[] {
  const code = readFileSync(file, 'utf8');
  return [...code.matchAll(IMPORT_RE)].map((m) => m[1] ?? m[2] ?? '').filter(Boolean);
}

function layerOf(file: string): string {
  return relative(SRC, file).split(sep)[0] ?? '';
}

function resolvedLayer(file: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const target = resolve(dirname(file), specifier);
  const rel = relative(SRC, target);
  if (rel.startsWith('..')) return 'outside-src';
  return rel.split(sep)[0] ?? '';
}

describe('架构依赖规则（§3.2 / §5.1）', () => {
  const files = listSources(SRC).filter((f) => layerOf(f) !== 'env.d.ts');

  it('能找到源码文件', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [relative(ROOT, f), f]))('%s 只依赖允许的层', (_name, file) => {
    const layer = layerOf(file);
    for (const spec of importsOf(file)) {
      const target = resolvedLayer(file, spec);
      if (layer === 'shared') {
        expect(spec.startsWith('node:'), `shared 禁止引用 Node 内置模块：${spec}`).toBe(false);
        expect(target === null || target === 'shared', `shared 只能引用 shared：${spec}`).toBe(true);
        expect(target !== null || spec === 'vitest', `shared 禁止引用第三方包：${spec}`).toBe(true);
      }
      if (layer === 'server') {
        expect(target, `server 禁止引用 web：${spec}`).not.toBe('web');
      }
      if (layer === 'web') {
        expect(spec.startsWith('node:'), `web 禁止引用 Node 内置模块：${spec}`).toBe(false);
        expect(target, `web 禁止引用 server：${spec}`).not.toBe('server');
      }
      expect(target, `禁止引用 src 之外的文件：${spec}`).not.toBe('outside-src');
    }
  });

  it('shared 不使用运行环境专有的全局对象', () => {
    for (const file of files.filter((f) => layerOf(f) === 'shared')) {
      const code = readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(/\b(window|document|process|Buffer|require)\b/.test(code), relative(ROOT, file)).toBe(false);
    }
  });
});
