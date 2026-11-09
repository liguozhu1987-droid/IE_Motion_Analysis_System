import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { CurrentUser } from '../../rbac/current-user.decorator';
import { AuthUser } from '../../auth/auth-user.interface';
import { Project } from '../../entities/project.entity';

/** 项目编号：字母/数字/短横，如 P-2026-007（2~32 位；兼容客户自有编码规则） */
class CreateProjectDto {
  @IsString() @Matches(/^[A-Za-z0-9][A-Za-z0-9-]{1,31}$/, { message: '项目编号仅允许字母/数字/短横（2~32 位），如 P-2026-007' })
  project_id!: string;
  @IsString() @MaxLength(64) name!: string;
  @IsOptional() @IsString() @MaxLength(64) customer?: string;
  @IsOptional() @IsIn(['NPI', '量产', '结项']) stage?: string;
}

/** 项目维护（v3.21 主数据维护页）：编号不可改（产线关联以编号为键），名称/客户/阶段可改 */
class PatchProjectDto {
  @IsOptional() @IsString() @MaxLength(64) name?: string;
  @IsOptional() @IsString() @MaxLength(64) customer?: string;
  @IsOptional() @IsIn(['NPI', '量产', '结项']) stage?: string;
}

/**
 * 项目主数据（v3.7）：新建分析对象向导的项目下拉数据源。
 * 现阶段允许在向导内直接新建（后续可改为仅导入标准化清单）。
 * 读写权限沿用 station:read / station:write——项目是建工位的前置主数据，不需要额外权限点。
 */
@Controller('projects')
export class ProjectsController {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  @Get()
  @RequirePermission('station:read')
  async list(@CurrentUser() user: AuthUser) {
    const rows = (await this.ds.getRepository(Project).find({
      where: { tenant_id: user.tenantId, status: 'active' } as any,
      order: { project_id: 'ASC' } as any,
    })) as any[];
    return rows.map((r) => ({
      project_id: r.project_id, name: r.name, customer: r.customer, stage: r.stage,
    }));
  }

  @Post()
  @RequirePermission('station:write')
  async create(@Body() dto: CreateProjectDto, @CurrentUser() user: AuthUser) {
    const repo = this.ds.getRepository(Project);
    const exists = await repo.countBy({ tenant_id: user.tenantId, project_id: dto.project_id } as any);
    if (exists > 0) {
      // 幂等：已存在直接返回，向导可继续使用
      const row = (await repo.findOneBy({ tenant_id: user.tenantId, project_id: dto.project_id } as any)) as any;
      return { project_id: row.project_id, name: row.name, customer: row.customer, stage: row.stage, existed: true };
    }
    const row = repo.create({
      tenant_id: user.tenantId,
      project_id: dto.project_id,
      name: dto.name,
      customer: dto.customer ?? '',
      stage: dto.stage ?? '量产',
      status: 'active',
    } as any);
    await repo.save(row as any);
    return { project_id: dto.project_id, name: dto.name, customer: dto.customer ?? '', stage: dto.stage ?? '量产', existed: false };
  }

  /** 修改项目属性（编号即关联键不可改；维护页行内编辑） */
  @Patch(':projectId')
  @RequirePermission('station:write')
  async patch(@Param('projectId') projectId: string, @Body() dto: PatchProjectDto, @CurrentUser() user: AuthUser) {
    const repo = this.ds.getRepository(Project);
    const row = (await repo.findOneBy({ tenant_id: user.tenantId, project_id: projectId } as any)) as any;
    if (!row) throw new NotFoundException(`项目 ${projectId} 不存在`);
    const next: any = { ...row };
    if (dto.name !== undefined) next.name = dto.name.trim();
    if (dto.customer !== undefined) next.customer = dto.customer.trim();
    if (dto.stage !== undefined) next.stage = dto.stage;
    await repo.save(next as any);
    return { project_id: projectId, name: next.name, customer: next.customer, stage: next.stage };
  }

  /**
   * 删除项目（v3.21 主数据维护）：软删除 status=inactive，列表接口只返 active。
   * 护栏：仍被产线关联时拒绝——t_line.product_project 存的是项目编号，先解除产线关联再删，
   * 否则向导下拉会出现"悬空项目"。
   */
  @Delete(':projectId')
  @RequirePermission('station:write')
  async remove(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser) {
    const repo = this.ds.getRepository(Project);
    const row = (await repo.findOneBy({ tenant_id: user.tenantId, project_id: projectId } as any)) as any;
    if (!row) throw new NotFoundException(`项目 ${projectId} 不存在`);
    const refs = (await this.ds.getRepository('t_line').find({
      where: { tenant_id: user.tenantId, product_project: projectId } as any,
    })) as any[];
    if (refs.length > 0) {
      throw new BadRequestException(`项目 ${projectId} 仍被 ${refs.length} 条产线关联（${refs.map((r) => r.line_id).join('、')}），请先在产线维护中解除关联再删除`);
    }
    await repo.update({ tenant_id: user.tenantId, project_id: projectId } as any, { status: 'inactive' } as any);
    return { project_id: projectId, deleted: true };
  }
}
