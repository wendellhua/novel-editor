import { LIMITS } from '../../shared/constants';
import type { ImportSkillFilesRequest } from '../../shared/types';
import { skillInvalid } from './errors';
import { parseSkillMd, type ParsedSkill } from './parser';
import { normalizeEntryPath, readZip, type PackageFile, type ZipLimits } from './zip';

export const SKILL_LIMITS: ZipLimits = {
  maxZipBytes: LIMITS.skillZipMaxBytes,
  maxUnpackedBytes: LIMITS.skillUnpackedMaxBytes,
  maxFiles: LIMITS.skillMaxFiles,
};

export interface SkillPackage {
  parsed: ParsedSkill;
  /** 只保留 .md / .txt（含 SKILL.md），路径相对技能根目录。 */
  files: PackageFile[];
  /** 被丢弃的非文本文件数（脚本、图片等，INV-13：任何文件都不会被执行）。 */
  skipped: number;
}

const TEXT_RE = /\.(md|txt)$/i;
const utf8Strict = new TextDecoder('utf-8', { fatal: true });

/** macOS 压缩时附带的 __MACOSX/、._* 与 .DS_Store 不属于技能内容。 */
function isJunk(path: string): boolean {
  const segments = path.split('/');
  return segments[0] === '__MACOSX' || segments.some((s) => s === '.DS_Store' || s.startsWith('._'));
}

export const isTextFile = (path: string): boolean => TEXT_RE.test(path);

/**
 * 把解压或上传得到的文件整理成技能包（§7.5、INV-13）：
 * 根目录下没有 SKILL.md、且全部文件都在同一个子目录里并且该子目录有 SKILL.md 时，把它当作根；
 * 校验 SKILL.md（UTF-8、frontmatter 的 name / description）；只保留 .md 与 .txt。
 */
export function buildPackage(input: PackageFile[], limits: ZipLimits = SKILL_LIMITS): SkillPackage {
  const files = input.filter((f) => !isJunk(f.path));
  if (files.length > limits.maxFiles) throw skillInvalid(`文件数超过 ${limits.maxFiles} 个`);
  const total = files.reduce((n, f) => n + f.data.length, 0);
  if (total > limits.maxUnpackedBytes) throw skillInvalid(`解压后超过 ${Math.round(limits.maxUnpackedBytes / 1048576)} MB`);

  let prefix = '';
  if (!files.some((f) => f.path === 'SKILL.md')) {
    const tops = new Set(files.map((f) => (f.path.includes('/') ? f.path.split('/')[0] : '')));
    const [top] = [...tops];
    if (tops.size === 1 && top !== undefined && top !== '' && files.some((f) => f.path === `${top}/SKILL.md`)) {
      prefix = `${top}/`;
    } else {
      throw skillInvalid('技能包根目录下缺少 SKILL.md');
    }
  }
  const rooted = files.map((f) => ({ path: f.path.slice(prefix.length), data: f.data }));
  const skillFile = rooted.find((f) => f.path === 'SKILL.md');
  if (skillFile === undefined) throw skillInvalid('技能包根目录下缺少 SKILL.md');
  let text: string;
  try {
    text = utf8Strict.decode(skillFile.data);
  } catch {
    throw skillInvalid('SKILL.md 不是 UTF-8 编码');
  }
  const parsed = parseSkillMd(text);
  const kept = rooted.filter((f) => isTextFile(f.path));
  return { parsed, files: kept, skipped: rooted.length - kept.length };
}

export function packageFromZip(zip: Buffer, limits: ZipLimits = SKILL_LIMITS): SkillPackage {
  return buildPackage(readZip(zip, limits), limits);
}

/** 文件夹导入（浏览器上传 base64）：路径同样按 INV-13 校验。 */
export function packageFromFiles(req: ImportSkillFilesRequest, limits: ZipLimits = SKILL_LIMITS): SkillPackage {
  if (req.files.length > limits.maxFiles) throw skillInvalid(`文件数超过 ${limits.maxFiles} 个`);
  const seen = new Set<string>();
  const files = req.files.map((f) => {
    const path = normalizeEntryPath(f.path);
    if (seen.has(path)) throw skillInvalid(`有重复的文件：${path}`);
    seen.add(path);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(f.contentBase64)) throw skillInvalid(`文件内容不是合法的 base64：${path}`);
    return { path, data: Buffer.from(f.contentBase64, 'base64') };
  });
  return buildPackage(files, limits);
}
