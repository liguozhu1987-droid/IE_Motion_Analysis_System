#!/usr/bin/env node
/**
 * AI 分解评测脚本（v3.43 P1-4）——回答「AI 到底准不准」
 *
 * 输入两份 JSON：
 *   1. candidates：AI 分解页「导出候选JSON」的产物
 *   2. ground-truth：人工片段级标注（模板见 docs/ai-segment-ground-truth.template.json）
 *
 * 指标（对齐行业验收目标：边界误差 ±2s 内、类型准确率 ≥70%）：
 *   - 匹配：真值段 × 候选段按 IoU≥0.5 贪心匹配（每真值最多配一候选）
 *   - 边界误差：匹配对的 |start 差| 与 |end 差| 的中位/P90，及 ±0.5s/±1s/±2s 命中率
 *   - 类型准确率：匹配对中 type 完全一致的比例（人工可把 AI「其他」改对——同时给
 *     「含人工修正」口径：真值 type 与 AI desc 前缀一致也算，避免骨架词干扰）
 *   - 查全/查准：IoU≥0.5 口径下 命中真值数/真值总数、命中候选数/候选总数
 *   - 覆盖率：真值时长被候选覆盖的比例（IoU>0 部分并集）
 *
 * 用法：
 *   node tools/eval-ai-segment.cjs <candidates.json> <ground-truth.json> [--iou 0.5]
 */

const fs = require('fs');

function main() {
  const [candPath, gtPath] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const iouIdx = process.argv.indexOf('--iou');
  const IOU_MIN = iouIdx > -1 ? Number(process.argv[iouIdx + 1]) || 0.5 : 0.5;
  if (!candPath || !gtPath) {
    console.error('用法: node tools/eval-ai-segment.cjs <candidates.json> <ground-truth.json> [--iou 0.5]');
    process.exit(1);
  }
  const cand = JSON.parse(fs.readFileSync(candPath, 'utf8'));
  const gt = JSON.parse(fs.readFileSync(gtPath, 'utf8'));
  const C = (cand.candidates ?? []).map((c) => ({ ...c }));
  const G = (gt.segments ?? []).map((s) => ({ ...s }));
  if (!G.length) { console.error('真值标注为空（segments 为空数组）'); process.exit(1); }

  const iou = (a, b) => {
    const inter = Math.max(0, Math.min(a.end_ms, b.end_ms) - Math.max(a.start_ms, b.start_ms));
    const union = Math.max(a.end_ms, b.end_ms) - Math.min(a.start_ms, b.start_ms);
    return union > 0 ? inter / union : 0;
  };

  // 贪心匹配：IoU 降序逐一配对（每真值/候选最多一次）
  const pairs = [];
  for (const g of G) for (const c of C) pairs.push({ g, c, v: iou(g, c) });
  pairs.sort((a, b) => b.v - a.v);
  const usedG = new Set(), usedC = new Set(), matched = [];
  for (const p of pairs) {
    if (p.v < IOU_MIN || usedG.has(p.g) || usedC.has(p.c)) continue;
    usedG.add(p.g); usedC.add(p.c); matched.push(p);
  }

  // 边界误差
  const se = matched.map((m) => Math.abs(m.g.start_ms - m.c.start_ms));
  const ee = matched.map((m) => Math.abs(m.g.end_ms - m.c.end_ms));
  const med = (a) => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN;
  const p90 = (a) => a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * 0.9))] : NaN;
  const hitRate = (a, th) => a.filter((v) => v <= th).length / (a.length || 1);

  // 类型准确率（两个口径：严格 = 完全一致；宽松 = AI 描述骨架的动词前缀命中真值类型）
  let typeExact = 0, typeLoose = 0;
  for (const m of matched) {
    if (m.g.type && m.c.type === m.g.type) typeExact += 1;
    const verb = (m.c.desc ?? '').trim().split(/[[：:]/)[0]?.trim();
    if (m.g.type && (m.c.type === m.g.type || (verb && m.g.type.includes(verb)))) typeLoose += 1;
  }

  // 覆盖率（真值时长被任一候选以 IoU>0 覆盖的部分 / 真值总时长）
  let gtDur = 0, covDur = 0;
  for (const g of G) {
    gtDur += g.end_ms - g.start_ms;
    let cov = 0;
    for (const c of C) cov = Math.max(cov, Math.min(g.end_ms, c.end_ms) - Math.max(g.start_ms, c.start_ms));
    covDur += Math.max(0, cov);
  }

  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  console.log('════════ AI 分解评测报告 ════════');
  console.log(`样本: ${cand.station_id ?? '?'} ｜ 真值 ${G.length} 段 ｜ 候选 ${C.length} 条 ｜ IoU≥${IOU_MIN}`);
  console.log(`匹配: ${matched.length} 对`);
  console.log(`查全率(真值被检出): ${pct(matched.length / G.length)}   查准率(候选是真动作): ${pct(matched.length / (C.length || 1))}`);
  console.log(`覆盖率(真值时长被覆盖): ${pct(gtDur ? covDur / gtDur : 0)}`);
  if (matched.length) {
    console.log(`边界误差 起点中位 ${med(se)}ms / P90 ${p90(se)}ms ｜ 终点中位 ${med(ee)}ms / P90 ${p90(ee)}ms`);
    console.log(`起点 ±0.5s ${pct(hitRate(se, 500))} · ±1s ${pct(hitRate(se, 1000))} · ±2s ${pct(hitRate(se, 2000))}`);
    console.log(`终点 ±0.5s ${pct(hitRate(ee, 500))} · ±1s ${pct(hitRate(ee, 1000))} · ±2s ${pct(hitRate(ee, 2000))}`);
    console.log(`类型准确率: 严格 ${pct(typeExact / matched.length)} ｜ 宽松(骨架动词) ${pct(typeLoose / matched.length)}`);
  }
  // 行业验收对照（推荐方案 §13 阶段1：动作准确率≥70%、边界 ±2s、浪费精确率≥60%）
  const okBoundary = matched.length ? hitRate(se, 2000) >= 0.7 && hitRate(ee, 2000) >= 0.7 : false;
  const okType = matched.length ? typeExact / matched.length >= 0.7 : false;
  const okRecall = matched.length / G.length >= 0.7;
  console.log('────── 验收对照（方案目标） ──────');
  console.log(`边界 ±2s 命中≥70%: ${okBoundary ? '✓ 达标' : '✗ 未达标'}`);
  console.log(`类型准确率 ≥70%:   ${okType ? '✓ 达标' : '✗ 未达标'}`);
  console.log(`查全率 ≥70%:       ${okRecall ? '✓ 达标' : '✗ 未达标'}`);
  console.log(matched.length < 3 ? '⚠ 样本过少，结论仅供参考——请补充真值段' : '');
}

main();
