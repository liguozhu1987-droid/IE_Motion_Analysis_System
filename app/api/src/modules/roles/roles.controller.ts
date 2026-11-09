import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { IsArray, ArrayMinSize, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { RolesService } from './roles.service';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { AuthedRequest } from '../../auth/auth-user.interface';

/** 每个字段必须带装饰器：全局 ValidationPipe(whitelist:true) 会剥离无装饰器属性 */
class CreateRoleDto {
  @IsString() @Matches(/^[a-z][a-z0-9_]{1,23}$/, { message: '角色 code 须为 2-24 位小写字母开头、仅含字母数字下划线' })
  code!: string;
  @IsString() @MaxLength(32) name!: string;
  @IsString() @IsOptional() @MaxLength(128) description?: string;
  @IsArray() @IsString({ each: true }) permissions!: string[];
  /** v3.58：从既有角色复制权限（给出则以该角色权限为底稿，避免逐项勾选漏项） */
  @IsString() @IsOptional() @MaxLength(32) sourceRoleId?: string;
}

class RenameRoleDto {
  @IsString() @IsOptional() @MaxLength(32) name?: string;
  @IsString() @IsOptional() @MaxLength(128) description?: string;
}

class SetPermsDto {
  @IsArray() @IsString({ each: true }) permissions!: string[];
}

/** v3.58 角色侧增删成员（人员↔角色双向授权） */
class MembersDto {
  @IsArray() @ArrayMinSize(1) @IsString({ each: true }) userIds!: string[];
}

class AuditQueryDto {
  @IsOptional() @IsIn(['rbac', 'user', 'station', 'element', 'improvement']) entity?: string;
  /** v3.58：按动作 / 操作人 / 对象精确追溯（如「谁改过这个角色」） */
  @IsOptional() @IsString() @MaxLength(32) action?: string;
  @IsOptional() @IsString() @MaxLength(32) operator?: string;
  @IsOptional() @IsString() @MaxLength(36) entityId?: string;
  /** 查询串是字符串：必须显式 @Type(() => Number)，否则 @IsInt 一律 400 */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

/**
 * 角色与权限管理（v3.50）：
 * 查看 role:read（sys_admin / ie_admin）；增删改 role:write（sys_admin）；审计 audit:read。
 */
@Controller('admin')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get('roles')
  @RequirePermission('role:read')
  async list() {
    return this.roles.list();
  }

  /** 权限点字典（按模块分组）——前端权限矩阵的数据源 */
  @Get('permissions')
  @RequirePermission('role:read')
  async permissions() {
    return this.roles.permissions();
  }

  /** 权限变更审计（谁改了什么、改前改后） */
  @Get('audit')
  @RequirePermission('audit:read')
  async auditLogs(@Query() query: AuditQueryDto) {
    return this.roles.auditLogs(query);
  }

  @Get('roles/:id')
  @RequirePermission('role:read')
  async getById(@Param('id') id: string) {
    return this.roles.getById(id);
  }

  /** v3.58 角色成员清单（角色侧看「谁有这个角色」） */
  @Get('roles/:id/members')
  @RequirePermission('role:read')
  async members(@Param('id') id: string) {
    return this.roles.members(id);
  }

  /** v3.58 角色侧加入成员（追加，不动该用户原有其他角色） */
  @Post('roles/:id/members')
  @HttpCode(200)
  @RequirePermission('role:write')
  async addMembers(@Param('id') id: string, @Body() dto: MembersDto, @Req() req: AuthedRequest) {
    return this.roles.addMembers(id, dto.userIds, req);
  }

  /** v3.58 角色侧移除成员（防锁死：不允许摘掉系统最后一名管理员） */
  @Post('roles/:id/members/remove')
  @HttpCode(200)
  @RequirePermission('role:write')
  async removeMembers(@Param('id') id: string, @Body() dto: MembersDto, @Req() req: AuthedRequest) {
    return this.roles.removeMembers(id, dto.userIds, req);
  }

  @Post('roles')
  @HttpCode(200)
  @RequirePermission('role:write')
  async create(@Body() dto: CreateRoleDto, @Req() req: AuthedRequest) {
    return this.roles.create(dto, req);
  }

  @Patch('roles/:id')
  @RequirePermission('role:write')
  async rename(@Param('id') id: string, @Body() dto: RenameRoleDto, @Req() req: AuthedRequest) {
    return this.roles.rename(id, dto, req);
  }

  /** 权限全量替换（勾选矩阵即全量提交；sys_admin 的 RBAC 权限锁定不可摘除） */
  @Put('roles/:id/permissions')
  @RequirePermission('role:write')
  async setPermissions(@Param('id') id: string, @Body() dto: SetPermsDto, @Req() req: AuthedRequest) {
    return this.roles.setPermissions(id, dto.permissions, req);
  }

  /** 删除自定义角色（系统角色不可删；有成员不可删） */
  @Delete('roles/:id')
  @RequirePermission('role:write')
  async remove(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.roles.remove(id, req);
  }
}
