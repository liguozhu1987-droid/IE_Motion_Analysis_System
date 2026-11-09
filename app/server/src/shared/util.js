export const ELEMENT_TYPES = ['装配', '使用', '取放', '预对', '检验', '搬运', '等待', '寻找选择', '持住', '其他'];
export const HANDS = ['L', 'R', 'B'];
export const VA_CLASSES = ['VA', 'NNVA', 'NVA'];
export const WASTE_TYPES = ['持住', '重复取放', '搬运', '等待', '寻找选择', '检验冗余'];
export const STATUSES = ['待实施', '已完成', '已验证'];

export function round1(n) { return Math.round((Number(n) + Number.EPSILON) * 10) / 10; }
export function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
export function round3(n) { return Math.round((Number(n) + Number.EPSILON) * 1000) / 1000; }

export function elementId(stationId, version, seq) {
  return `${stationId}-V${version}-${String(seq).padStart(3, '0')}`;
}

export function normalizeDesc(desc) {
  return String(desc ?? '')
    .replace(/\[VA(改判|确认)\|[^\]]*\]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

export function extractMarker(desc) {
  const match = /\[VA(改判|确认)\|([^\]]*)\]/.exec(String(desc ?? ''));
  if (!match) return null;
  const fields = {};
  for (const part of match[2].split('|')) {
    const idx = part.indexOf(':');
    if (idx > 0) fields[part.slice(0, idx)] = part.slice(idx + 1);
  }
  return { type: match[1], fields, raw: match[0] };
}

/** 编辑距离相似度（0~1），用于前后要素配对 L2 规则；包含关系（如“锁附4颗螺丝”⊂“锁附4颗螺丝(治具夹持)”）给0.85 */
export function similarity(a, b) {
  const s = normalizeDesc(a);
  const t = normalizeDesc(b);
  if (s === t) return 1;
  if (!s.length || !t.length) return 0;
  if (s.includes(t) || t.includes(s)) return 0.85;
  const dp = Array.from({ length: s.length + 1 }, (_, i) => [i, ...new Array(t.length).fill(0)]);
  for (let j = 1; j <= t.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= s.length; i += 1) {
    for (let j = 1; j <= t.length; j += 1) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1),
      );
    }
  }
  return 1 - dp[s.length][t.length] / Math.max(s.length, t.length);
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function asNumber(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`字段 ${field} 必须是数字`);
  return n;
}
