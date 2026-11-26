import dayjs from 'dayjs';

export function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function formatTime(input: string | null | undefined): string {
  if (!input) return '-';
  return dayjs(input).format('YYYY-MM-DD HH:mm:ss');
}

export function fromNow(input: string | null | undefined): string {
  if (!input) return '-';
  const diff = Date.now() - dayjs(input).valueOf();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return dayjs(input).format('YYYY-MM-DD');
}

export const RUN_STATUS_TEXT: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  passed: '已通过',
  warning: '告警',
  failed: '失败',
  canceled: '已取消',
  timeout: '超时',
  error: '错误',
};

export const RUN_STATUS_BADGE: Record<string, string> = {
  queued: 'neutral',
  running: 'info running',
  passed: 'passed',
  warning: 'warn',
  failed: 'failed',
  canceled: 'neutral',
  timeout: 'warn',
  error: 'failed',
};

export const CASE_STATUS_TEXT: Record<string, string> = {
  draft: '草稿',
  'trial-pending': '待试运行',
  'trial-passed': '试运行通过',
  published: '已发布',
  deprecated: '已停用',
};

export const CASE_STATUS_BADGE: Record<string, string> = {
  draft: 'neutral',
  'trial-pending': 'warn',
  'trial-passed': 'info',
  published: 'passed',
  deprecated: 'neutral',
};

export const MODE_TEXT: Record<string, string> = {
  explore: '探索',
  replay: '回放',
  strict: '严格回放',
};
