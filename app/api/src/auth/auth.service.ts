import { BadRequestException, ConflictException, ForbiddenException, HttpException, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { APP_CONFIG } from '../core/config/configuration';
import { AppConfig } from '../core/config/configuration';
import { AuthedRequest } from './auth-user.interface';
import { AuthUserLoader } from './auth-user.loader';

export interface TokenPair { accessToken: string; refreshToken: string; }
export interface LoginResult extends TokenPair { mustChangePwd: boolean; }
export interface RegisterInput { username: string; password: string; displayName?: string; email?: string; }

/** 密码策略：至少 8 位且包含字母和数字（与 changePassword 一致，单一来源） */
export function validatePassword(pwd: string): void {
  if (!pwd || pwd.length < 8 || !/[a-zA-Z]/.test(pwd) || !/\d/.test(pwd)) {
    throw new BadRequestException('密码至少 8 位且包含字母和数字');
  }
}

const RESET_CODE_TTL_MS = 30 * 60_000;      // 重置码 30 分钟有效
const RESET_MAX_ATTEMPTS = 5;               // 单码尝试上限
const TEMP_PWD_LEN = 12;                    // 管理员代置临时口令长度

/**
 * 认证服务：登录（锁定策略）/ 刷新（轮换+复用检测）/ 登出 / 改密 /
 * 注册（pending 待审批）/ 忘记密码（通用应答）/ 重置密码（尝试上限+会话吊销）。
 * 限流为进程内内存计数（单实例有效；PM2 多实例部署时每进程独立计数，可接受
 * 的兜底防护——生产多实例严格限流需换 Redis，见 AGENT必读 待办）。
 */
@Injectable()
export class AuthService {
  private readonly log = new Logger('AuthService');
  /** 限流桶：key → { count, resetAt } */
  private readonly rateBuckets = new Map<string, { count: number; resetAt: number }>();

  /**
   * 桶表容量上限：暴破会轮换用户名/（伪造头失效后仍可能来自不同真实 IP），
   * 键无限增长就是一次内存泄漏。超限时先清过期项，再按最旧插入淘汰。
   */
  private static readonly RATE_BUCKET_MAX = 20_000;

  /** 过期桶清扫器（5 分钟一轮，unref 不阻挡进程退出） */
  private readonly bucketSweeper: NodeJS.Timeout;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly jwt: JwtService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly loader: AuthUserLoader,
  ) {
    this.bucketSweeper = setInterval(() => this.sweepRateBuckets(), 5 * 60_000);
    this.bucketSweeper.unref();
  }

  async login(username: string, password: string, req: AuthedRequest): Promise<LoginResult> {
    /* 双轨开关（D5）：本地入口可单独关闭；关闭后既有 refresh 会话仍可续期，不影响已登录用户 */
    if (!this.cfg.authLocalLoginEnabled) {
      throw new ForbiddenException('本地账号登录已关闭，请使用统一身份登录');
    }
    const name = (username ?? '').trim();
    const ip = clientIp(req);
    /*
     * 登录限流双桶（**只计失败**，成功不计入并清空该账号桶）：
     *  - login:ip   —— 15 次失败 / 5 分钟：挡住"同一出口对一个系统的批量试错"；
     *  - login:user —— 10 次失败 / 15 分钟：挡住"对一个账号的定点爆破"。
     * 为什么只计失败：50 人早高峰共用 ARR 一个出口 IP，若按"所有尝试"计数，
     * 正常用户会被同事的错误尝试连坐；只计失败则正常用户零消耗，暴破立刻触顶。
     *
     * 预检必须在查库与 bcrypt 之前：bcrypt cost=10 是 60~100ms CPU，
     * 50 并发下暴破会把事件循环占满（这也是本次最贵的单点），限流要挡在算力消耗之前。
     */
    const ipKey = `login:ip:${ip}`;
    const userKey = `login:user:${name}`;
    const ipWindowMs = this.cfg.loginIpWindowMin * 60_000;
    const userWindowMs = this.cfg.loginUserWindowMin * 60_000;
    this.assertLoginBudget(ipKey, this.cfg.loginIpMaxFail);
    this.assertLoginBudget(userKey, this.cfg.loginUserMaxFail);

    const fail = (): never => {
      // 失败才记：两个桶都要记，否则换个用户名就能绕开账号桶、换个 IP 就能绕开 IP 桶
      this.recordLoginFailure(ipKey, ipWindowMs);
      if (name) this.recordLoginFailure(userKey, userWindowMs);
      // 文案不区分"用户不存在/口令错误"，避免账号枚举
      throw new UnauthorizedException('用户名或密码错误');
    };

    const repo = this.ds.getRepository('t_user');
    const user = await repo.findOne({ where: { username: name }, select: ['user_id', 'username', 'password_hash', 'status', 'failed_count', 'locked_until', 'tenant_id', 'display_name', 'must_change_pwd'] } as any) as any;
    if (!user) fail();
    /* 统一身份自动建档的账号没有本地口令（占位值不是 bcrypt 哈希）：
       必须给明确入口提示，而不是让 bcrypt 拿垃圾值比较后报"密码错误" */
    if (!String(user.password_hash ?? '').startsWith('$2')) {
      throw new UnauthorizedException('该账号由统一身份认证开通，请从统一身份登录入口登录');
    }
    if (user.status === 'pending') throw new UnauthorizedException('账号待管理员审批，请耐心等待');
    if (user.status === 'rejected') throw new UnauthorizedException('账号申请未通过，请联系管理员');
    if (user.status === 'disabled') throw new UnauthorizedException('账号已停用');
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      throw new UnauthorizedException(`账号已锁定，请 ${Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 60000)} 分钟后重试`);
    }
    const ok = bcrypt.compareSync(password, user.password_hash);
    if (!ok) {
      const failed = (user.failed_count ?? 0) + 1;
      const patch: any = { failed_count: failed };
      if (failed >= this.cfg.loginMaxFail) {
        patch.status = 'locked';
        patch.locked_until = new Date(Date.now() + this.cfg.loginLockMin * 60_000);
      }
      await repo.update({ user_id: user.user_id } as any, patch);
      fail();
    }
    // 登录成功：清空该账号的失败桶（IP 桶不清——清了等于给攻击者一个"成功一次即重置"的后门）
    this.rateBuckets.delete(userKey);
    await repo.update({ user_id: user.user_id } as any, { failed_count: 0, locked_until: null, status: 'active' });
    this.loader.invalidate(user.user_id);
    const pair = await this.issuePair(user.user_id, user.username, user.tenant_id, req, 'local');
    this.audit(user, 'login', 'user', user.user_id, req);
    return { ...pair, mustChangePwd: Number(user.must_change_pwd) === 1 };
  }

  /** 刷新：轮换 + 重放检测（旧 token 重放 → 全族吊销） */
  async refresh(refreshToken: string, req: AuthedRequest): Promise<TokenPair> {
    const repo = this.ds.getRepository('t_refresh_token');
    const hash = sha256(refreshToken);
    const row = await repo.findOne({ where: { token_hash: hash } } as any) as any;
    if (!row) throw new UnauthorizedException('刷新令牌无效');
    if (row.revoked) {
      // 重放检测：吊销该用户全部有效 refresh
      await repo.update({ user_id: row.user_id, revoked: 0 } as any, { revoked: 1 });
      throw new UnauthorizedException('刷新令牌已失效（检测到重放，全部会话已吊销）');
    }
    if (new Date(row.expires_at) < new Date()) throw new UnauthorizedException('刷新令牌已过期');
    const user = await this.ds.getRepository('t_user').findOne({ where: { user_id: row.user_id } } as any) as any;
    if (!user || user.status !== 'active') throw new UnauthorizedException('用户不存在或已停用');
    const pair = await this.issuePair(user.user_id, user.username, user.tenant_id, req, row.source === 'oidc' ? 'oidc' : 'local');
    await repo.update({ token_id: row.token_id } as any, { revoked: 1, replaced_by: pair.refreshToken.slice(0, 36) });
    return pair;
  }

  async logout(refreshToken: string): Promise<void> {
    const repo = this.ds.getRepository('t_refresh_token');
    await repo.update({ token_hash: sha256(refreshToken) } as any, { revoked: 1 });
  }

  async changePassword(userId: string, oldPwd: string, newPwd: string): Promise<void> {
    validatePassword(newPwd);
    const repo = this.ds.getRepository('t_user');
    const user = await repo.findOne({ where: { user_id: userId }, select: ['user_id', 'password_hash'] } as any) as any;
    if (!user) throw new UnauthorizedException('用户不存在');
    if (!bcrypt.compareSync(oldPwd, user.password_hash)) throw new UnauthorizedException('原密码错误');
    await repo.update({ user_id: userId } as any, { password_hash: bcrypt.hashSync(newPwd, 10), must_change_pwd: 0 });
    this.loader.invalidate(userId);
  }

  /**
   * 自助注册：用户名全局唯一；进入 pending 待审批态（无角色 → 看不到任何租户数据），
   * 由管理员在用户管理页审批并赋予角色后生效。tenant 固定 DEFAULT（多租户开通走管理端）。
   */
  async register(dto: RegisterInput, req: AuthedRequest): Promise<{ status: string; message: string }> {
    /* D9：保留本地自助注册能力，但默认关闭（AUTH_REGISTRATION_ENABLED 默认 false） */
    if (!this.cfg.authRegistrationEnabled) {
      throw new ForbiddenException('自助注册已关闭，请联系管理员开通账号');
    }
    validatePassword(dto.password);
    const username = (dto.username ?? '').trim();
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
      throw new BadRequestException('用户名须为 3-32 位字母、数字、._- 组合');
    }
    const email = (dto.email ?? '').trim() || null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('邮箱格式不正确');
    }
    const repo = this.ds.getRepository('t_user');
    const dup = await repo.countBy({ username } as any);
    if (dup > 0) throw new ConflictException('用户名已存在');
    // 限流仅计成功注册（防批量建号）；校验失败/重名不计入，避免误伤正常用户
    this.checkRate(`register:${clientIp(req)}`, 3, 3600_000); // 3 次/小时/IP
    const userId = 'u_' + randomUUID().replace(/-/g, '').slice(0, 26);
    await repo.save(repo.create({
      user_id: userId, tenant_id: 'DEFAULT', username,
      password_hash: bcrypt.hashSync(dto.password, 10),
      display_name: (dto.displayName ?? '').trim() || username,
      email, status: 'pending', failed_count: 0, must_change_pwd: 0,
    } as any));
    this.audit({ user_id: userId, username, tenant_id: 'DEFAULT' }, 'register', 'user', userId, req);
    return { status: 'pending', message: '注册成功，请等待管理员审批后登录' };
  }

  /**
   * 忘记密码（helpdesk 模式，无 SMTP）：通用应答不泄露账号存在性；
   * 生成 6 位重置码（sha256(code:user_id) 存储）后由管理员人工送达。
   */
  async forgotPassword(username: string, req: AuthedRequest): Promise<{ ok: boolean; message: string }> {
    this.checkRate(`forgot:${clientIp(req)}`, 5, 3600_000); // 5 次/小时/IP
    const generic = { ok: true, message: '如果该账号存在，重置码已生成（30 分钟内有效），请联系管理员获取' };
    const user = await this.ds.getRepository('t_user').findOne({ where: { username: (username ?? '').trim() } } as any) as any;
    if (!user || user.status === 'disabled' || user.status === 'rejected') return generic;
    await this.issueCode(user, clientIp(req));
    this.audit(user, 'forgot_password', 'user', user.user_id, req);
    return generic;
  }

  /** 重置密码：校验 6 位码（尝试上限 5 次），成功后更新密码并吊销该用户全部 refresh 会话 */
  async resetPassword(username: string, code: string, newPassword: string, req: AuthedRequest): Promise<{ ok: boolean }> {
    this.checkRate(`reset:${clientIp(req)}`, 10, 3600_000); // 10 次/小时/IP
    validatePassword(newPassword);
    const invalid = () => new UnauthorizedException('重置码无效或已过期，请联系管理员重新获取');
    const user = await this.ds.getRepository('t_user').findOne({ where: { username: (username ?? '').trim() } } as any) as any;
    if (!user) throw invalid();
    const repo = this.ds.getRepository('t_password_reset');
    const row = await repo.findOne({ where: { user_id: user.user_id, used: 0 }, order: { created_at: 'DESC' } } as any) as any;
    if (!row) throw invalid();
    if (new Date(row.expires_at) < new Date()) {
      await repo.update({ reset_id: row.reset_id } as any, { used: 1 });
      throw invalid();
    }
    if ((row.attempts ?? 0) >= RESET_MAX_ATTEMPTS) {
      await repo.update({ reset_id: row.reset_id } as any, { used: 1 });
      throw new UnauthorizedException('尝试次数过多，重置码已作废，请联系管理员重新获取');
    }
    if (sha256(`${code}:${user.user_id}`) !== row.code_hash) {
      const attempts = (row.attempts ?? 0) + 1;
      await repo.update({ reset_id: row.reset_id } as any, { attempts });
      const left = Math.max(0, RESET_MAX_ATTEMPTS - attempts);
      throw new UnauthorizedException(left > 0 ? `重置码错误，还可尝试 ${left} 次` : '尝试次数过多，重置码已作废，请联系管理员重新获取');
    }
    // 校验通过：更新密码（锁定中的账号一并解锁）、消费本码并作废其余、吊销全部会话
    const patch: any = {
      password_hash: bcrypt.hashSync(newPassword, 10),
      must_change_pwd: 0, failed_count: 0, locked_until: null,
    };
    if (user.status === 'locked') patch.status = 'active';
    await this.ds.getRepository('t_user').update({ user_id: user.user_id } as any, patch);
    await repo.update({ reset_id: row.reset_id } as any, { used: 1 });
    await repo.update({ user_id: user.user_id, used: 0 } as any, { used: 1 });
    await this.revokeAllSessions(user.user_id);
    this.loader.invalidate(user.user_id);
    this.audit(user, 'reset_password', 'user', user.user_id, req);
    return { ok: true };
  }

  /**
   * 管理员下发重置码（user:write）：为用户生成新码并一次性返回明文，
   * 由管理员通过电话/企业微信等可信通道告知用户。审计不记明文。
   */
  async adminIssueResetCode(userId: string, ip: string): Promise<{ code: string; expiresAt: Date }> {
    const user = await this.ds.getRepository('t_user').findOne({ where: { user_id: userId } } as any) as any;
    if (!user) throw new UnauthorizedException('用户不存在');
    if (user.status === 'disabled' || user.status === 'rejected') {
      throw new BadRequestException('账号已停用或未通过审批，不能下发重置码');
    }
    const code = await this.issueCode(user, ip);
    // v3.58：此处原以「被重置者」身份写审计，导致高危动作归因到受害者且 ip 失真；
    // 统一收口到 users.service.issueResetCode（actor=操作管理员，ip=操作来源），此处不再重复留痕。
    return { code, expiresAt: new Date(Date.now() + RESET_CODE_TTL_MS) };
  }

  /** 生成重置码：作废旧码 → 新码 sha256(code:user_id) 入库，返回明文（仅调用方一次性可见） */
  private async issueCode(user: any, ip: string): Promise<string> {
    const repo = this.ds.getRepository('t_password_reset');
    await repo.update({ user_id: user.user_id, used: 0 } as any, { used: 1 });
    const code = String(randomInt(100000, 999999));
    await repo.save(repo.create({
      reset_id: randomUUID(),
      tenant_id: user.tenant_id,
      user_id: user.user_id,
      code_hash: sha256(`${code}:${user.user_id}`),
      expires_at: new Date(Date.now() + RESET_CODE_TTL_MS),
      used: 0, attempts: 0, ip: ip || null,
    } as any));
    return code;
  }

  /** 管理员代置临时口令：生成 12 位随机口令（仅返回一次）+ must_change_pwd=1 + 吊销全部会话 */
  async adminResetPassword(userId: string, ip: string): Promise<{ tempPassword: string }> {
    const repo = this.ds.getRepository('t_user');
    const user = await repo.findOne({ where: { user_id: userId } } as any) as any;
    if (!user) throw new UnauthorizedException('用户不存在');
    if (user.status === 'disabled' || user.status === 'rejected') {
      throw new BadRequestException('账号已停用或未通过审批，不能重置密码');
    }
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'; // 去混淆字符
    let tempPassword = '';
    for (let i = 0; i < TEMP_PWD_LEN; i++) tempPassword += chars[randomInt(chars.length)];
    await repo.update({ user_id: userId } as any, {
      password_hash: bcrypt.hashSync(tempPassword, 10),
      must_change_pwd: 1, failed_count: 0, locked_until: null,
    });
    await this.ds.getRepository('t_password_reset').update({ user_id: userId, used: 0 } as any, { used: 1 }); // 旧重置码一并作废
    await this.revokeAllSessions(userId);
    this.loader.invalidate(userId);
    // v3.58：审计收口到 users.service.resetPassword（actor=操作管理员），理由同上。
    return { tempPassword };
  }

  /** 吊销某用户全部有效 refresh 会话（改密/重置/代置口令后调用） */
  private async revokeAllSessions(userId: string): Promise<void> {
    await this.ds.getRepository('t_refresh_token').update({ user_id: userId, revoked: 0 } as any, { revoked: 1 });
  }

  private checkRate(key: string, max: number, windowMs: number): void {
    const now = Date.now();
    const b = this.rateBuckets.get(key);
    if (!b || b.resetAt < now) {
      this.rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      this.enforceBucketCap();
      return;
    }
    b.count += 1;
    if (b.count > max) {
      throw new HttpException('操作过于频繁，请稍后再试', 429);
    }
  }

  /**
   * 登录失败桶预检（只读，不累加）：
   * 与 checkRate 的"调用即累加"语义不同——登录只计失败，所以判定与记账必须拆开，
   * 否则成功登录也会消耗配额（50 人早高峰会互相连坐）。
   */
  private assertLoginBudget(key: string, max: number): void {
    const b = this.rateBuckets.get(key);
    if (!b) return;
    if (b.resetAt <= Date.now()) {
      this.rateBuckets.delete(key);
      return;
    }
    if (b.count >= max) {
      // 文案不提"账号是否存在"，避免把 429 变成账号枚举的旁路
      throw new HttpException('尝试过于频繁，请稍后再试', 429);
    }
  }

  /** 记一次登录失败（窗口内累加） */
  private recordLoginFailure(key: string, windowMs: number): void {
    const now = Date.now();
    const b = this.rateBuckets.get(key);
    if (!b || b.resetAt <= now) {
      this.rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      this.enforceBucketCap();
      return;
    }
    b.count += 1;
  }

  /** 清掉全部过期桶（定时器每 5 分钟一次；读路径另有惰性淘汰） */
  private sweepRateBuckets(): void {
    const now = Date.now();
    for (const [key, b] of this.rateBuckets) {
      if (b.resetAt <= now) this.rateBuckets.delete(key);
    }
  }

  /** 桶表硬上限：仅在超限时触发，先清过期再按最旧插入淘汰，保证内存有界 */
  private enforceBucketCap(): void {
    if (this.rateBuckets.size <= AuthService.RATE_BUCKET_MAX) return;
    this.sweepRateBuckets();
    while (this.rateBuckets.size > AuthService.RATE_BUCKET_MAX) {
      const oldest = this.rateBuckets.keys().next();
      if (oldest.done) return;
      this.rateBuckets.delete(oldest.value);
    }
  }

  /**
   * 统一身份（OIDC）登录成功后的本地凭证签发：与本地登录共用同一套 JWT/refresh，
   * 下游鉴权零改动（交底书 §3.2）。source 仅影响 /auth/me 的 authSource 展示与刷新来源。
   */
  async issueSsoSession(
    userId: string, username: string, tenantId: string, req: AuthedRequest,
  ): Promise<TokenPair> {
    this.loader.invalidate(userId);
    return this.issuePair(userId, username, tenantId, req, 'oidc');
  }

  private async issuePair(
    userId: string, username: string, tenantId: string, req: AuthedRequest,
    source: 'local' | 'oidc' = 'local',
  ): Promise<TokenPair> {
    const accessToken = this.jwt.sign(
      // src 声明只用于前端/审计区分来源；鉴权仍只看 sub + 实时角色权限
      { sub: userId, username, tenant_id: tenantId, src: source },
      { secret: this.cfg.jwtAccessSecret, expiresIn: this.cfg.jwtAccessTtl },
    );
    const refreshToken = randomUUID() + randomUUID();
    const ttlMs = parseTtl(this.cfg.jwtRefreshTtl);
    await this.ds.getRepository('t_refresh_token').save(this.ds.getRepository('t_refresh_token').create({
      token_id: randomUUID(),
      user_id: userId,
      token_hash: sha256(refreshToken),
      expires_at: new Date(Date.now() + ttlMs),
      revoked: 0,
      ip: clientIp(req),
      source,
    } as any));
    return { accessToken, refreshToken };
  }

  private audit(user: any, action: string, entity: string, entityId: string, req: AuthedRequest): void {
    // 异步落审计，不阻塞响应
    void this.ds.getRepository('t_audit_log').save(this.ds.getRepository('t_audit_log').create({
      log_id: randomUUID(),
      tenant_id: user.tenant_id,
      user_id: user.user_id,
      username: user.username,
      action, entity, entity_id: entityId,
      ip: clientIp(req),
    } as any)).catch((e) => this.log.error(`审计写入失败 ${action}/${entity}/${entityId}: ${(e as Error).message}`));
  }
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/* ─────────────────────── 可信客户端 IP 解析 ─────────────────────── */

/**
 * 为什么不再用 X-Forwarded-For：
 * 本系统部署形态是 "客户端 → IIS ARR → API(127.0.0.1:3001)"，ARR 与 API **同机**。
 * 这意味着任何同机进程（含被攻陷的低权服务、误配的代理规则）都能直接向 127.0.0.1:3001
 * 发请求并自带任意 XFF。XFF 首值由客户端写、末值由"最后一个代理"写——当这个代理就是
 * 攻击者本机进程时，首末两值都不可信（实测：轮换伪造 XFF 可 8/8 绕过限流）。
 *
 * 因此唯一可信的链路是：
 *  ① socket peer 地址由内核填，不可伪造 —— 先看 peer；
 *  ② peer 是白名单内的反代（TRUSTED_PROXIES，默认仅回环）才认它写的专用头
 *     （CLIENT_IP_HEADER，默认 x-real-ip，由 ARR 的 URL Rewrite 规则**覆写**，
 *      而不是 append —— 覆写才没有"客户端预置值混进来"的问题）；
 *  ③ peer 不在白名单（直连、或从内网别处打过来）→ 一律用 peer 本身，客户端自带的头全部忽略。
 * 另外 main.ts 里显式 set('trust proxy', false)：不让 Express 再把 XFF 塞进 req.ip，
 * 避免 req.ip 成为"看起来可信、实际可伪造"的第二来源。
 */
interface ClientIpPolicy {
  /** 小写化的专用头名 */
  header: string;
  /** 归一化后的可信 peer 集合 */
  trusted: Set<string>;
}

let cachedPolicy: ClientIpPolicy | null = null;

/** IPv4-mapped IPv6（::ffff:127.0.0.1）归一成 IPv4，便于与白名单逐字比较 */
function normalizePeerIp(raw: string | undefined): string {
  const ip = String(raw ?? '').trim().toLowerCase();
  if (!ip) return '';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  return mapped ? mapped[1] : ip;
}

/** 只接受字面量 IP：头值最终会写进审计表/日志，必须挡掉 CRLF 与任意字符串注入 */
function isIpLiteral(value: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (v4) return v4.slice(1).every((octet) => Number(octet) <= 255);
  // IPv6：仅允许十六进制、冒号、点（含 IPv4-mapped/压缩写法），且必须含冒号
  return value.includes(':') && /^[0-9a-f:.]+$/.test(value) && value.length <= 45;
}

/** 策略惰性读取（与 AppConfig 同源，值启动后固定；clientIp 是纯函数式多调用点，无法注入 cfg） */
function clientIpPolicy(): ClientIpPolicy {
  if (cachedPolicy) return cachedPolicy;
  const header = (process.env.CLIENT_IP_HEADER ?? 'x-real-ip').trim().toLowerCase() || 'x-real-ip';
  const raw = process.env.TRUSTED_PROXIES ?? '127.0.0.1,::1,::ffff:127.0.0.1';
  const trusted = new Set<string>(raw.split(',').map((s) => normalizePeerIp(s)).filter((s) => s.length > 0));
  // 回环恒可信：本服务只 listen 127.0.0.1，能连上来的同机进程就是 ARR 本身。
  // 若白名单被误配成空，绝不退化成"谁都可信"，而是回到"只认 peer"的安全侧。
  trusted.add('127.0.0.1');
  trusted.add('::1');
  cachedPolicy = { header, trusted };
  return cachedPolicy;
}

/**
 * 解析可信客户端 IP（导出名与签名保持不变，调用点遍布审计/限流/会话记录）。
 * 返回空串表示无法判定（此时调用方拿到的是空键，多个未知来源会共用一个桶——
 * 宁可误伤也不放过，且本服务只监听回环，实际不会发生）。
 */
export function clientIp(req: AuthedRequest): string {
  const { header, trusted } = clientIpPolicy();
  const peer = normalizePeerIp(req.socket?.remoteAddress);

  // ① 非可信来源直连：只认 socket peer，客户端自带的任何 IP 头都不采信
  if (!peer || !trusted.has(peer)) return peer;

  // ② 可信反代：读专用头。同名头出现多次时 Node 会按 ", " 合并成一个字符串，
  //    反代通常把"自己写入的值"追加在尾部，故取最后一个非空值。
  const raw = req.headers?.[header];
  const values = (Array.isArray(raw) ? raw : [raw])
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const parts = values[i].split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    for (let j = parts.length - 1; j >= 0; j -= 1) {
      const candidate = normalizePeerIp(parts[j]);
      if (isIpLiteral(candidate)) return candidate;
    }
  }

  // ③ 头缺失/非法 → 回落 peer（即 ARR 自己）。绝不回落到 XFF。
  return peer;
}

function parseTtl(ttl: string): number {
  const m = /^(\d+)([mhd])$/.exec(ttl);
  if (!m) return 7 * 24 * 3600 * 1000;
  const n = Number(m[1]);
  return m[2] === 'm' ? n * 60_000 : m[2] === 'h' ? n * 3600_000 : n * 24 * 3600_000;
}
