// ===========================================================================
// Formatting helpers shared across pages
// ===========================================================================
export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return (i === 0 ? Math.round(v) : v >= 100 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i];
}

export function formatDuration(ms) {
  if (!ms && ms !== 0) return '-';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + ' 秒';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' 分钟';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' 小时';
  return Math.floor(h / 24) + ' 天';
}

export function formatUptime(seconds) {
  const s = Number(seconds) || 0;
  if (s < 60) return s + ' 秒';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' 分钟';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' 小时';
  return Math.floor(h / 24) + ' 天 ' + (h % 24) + ' 小时';
}

export function timeStr(ts) {
  return new Date(ts).toLocaleTimeString();
}

export function localDateKey(ts) {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + mm + '-' + dd;
}
