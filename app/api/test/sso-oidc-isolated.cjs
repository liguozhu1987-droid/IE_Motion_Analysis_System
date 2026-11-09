/**
 * 统一身份认证隔离套件启动器。
 *
 * 顺序：
 *   1. 本进程拉起「本地假 OIDC 提供方」（随机端口、HTTP、RSA 密钥）；
 *   2. 用隔离基座跑三组临时 SQLite + 独立端口 API：
 *      dual（双轨并存，跑两遍验证稳定）、off（OIDC 关闭降级）、nolocal（本地登录关闭）；
 *   3. 每轮 seed 后写入 SSO 中央表夹具（仅作用于本轮临时库）；
 *   4. finally 关闭假 IdP，临时目录由基座清理。
 *
 * 凭据纪律：client_secret 使用测试值并通过进程环境注入，不落仓库文件。
 */
const { runIsolated } = require('./isolated-harness.cjs');
const { createFakeOidcProvider } = require('./fake-oidc-provider.cjs');

const CLIENT_SECRET = 'test-sso-secret';

/** SSO 中央表夹具：仅写入本轮临时 SQLite（生产 synchronize=false，读写列子集一致） */
const SSO_FIXTURES = [
  'DELETE FROM CN_AME_SSO_UserMap',
  'DELETE FROM CN_AME_SSO_User',
  `INSERT INTO CN_AME_SSO_User (employee_no, login_name, display_name, email, status, source) VALUES
     ('E001', 'ie1', 'IE 工程师 王工', 'ie1@example.com', 1, 'AD'),
     ('E002', 'viewer1', '访客', 'viewer1@example.com', 1, 'AD'),
     ('E003', 'newie1', '新同事', 'newie1@example.com', 1, 'AD'),
     ('E004', 'leave1', '离职员工', 'leave1@example.com', 0, 'AD'),
     ('E009', 'bad user!', '非法用户名', NULL, 1, 'MANUAL')`,
  `INSERT INTO CN_AME_SSO_UserMap (employee_no, system_code, local_username) VALUES
     ('E001', 'ie', 'ie1'),
     ('E003', 'ie', 'ie_new')`,
  /* 离职回写用例：本地已绑定工号 E004 的 SSO 账号 + 一条未吊销 refresh */
  `INSERT INTO t_user (user_id, tenant_id, username, password_hash, display_name, email, status,
     failed_count, locked_until, must_change_pwd, ai_quota, ai_quota_used, department, position,
     employee_no, data_scope, cert_level, cert_expires_at, auth_source, created_at)
   VALUES ('u_sso_leave', 'DEFAULT', 'leave1', '!', '离职员工', 'leave1@example.com', 'active',
     0, NULL, 0, 1, 0, NULL, NULL, 'E004', 'own', NULL, NULL, 'oidc', datetime('now'))`,
  "INSERT INTO t_user_role (user_id, role_id) VALUES ('u_sso_leave', 'r_DEFAULT_viewer')",
  `INSERT INTO t_refresh_token (token_id, user_id, token_hash, expires_at, revoked, replaced_by, ip, source, created_at)
   VALUES ('rt_sso_leave', 'u_sso_leave', '${'f'.repeat(64)}', datetime('now', '+7 days'), 0, NULL, '127.0.0.1', 'oidc', datetime('now'))`,
];

const BASE_ENV = {
  AUTH_OIDC_CLIENT_ID: 'ie-platform',
  AUTH_OIDC_CLIENT_SECRET: CLIENT_SECRET,
  AUTH_OIDC_REDIRECT_URI: '',
  AUTH_OIDC_REQUIRED_GROUP: 'app-ie',
  AUTH_OIDC_SYSTEM_CODE: 'ie',
  AUTH_OIDC_DEFAULT_ROLE: 'viewer',
  AUTH_OIDC_AUTO_PROVISION: 'true',
  AUTH_OIDC_FRONTEND_CALLBACK: '#/oidc/callback',
  AUTH_REGISTRATION_ENABLED: 'false',
  FAKE_OIDC_SECRET: CLIENT_SECRET,
};

function runPlan(provider) {
  const env = { ...BASE_ENV, AUTH_OIDC_ISSUER: provider.issuer, FAKE_OIDC_CONTROL: provider.controlUrl };
  return [
    {
      suite: 'sso-dual',
      repeat: 2,
      env: { ...env, SSO_MODE: 'dual', AUTH_OIDC_ENABLED: 'true', AUTH_LOCAL_LOGIN_ENABLED: 'true' },
    },
    {
      suite: 'sso-off',
      repeat: 1,
      env: { ...env, SSO_MODE: 'off', AUTH_OIDC_ENABLED: 'false' },
    },
    {
      suite: 'sso-nolocal',
      repeat: 1,
      env: { ...env, SSO_MODE: 'nolocal', AUTH_OIDC_ENABLED: 'true', AUTH_LOCAL_LOGIN_ENABLED: 'false' },
    },
  ];
}

(async () => {
  let provider;
  let allPass = true;
  const rows = [];
  try {
    provider = await createFakeOidcProvider({ clientId: 'ie-platform', secret: CLIENT_SECRET });
    console.log(`本地假 OIDC 提供方已启动: ${provider.issuer}`);

    for (const plan of runPlan(provider)) {
      const summary = await runIsolated({
        suite: plan.suite,
        script: 'test/sso-oidc-flow.cjs',
        mode: 'api',
        repeat: plan.repeat,
        extraSql: SSO_FIXTURES,
        env: plan.env,
      });
      rows.push({ name: plan.suite, summary });
      if (!summary.success) allPass = false;
    }
  } catch (e) {
    console.error('SSO 隔离套件启动失败:', e.message);
    allPass = false;
  } finally {
    if (provider) await provider.close();
  }

  console.log('\n' + '='.repeat(78));
  console.log('统一身份认证（OIDC 双轨）隔离回归汇总');
  console.log('='.repeat(78));
  for (const { name, summary } of rows) {
    const runs = summary.results.map((r) => (r.pass !== null ? `${r.pass}/${r.fail}` : `exit=${r.code}`)).join(' , ');
    console.log(`${name.padEnd(16)}各遍通过/失败: ${runs.padEnd(14)}一致性: ${summary.consistent ? 'PASS' : 'FAIL'}  清理: ${summary.cleanupOk ? 'PASS' : 'FAIL'}`);
  }
  console.log(`总判定: ${allPass ? 'PASS' : 'FAIL'}`);
  if (!allPass) process.exitCode = 1;
})().catch((e) => {
  console.error('SSO 隔离套件异常:', e);
  process.exitCode = 1;
});
