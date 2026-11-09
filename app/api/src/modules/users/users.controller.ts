import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ArrayMinSize, IsArray, IsEmail, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { UsersService } from './users.service';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { SkipAudit } from '../../audit/skip-audit.decorator';
import { AuthedRequest } from '../../auth/auth-user.interface';

/** 每个字段必须带装饰器：全局 ValidationPipe(whitelist:true) 会剥离无装饰器属性 */
class UserQueryDto {
  @IsOptional() @IsIn(['active', 'pending', 'rejected', 'locked', 'disabled']) status?: string;
  @IsOptional() @IsString() @MaxLength(64) keyword?: string;
  /** v3.50：按部门筛选（组织维度） */
  @IsOptional() @IsString() @MaxLength(64) department?: string;
  /** v3.58：按角色筛选（"谁有这个角色"）+ 按资质状态筛选（资质台账） */
  @IsOptional() @IsString() @MaxLength(32) role?: string;
  @IsOptional() @IsIn(['none', 'valid', 'expiring', 'expired']) certStatus?: string;
}

class CreateUserDto {
  @IsString() @Matches(/^[a-zA-Z0-9_.-]{3,32}$/, { message: '用户名须为 3-32 位字母、数字、._- 组合' }) username!: string;
  @IsString() @MinLength(8) password!: string;
  @IsString() @IsOptional() @MaxLength(32) displayName?: string;
  @IsEmail() @IsOptional() @MaxLength(128) email?: string;
  @IsArray() @ArrayMinSize(1) @IsString({ each: true }) roles!: string[];
  // v3.50 人员档案 + 数据范围 + 方法资质
  @IsString() @IsOptional() @MaxLength(64) department?: string;
  @IsString() @IsOptional() @MaxLength(64) position?: string;
  @IsString() @IsOptional() @MaxLength(32) employeeNo?: string;
  @IsOptional() @IsIn(['own', 'line', 'tenant', 'all']) dataScope?: string;
  @IsOptional() @IsIn(['none', 'L1', 'L2', 'L3']) certLevel?: string;
  @IsString() @IsOptional() @MaxLength(32) certExpiresAt?: string;
}

class UpdateUserDto {
  @IsString() @IsOptional() @MaxLength(32) displayName?: string;
  @IsEmail() @IsOptional() @MaxLength(128) email?: string;
  @IsOptional() @IsIn(['active', 'disabled']) status?: string;
  /**
   * v3.58：停用「当前登录管理员本人」的显式确认位。
   * 未带此位会被拒绝——避免管理员一键把自己锁在门外。
   */
  @IsOptional() @IsIn(['true', 'false']) confirmSelf?: string;
  // v3.50 人员档案 + 数据范围 + 方法资质（与建号同构）
  @IsString() @IsOptional() @MaxLength(64) department?: string;
  @IsString() @IsOptional() @MaxLength(64) position?: string;
  @IsString() @IsOptional() @MaxLength(32) employeeNo?: string;
  @IsOptional() @IsIn(['own', 'line', 'tenant', 'all']) dataScope?: string;
  @IsOptional() @IsIn(['none', 'L1', 'L2', 'L3']) certLevel?: string;
  @IsString() @IsOptional() @MaxLength(32) certExpiresAt?: string;
}

class SetRolesDto {
  @IsArray() @ArrayMinSize(1) @IsString({ each: true }) roles!: string[];
}

/** v3.50 批量授权：一次给多名用户改角色 */
class BulkRolesDto {
  @IsArray() @ArrayMinSize(1) @IsString({ each: true }) userIds!: string[];
  @IsArray() @ArrayMinSize(1) @IsString({ each: true }) roles!: string[];
  @IsOptional() @IsIn(['replace', 'merge']) mode?: string;
}

class RejectDto {
  @IsString() @IsOptional() @MaxLength(200) reason?: string;
}

/** v3.58 按部门批量授权（组织维度：部门整体调岗 / 新线开线） */
class BulkByDepartmentDto {
  @IsString() @MaxLength(64) department!: string;
  @IsArray() @ArrayMinSize(1) @IsString({ each: true }) roles!: string[];
  @IsOptional() @IsIn(['replace', 'merge']) mode?: string;
}

/**
 * 用户管理（sys_admin）：列表/详情 user:read；建号/改资料/角色/审批/停启用/代重置/下发码 user:write。
 * 管理范围为 DEFAULT 租户用户。
 */
@Controller('admin')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('users')
  @RequirePermission('user:read')
  async list(@Query() query: UserQueryDto) {
    return this.users.list(query);
  }

  @Get('users/:id')
  @RequirePermission('user:read')
  async getById(@Param('id') id: string) {
    return this.users.getById(id);
  }

  /** 生效权限：该账号按角色展开后实际拥有的权限点（授权前的"能干什么"核查） */
  @Get('users/:id/permissions')
  @RequirePermission('user:read')
  async effectivePermissions(@Param('id') id: string) {
    return this.users.effectivePermissions(id);
  }

  /** 批量授权：组织调整/新线开线时一次给多人改角色（replace 全量替换 / merge 追加） */
  @Post('users/bulk-roles')
  @HttpCode(200)
  @RequirePermission('user:write')
  async bulkSetRoles(@Body() dto: BulkRolesDto, @Req() req: AuthedRequest) {
    return this.users.bulkSetRoles(dto.userIds, dto.roles, (dto.mode as 'replace' | 'merge') ?? 'replace', req);
  }

  /** v3.58 按部门批量授权：以组织维度整体调岗（避免逐个勾选漏人） */
  @Post('users/bulk-by-department')
  @HttpCode(200)
  @RequirePermission('user:write')
  async bulkByDepartment(@Body() dto: BulkByDepartmentDto, @Req() req: AuthedRequest) {
    return this.users.bulkSetRolesByDepartment(
      dto.department, dto.roles, (dto.mode as 'replace' | 'merge') ?? 'replace', req,
    );
  }

  @Post('users')
  @HttpCode(200)
  @RequirePermission('user:write')
  async create(@Body() dto: CreateUserDto, @Req() req: AuthedRequest) {
    return this.users.create(dto, req);
  }

  @Patch('users/:id')
  @RequirePermission('user:write')
  async update(@Param('id') id: string, @Body() dto: UpdateUserDto, @Req() req: AuthedRequest) {
    return this.users.update(id, { ...dto, confirmSelf: dto.confirmSelf === 'true' }, req);
  }

  @Put('users/:id/roles')
  @RequirePermission('user:write')
  async setRoles(@Param('id') id: string, @Body() dto: SetRolesDto, @Req() req: AuthedRequest) {
    return this.users.setRoles(id, dto.roles, req);
  }

  /** 审批通过：pending → active 并赋予角色 */
  @Post('users/:id/approve')
  @HttpCode(200)
  @RequirePermission('user:write')
  async approve(@Param('id') id: string, @Body() dto: SetRolesDto, @Req() req: AuthedRequest) {
    return this.users.approve(id, dto.roles, req);
  }

  /** 审批驳回：pending → rejected */
  @Post('users/:id/reject')
  @HttpCode(200)
  @RequirePermission('user:write')
  async reject(@Param('id') id: string, @Body() dto: RejectDto, @Req() req: AuthedRequest) {
    return this.users.reject(id, dto.reason, req);
  }

  /**
   * 代置临时口令：一次性返回明文，下次登录强制改密。
   * @SkipAudit：响应体含明文口令，禁止进审计响应快照；本动作由 users.service 自行留痕。
   */
  @Post('users/:id/reset-password')
  @HttpCode(200)
  @SkipAudit()
  @RequirePermission('user:write')
  async resetPassword(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.users.resetPassword(id, req);
  }

  /** 下发重置码：一次性返回 6 位明文码（30 分钟有效），由管理员线下告知用户 */
  @Post('users/:id/issue-reset-code')
  @HttpCode(200)
  @SkipAudit()
  @RequirePermission('user:write')
  async issueResetCode(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.users.issueResetCode(id, req);
  }

  /** 重置申请列表（helpdesk 视图：谁在申请、申请时间、过期时间；不含明文码） */
  @Get('password-resets')
  @RequirePermission('user:read')
  async listResetRequests() {
    return this.users.listResetRequests();
  }
}
