import { stripVaMarker } from '../../core/shared/util';

/** 显示用短描述：剥离 [VA改判|…] / [VA确认|…] 标记后压到 ≤24 字（信息克制硬约束） */
export function shortDesc(raw: unknown, max = 24): string {
  const s = stripVaMarker(String(raw ?? '')).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const p2 = (n: number) => String(n).padStart(2, '0');

/** 文件名时间戳（服务器本地时区）：yyyyMMdd-HHmm */
export function fileStamp(d = new Date()): string {
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
}

/** 表内显示时间戳（服务器本地时区）：yyyy-MM-dd HH:mm:ss */
export function displayStamp(d = new Date()): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/** VA 三分法文字标签：颜色之外必须有文字，保证黑白打印 / 色弱可读 */
export function vaLabel(va: string): string {
  const v = String(va ?? '');
  if (v === 'VA') return '增值(VA)';
  if (v === 'RNVA') return '必要非增值(RNVA)';
  if (v === 'NVA') return '非增值(NVA)';
  return v;
}
