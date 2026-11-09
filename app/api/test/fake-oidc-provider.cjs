/**
 * 本地假 OIDC 提供方（仅隔离测试使用，不连接任何真实 IdP）。
 *
 * 现场没有可连的 Keycloak，本进程用 node:http + node:crypto 模拟交底书 §3 的
 * 「授权码 + PKCE S256 + RS256 id_token」最小闭环：
 *
 *   GET  /.well-known/openid-configuration   discovery
 *   GET  /jwks                               公钥（RS256）
 *   GET  /authorize                          校验 client_id → 302 回 redirect_uri?code&state
 *   POST /token                              校验 client_secret / redirect_uri / code_verifier(S256) / code 单次
 *   POST /__control                          切换下一个授权请求使用的身份与异常模式
 *   GET  /__health                           就绪探针
 *
 * 异常模式（由 __control 设置，覆盖 id_token 校验与准入拒绝分支）：
 *   ok | bad_nonce | bad_aud | bad_iss | bad_signature | expired | no_group |
 *   idp_error（/authorize 直接回 error=access_denied）| token_error（/token 回 400）
 *
 * 凭据纪律：client_secret 只存在于本进程内存与测试进程环境变量，不写入仓库任何文件。
 */
const http = require('node:http');
const crypto = require('node:crypto');

function b64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function readBody(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

function createFakeOidcProvider(options = {}) {
  const clientId = options.clientId ?? 'ie-platform';
  const clientSecret = options.secret ?? 'test-sso-secret';

  /* 正常签名密钥与「攻击者」密钥：后者只在 bad_signature 模式使用，kid 保持不变 */
  const signing = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const attacker = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = `fake-${crypto.randomBytes(6).toString('hex')}`;
  const publicJwk = signing.publicKey.export({ format: 'jwk' });

  /** 当前授权情景；套件每次登录前用 /__control 覆盖 */
  let scenario = {
    mode: 'ok',
    loginName: 'ie1',
    displayName: 'IE 工程师 王工',
    email: 'ie1@example.com',
    employeeNo: 'E001',
    groups: ['app-ie'],
  };
  /** code → 授权快照（一次性；含 nonce/verifier 挑战/redirect_uri） */
  const codes = new Map();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const path = url.pathname;

      if (path === '/__health') return json(res, 200, { ok: true });
      if (path === '/__control') {
        if (req.method === 'GET') return json(res, 200, { scenario });
        const raw = await readBody(req);
        const patch = raw ? JSON.parse(raw) : {};
        scenario = { ...scenario, ...patch };
        if (scenario.mode === 'no_group') scenario.groups = [];
        return json(res, 200, { scenario });
      }
      if (path === '/.well-known/openid-configuration') {
        return json(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
        });
      }
      if (path === '/jwks') {
        return json(res, 200, {
          keys: [{ ...publicJwk, kid, use: 'sig', alg: 'RS256' }],
        });
      }

      if (path === '/authorize') {
        const q = url.searchParams;
        if (q.get('client_id') !== clientId) return json(res, 400, { error: 'invalid_client' });
        const redirectUri = q.get('redirect_uri') ?? '';
        const state = q.get('state') ?? '';
        if (!redirectUri || !state) return json(res, 400, { error: 'invalid_request' });
        /* IdP 侧拒绝（用户取消/未授权） */
        if (scenario.mode === 'idp_error') {
          const target = new URL(redirectUri);
          target.searchParams.set('error', 'access_denied');
          target.searchParams.set('state', state);
          return redirect(res, target.toString());
        }
        const code = crypto.randomBytes(18).toString('base64url');
        codes.set(code, {
          redirectUri,
          state,
          nonce: q.get('nonce') ?? '',
          codeChallenge: q.get('code_challenge') ?? '',
          codeChallengeMethod: q.get('code_challenge_method') ?? '',
          snapshot: { ...scenario, groups: [...(scenario.groups ?? [])] },
          createdAt: Date.now(),
        });
        const target = new URL(redirectUri);
        target.searchParams.set('code', code);
        target.searchParams.set('state', state);
        return redirect(res, target.toString());
      }

      if (path === '/token' && req.method === 'POST') {
        const raw = await readBody(req);
        const form = new URLSearchParams(raw);
        if (form.get('client_id') !== clientId || form.get('client_secret') !== clientSecret) {
          return json(res, 401, { error: 'invalid_client' });
        }
        const code = form.get('code') ?? '';
        const pending = codes.get(code);
        if (!pending) return json(res, 400, { error: 'invalid_grant', error_description: 'code 不存在或已使用' });
        codes.delete(code); // 单次消费
        if (form.get('redirect_uri') !== pending.redirectUri) {
          return json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri 不匹配' });
        }
        const verifier = form.get('code_verifier') ?? '';
        const expected = b64url(crypto.createHash('sha256').update(verifier).digest());
        if (!verifier || pending.codeChallengeMethod !== 'S256' || expected !== pending.codeChallenge) {
          return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE 校验失败' });
        }
        if (pending.snapshot.mode === 'token_error') {
          return json(res, 400, { error: 'server_error', error_description: '模拟令牌端点故障' });
        }

        const now = Math.floor(Date.now() / 1000);
        const claims = {
          iss: issuer,
          aud: clientId,
          azp: clientId,
          sub: String(pending.snapshot.employeeNo || pending.snapshot.loginName),
          preferred_username: pending.snapshot.loginName,
          name: pending.snapshot.displayName,
          email: pending.snapshot.email,
          nonce: pending.nonce,
          iat: now,
          exp: now + 300,
          groups: pending.snapshot.groups ?? ['app-ie'],
        };
        switch (pending.snapshot.mode) {
          case 'bad_nonce': claims.nonce = 'wrong-nonce'; break;
          case 'bad_aud': claims.aud = 'other-client'; break;
          case 'bad_iss': claims.iss = `${issuer}/other`; break;
          case 'expired':
            claims.exp = now - 300;
            claims.iat = now - 600;
            break;
          default: break;
        }
        const header = { alg: 'RS256', typ: 'JWT', kid };
        const head = b64url(JSON.stringify(header));
        const payload = b64url(JSON.stringify(claims));
        const key = pending.snapshot.mode === 'bad_signature' ? attacker.privateKey : signing.privateKey;
        const signature = b64url(crypto.sign('RSA-SHA256', Buffer.from(`${head}.${payload}`), key));
        const idToken = `${head}.${payload}.${signature}`;

        return json(res, 200, {
          access_token: `fake-access-${code}`,
          token_type: 'Bearer',
          expires_in: 300,
          id_token: idToken,
        });
      }

      return json(res, 404, { error: 'not_found', path });
    } catch (e) {
      return json(res, 500, { error: 'server_error', error_description: e.message });
    }
  });

  let issuer = '';

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      issuer = `http://127.0.0.1:${port}`;
      resolve({
        port,
        issuer,
        clientId,
        controlUrl: `${issuer}/__control`,
        healthUrl: `${issuer}/__health`,
        server,
        close: () => new Promise((done) => {
          server.closeAllConnections?.();
          server.close(() => done());
        }),
      });
    });
  });
}

module.exports = { createFakeOidcProvider };
