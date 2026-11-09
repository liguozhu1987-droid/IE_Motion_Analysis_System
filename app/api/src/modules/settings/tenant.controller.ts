import { Body, Controller, Get, NotFoundException, Patch } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { CurrentUser } from '../../rbac/current-user.decorator';
import { AuthUser } from '../../auth/auth-user.interface';
import { Tenant } from '../../entities/tenant.entity';

/**
 * 公司（租户）信息维护（v3.21 主数据维护页）。
 * 背景：新建分析对象向导的"工厂"一档此前只读展示，用户找不到地方维护公司名称与区域——
 * 租户表原先只由种子脚本写入，无任何读写接口。
 * 口径：名称/区域均为展示维度（驾驶舱按 region 汇总），不影响任何业务主键。
 * 权限：读 = station:read（导航就要显示公司名）；写 = settings:benefit-write（仅管理员，
 * 与设置中心其他"写"操作同档——改公司名影响全租户展示，不给工程师放权）。
 */
class PatchTenantDto {
  @IsOptional() @IsString() @MaxLength(64) name?: string;
  @IsOptional() @IsString() @MaxLength(32) region?: string;
}

@Controller('tenant')
export class TenantController {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  @Get()
  @RequirePermission('station:read')
  async get(@CurrentUser() user: AuthUser) {
    const row = (await this.ds.getRepository(Tenant).findOneBy({ tenant_id: user.tenantId } as any)) as any;
    if (!row) throw new NotFoundException(`租户 ${user.tenantId} 不存在`);
    return { tenant_id: row.tenant_id, code: row.code, name: row.name, region: row.region, status: row.status };
  }

  @Patch()
  @RequirePermission('settings:benefit-write')
  async patch(@Body() dto: PatchTenantDto, @CurrentUser() user: AuthUser) {
    const repo = this.ds.getRepository(Tenant);
    const row = (await repo.findOneBy({ tenant_id: user.tenantId } as any)) as any;
    if (!row) throw new NotFoundException(`租户 ${user.tenantId} 不存在`);
    const next: any = { ...row };
    if (dto.name !== undefined) next.name = dto.name.trim() || row.name;
    if (dto.region !== undefined) next.region = dto.region.trim() || row.region;
    await repo.save(next as any);
    return { tenant_id: row.tenant_id, name: next.name, region: next.region };
  }
}
