/** 字数显示：不足 1 万显示原数，否则显示「x.x 万字」。 */
export function formatWords(n: number): string {
  if (n < 10_000) return `${n} 字`;
  const wan = n / 10_000;
  return `${wan >= 100 ? Math.round(wan) : wan.toFixed(1)} 万字`;
}

/** token 数显示：不足 1 万显示原数，否则「x.x 万」。 */
export function formatTokens(n: number): string {
  if (n < 10_000) return String(n);
  const wan = n / 10_000;
  return `${wan >= 100 ? Math.round(wan) : wan.toFixed(1)} 万`;
}

/** 相对时间：刚刚、N 秒前、N 分钟前；一小时以上用 formatTime。 */
export function formatAgo(ms: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 10) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  return formatTime(ms, now);
}

export function formatTime(ms: number, now: number = Date.now()): string {
  const d = new Date(ms);
  const pad = (x: number): string => String(x).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return `今天 ${hm}`;
  const yesterday = new Date(now - 86_400_000);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`;
  const date = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
  return d.getFullYear() === today.getFullYear() ? date : `${d.getFullYear()}-${date}`;
}
