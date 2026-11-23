/**
 * 门禁清单（QA 解禁路径 0a）
 *
 * 设计原则：
 * - 只登记「已存在且实际可跑」的资产，不编造测试；
 * - 串行执行（项目铁律：隔离/UI 回归禁并行）；
 * - 阻断项（blocking=true）决定总判定；advisory 只记录，不改变退出码；
 * - 需要真值/外部服务的门必须明确 SKIPPED（退出码 78），不得冒充 PASS。
 *
 * 每个门可带 parse(output) 返回 { pass, fail, unit, note }，用于输出实际用例数；
 * 缺省按「命令」计（exit 0 = 1/0，否则 0/1）。
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

/** 解析最后一条匹配，返回 { pass, fail } 或 null。 */
function lastMatch(text, passRe, failRe) {
  const picks = (re) => {
    if (!re) return [];
    const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
    return [...text.matchAll(new RegExp(re.source, flags))];
  };
  const p = picks(passRe);
  const f = picks(failRe);
  const pass = p.length ? Number(p[p.length - 1][1]) : undefined;
  const fail = f.length ? Number(f[f.length - 1][1]) : undefined;
  if (pass === undefined && fail === undefined) return null;
  return { pass: pass ?? 0, fail: fail ?? 0 };
}

module.exports = {
  root: ROOT,
  skipExitCode: 78,
  profiles: {
    fast: [
      'api:typecheck',
      'web:typecheck',
      'web:css-classes',
      'web:desc-hints',
      'web:ms15',
      'web:ms16',
      'web:no-native-select',
      'api:batch-export-contract',
      'api:smoke-isolated',
      'eval:ai-segment',
      'repo:traceability',
    ],
    full: [
      'api:typecheck',
      'web:typecheck',
      'web:css-classes',
      'web:desc-hints',
      'web:ms15',
      'web:ms16',
      'web:no-native-select',
      'api:batch-export-contract',
      'api:smoke-isolated',
      'api:isolated-all',
      'eval:ai-segment',
      'repo:traceability',
      'api:deps',
    ],
  },
  gates: [
    {
      id: 'api:typecheck',
      title: 'API 类型检查（tsc --noEmit）',
      command: { kind: 'npm', script: 'typecheck', cwd: 'app/api' },
      blocking: true,
      timeoutMs: 240000,
      parse: (out) => {
        const errors = [...out.matchAll(/error TS\d+/g)].length;
        return { pass: errors === 0 ? 1 : 0, fail: errors, unit: '编译错误' };
      },
    },
    {
      id: 'web:typecheck',
      title: 'Web 类型检查（tsc --noEmit）',
      command: { kind: 'npm', script: 'typecheck', cwd: 'app/web' },
      blocking: true,
      timeoutMs: 240000,
      parse: (out) => {
        const errors = [...out.matchAll(/error TS\d+/g)].length;
        return { pass: errors === 0 ? 1 : 0, fail: errors, unit: '编译错误' };
      },
    },
    {
      id: 'web:css-classes',
      title: 'CSS 类名「用了但未定义」静态门禁',
      command: { kind: 'npm', script: 'test:css-classes', cwd: 'app/web' },
      blocking: true,
      timeoutMs: 120000,
      parse: (out) => {
        const m = out.match(/合计未定义:\s*(\d+)/);
        const undef = m ? Number(m[1]) : undefined;
        return { pass: undef === 0 ? 1 : 0, fail: undef ?? 1, unit: '未定义类名' };
      },
    },
    {
      id: 'web:desc-hints',
      title: '描述联想（公司标准骨架）离线回归',
      command: { kind: 'npm', script: 'test:desc-hints', cwd: 'app/web' },
      blocking: true,
      timeoutMs: 120000,
      parse: (out) => {
        const r = lastMatch(out, /(\d+)\s*通过\s*\/\s*\d+\s*失败/, /通过\s*\/\s*(\d+)\s*失败/);
        return r ? { ...r, unit: '用例' } : null;
      },
    },
    {
      id: 'web:ms15',
      title: '动作标准 MS1.5 + 部位词表离线回归',
      command: { kind: 'npm', script: 'test:ms15', cwd: 'app/web' },
      blocking: true,
      timeoutMs: 120000,
      parse: (out) => {
        const r = lastMatch(out, /(\d+)\s*通过\s*\/\s*\d+\s*失败/, /通过\s*\/\s*(\d+)\s*失败/);
        return r ? { ...r, unit: '用例' } : null;
      },
    },
    {
      id: 'web:ms16',
      title: '动作标准 MS1.6 离线回归',
      command: { kind: 'npm', script: 'test:ms16', cwd: 'app/web' },
      blocking: true,
      timeoutMs: 120000,
      parse: (out) => {
        const r = lastMatch(out, /(\d+)\s*通过\s*\/\s*\d+\s*失败/, /通过\s*\/\s*(\d+)\s*失败/);
        return r ? { ...r, unit: '用例' } : null;
      },
    },
    {
      id: 'web:no-native-select',
      title: '禁用原生 <select> 静态扫描（复发≥3轮）',
      command: { kind: 'node', script: 'scripts/gates/check-no-native-select.cjs', cwd: '.' },
      blocking: true,
      timeoutMs: 60000,
      parse: (out) => {
        const m = out.match(/NATIVE_SELECT=(\d+)/);
        const n = m ? Number(m[1]) : undefined;
        return { pass: n === 0 ? 1 : 0, fail: n ?? 1, unit: '原生 select' };
      },
    },
    {
      id: 'api:batch-export-contract',
      title: '批量导出工作簿离线契约（6-sheet）',
      command: { kind: 'node', script: 'test/batch-export-contract.cjs', cwd: 'app/api' },
      blocking: true,
      timeoutMs: 180000,
      parse: (out) => {
        const m = out.match(/通过\s+(\d+)\s+项/);
        return m ? { pass: Number(m[1]), fail: 0, unit: '用例' } : null;
      },
    },
    {
      id: 'api:smoke-isolated',
      title: '隔离冒烟契约（临时 SQLite，双遍一致 + 正式库/存储指纹不变）',
      command: { kind: 'node', script: 'test/isolated-run.cjs', args: ['smoke'], cwd: 'app/api' },
      blocking: true,
      timeoutMs: 420000,
      parse: (out) => {
        const r = lastMatch(out, /通过=(\d+)\s+失败=\d+/, /通过=\d+\s+失败=(\d+)/);
        return r ? { ...r, unit: '用例' } : null;
      },
    },
    {
      id: 'api:isolated-all',
      title: '全部已迁移隔离套件（串行，默认双遍）',
      command: { kind: 'node', script: 'test/isolated-run.cjs', cwd: 'app/api' },
      blocking: true,
      timeoutMs: 1500000,
      // 全量套件含多种输出格式，统一按命令成败计；明细逐套见日志。
      parse: null,
    },
    {
      id: 'api:deps',
      title: '生产依赖审计（high/critical 阻断；当前已知未清零）',
      command: { kind: 'node', script: 'test/dependency-audit.mjs', cwd: 'app/api' },
      blocking: false,
      timeoutMs: 300000,
      note: 'QA 解禁第 ⑤ 步资产；在 critical/high 清零前保持 advisory，不改变门禁退出码。',
    },
    {
      id: 'eval:ai-segment',
      title: 'AI 分解评测基线（真值/候选缺省时明确 SKIPPED）',
      command: { kind: 'node', script: 'scripts/gates/run-eval-gate.cjs', cwd: '.' },
      blocking: false,
      timeoutMs: 180000,
      allowSkip: true,
      note: '0c：首次基线落档。真值必须由人独立标注（模板占位视为未配置）；'
        + 'P0-4 完成后再转 blocking 并按同一真值对比上一版。',
      parse: (out) => {
        const m = out.match(/EVAL_ACCEPTED=(\d+)\/(\d+)/);
        if (!m) return null;
        const passed = Number(m[1]);
        const total = Number(m[2]);
        return { pass: passed, fail: total - passed, unit: '验收项' };
      },
    },
    {
      id: 'repo:traceability',
      title: '版本可追溯（0b 三项判据：工作区干净 / 已打 tag / 某 tag 含 scripts/gates 全部文件）',
      command: { kind: 'node', script: 'scripts/gates/check-repo-traceability.cjs', cwd: '.' },
      blocking: false,
      timeoutMs: 60000,
      note: '0a 落地时必然未达成（待 0b 提交+tag）；保持 advisory，不改变门禁退出码。',
      parse: (out) => {
        const m = out.match(/TRACE_CHECKS=(\d+)\/(\d+)/);
        if (!m) return null;
        return { pass: Number(m[1]), fail: Number(m[2]) - Number(m[1]), unit: '判据' };
      },
    },
  ],
};
