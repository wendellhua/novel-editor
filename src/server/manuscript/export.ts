import { setImmediate as yieldToLoop } from 'node:timers/promises';
import type { ExportFormat } from '../../shared/types';
import type { SqliteDatabase } from '../storage/sqlite';
import { getWorkRow, listLiveChapterNodes, listLiveVolumes } from './repo';

export const EXPORT_YIELD_EVERY = 50;

export interface ExportResult {
  filename: string;
  contentType: string;
  content: string;
}

export function safeFilename(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
  return cleaned === '' ? '未命名作品' : cleaned.slice(0, 80);
}

const MD_BLOCK_START = /^(\s*)([#>*+-]|\d+[.)]|```|~~~|\|)/;

function markdownParagraphs(body: string): string {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => line.replace(MD_BLOCK_START, '$1\\$2'))
    .join('\n\n');
}

/**
 * 导出整部作品（按卷序、章序，只含未删除内容）。正文按章读取，每 EXPORT_YIELD_EVERY 章让出一次事件循环。
 * 调用方必须在 await 期间 pin 住连接（见 WorkDbPool）。
 */
export async function exportWork(db: SqliteDatabase, format: ExportFormat): Promise<ExportResult> {
  const work = getWorkRow(db);
  const volumes = listLiveVolumes(db);
  const chapters = listLiveChapterNodes(db);
  const bodyStmt = db.prepare('SELECT body FROM chapter WHERE id = ?');
  const parts: string[] = [];
  const md = format === 'md';

  parts.push(md ? `# ${work.title}\n` : `${work.title}\n`);
  if (work.author !== '') parts.push(md ? `> 作者：${work.author}\n` : `作者：${work.author}\n`);
  if (work.synopsis !== '') parts.push(md ? `> ${work.synopsis.replace(/\n/g, '\n> ')}\n` : `${work.synopsis}\n`);

  let count = 0;
  for (const v of volumes) {
    parts.push(md ? `\n## ${v.title}\n` : `\n${v.title}\n`);
    for (const c of chapters) {
      if (c.volume_id !== v.id) continue;
      const { body } = bodyStmt.get(c.id) as { body: string };
      parts.push(md ? `\n### ${c.title}\n\n${markdownParagraphs(body)}\n` : `\n${c.title}\n\n${body.replace(/\n+$/, '')}\n`);
      count++;
      if (count % EXPORT_YIELD_EVERY === 0) await yieldToLoop();
    }
  }

  const text = parts.join('');
  return md
    ? { filename: `${safeFilename(work.title)}.md`, contentType: 'text/markdown; charset=utf-8', content: text }
    : { filename: `${safeFilename(work.title)}.txt`, contentType: 'text/plain; charset=utf-8', content: `\ufeff${text.replace(/\n/g, '\r\n')}` };
}
