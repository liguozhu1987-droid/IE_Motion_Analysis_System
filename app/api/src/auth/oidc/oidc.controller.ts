import {
  Body, Controller, Get, HttpCode, Inject, Logger, NotFoundException, Post, Query, Req, Res, UnauthorizedException,
} from '@nestjs/common';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { randomBytes } from 'node:crypto';
import { APP_CONFIG, AppConfig } from '../../core/config/configuration';
import { AuditService } from '../../audit/audit.service';
import { AuthService, clientIp } from '../auth.service';
import { Public } from '../../rbac/public.decorator';
import { AuthedRequest } from '../auth-user.interface';
import { OidcClientService } from './oidc-client.service';
import { OidcStateStore } from './oidc-state.store';
import { SsoIdentityService, SsoRejectedError } from './sso-identity.service';

class OtkDto {
  @IsString() @IsNotEmpty() @MaxLength(128) otk!: string;
}

function first(v: string | string[] | undefined): string {
  return Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '');
}

/**
 * 统一身份认证端点（交底书 §6.2 契约）：
 *  GET  /auth/config          登录页开关（公开）
 *  GET  /auth/oidc/login      302 → Keycloak 授权端点
 *  GET  /auth/oidc/callback   校验 state/nonce → 换令牌 → 解析身份 → 签发本地凭证 → OTK 回跳前端
 *  POST /auth/oidc/token      OTK 单次兑换本地登录态
 *
 * 关闭 OIDC 时四个端点一律 404（前端据 /auth/config 不展示入口），
 * 本地登录/刷新/登出逻辑完全不变 = 回归不退化。
 */
@Controller('auth')
export class OidcController {
  private readonly log = new Logger('OidcController');

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly client: OidcClientService,
    private readonly store: OidcStateStore,
    private readonly identity: SsoIdentityService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  /** 登录页开关；不暴露 issuer/secret 等任何配置细节 */
  @Public()
  @Get('config')
  config() {
    return {
      oidcEnabled: this.cfg.authOidcEnabled,
      localLoginEnabled: this.cfg.authLocalLoginEnabled,
      registrationEnabled: this.cfg.authRegistrationEnabled,
      /* 密码自助（忘记密码 → helpdesk 下发重置码）本版本无独立开关，随账号体系一并可用 */
      passwordSelfServiceEnabled: true,
      oidcLoginPath: '/auth/oidc/login',
    };
  }

  @Public()
  @Get('oidc/login')
  async login(@Req() req: AuthedRequest, @Res() res: any): Promise<void> {
    if (!this.cfg.authOidcEnabled) throw new NotFoundException();
    const state = randomBytes(24).toString('base64url');
    const nonce = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const redirectUri = this.redirectUriOf(req);
    try {
      /* 先取 discovery 再存 state：连不上 IdP 时不留下必然过期的中间态 */
      const url = await this.client.buildAuthorizeUrl({ state, nonce, verifier, redirectUri });
      this.store.putState(state, { nonce, verifier, redirectUri, createdAt: Date.now() });
      res.redirect(302, url);
    } catch (e) {
      this.log.error(`发起 SSO 登录失败：${(e as Error).message}`);
      res.redirect(302, this.frontUrl({ error: 'oidc_unavailable' }));
    }
  }

  @Public()
  @Get('oidc/callback')
  async callback(
    @Query('code') codeRaw: string,
    @Query('state') stateRaw: string,
    @Query('error') errorRaw: string,
    @Req() req: AuthedRequest,
    @Res() res: any,
  ): Promise<void> {
    if (!this.cfg.authOidcEnabled) throw new NotFoundException();
    const code = first(codeRaw);
    const state = first(stateRaw);
    const ip = clientIp(req);
    const failed = (error: string): void => { res.redirect(302, this.frontUrl({ error })); };

    /* state 必须一次性消费：无论后续成败都先删，重放直接失效 */
    const pending = this.store.takeState(state);
    if (!pending) {
      this.log.warn(`SSO 回调 state 无效或已过期（来源 ${ip}）`);
      this.audit.record(null, 'sso.login_rejected', 'user', null, null, { code: 'state_invalid' }, ip);
      return failed('state_invalid');
    }
    if (first(errorRaw)) {
      this.log.warn(`IdP 返回错误：${first(errorRaw)}（来源 ${ip}）`);
      this.audit.record(null, 'sso.login_rejected', 'user', null, null, { code: 'sso_denied', error: first(errorRaw) }, ip);
      return failed('sso_denied');
    }
    if (!code) return failed('code_missing');

    try {
      const idToken = await this.client.exchangeCode(code, pending.verifier, pending.redirectUri);
      const claims = await this.client.verifyIdToken(idToken, pending.nonce);
      const who = await this.identity.resolve(claims, req);
      const pair = await this.auth.issueSsoSession(who.userId, who.username, who.tenantId, req);
      const otk = this.store.putOtk({ ...pair, userId: who.userId, createdAt: Date.now() });
      res.redirect(302, this.frontUrl({ otk }));
    } catch (e) {
      if (e instanceof SsoRejectedError) return failed(e.code);
      const errCode = e instanceof UnauthorizedException ? 'id_token_invalid' : 'oidc_callback_failed';
      this.log.warn(`SSO 回调失败（${errCode}）：${(e as Error).message}`);
      return failed(errCode);
    }
  }

  @Public()
  @Post('oidc/token')
  @HttpCode(200)
  async token(@Body() dto: OtkDto, @Req() req: AuthedRequest) {
    if (!this.cfg.authOidcEnabled) throw new NotFoundException();
    const session = this.store.takeOtk(first(dto?.otk));
    if (!session) throw new UnauthorizedException('一次性登录码无效或已过期');
    return {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      tokenType: 'Bearer',
      expiresIn: 900,
      /* D7：SSO 用户跳过强制改密 */
      mustChangePwd: false,
    };
  }

  /** 回调地址：优先显式配置（生产必须固定内网地址），否则按请求 Host 推导（单机/隔离测试） */
  private redirectUriOf(req: AuthedRequest): string {
    if (this.cfg.authOidcRedirectUri) return this.cfg.authOidcRedirectUri;
    const proto = first(req.headers['x-forwarded-proto']) || 'http';
    const host = first(req.headers['x-forwarded-host']) || first(req.headers.host) || '127.0.0.1';
    return `${proto}://${host}/api/auth/oidc/callback`;
  }

  private frontUrl(params: Record<string, string>): string {
    const configured = this.cfg.authOidcFrontendCallback || '#/oidc/callback';
    const path = configured.startsWith('http') ? configured
      : configured.startsWith('/') ? configured : `/${configured}`;
    const search = new URLSearchParams(params).toString();
    return `${path}${path.includes('?') ? '&' : '?'}${search}`;
  }
}
