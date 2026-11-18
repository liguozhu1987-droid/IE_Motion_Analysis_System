import ExcelJS from 'exceljs';
import { stripVaMarker } from '../../core/shared/util';
import type { ExportModel } from './export-model';
import { displayStamp, shortDesc, vaLabel } from './format';
import { TIME_BUCKET_LABELS, bucketOf, type TimeBucket } from './time-buckets';

/**
 * 固定 6 张 sheet 的 XLSX 生成（定稿 §4 / §5）。
 * 纪律：只做「派生 → 排版」，不新增第二套计算；所有数值来自 BatchExportService 的 model。
 * 列数硬约束：02/03 ≤12、04 ≤9、01 ≤14；分析单元格 ≤24 字；空值写空单元格。
 */

const FONT = 'Microsoft YaHei';
const C = {
  ink: 'FF1E272D', muted: 'FF6B7378', white: 'FFFFFFFF',
  head: 'FF2F5D6C', band: 'FFF1EFE9', line: 'FFD8D5CC',
  copper: 'FFB0703C',
  va: 'FF0E8074', rnva: 'FFC9A227', nva: 'FFC2544B',
  vaBg: 'FFE4F3F0', rnvaBg: 'FFFBF1D6', nvaBg: 'FFFBE8E6',
  grayBg: 'FFF0F0EE', redBg: 'FFFBE8E6',
};
const SHEETS = ['00_封面', '01_工位汇总', '02_动作分解', '03_增值非增值分析', '04_动作分析', '99_说明'] as const;

const fill = (argb: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const font = (opts: { bold?: boolean; color?: string; size?: number; italic?: boolean } = {}): Partial<ExcelJS.Font> => ({
  name: FONT, size: opts.size ?? 10, bold: !!opts.bold, italic: !!opts.italic,
  color: { argb: opts.color ?? C.ink },
});

interface CellOpts {
  numFmt?: string;
  align?: 'left' | 'center' | 'right';
  bold?: boolean;
  color?: string;
  bg?: string;
  wrap?: boolean;
  size?: number;
  italic?: boolean;
}

function put(ws: ExcelJS.Worksheet, r: number, c: number, value: ExcelJS.CellValue, o: CellOpts = {}) {
  const cell = ws.getCell(r, c);
  cell.value = value;
  cell.font = font({ bold: o.bold, color: o.color, size: o.size, italic: o.italic }) as ExcelJS.Font;
  cell.alignment = { vertical: 'middle', horizontal: o.align ?? 'left', wrapText: !!o.wrap };
  if (o.numFmt) cell.numFmt = o.numFmt;
  if (o.bg) cell.fill = fill(o.bg);
  cell.border = { bottom: { style: 'hair', color: { argb: C.line } } };
  return cell;
}

function vaStyle(va: string): { bg: string; color: string } {
  if (va === 'VA') return { bg: C.vaBg, color: C.va };
  if (va === 'RNVA') return { bg: C.rnvaBg, color: C.rnva };
  if (va === 'NVA') return { bg: C.nvaBg, color: C.nva };
  return { bg: C.grayBg, color: C.muted };
}

/** 数据表统一骨架：1–3 行信息区 / 4 行表头 / 5 行起数据 / 冻结 B5 / 筛选 / A4 横向打印 */
function setupSheet(ws: ExcelJS.Worksheet, title: string, headers: string[], widths: number[], model: ExportModel, info: string[]) {
  const n = headers.length;
  ws.columns = widths.map((width, i) => ({ width, key: `c${i}` }));
  const band = (r: number, text: string, bg = C.band, color = C.ink, bold = false) => {
    ws.mergeCells(r, 1, r, n);
    const cell = put(ws, r, 1, text, { bg, color, bold, wrap: false });
    cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    ws.getRow(r).height = 19;
  };
  band(1, title, C.head, C.white, true);
  band(2, info[0] ?? '', C.band, C.ink);
  band(3, info[1] ?? '', C.band, C.muted);
  ws.getRow(1).height = 26;

  const hr = ws.getRow(4);
  hr.values = headers;
  hr.height = 28;
  hr.eachCell((cell) => {
    cell.font = font({ bold: true, color: C.white }) as ExcelJS.Font;
    cell.fill = fill(C.head);
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: C.copper } } };
  });
  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 4 } as any];
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: n } } as any;
  ws.pageSetup = {
    orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    margins: { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
  } as any;
  (ws.pageSetup as any).printTitlesRow = '4:4';
  ws.headerFooter.oddFooter = '&C第 &P 页 / 共 &N 页　·　' + (model.meta.taskNo ?? model.meta.lineId);
}

function infoLines(model: ExportModel, extra: string): string[] {
  const m = model.meta;
  // Phase 2：每个 sheet 的表头信息区都带任务号 + 时间段（文件脱离系统后仍可归档追溯）
  const taskTag = m.taskNo
    ? `任务：${m.taskNo} · ${m.taskName ?? ''} · ${m.periodStart}~${m.periodEnd}　|　`
    : '任务：（按产线兼容模式，未指定分解任务）　|　';
  return [
    `${taskTag}范围：${m.lineId} · ${m.lineName}　|　${m.stationCount} 工位（已分解 ${m.decomposedCount}）　|　${m.taskNo ? '任务锁定版本' : '各工位当前生效版本'}　|　${extra}`,
    `导出：${displayStamp(m.exportedAt)}（服务器本地时间） · ${m.exporter}　|　规则：va_rules ${m.ruleVersions.va_rules} / waste_triggers ${m.ruleVersions.waste_triggers} / ecrsa_map ${m.ruleVersions.ecrsa_map} / motion_standard ${m.ruleVersions.motion_standard}　|　Σ四桶=ΣST=CT`,
  ];
}

const handLabel = (h: unknown) => ({ L: '左手', R: '右手', B: '双手' } as Record<string, string>)[String(h ?? '')] ?? String(h ?? '');

/* ─────────────────────────── 00_封面 ─────────────────────────── */

function buildCover(wb: ExcelJS.Workbook, model: ExportModel) {
  const ws = wb.addWorksheet(SHEETS[0], { properties: { defaultColWidth: 14 } });
  ws.columns = [{ width: 20 }, { width: 24 }, { width: 20 }, { width: 24 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 16 }];
  const m = model.meta;
  const t = model.totals;
  const line = (r: number, label: string, value: string | number, opt: CellOpts = {}) => {
    put(ws, r, 1, label, { bold: true, color: C.head });
    ws.mergeCells(r, 2, r, 8);
    put(ws, r, 2, value, opt);
    ws.getRow(r).height = 19;
  };

  ws.mergeCells(1, 1, 1, 8);
  put(ws, 1, 1, 'IE 分解任务导出 · 动作分解与增值分析', { bold: true, size: 16, color: C.white, bg: C.head, align: 'center' });
  ws.getRow(1).height = 38;
  ws.mergeCells(2, 1, 2, 8);
  put(ws, 2, 1, '仅供阅读 / 评审 / 打印归档　·　不可回导（回导请用单工位 CSV）', { color: C.muted, align: 'center', size: 9 });

  line(4, '导出范围', `${m.lineId} · ${m.lineName}`);
  line(5, '公司 / 区域', [m.company, m.region].filter(Boolean).join(' · ') || '—');
  line(6, '产品项目 / 工艺', [m.productProject, m.processType].filter(Boolean).join(' · ') || '—');
  line(7, '分解任务号', m.taskNo
    ? `${m.taskNo} · ${m.taskName ?? ''}（状态：${m.taskStatus ?? '—'}）`
    : '（按产线兼容模式，未指定分解任务）');
  line(8, '轮次 / 时间段', m.taskNo
    ? `${m.roundType ?? '—'} · ${m.periodStart || '—'} ~ ${m.periodEnd || '—'}（跨期对比请前往 #/diff）`
    : '（未启用）— 不区分历史轮次，跨期对比请前往 #/diff');
  line(9, '范围说明', m.scopeNote, { wrap: true });
  ws.getRow(9).height = 30;

  line(11, '工位数 / 已分解', `${m.stationCount} / ${m.decomposedCount}`);
  line(12, '要素数（有效 / 全部）', `${m.activeElementCount} / ${m.elementCount}`);
  line(13, '焦点要素数 / 异常要素数', `${m.focusCount} / ${t.outlierCount}`);

  const kpi = (r: number, label: string, value: string | number, fmt?: string) => {
    put(ws, r, 1, label, { bold: true, color: C.head });
    put(ws, r, 2, value, { bold: true, size: 12, numFmt: fmt });
  };
  kpi(15, 'ΣCT(s)', t.ct, '0.00');
  kpi(16, 'TT(s)', t.tt, '0.00');
  kpi(17, '平衡率(%)', t.balanceRate, '0.0"%"');
  kpi(18, 'VA%(全口径)', t.vaPct, '0.0"%"');
  kpi(19, 'NVA%(全口径)', t.nvaPct, '0.0"%"');
  put(ws, 15, 4, '关键结论只给 5 个数；其余指标见 01 / 03 合计区与 99_说明', { color: C.muted, size: 9 });

  line(21, '规则版本', `va_rules ${m.ruleVersions.va_rules} · waste_triggers ${m.ruleVersions.waste_triggers} · ecrsa_map ${m.ruleVersions.ecrsa_map} · motion_standard ${m.ruleVersions.motion_standard}`);
  line(22, '数据口径', '仅当前生效版本；Σ四桶 = ΣST = CT；ST = 观测 × 评比 × (1 + 宽放)；异常要素不计入任何合计');
  line(23, '图例', '增值(VA) / 必要非增值(RNVA) / 非增值(NVA) / ★焦点 / 异常（颜色 + 文字标签并存，黑白打印可辨）');
  line(24, '生成信息', `${displayStamp(m.exportedAt)}（服务器本地时间）　·　${m.exporter}`);

  put(ws, 26, 1, '工作表索引', { bold: true, color: C.head });
  const duties = ['元数据与关键结论', '一工位一行 · CT/TT/VA/四桶', '全要素 · 事实层', '全有效要素 · 分类层（四类时间独立成列）', '仅焦点要素 · 改善层', '字段字典 / 公式 / 口径 / 免责'];
  const counts = [
    1, model.stations.length + 1,
    model.stations.reduce((a, s) => a + (model.options.includeOutliers ? s.elements.length : s.active.length), 0) + 1,
    model.stations.reduce((a, s) => a + s.active.length + (model.options.includeOutliers ? s.elements.length - s.active.length : 0), 0) + 1,
    model.focus.length + 1, 1,
  ];
  SHEETS.forEach((name, i) => {
    if (!model.options.withFocus && i === 4) return;
    const r = 27 + i;
    put(ws, r, 1, { text: name, hyperlink: `#'${name}'!A1`, tooltip: `跳转到 ${name}` } as any, { color: C.head, bold: true });
    ws.mergeCells(r, 2, r, 5);
    put(ws, r, 2, duties[i]);
    ws.mergeCells(r, 6, r, 8);
    put(ws, r, 6, `约 ${counts[i]} 行　·　打开 →`, { color: C.muted, size: 9 });
  });

  const last = 27 + SHEETS.length + 1;
  ws.mergeCells(last, 1, last, 8);
  put(ws, last, 1,
    '用途与免责：仅供阅读 / 评审 / 打印归档，不可回导；四类时间、占CT%、预计可压缩均为规则推导值，不是采集字段，须现场实测与工程师复核；AI 输出为决策辅助，不替代工程判断。',
    { color: C.muted, size: 9, wrap: true });
  ws.getRow(last).height = 34;
  ws.pageSetup = { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 1 } as any;
}

/* ─────────────────────────── 01_工位汇总 ─────────────────────────── */

function buildSummary(wb: ExcelJS.Workbook, model: ExportModel) {
  const ws = wb.addWorksheet(SHEETS[1]);
  const headers = ['工位编码', '工位名称', '版本', '要素数', 'CT(s)', 'TT(s)', 'CT−TT(s)', 'VA%', 'RNVA(s)', 'NVA(s)', '机器(s)', '走动(s)', '等待(s)', '标记'];
  setupSheet(ws, `01_工位汇总　·　${model.meta.lineName}`, headers,
    [14, 24, 8, 9, 10, 10, 11, 9, 11, 10, 10, 10, 10, 18], model,
    infoLines(model, '合计行与 CT 仅含有效要素'));
  let r = 5;
  for (const s of model.stations) {
    const m = s.metrics;
    const focusN = s.focusIds.size;
    const marks = [
      s.isBottleneck ? '★瓶颈' : '',
      focusN > 0 ? `焦点 ${focusN}` : '',
      s.elements.length === 0 ? '未分解' : '',
      Number(m.outlier_count) > 0 ? `含异常 ${m.outlier_count}` : '',
    ].filter(Boolean).join(' · ');
    const base = { bg: s.isBottleneck ? C.redBg : undefined };
    put(ws, r, 1, s.stationId, { ...base, bold: true });
    put(ws, r, 2, s.stationName, base);
    put(ws, r, 3, `v${s.version}`, { align: 'center' });
    put(ws, r, 4, Number(m.element_count), { numFmt: '0', align: 'right' });
    put(ws, r, 5, Number(m.ct), { numFmt: '0.00', align: 'right', bold: true });
    put(ws, r, 6, Number(m.tt), { numFmt: '0.00', align: 'right' });
    put(ws, r, 7, Number(m.ct) - Number(m.tt), { numFmt: '0.00', align: 'right', color: Number(m.ct) > Number(m.tt) ? C.nva : C.va });
    put(ws, r, 8, Number(m.ct) > 0 ? Number(m.va) / Number(m.ct) : null, { numFmt: '0.0%', align: 'right' });
    put(ws, r, 9, Number(m.rnva), { numFmt: '0.00', align: 'right' });
    put(ws, r, 10, Number(m.nva), { numFmt: '0.00', align: 'right' });
    put(ws, r, 11, s.buckets.machine, { numFmt: '0.00', align: 'right' });
    put(ws, r, 12, s.buckets.walk, { numFmt: '0.00', align: 'right' });
    put(ws, r, 13, s.buckets.wait, { numFmt: '0.00', align: 'right' });
    put(ws, r, 14, marks, { size: 9, color: s.isBottleneck ? C.nva : C.muted });
    ws.getRow(r).height = 18;
    r += 1;
  }
  const t = model.totals;
  put(ws, r, 1, '合计', { bold: true, bg: C.band });
  put(ws, r, 2, `${model.stations.length} 工位`, { bold: true, bg: C.band });
  put(ws, r, 3, '', { bg: C.band });
  put(ws, r, 4, model.meta.activeElementCount, { numFmt: '0', bold: true, bg: C.band, align: 'right' });
  put(ws, r, 5, t.ct, { numFmt: '0.00', bold: true, bg: C.band, align: 'right' });
  put(ws, r, 6, t.tt, { numFmt: '0.00', bold: true, bg: C.band, align: 'right' });
  put(ws, r, 7, '', { bg: C.band });
  put(ws, r, 8, t.ct > 0 ? t.va / t.ct : null, { numFmt: '0.0%', bold: true, bg: C.band, align: 'right' });
  put(ws, r, 9, t.rnva, { numFmt: '0.00', bold: true, bg: C.band, align: 'right' });
  put(ws, r, 10, t.nva, { numFmt: '0.00', bold: true, bg: C.band, align: 'right' });
  put(ws, r, 11, t.machine, { numFmt: '0.00', bold: true, bg: C.band, align: 'right' });
  put(ws, r, 12, t.walk, { numFmt: '0.00', bold: true, bg: C.band, align: 'right' });
  put(ws, r, 13, t.wait, { numFmt: '0.00', bold: true, bg: C.band, align: 'right' });
  put(ws, r, 14, `手作业 ${t.manual.toFixed(2)}s · 平衡率 ${t.balanceRate.toFixed(1)}% · 异常 ${t.outlierCount}`, { size: 9, bold: true, bg: C.band });
  ws.getRow(r).height = 22;
}

/* ─────────────────────────── 02_动作分解 ─────────────────────────── */

function buildElements(wb: ExcelJS.Workbook, model: ExportModel) {
  const ws = wb.addWorksheet(SHEETS[2]);
  const headers = ['工位编码', '序号', '起点(s)', '观测(s)', '手别', '动作类型', '作业内容', '评比', '宽放(%)', '标准工时(s)', '异常'];
  setupSheet(ws, `02_动作分解　·　全要素事实层`, headers,
    [14, 7, 10, 10, 8, 12, 38, 8, 10, 13, 16], model,
    infoLines(model, '终点 = 起点 + 观测；异常要素标灰且不计入合计'));
  let r = 5;
  for (const s of model.stations) {
    const list = model.options.includeOutliers ? s.elements : s.elements.filter((e) => Number(e.outlier_flag) === 0);
    for (const el of list) {
      const outlier = Number(el.outlier_flag) === 1;
      const bg = outlier ? C.grayBg : undefined;
      const color = outlier ? C.muted : C.ink;
      put(ws, r, 1, s.stationId, { bg, color, bold: !outlier });
      put(ws, r, 2, Number(el.seq), { numFmt: '0', align: 'center', bg, color });
      put(ws, r, 3, Number(el.start_ms) / 1000, { numFmt: '0.00', align: 'right', bg, color });
      put(ws, r, 4, Number(el.dur_s), { numFmt: '0.00', align: 'right', bg, color });
      put(ws, r, 5, handLabel(el.hand), { align: 'center', bg, color });
      put(ws, r, 6, String(el.type ?? ''), { bg, color });
      put(ws, r, 7, stripVaMarker(String(el.desc ?? '')), { wrap: true, bg, color });
      put(ws, r, 8, Number(el.rating), { numFmt: '0.00', align: 'right', bg, color });
      // allowance 落库为小数（0.15）；用 Excel 百分比格式显示 15.0%，保持单元格为可计算数值
      put(ws, r, 9, Number(el.allowance), { numFmt: '0.0%', align: 'right', bg, color });
      put(ws, r, 10, Number(el.std_time), { numFmt: '0.00', align: 'right', bold: !outlier, bg, color });
      put(ws, r, 11, outlier ? `异常·${shortDesc(el.outlier_reason ?? '', 12)}` : null, { size: 9, bg, color });
      ws.getRow(r).height = 18;
      r += 1;
    }
  }
  const t = model.totals;
  put(ws, r, 1, '合计', { bold: true, bg: C.band });
  put(ws, r, 2, `${model.meta.activeElementCount} 有效要素`, { bold: true, bg: C.band });
  ws.mergeCells(r, 3, r, 6);
  put(ws, r, 3, 'Σ观测（有效要素） / Σ标准工时', { bold: true, bg: C.band });
  const sumDur = round2sum(model.stations.flatMap((s) => s.active.map((e) => Number(e.dur_s))));
  put(ws, r, 7, sumDur, { numFmt: '0.00', bold: true, bg: C.band, align: 'right' });
  ws.mergeCells(r, 8, r, 9);
  put(ws, r, 8, '', { bg: C.band });
  put(ws, r, 10, t.ct, { numFmt: '0.00', bold: true, bg: C.band, align: 'right' });
  put(ws, r, 11, `异常 ${t.outlierCount}`, { size: 9, bg: C.band });
}

const round2sum = (values: number[]) => Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100;

/* ─────────────────── 03_增值非增值分析（四类时间独立成列） ─────────────────── */

function buildVaAnalysis(wb: ExcelJS.Workbook, model: ExportModel) {
  const ws = wb.addWorksheet(SHEETS[3]);
  const headers = ['工位编码', '序号', '作业内容', '增值判定',
    TIME_BUCKET_LABELS.manual, TIME_BUCKET_LABELS.machine, TIME_BUCKET_LABELS.walk, TIME_BUCKET_LABELS.wait,
    '标准工时(s)', '占CT(%)', '焦点', '备注'];
  setupSheet(ws, `03_增值非增值分析　·　四类时间独立成列`, headers,
    [14, 7, 28, 18, 11, 10, 10, 10, 13, 10, 7, 14], model,
    infoLines(model, 'E–H 每要素只填一桶；Σ四桶 = ΣST = CT'));
  let r = 5;
  const columns: TimeBucket[] = ['manual', 'machine', 'walk', 'wait'];
  // Phase 2：与 service 的汇总、三级校验共用同一个解析器（规则集优先）；离线契约回落内置映射
  const resolveBucket = model.bucketResolver ?? bucketOf;
  for (const s of model.stations) {
    const ct = Number(s.metrics.ct);
    // 每个工位一个小计区（设计 §5.4 合计区放在表格下方，不给每行加列）
    const list: any[] = model.options.includeOutliers
      ? [...s.active, ...s.elements.filter((e) => Number(e.outlier_flag) === 1)]
      : s.active;
    list.sort((a, b) => Number(a.seq) - Number(b.seq));
    for (const el of list) {
      const outlier = Number(el.outlier_flag) === 1;
      const st = Number(el.std_time);
      const bucket = resolveBucket(String(el.type));
      const va = String(el.va_effective ?? el.va_class ?? '');
      const vs = vaStyle(va);
      const notes: string[] = [];
      if (outlier) notes.push('异常');
      if (/\[VA(改判|确认)\|/.test(String(el.desc ?? ''))) notes.push('VA改判');
      if (String(el.type) === '机器自动') notes.push('机器占位');
      put(ws, r, 1, s.stationId, { bold: true, bg: outlier ? C.grayBg : undefined });
      put(ws, r, 2, Number(el.seq), { numFmt: '0', align: 'center' });
      put(ws, r, 3, shortDesc(el.desc), { wrap: false, color: outlier ? C.muted : C.ink });
      put(ws, r, 4, vaLabel(va), { align: 'center', bg: vs.bg, color: vs.color, bold: true, size: 9 });
      columns.forEach((b, i) => {
        // 异常要素 E–H 全部留空、不计入合计；其余恰好一桶有值
        put(ws, r, 5 + i, !outlier && bucket === b ? st : null, { numFmt: '0.00', align: 'right' });
      });
      put(ws, r, 9, st, { numFmt: '0.00', align: 'right', bold: !outlier });
      put(ws, r, 10, !outlier && ct > 0 ? st / ct : null, { numFmt: '0.0%', align: 'right' });
      put(ws, r, 11, s.focusIds.has(String(el.element_id)) ? '★' : null, { align: 'center', color: C.copper, bold: true });
      put(ws, r, 12, notes.join(' · ') || null, { size: 9, color: C.muted });
      ws.getRow(r).height = 18;
      r += 1;
    }
    // 工位合计区（紧跟该工位数据之后，浅色带）
    const m = s.metrics;
    put(ws, r, 1, `${s.stationId} 小计`, { bold: true, bg: C.band, size: 9 });
    put(ws, r, 2, '', { bg: C.band });
    put(ws, r, 3, `CT ${Number(m.ct).toFixed(2)}s`, { bold: true, bg: C.band, size: 9 });
    put(ws, r, 4, 'Σ四桶 = CT ✓', { bold: true, bg: C.band, color: C.va, size: 9 });
    columns.forEach((b, i) => put(ws, r, 5 + i, s.buckets[b], { numFmt: '0.00', bold: true, bg: C.band, align: 'right' }));
    put(ws, r, 9, Number(m.ct), { numFmt: '0.00', bold: true, bg: C.band, align: 'right' });
    put(ws, r, 10, '', { bg: C.band });
    put(ws, r, 11, '', { bg: C.band });
    put(ws, r, 12, `VA ${Number(m.va).toFixed(2)}s · RNVA ${Number(m.rnva).toFixed(2)}s · NVA ${Number(m.nva).toFixed(2)}s`, { size: 9, bg: C.band, color: C.muted });
    ws.getRow(r).height = 19;
    r += 1;
  }
  // 全任务合计区
  const t = model.totals;
  put(ws, r, 1, '全任务合计', { bold: true, bg: C.head, color: C.white });
  put(ws, r, 2, '', { bg: C.head });
  put(ws, r, 3, `ΣCT ${t.ct.toFixed(2)}s · ${model.stations.length} 工位`, { bold: true, bg: C.head, color: C.white, size: 9 });
  put(ws, r, 4, 'Σ四桶 = ΣST = CT ✓', { bold: true, bg: C.head, color: C.white, size: 9 });
  [t.manual, t.machine, t.walk, t.wait].forEach((v, i) =>
    put(ws, r, 5 + i, v, { numFmt: '0.00', bold: true, bg: C.head, color: C.white, align: 'right' }));
  put(ws, r, 9, t.ct, { numFmt: '0.00', bold: true, bg: C.head, color: C.white, align: 'right' });
  put(ws, r, 10, '', { bg: C.head });
  put(ws, r, 11, '', { bg: C.head });
  put(ws, r, 12, `VA%(全口径) ${t.vaPct.toFixed(1)}% · VA%(操作工口径) ${t.operatorVaPct.toFixed(1)}% · 操作工作业时间 ${(t.ct - t.machine).toFixed(2)}s`, { size: 9, bg: C.head, color: C.white });
  ws.getRow(r).height = 21;
}

/* ─────────────────────────── 04_动作分析 ─────────────────────────── */

function buildFocus(wb: ExcelJS.Workbook, model: ExportModel) {
  const ws = wb.addWorksheet(SHEETS[4]);
  const headers = ['工位编码', '序号', '作业内容', '增值判定', '标准工时(s)', '浪费类型', 'ECRS', '改善方向', '预计可压缩(s)'];
  const total = model.meta.activeElementCount;
  const pct = total > 0 ? ((model.focus.length / total) * 100).toFixed(1) : '0.0';
  // Phase 2：04 表用自定义信息行，仍须带任务号 + 时间段（与其余 sheet 同口径）
  const taskTag = model.meta.taskNo
    ? `任务：${model.meta.taskNo} · ${model.meta.periodStart}~${model.meta.periodEnd}　|　`
    : '';
  setupSheet(ws, `04_动作分析　·　仅焦点要素`, headers,
    [14, 7, 30, 16, 13, 14, 9, 32, 15], model,
    [
      `${taskTag}本表仅列焦点要素 ${model.focus.length} 条（全部 ${total} 条有效要素的 ${pct}%），按改善潜力降序；完整分析见系统页面。`,
      `焦点规则：命中浪费 / NVA 且 ST≥0.5s / ST≥1.0s 或占CT≥3%；每工位 Top5 · 全任务 Top${model.options.focusTop}；异常要素不进本表。`,
    ]);
  let r = 5;
  for (const f of model.focus) {
    const vs = vaStyle(f.vaLabel.includes('RNVA') ? 'RNVA' : f.vaLabel.includes('NVA') ? 'NVA' : 'VA');
    put(ws, r, 1, f.stationId, { bold: true });
    put(ws, r, 2, f.seq, { numFmt: '0', align: 'center' });
    put(ws, r, 3, f.desc, { wrap: false });
    put(ws, r, 4, f.vaLabel, { align: 'center', bg: vs.bg, color: vs.color, bold: true, size: 9 });
    put(ws, r, 5, f.stdTime, { numFmt: '0.00', align: 'right', bold: true });
    put(ws, r, 6, f.waste || null, { size: 9 });
    put(ws, r, 7, f.ecrs || null, { align: 'center', size: 9 });
    put(ws, r, 8, f.measure || null, { size: 9 });
    put(ws, r, 9, f.compressible, { numFmt: '0.00', align: 'right', color: C.copper });
    ws.getRow(r).height = 18;
    r += 1;
  }
  if (model.focus.length === 0) {
    ws.mergeCells(5, 1, 5, 9);
    put(ws, 5, 1, '本任务未识别到焦点要素（保留本表，不静默删页）', { color: C.muted, align: 'center' });
  }
  ws.mergeCells(r + 1, 1, r + 1, 9);
  put(ws, r + 1, 1, '「预计可压缩(s)」= ST × factor，仅用于排序与筛选，不是收益承诺、不作为财务节约依据，须现场实测复核。', { size: 9, color: C.muted, italic: true });
}

/* ─────────────────────────── 99_说明 ─────────────────────────── */

function buildNotes(wb: ExcelJS.Workbook, model: ExportModel) {
  const ws = wb.addWorksheet(SHEETS[5]);
  ws.columns = [{ width: 22 }, { width: 30 }, { width: 30 }, { width: 30 }, { width: 22 }, { width: 22 }];
  let r = 1;
  const section = (title: string) => {
    ws.mergeCells(r, 1, r, 6);
    put(ws, r, 1, title, { bold: true, bg: C.head, color: C.white });
    ws.getRow(r).height = 22;
    r += 1;
  };
  const row = (label: string, value: string, wrap = true) => {
    put(ws, r, 1, label, { bold: true, color: C.head, wrap });
    ws.mergeCells(r, 2, r, 6);
    put(ws, r, 2, value, { wrap, size: 9 });
    if (wrap) ws.getRow(r).height = Math.max(18, Math.ceil(value.length / 62) * 16);
    r += 1;
  };
  const m = model.meta;
  ws.mergeCells(r, 1, r, 6);
  put(ws, r, 1, '99_说明　·　字段字典 / 公式 / 口径 / 边界 / 免责', { bold: true, size: 14, bg: C.band });
  r += 2;
  row('导出范围', m.taskNo
    ? `任务 ${m.taskNo}（${m.periodStart}~${m.periodEnd}）· ${m.lineId} · ${m.lineName} · ${m.stationCount} 工位 · 任务锁定 bol_version`
    : `${m.lineId} · ${m.lineName} · ${m.stationCount} 工位 · 各工位当前生效版本（按产线兼容模式）`);
  row('生成信息', `${displayStamp(m.exportedAt)}（服务器本地时间） · ${m.exporter}`);
  row('规则版本', `va_rules ${m.ruleVersions.va_rules} / waste_triggers ${m.ruleVersions.waste_triggers} / ecrsa_map ${m.ruleVersions.ecrsa_map} / motion_standard ${m.ruleVersions.motion_standard}`);
  r += 1;

  section('1. 字段字典（按 sheet）');
  row('02_动作分解', '工位编码 / 序号 / 起点(s)=start_ms÷1000 / 观测(s)=dur_s / 手别 L·R·B / 动作类型 / 作业内容（已剥离 VA 改判标记）/ 评比 / 宽放 / 标准工时 / 异常（原因前 12 字）');
  row('03_增值非增值分析', '工位编码 / 序号 / 作业内容（≤24字）/ 增值判定 / 手作业(s) / 机器(s) / 走动(s) / 等待(s) / 标准工时(s) / 占CT(%) / 焦点★ / 备注');
  row('04_动作分析', '工位编码 / 序号 / 作业内容 / 增值判定 / 标准工时(s) / 浪费类型 / ECRS / 改善方向 / 预计可压缩(s)');
  row('01_工位汇总', '工位编码 / 名称 / 版本 / 要素数 / CT / TT / CT−TT / VA% / RNVA / NVA / 机器 / 走动 / 等待 / 标记。手作业 = CT − 机器 − 走动 − 等待。');
  r += 1;

  section('2. 公式与三级校验');
  row('ST', 'ST = 观测(dur_s) × 评比(rating) × (1 + 宽放 allowance)');
  row('CT', 'CT = Σ 有效要素（outlier_flag=0）ST；异常要素不计入任何合计');
  row('占CT%', '占CT% = 该要素 ST ÷ 所在工位 CT × 100');
  row('VA% 双口径', `全口径 = VA_s ÷ CT（平台现行，主指标，本次 ${model.totals.vaPct.toFixed(1)}%）；操作工口径 = VA_s ÷ (CT − 机器时间)（与公司 VA Template 对齐，本次 ${model.totals.operatorVaPct.toFixed(1)}%）。封面只给主指标。`);
  row('平衡率', 'Σ各工位 CT ÷ (最大 CT × 工位数) × 100；本次 ' + model.totals.balanceRate.toFixed(1) + '%');
  row('Σ四桶', '逐要素 E+F+G+H = ST 且恰一桶有值；逐工位 Σ四桶 = ΣST = CT；全任务 Σ工位CT = 01 表 ΣCT。误差 ≤0.01s，服务端生成前自检，不通过不出表。');
  row('预计可压缩', 'ST × factor（factor 取命中 ecrsa_map 映射的最大值；无命中 0.3 保守默认）。仅用于排序，非收益承诺。');
  r += 1;

  section('3. 类型 → 四类时间桶映射（motion_standard 规则集配置，随 MS 版本发布）');
  const g = model.bucketTable.groups;
  row('判定入口', `motion_standard ${model.meta.ruleVersions.motion_standard} 的 time_bucket（manual/machine/walk/wait）；规则集显式配置 ${model.bucketTable.ruleConfigured.length} 类，内置 44 类映射兜底 ${model.bucketTable.builtin.length} 类，其余回落 manual。`);
  row('机器 machine', g.machine.join('、') || '—');
  row('走动 walk', g.walk.join('、') || '—');
  row('等待 wait', g.wait.join('、') || '—');
  row('手作业 manual', `共 ${g.manual.length} 类：${g.manual.join('、') || '—'}`);
  row('规则集配置', model.bucketTable.ruleConfigured.length ? model.bucketTable.ruleConfigured.join('、') : '（本次未读到规则集配置，全部走内置兜底）');
  row('内置兜底', model.bucketTable.builtin.length ? `未在规则集登记、由导出层内置映射判定的类型：${model.bucketTable.builtin.join('、')}` : '无');
  row('未识别类型', model.bucketTable.fallback.length ? `既无规则集配置也无内置映射、按 manual 回落的类型：${model.bucketTable.fallback.join('、')}` : '无');
  row('配置化路线', '在「动作标准」配置页（#/standard）修改类型的 time_bucket 并发布新 MS 版本后，导出即时按新配置重算；口径只派生不落库、不回写正式 ST，规则版本指纹见封面与本页。');
  row('同名词风险', '经典动素「移物」= 手部搬运物件，公司词表「移物」= 负载走动，平台 va_rules 共用同一词条。本版统一按 walk 处理；若该要素实为手部移物，Walk time 会高估。不引入基于描述关键词的猜测规则（宁缺勿错）。');
  row('边界裁定', '转身/弯腰（躯干动作、无脚步位移）计入手作业；持住计入手作业（由 WT01/WT02 识别进焦点表）；休息/不可避免延迟归等待。不新设第五桶。');
  r += 1;

  section('4. 焦点要素规则与 VA 三分法');
  row('候选规则', 'F1 命中任一 waste_triggers；F2 NVA 且 ST≥0.5s；F3 ST≥1.0s 或 占CT≥3%；F4 异常要素不进焦点表（数据质量问题 ≠ 改善机会）。');
  row('排序与截取', `改善潜力 = ST × factor，降序 → 占CT% 降序 → 工位编码+序号稳定排序；每工位 Top5，全任务上限 Top${model.options.focusTop}。03 表 ★ 与 04 表行一一对应。`);
  row('信息克制', '每要素最多 1 浪费 / 1 ECRS / 1 条 ≤24 字措施（取 factor 最大的一条映射，不 join）；02/03 ≤12 列、04 ≤9 列、01 ≤14 列。');
  row('三分法', 'VA 增值 / RNVA 必要非增值 / NVA 非增值。检查 = RNVA（客户或规范要求时属必要非增值，须持续改善检查方法；无依据的返检按 NVA）。VA 非绝对：操作族默认 RNVA，对象为装入产品的物料/零部件时判 VA。机器自动的 RNVA 仅为占位，不参与操作工 VA 率。');
  row('口径版本', `本表 VA 判定沿用平台 va_rules ${m.ruleVersions.va_rules}，与公司《VA N-VA Defination》对应关系见「动作标准」配置页。`);
  r += 1;

  section('5. 公司表单列映射（IRSCN-IE-Method-07 · VA Template / Motion-03）');
  row('Work / Machine / Walk / Wait time', '→ 03 表 E/F/G/H 四列（多工位同 sheet，按工位编码区分；一行只填一值）');
  row('IF Valued', '→ 03 表 增值判定');
  row('IF Improved / Action', '→ 04 表（只在焦点行出现；Action 取 1 条 ≤24 字短句）');
  row('Select', '→ 03 表 焦点 ★');
  row('Route / 移动（身体部位）/ 步数', '不导出：系统未采集该字段，完整行程描述见系统页面');
  row('STEP / CT(s) / 作业内容 / 分类 / 浪费类型 / 改善方向', '→ 04 表（与「动作分析-VA」6 列同构，另加 ECRS 与预计可压缩）');
  row('改善前 / 改善后双栏', 'v1 不做；跨期对比请用 #/diff');
  r += 1;

  section('6. 数据边界与口径声明');
  row('未采集字段', 'cycle_count / CV / 最低重复值 / 多循环读数 / Route / 步数 / MTM 代码 / TMU 均未持久化。本表是**单循环要素分解汇总表，不是 REFA 式原始观测表，也不得冒充 MTM-1 分析表**。');
  row('四类时间性质', '由动作类型推导的派生列，不是采集字段；类型选错即列错。合并区标注 + 三级校验 + 本说明页，须现场复核。');
  row('版本边界', '仅导出各工位当前生效版本；不导出封存修订版。本版未启用「分解任务」实体，不区分同一产线不同时期的多轮分解。');
  row('被砍列的追溯', 'VA 改判理由原文、AI 证据、完整措施、原始读数、element_id、source 一律不进 Excel；取数入口：分解工作台 / 分析页 / 单工位 CSV / #/diff。');
  row('AI 与模块边界', '04 表的浪费与措施只来自 waste_triggers ∪ ecrsa_map 规则口径，不跨模块合并 AI 浪费证据与 AI 建议全文；AI 输出恒为决策辅助，不替代工程判断。');
  row('不可回导', '本 XLSX 列结构不复用单工位 CSV 表头，仅供阅读 / 评审 / 打印归档；回导请使用「导出 CSV」按钮生成的单工位 CSV。');
  row('用途与免责', '推导值与标准工时须经现场实测与工程师复核；涉及安全 / 质量结论须走 EHS 与质量体系复核；公司具体名称对外输出时请自行脱敏。');
  r += 1;

  section('7. 打印签署位');
  row('制表 / 复核 / 批准', '____________________　　____________________　　____________________');
  row('日期', '______ 年 ____ 月 ____ 日');
  ws.pageSetup = { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 } as any;
}

/** 生成 XLSX 二进制；固定 6 张 sheet（关闭 04 表时为 5 张），不随工位数增长、不产生分卷 ZIP */
export async function buildWorkbook(model: ExportModel): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'IE Improvement Platform';
  wb.created = model.meta.exportedAt;
  wb.company = model.meta.company || 'IE';
  buildCover(wb, model);
  buildSummary(wb, model);
  buildElements(wb, model);
  buildVaAnalysis(wb, model);
  if (model.options.withFocus) buildFocus(wb, model);
  buildNotes(wb, model);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}

export { SHEETS };
