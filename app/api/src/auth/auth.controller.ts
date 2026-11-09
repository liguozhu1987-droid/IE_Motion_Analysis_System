import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { IsEmail, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
import { Public } from '../rbac/public.decorator';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { AuthedRequest } from './auth-user.interface';
import { hasFullAccess } from '../rbac/full-access';

/** 每个字段必须带装饰器：全局 ValidationPipe(whitelist:true) 会剥离无装饰器属性 */
class LoginDto {
  @IsString() @IsNotEmpty() username!: string;
  @IsString() @IsNotEmpty() password!: string;
}

class RefreshDto {
  @IsString() @IsNotEmpty() refreshToken!: string;
}

class ChangePwdDto {
  @IsString() @IsNotEmpty() oldPassword!: string;
  @IsString() @MinLength(8) newPassword!: string;
}

class RegisterDto {
  @IsString() @Matches(/^[a-zA-Z0-9_.-]{3,32}$/, { message: '用户名须为 3-32 位字母、数字、._- 组合' }) username!: string;
  @IsString() @MinLength(8) password!: string;
  @IsString() @IsOptional() @MaxLength(32) displayName?: string;
  @IsEmail() @IsOptional() @MaxLength(128) email?: string;
}

class ForgotPwdDto {
  @IsString() @IsNotEmpty() @MaxLength(64) username!: string;
}

class ResetPwdDto {
  @IsString() @IsNotEmpty() @MaxLength(64) username!: string;
  @IsString() @Matches(/^\d{6}$/, { message: '重置码须为 6 位数字' }) code!: string;
  @IsString() @MinLength(8) newPassword!: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() req: AuthedRequest) {
    const pair = await this.auth.login(dto.username, dto.password, req);
    return { ...pair, tokenType: 'Bearer', expiresIn: 900 };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() dto: RefreshDto, @Req() req: AuthedRequest) {
    return this.auth.refresh(dto.refreshToken, req);
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  async logout(@Body() dto: RefreshDto) {
    await this.auth.logout(dto.refreshToken);
    return { ok: true };
  }

  /** 自助注册：进入 pending 待审批态，管理员审批赋角色后生效（限流 3 次/小时/IP） */
  @Public()
  @Post('register')
  @HttpCode(200)
  async register(@Body() dto: RegisterDto, @Req() req: AuthedRequest) {
    return this.auth.register(dto, req);
  }

  /** 忘记密码（helpdesk 模式）：通用应答；重置码由管理员人工送达（限流 5 次/小时/IP） */
  @Public()
  @Post('forgot-password')
  @HttpCode(200)
  async forgotPassword(@Body() dto: ForgotPwdDto, @Req() req: AuthedRequest) {
    return this.auth.forgotPassword(dto.username, req);
  }

  /** 重置密码：用户名 + 6 位码 + 新密码；成功后全部会话吊销（限流 10 次/小时/IP） */
  @Public()
  @Post('reset-password')
  @HttpCode(200)
  async resetPassword(@Body() dto: ResetPwdDto, @Req() req: AuthedRequest) {
    return this.auth.resetPassword(dto.username, dto.code, dto.newPassword, req);
  }

  /** 当前登录用户信息（前端启动时拉取，用于权限渲染） */
  @Get('me')
  @RequirePermission('auth:self')
  me(@Req() req: AuthedRequest) {
    const u = req.user!;
    return {
      userId: u.userId, username: u.username, displayName: u.displayName,
      tenantId: u.tenantId, roles: u.roles, permissions: [...u.permissions],
      mustChangePwd: u.mustChangePwd,
      /* v3.56：行级数据可见范围下发前端——顶栏「权限」浮层据此展示用户能看到多大范围。
         只读展示用，不参与任何前端判定（判定一律由服务端 assertReadable / visibleStationIds 执行）。 */
      dataScope: u.dataScope,
      /* 全权角色（sys_admin/ie_admin）不看 data_scope，实际可见范围为全租户——
         下发给前端仅用于展示「我到底能看到多大范围」，避免管理员被显示成「仅本人」。
         单一数据源：rbac/full-access.ts */
      fullAccess: hasFullAccess(u.roles),
      /* v3.57 统一身份认证增量字段（向后兼容：旧前端忽略未知字段即可） */
      authSource: req.authSource ?? u.authSource ?? 'local',
      ssoEmployeeNo: u.employeeNo ?? null,
    };
  }

  @Post('change-password')
  @HttpCode(200)
  @RequirePermission('auth:self')
  async changePwd(@Body() dto: ChangePwdDto, @Req() req: AuthedRequest) {
    await this.auth.changePassword(req.user!.userId, dto.oldPassword, dto.newPassword);
    return { ok: true };
  }
}
