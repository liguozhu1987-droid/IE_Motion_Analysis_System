import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { APP_CONFIG, AppConfig } from '../../core/config/configuration';

/** OIDC discovery 文档（只声明本系统用到的字段） */
export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

export interface IdTokenClaims {
  iss: string;
  aud: string | string[];
  sub: string;
  exp: number;
  iat: number;
  nonce?: string;
  azp?: string;
  preferred_username?: string;
  name?: string;
  email?: string;
  groups?: string[];
  [k: string]: unknown;
}

const CACHE_TTL_MS = 10 * 60_000;
const CLOCK_LEEWAY_SEC = 60;

function b64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PKCE S256：challenge = BASE64URL(SHA256(verifier)) */
export function pkceChallenge(verifier: string): string {
  return b64url(createHash('sha256').update(verifier).digest());
}

/**
 * OIDC 客户端（授权码 + PKCE S256 + JWKS/RS256）。
 *
 * 刻意不引入 openid-client 依赖：本系统只需要 discovery / 授权跳转 / 令牌交换 / id_token 验签
 * 四件事，用 node:crypto + fetch 即可闭环，避免为接入方案引入无法在离线现场审计的第三方包。
 * 令牌交换走 client_secret_post（Keycloak confidential client 支持，secret 由环境变量注入）。
 */
@Injectable()
export class OidcClientService {
  private readonly log = new Logger('OidcClient');
  private discoveryCache?: { doc: OidcDiscovery; at: number };
  private jwksCache?: { keys: any[]; at: number };
  private discoveryInflight?: Promise<OidcDiscovery>;
  private jwksInflight?: Promise<any[]>;

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  private async getJson(url: string): Promise<any> {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.cfg.authOidcTimeoutMs),
    });
    if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
    return res.json();
  }

  async getDiscovery(force = false): Promise<OidcDiscovery> {
    if (!force && this.discoveryCache && Date.now() - this.discoveryCache.at < CACHE_TTL_MS) {
      return this.discoveryCache.doc;
    }
    if (this.discoveryInflight) return this.discoveryInflight;
    this.discoveryInflight = (async () => {
      const doc = (await this.getJson(
        `${this.cfg.authOidcIssuer}/.well-known/openid-configuration`,
      )) as OidcDiscovery;
      /* issuer 必须与配置严格一致：否则同一个 Keycloak 的另一个 realm 也能签发本系统令牌 */
      if (!doc?.issuer || doc.issuer.replace(/\/+$/, '') !== this.cfg.authOidcIssuer) {
        throw new Error(`discovery issuer 不匹配：期望 ${this.cfg.authOidcIssuer}，实际 ${doc?.issuer ?? '(空)'}`);
      }
      for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
        if (!doc[key]) throw new Error(`discovery 缺少 ${key}`);
      }
      this.discoveryCache = { doc, at: Date.now() };
      return doc;
    })().finally(() => { this.discoveryInflight = undefined; }) as Promise<OidcDiscovery>;
    return this.discoveryInflight;
  }

  private async getJwks(force = false): Promise<any[]> {
    if (!force && this.jwksCache && Date.now() - this.jwksCache.at < CACHE_TTL_MS) return this.jwksCache.keys;
    if (this.jwksInflight) return this.jwksInflight;
    this.jwksInflight = (async () => {
      const doc = await this.getDiscovery(force);
      const body = await this.getJson(doc.jwks_uri);
      if (!Array.isArray(body?.keys) || body.keys.length === 0) throw new Error('JWKS 无可用密钥');
      this.jwksCache = { keys: body.keys, at: Date.now() };
      return body.keys as any[];
    })().finally(() => { this.jwksInflight = undefined; }) as Promise<any[]>;
    return this.jwksInflight;
  }

  async buildAuthorizeUrl(input: {
    state: string; nonce: string; verifier: string; redirectUri: string;
  }): Promise<string> {
    const doc = await this.getDiscovery();
    const query = new URLSearchParams({
      client_id: this.cfg.authOidcClientId,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      scope: 'openid profile email',
      state: input.state,
      nonce: input.nonce,
      code_challenge: pkceChallenge(input.verifier),
      code_challenge_method: 'S256',
    });
    return `${doc.authorization_endpoint}${doc.authorization_endpoint.includes('?') ? '&' : '?'}${query.toString()}`;
  }

  /** 授权码换 id_token；失败只抛通用错误，细节进日志（不回显 code/secret） */
  async exchangeCode(code: string, verifier: string, redirectUri: string): Promise<string> {
    const doc = await this.getDiscovery();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: this.cfg.authOidcClientId,
      client_secret: this.cfg.authOidcClientSecret,
      code_verifier: verifier,
    });
    const res = await fetch(doc.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(this.cfg.authOidcTimeoutMs),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok || !json?.id_token) {
      this.log.warn(`令牌交换失败 HTTP ${res.status}：${json?.error ?? '(非 JSON 响应)'} ${json?.error_description ?? ''}`.trim());
      throw new UnauthorizedException('统一身份令牌交换失败');
    }
    return String(json.id_token);
  }

  /** 验签 + 标准声明校验（iss/aud/exp/iat/nonce/azp），全部通过才返回 claims */
  async verifyIdToken(idToken: string, expectedNonce: string): Promise<IdTokenClaims> {
    const parts = (idToken ?? '').split('.');
    if (parts.length !== 3) throw new UnauthorizedException('id_token 格式非法');
    let header: any; let claims: IdTokenClaims;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      throw new UnauthorizedException('id_token 无法解析');
    }
    /* 只接受 RS256：拒绝 none / HS256，防止算法混淆 */
    if (header?.alg !== 'RS256') throw new UnauthorizedException('id_token 签名算法不受支持');

    let keys = await this.getJwks();
    let jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) { keys = await this.getJwks(true); jwk = keys.find((k) => k.kid === header.kid); }
    if (!jwk) throw new UnauthorizedException('id_token 签名密钥未知');

    let ok = false;
    try {
      const publicKey = createPublicKey({ key: jwk, format: 'jwk' } as any);
      ok = cryptoVerify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], 'base64url'));
    } catch (e) {
      this.log.warn(`JWK 转公钥失败：${(e as Error).message}`);
    }
    if (!ok) throw new UnauthorizedException('id_token 签名校验失败');

    const now = Math.floor(Date.now() / 1000);
    if (claims.iss?.replace(/\/+$/, '') !== this.cfg.authOidcIssuer) throw new UnauthorizedException('id_token iss 不匹配');
    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!auds.includes(this.cfg.authOidcClientId)) throw new UnauthorizedException('id_token aud 不匹配');
    if (claims.azp && claims.azp !== this.cfg.authOidcClientId) throw new UnauthorizedException('id_token azp 不匹配');
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_LEEWAY_SEC < now) throw new UnauthorizedException('id_token 已过期');
    if (typeof claims.iat !== 'number' || claims.iat - CLOCK_LEEWAY_SEC > now) throw new UnauthorizedException('id_token 签发时间异常');
    if (!expectedNonce || claims.nonce !== expectedNonce) throw new UnauthorizedException('id_token nonce 不匹配');
    if (!claims.sub) throw new UnauthorizedException('id_token 缺少 sub');
    return claims;
  }
}
