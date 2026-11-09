/**
 * P0-4 告警 SMTP + 业务规则全链路验证（非生产测试脚本，NON_PRODUCTION）。
 *
 * 覆盖：
 *  A. SMTP 未配置 → send() 返回 false、不抛异常（纯日志降级）
 *  B. SMTP 配齐 + 本地假 SMTP 接收端 → 真发信 → 服务端收到原文（含唯一 ASCII token）
 *  C. 临时 SQLite（不连 CN_AME、不碰 data/ie.db）+ 假 SMTP：
 *     触发 3 条业务规则 → 各 1 封告警 → 同条件不重发 → 恢复 → 各 1 封恢复且只发一次
 *     → 冷却期内再越限静默抑制
 *  D. 业务阈值未配置 → 规则关闭且不发信（不暗设默认）
 *  E. GET /api/alerts/status 的权限元数据为 audit:read，返回结构含 6 条规则
 *
 * 跑法：cd app/api && npm run build && node test/alert-pipeline-p0-4.cjs
 * 隔离：临时目录 SQLite + 127.0.0.1 随机端口假 SMTP，收尾整目录删除。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');

const API_DIR = path.resolve(__dirname, '..');
require('reflect-metadata');
const { DataSource, EntitySchema } = require('typeorm');
const { AlertMailerService } = require(path.join(API_DIR, 'dist', 'src', 'core', 'alert', 'mailer.service.js'));
const { AlertMonitorService } = require(path.join(API_DIR, 'dist', 'src', 'core', 'alert', 'alert-monitor.service.js'));
const { AlertsController } = require(path.join(API_DIR, 'dist', 'src', 'core', 'alert', 'alerts.controller.js'));
const { diskGuardRuntime } = require(path.join(API_DIR, 'dist', 'src', 'core', 'alert', 'alert-runtime.js'));

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ok  ${name}`); }
  else {
    fail += 1;
    const d = detail === undefined ? '' : ` → ${JSON.stringify(detail).slice(0, 300)}`;
    failures.push(name + d);
    console.error(`FAIL  ${name}${d}`);
  }
}

/** 最小假 SMTP：单连接顺序命令，捕获 DATA 原文 */
function startFakeSmtp() {
  const messages = [];
  const server = net.createServer((socket) => {
    socket.write('220 localhost ESMTP\r\n');
    let buf = '';
    let dataMode = false;
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        if (dataMode) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end === -1) return;
          messages.push(buf.slice(0, end));
          buf = buf.slice(end + 5);
          dataMode = false;
          socket.write('250 OK\r\n');
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl === -1) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const cmd = (line.split(' ')[0] || '').toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') socket.write('250-localhost\r\n250 OK\r\n');
        else if (cmd === 'DATA') { dataMode = true; socket.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
        else if (cmd === 'QUIT') { socket.write('221 Bye\r\n'); socket.end(); }
        else socket.write('250 OK\r\n');
      }
    });
    socket.on('error', () => undefined);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, messages }));
  });
}

const UserSchema = new EntitySchema({
  name: 't_user',
  tableName: 't_user',
  columns: {
    user_id: { type: String, primary: true },
    status: { type: String, nullable: true },
    locked_until: { type: 'datetime', nullable: true },
  },
});
const AiTaskSchema = new EntitySchema({
  name: 't_ai_task',
  tableName: 't_ai_task',
  columns: {
    task_id: { type: String, primary: true },
    status: { type: String, nullable: false },
    updated_at: { type: 'datetime', nullable: false },
  },
});
const DerivativeSchema = new EntitySchema({
  name: 't_video_derivative',
  tableName: 't_video_derivative',
  columns: {
    id: { type: String, primary: true },
    status: { type: String, nullable: false },
    retry: { type: 'int', nullable: false, default: 0 },
    updated_at: { type: 'datetime', nullable: false },
  },
});

async function insertMany(ds, target, rows) {
  if (!rows.length) return;
  await ds.getRepository(target).insert(rows);
}

function mailerCfg(overrides = {}) {
  return {
    smtpHost: '', smtpPort: 25, smtpUser: '', smtpPass: '', smtpFrom: '', alertMailTo: '',
    ...overrides,
  };
}

function monitorCfg(overrides = {}) {
  return {
    alertLoginLockedMax: 5,
    alertAiTaskBacklog: 50,
    alertErrorRatePct: 1,
    alertErrorMinRequests: 20,
    alertCooldownMin: 30,
    alertCheckSec: 10,
    alertDeriveFailPct: 20,
    alertAiFailPct: 20,
    alertFailWindowMin: 60,
    alertFailMinSample: 10,
    ...overrides,
  };
}

(async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ie-alert-p04-'));
  const dbPath = path.join(tmpRoot, 'alert-test.db');
  process.env.DB_TYPE = 'sqlite';
  process.env.DB_PATH = dbPath;
  process.env.VIDEO_DERIVED_MAX_GB = '1';
  for (const k of ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASS', 'DB_ENCRYPT']) delete process.env[k];

  const smtp = await startFakeSmtp();
  const ds = new DataSource({
    type: 'sqlite',
    database: dbPath,
    entities: [UserSchema, AiTaskSchema, DerivativeSchema],
    synchronize: true,
    logging: false,
  });
  await ds.initialize();
  console.log(`临时目录: ${tmpRoot}；假 SMTP: 127.0.0.1:${smtp.port}`);

  try {
    // ── A. SMTP 未配置：静默降级 ──
    console.log('\n[A] SMTP 未配置 → 只落日志不发信');
    const disabled = new AlertMailerService(mailerCfg());
    check('A1 enabled=false', disabled.enabled === false);
    let threw = false;
    let ret = null;
    try { ret = await disabled.send('未配置测试', '仅日志'); } catch { threw = true; }
    check('A2 send 不抛异常且返回 false', threw === false && ret === false, { threw, ret });
    check('A3 未产生任何 SMTP 会话', smtp.messages.length === 0, smtp.messages.length);

    // ── B. SMTP 配齐：本地假接收端真收信 ──
    console.log('\n[B] SMTP 配齐 → 真发信 → 接收端收到');
    const token = `P0-4-${crypto.randomUUID()}`;
    const live = new AlertMailerService(mailerCfg({
      smtpHost: '127.0.0.1', smtpPort: smtp.port, smtpFrom: 'alert@test.local', alertMailTo: 'ops@test.local',
    }));
    check('B1 enabled=true', live.enabled === true);
    const sentOk = await live.send(`SMTP probe ${token}`, `body token=${token}`);
    check('B2 send 返回 true', sentOk === true, sentOk);
    check('B3 接收端收到 1 封', smtp.messages.length === 1, smtp.messages.length);
    check('B4 收到原文含唯一 token（证明走真实 SMTP DATA）',
      smtp.messages[0] && smtp.messages[0].includes(token), (smtp.messages[0] ?? '').slice(0, 120));
    check('B5 邮件含 Subject 头', /subject:/i.test(smtp.messages[0] ?? ''));

    // ── C. 业务规则全链路（临时 SQLite） ──
    console.log('\n[C] 触发 → 告警 → 不重发 → 恢复 → 恢复通知一次 → 冷却抑制');
    const sends = [];
    const pendingSends = [];
    const recorder = {
      enabled: live.enabled,
      send: (subject, text) => {
        sends.push({ subject, text });
        const p = live.send(subject, text);
        pendingSends.push(p);
        return p;
      },
      drain: async () => { await Promise.all(pendingSends.splice(0)); },
    };
    const monitor = new AlertMonitorService(ds, recorder, monitorCfg());
    const smtpBefore = smtp.messages.length;

    const now = new Date();
    const readyRows = Array.from({ length: 10 }, (_, i) => ({
      id: `d-ready-${i}`, status: 'ready', retry: 0, updated_at: now,
    }));
    const doneRows = Array.from({ length: 10 }, (_, i) => ({
      task_id: `ai-done-${i}`, status: 'done', updated_at: now,
    }));
    await insertMany(ds, 't_video_derivative', readyRows);
    await insertMany(ds, 't_ai_task', doneRows);

    diskGuardRuntime.overLimit = false;
    await monitor.check();
    check('C1 基线无失败：不发告警', sends.length === 0, sends.length);

    const failedDeriveRows = Array.from({ length: 5 }, (_, i) => ({
      id: `d-fail-${i}`, status: 'error', retry: 2, updated_at: new Date(),
    }));
    const failedAiRows = Array.from({ length: 5 }, (_, i) => ({
      task_id: `ai-fail-${i}`, status: 'failed', updated_at: new Date(),
    }));
    await insertMany(ds, 't_video_derivative', failedDeriveRows);
    await insertMany(ds, 't_ai_task', failedAiRows);
    diskGuardRuntime.overLimit = true;
    diskGuardRuntime.lastTotalBytes = 2 * 1024 ** 3;
    diskGuardRuntime.lastLimitBytes = 1 * 1024 ** 3;

    await monitor.check();
    await recorder.drain();
    const triggeredCodes = monitor.getStatus().rules.filter((r) => r.firing).map((r) => r.code).sort();
    check('C2 三条业务规则同时触发（派生失败率/AI失败率/磁盘占用）',
      JSON.stringify(triggeredCodes) === JSON.stringify(['ai_task_failure_rate', 'derive_failure_rate', 'derived_disk_usage']),
      triggeredCodes);
    check('C3 触发即发 3 封告警', sends.length === 3, sends.map((s) => s.subject));
    check('C4 SMTP 接收端新增 3 封', smtp.messages.length - smtpBefore === 3, smtp.messages.length - smtpBefore);
    check('C5 状态含上次触发时间与最近告警内容',
      monitor.getStatus().rules.filter((r) => r.firing).every((r) => r.last_fire_at && r.last_event?.title));

    await monitor.check();
    check('C6 条件持续为真不重复发火（边沿触发）', sends.length === 3, sends.length);

    // 恢复：失败行转为成功，磁盘回落
    await ds.getRepository('t_video_derivative').update({ status: 'error' } , { status: 'ready' });
    await ds.getRepository('t_ai_task').update({ status: 'failed' }, { status: 'done' });
    diskGuardRuntime.overLimit = false;

    await monitor.check();
    await recorder.drain();
    const afterRecovery = monitor.getStatus().rules;
    check('C7 三条规则全部恢复，发 3 封恢复通知', sends.length === 6, sends.slice(3).map((s) => s.subject));
    check('C8 恢复后 firing 全部为 false', afterRecovery.every((r) => r.firing === false));
    const recoveredBusiness = afterRecovery.filter((r) => ['derive_failure_rate', 'ai_task_failure_rate', 'derived_disk_usage'].includes(r.code));
    check('C9 恢复事件各记录一次',
      recoveredBusiness.every((r) => r.last_recovery_at && r.last_recovery?.title),
      recoveredBusiness.map((r) => r.code));

    await monitor.check();
    check('C10 恢复通知只发一次（再巡检不重发）', sends.length === 6, sends.length);

    // 冷却期内再越限：派生失败率重新超标，但距上次发火不足 30min → 静默抑制
    await insertMany(ds, 't_video_derivative', Array.from({ length: 5 }, (_, i) => ({
      id: `d-fail2-${i}`, status: 'error', retry: 2, updated_at: new Date(),
    })));
    await monitor.check();
    const deriveState = monitor.getStatus().rules.find((r) => r.code === 'derive_failure_rate');
    check('C11 冷却期内再越限不发火（firing 仍 false）',
      sends.length === 6 && deriveState.firing === false, { sends: sends.length, firing: deriveState.firing });
    check('C12 状态仍能看到本轮实测失败率（观测不受冷却影响）',
      deriveState.observed.failure_pct != null && deriveState.observed.failure_pct >= 20, deriveState.observed);

    // ── D. 业务阈值未配置：规则关闭，不暗设默认 ──
    console.log('\n[D] 业务阈值未配置 → 规则关闭且不发信');
    process.env.VIDEO_DERIVED_MAX_GB = '';
    const offSends = [];
    const offRecorder = { enabled: false, send: async (s, t) => { offSends.push({ s, t }); return false; } };
    const offMonitor = new AlertMonitorService(ds, offRecorder, monitorCfg({
      alertDeriveFailPct: null, alertAiFailPct: null, alertFailWindowMin: null, alertFailMinSample: null,
    }));
    await offMonitor.check();
    const offStatus = offMonitor.getStatus().rules;
    const business = offStatus.filter((r) => ['derive_failure_rate', 'ai_task_failure_rate', 'derived_disk_usage'].includes(r.code));
    check('D1 三条业务规则 configured 均为 false', business.every((r) => r.configured === false), business.map((r) => [r.code, r.configured]));
    check('D2 未配置阈值不发任何告警', offSends.length === 0, offSends.length);
    check('D3 未配置窗口时不做业务统计（observed.failed 为 null，避免暗设窗口）',
      business.find((r) => r.code === 'derive_failure_rate').observed.failed === null);

    // ── E. 端点权限与结构 ──
    console.log('\n[E] GET /api/alerts/status 权限与返回结构');
    const perms = Reflect.getMetadata('require_permissions', AlertsController.prototype.status);
    check('E1 权限收口为 audit:read', Array.isArray(perms) && perms.length === 1 && perms[0] === 'audit:read', perms);
    const ctrl = new AlertsController(monitor);
    const payload = ctrl.status();
    check('E2 返回 6 条规则', Array.isArray(payload.rules) && payload.rules.length === 6, payload.rules?.length);
    check('E3 返回 smtp.enabled / cooldown_min / last_check_at',
      payload.smtp && typeof payload.smtp.enabled === 'boolean'
      && payload.cooldown_min === 30 && !!payload.last_check_at);
  } finally {
    try { await ds.destroy(); } catch { /* 已关闭 */ }
    await new Promise((r) => smtp.server.close(r));
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* Windows 句柄占用 */ }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  if (fail > 0) { failures.forEach((f) => console.log(`  - ${f}`)); process.exitCode = 1; }
})().catch((e) => { console.error('测试执行异常:', e); process.exitCode = 1; });
