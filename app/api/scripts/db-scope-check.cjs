/**
 * 数据库边界硬性校验（对应 CLAUDE.md §1.6）。
 *
 *   node app/api/scripts/db-scope-check.cjs        （或根目录 npm run ops:db-scope-check）
 *
 * 校验内容：
 *  1) 所有来源文件里出现的 t_* 表名必须命中 30 张白名单（= 不允许操作其他业务表）；
 *  2) 禁止 CREATE/ALTER/DROP DATABASE、USE <库>、OPENROWSET/OPENQUERY、链接服务器、xp_cmdshell；
 *  3) 三段式引用 <X>.dbo.<表> 只允许 X = CN_AME；CMC.dbo.* 只允许出现在 SELECT 上下文；
 *  4) CN_AME_SSO_* 只允许读，出现写语句即失败；
 *  5) 仓库（不含 .env）中不得出现生产数据库口令；
 *  6) 生产 .env 必须指向 CN_AME@IRSCNYTFINEREPORT.ap.inalfa.local、账号 publicUser。
 *
 * 退出码：0 = 通过；1 = 存在违规（禁止部署）。纯静态检查，不连数据库。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..'); // 仓库根
const API = path.join(ROOT, 'app', 'api');

/** CLAUDE.md §1.2 白名单：30 张本系统表 */
const ALLOWED_TABLES = new Set([
  't_tenant', 't_user', 't_role', 't_permission', 't_user_role', 't_role_permission',
  't_refresh_token', 't_password_reset', 't_rule_set', 't_project', 't_line', 't_station',
  't_station_collaborator', 't_line_share', 't_element', 't_improvement', 't_video_asset',
  't_video_derivative', 't_ai_task', 't_ai_suggestion_batch', 't_ai_suggestion',
  't_ai_custom_dict', 't_ai_setting', 't_ai_llm_profile', 't_ai_waste_batch',
  't_ai_waste_finding', 't_ai_waste_issue', 't_ai_waste_kb', 't_ai_usage_event', 't_audit_log',
]);

const ALLOWED_PREFIXES = ['CN_AME_SSO_']; // 只读例外，另行校验

const FORBIDDEN_PATTERNS = [
  { re: /\bCREATE\s+DATABASE\b/i, msg: '禁止 CREATE DATABASE' },
  { re: /\bALTER\s+DATABASE\b/i, msg: '禁止 ALTER DATABASE' },
  { re: /\bDROP\s+DATABASE\b/i, msg: '禁止 DROP DATABASE' },
  { re: /^\s*USE\s+[A-Za-z_][A-Za-z0-9_]*\s*;/im, msg: '禁止 USE <其他库>' },
  { re: /\bOPENROWSET\b/i, msg: '禁止 OPENROWSET' },
  { re: /\bOPENQUERY\b/i, msg: '禁止 OPENQUERY' },
  { re: /\bsp_addlinkedserver\b/i, msg: '禁止链接服务器' },
  { re: /\bxp_cmdshell\b/i, msg: '禁止 xp_cmdshell' },
];

const WRITE_KEYWORD = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE|ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE\s+TABLE|CREATE\s+TABLE)\b/i;

/**
 * 仅在 SQL 表名上下文提取标识符，避免把注释里的 t_ai_waste_*、SQL 别名
 * t_user_auth_source_len 误判为表名。
 */
const TABLE_CONTEXT_RES = [
  /\b(?:FROM|JOIN|INTO|UPDATE|TABLE|REFERENCES)\s+([A-Za-z0-9_.$\[\]"`]+)/gi,
  /\bDELETE\s+(?:FROM\s+)?([A-Za-z0-9_.$\[\]"`]+)/gi,
  /(?:OBJECT_ID|COL_LENGTH)\s*\(\s*'([A-Za-z0-9_.]+)'/gi,
  /\bCREATE\s+(?:UNIQUE\s+)?(?:CLUSTERED\s+|NONCLUSTERED\s+)?INDEX\s+[A-Za-z0-9_$]+\s+ON\s+([A-Za-z0-9_.$\[\]"`]+)/gi,
];

function lineAt(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function checkTableNames(file, text) {
  for (const re of TABLE_CONTEXT_RES) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const raw = m[1].replace(/[\[\]"'`]/g, '');
      const parts = raw.split('.').filter(Boolean);
      const table = (parts[parts.length - 1] ?? '').toLowerCase();
      if (!/^t_[a-z0-9_]+$/.test(table)) continue;
      if (!ALLOWED_TABLES.has(table)) {
        fail(file, lineAt(text, m.index ?? 0),
          `表 ${table} 不在 CLAUDE.md 白名单内（新增表必须先取得书面同意并更新 CLAUDE.md）`);
      }
    }
  }
}

const problems = [];
const notes = [];
const filesChecked = [];

function fail(file, line, msg) {
  problems.push(`${path.relative(ROOT, file)}:${line}  ${msg}`);
}

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

function listFiles(dir, exts) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'build') continue;
      out.push(...listFiles(p, exts));
    } else if (exts.some((x) => p.endsWith(x))) out.push(p);
  }
  return out;
}

/** 1) t_* 白名单 + 5) SSO 只读 */
function checkFile(file) {
  filesChecked.push(file);
  const text = read(file);
  const lines = text.split(/\r?\n/);

  checkTableNames(file, text);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    for (const pat of FORBIDDEN_PATTERNS) {
      if (pat.re.test(line)) fail(file, lineNo, pat.msg);
    }

    // CN_AME_SSO_*：任何写语句同现即违规
    if (/CN_AME_SSO_/i.test(line) && WRITE_KEYWORD.test(line)) {
      fail(file, lineNo, 'CN_AME_SSO_* 仅允许 SELECT 只读');
    }

    // 三段式引用：只允许 CN_AME；CMC 单独判断写上下文
    for (const m of line.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*dbo\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/gi)) {
      const db = m[1];
      if (db.toUpperCase() === 'CN_AME') continue;
      if (db.toUpperCase() === 'CMC') {
        // CMC 只允许 SELECT：检查该行及前 6 行是否出现写关键字
        const ctx = lines.slice(Math.max(0, i - 6), i + 1).join('\n');
        if (WRITE_KEYWORD.test(ctx)) {
          fail(file, lineNo, `CMC.dbo.* 出现写语句（只允许 SELECT）`);
        }
        continue;
      }
      fail(file, lineNo, `跨库引用 ${db}.dbo.${m[2]}：除 CMC 只读例外外，不得引用其他数据库`);
    }

    // CMC 写语句：INSERT/UPDATE/DELETE 后紧跟 CMC.
    if (/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE|ALTER\s+TABLE|DROP\s+TABLE)\s+CMC\s*\./i.test(line)) {
      fail(file, lineNo, '禁止对 CMC 库执行写/DDL');
    }
  }
}

/** 6) .env 生产配置指向校验 */
function checkEnv() {
  const envPath = path.join(API, '.env');
  if (!fs.existsSync(envPath)) {
    notes.push('app/api/.env 不存在：跳过连接目标校验（部署前必须创建并指向 CN_AME）');
    return;
  }
  const env = {};
  for (const l of read(envPath).split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l);
    if (m) env[m[1]] = m[2].trim();
  }
  const expect = {
    DB_TYPE: 'mssql',
    DB_NAME: 'CN_AME',
    DB_USER: 'publicUser',
  };
  for (const [k, v] of Object.entries(expect)) {
    if (env[k] !== v) fail(envPath, 1, `${k}=${env[k] ?? '(未设置)'}，按硬性规则必须为 ${v}`);
  }
  const host = env.DB_HOST ?? '';
  if (!/^IRSCNYTFINEREPORT\.ap\.inalfa\.local$/i.test(host)) {
    fail(envPath, 1, `DB_HOST=${host || '(未设置)'}，按硬性规则必须为 IRSCNYTFINEREPORT.ap.inalfa.local`);
  }
  if (env.NODE_ENV === 'production') {
    for (const k of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']) {
      if (!env[k] || env[k].startsWith('dev-')) fail(envPath, 1, `${k} 生产环境必须为非 dev- 前缀的随机值`);
    }
  }
  // 口令存在性（不打印内容）
  if (!env.DB_PASS) fail(envPath, 1, 'DB_PASS 未设置');
  notes.push(`app/api/.env: DB_HOST=${host} DB_NAME=${env.DB_NAME} DB_USER=${env.DB_USER}`);
  return env;
}

/** 5) 口令不得出现在受版本控制的文件 */
function checkSecretSpread(env) {
  const secret = env?.DB_PASS;
  if (!secret || secret.length < 6) return;
  const skipDirs = new Set(['node_modules', 'dist', 'build', '.git', '.screenshots', 'deliverables']);
  const scan = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skipDirs.has(e.name)) continue;
        scan(p);
        continue;
      }
      if (e.name === '.env') continue;
      if (!/\.(md|ts|tsx|js|cjs|mjs|json|sql|ps1|bat|template|example|yml|yaml|txt)$/.test(e.name)) continue;
      let content;
      try { content = read(p); } catch { continue; }
      if (content.includes(secret)) {
        fail(p, 1, '生产数据库口令出现在受版本控制的文件中（必须只存在于 app/api/.env）');
      }
    }
  };
  if (fs.existsSync(ROOT)) scan(ROOT);
}

(function main() {
  const migrate = path.join(API, 'scripts', 'migrate.ts');
  if (!fs.existsSync(migrate)) {
    console.error(`找不到 migrate.ts：${migrate}`);
    process.exit(1);
  }
  checkFile(migrate);

  for (const f of listFiles(path.join(API, 'scripts'), ['.ts', '.cjs'])) {
    if (path.basename(f) === 'db-scope-check.cjs') continue; // 自身包含规则字面量，跳过
    checkFile(f);
  }
  for (const f of listFiles(path.join(API, 'src'), ['.ts'])) checkFile(f);
  for (const f of listFiles(path.join(ROOT, 'deploy', 'sql'), ['.sql', '.ps1'])) checkFile(f);
  for (const f of listFiles(path.join(API, 'packaging'), ['.bat'])) checkFile(f);

  const env = checkEnv();
  checkSecretSpread(env);

  console.log(`检查文件 ${filesChecked.length} 个，白名单表 ${ALLOWED_TABLES.size} 张`);
  for (const n of notes) console.log(`  · ${n}`);

  if (problems.length > 0) {
    console.error(`\n✗ 数据库边界校验失败（${problems.length} 项）——禁止部署：`);
    for (const p of problems.slice(0, 60)) console.error(`  ${p}`);
    if (problems.length > 60) console.error(`  … 另有 ${problems.length - 60} 项`);
    process.exit(1);
  }
  console.log('\n✓ 数据库边界校验通过：DDL/写入仅限 CN_AME 的 30 张白名单表，CMC 仅只读。');
})();
