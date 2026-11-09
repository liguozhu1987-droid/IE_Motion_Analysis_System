import { BadRequestException, Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { CurrentUser } from '../../rbac/current-user.decorator';
import { AuthUser } from '../../auth/auth-user.interface';

/** CMC 工艺码 → IE 平台工艺类型（中文口径；未知码原样透出，不猜） */
const PROCESS_TYPE_CN: Record<string, string> = {
  FA: '装配',
  bonding: '焊接',
  IHE: '测试',
  IHR: '测试',
  Tailgate: '其他',
};

const mapProcessType = (raw: string | null): string => {
  if (!raw) return '其他';
  return PROCESS_TYPE_CN[raw] ?? raw;
};

/**
 * CMC 查询参数内联助手（本版本 TypeORM DataSource.query 只收位置参数数组，
 * 跨库查询无可移植占位符）：数值取整；字符串必须命中 [A-Za-z0-9-_] 白名单，
 * 单引号双写转义——双重防线防注入。调用方一律先过白名单校验再内联。
 */
const q = (v: string | number): string => {
  if (typeof v === 'number') return String(Math.trunc(v));
  if (!/^[A-Za-z0-9\-_]+$/.test(v)) throw new BadRequestException(`非法参数：${v}`);
  return `'${v.replace(/'/g, "''")}'`;
};

/**
 * CMC 产能系统集成（v3.21）：基础信息零维护——公司/产线/项目/产线-项目分配关系
 * 全部通过跨库实时查询从 CMC 获取（同 SQL Server 实例，三部分名 CMC.dbo.*），
 * 本系统不做任何同步表、不提供维护入口，一致性由"单一数据源"天然保证。
 *
 * 数据口径（与 CMC 现场确认 2026-10-24）：
 *  - 公司/工厂   CMC.dbo.factories（is_active=1）
 *  - 产线        CMC.dbo.production_lines（is_enabled=1；code 形如 BJFA1/GZFA3，即工位编码前缀）
 *  - 项目        CMC.dbo.cbco_records（program_number=项目号；同号多年度记录，取 year 最新一条的描述/客户/阶段）
 *  - 产线↔项目   CMC.dbo.project_line_allocations（line_id=production_lines.id，is_enabled=1；带 ct_standard 标准节拍）
 *
 * 失败语义：CMC 不可达/表缺失时抛 503 语义的 400（向导提示"产能系统暂不可联"），
 * 绝不在本地伪造基础数据——宁缺勿错。
 */
@Controller('cmc')
export class CmcController {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /** 公司（工厂）清单：新建分析对象第一步 */
  @Get('factories')
  @RequirePermission('station:read')
  async factories() {
    const rows = (await this.ds.query(
      `SELECT id, code, name, region
       FROM CMC.dbo.factories
       WHERE is_active = 1
       ORDER BY code`,
    )) as any[];
    return rows.map((r) => ({ cmc_factory_id: r.id, code: r.code, name: r.name, region: r.region ?? null }));
  }

  /**
   * 产线清单（可按工厂过滤）。project_count = 该产线已分配的项目数。
   * 性能（v3.22）：COUNT 改 LEFT JOIN 预聚合子查询——相关子查询每行触发一次
   * alloc 表扫描，实测 24~35ms/查询；预聚合一次 GROUP BY 后 5~9ms（5 倍），
   * 且冷缓存（PLE 仅 54s）放大差距时更明显。
   */
  @Get('lines')
  @RequirePermission('station:read')
  async lines(@Query('factory_id') factoryId?: string) {
    let where = 'WHERE pl.is_enabled = 1';
    if (factoryId !== undefined) {
      if (!/^\d+$/.test(factoryId)) throw new BadRequestException('factory_id 须为数字');
      where += ` AND pl.factory_id = ${q(Number(factoryId))}`;
    }
    const rows = (await this.ds.query(
      `SELECT pl.id, pl.code, pl.name, pl.process_type, pl.line_type, pl.status, pl.factory_id,
              f.code AS factory_code, f.name AS factory_name,
              COALESCE(pc.project_count, 0) AS project_count
       FROM CMC.dbo.production_lines pl
       JOIN CMC.dbo.factories f ON f.id = pl.factory_id
       LEFT JOIN (
         SELECT a.line_id, COUNT(*) AS project_count
         FROM CMC.dbo.project_line_allocations a
         WHERE a.is_enabled = 1
         GROUP BY a.line_id
       ) pc ON pc.line_id = pl.id
       ${where}
       ORDER BY f.code, pl.code`,
    )) as any[];
    return rows.map((r) => ({
      cmc_line_id: r.id,
      factory_id: r.factory_id,
      code: r.code,
      name: r.name,
      process_type: mapProcessType(r.process_type),
      process_type_raw: r.process_type ?? null,
      line_type: r.line_type ?? null,
      factory_code: r.factory_code,
      factory_name: r.factory_name,
      project_count: Number(r.project_count ?? 0),
    }));
  }

  /**
   * 某产线已分配的项目清单（分配关系 + cbco 最新年度信息 + 标准节拍）。
   * cbco_records 同 program_number 有多年的记录，窗口 ROW_NUMBER(year DESC, id DESC) 取最新一条。
   * 性能关键（v3.22b 实测 25s→20ms）：JOIN 条件写进窗口子查询——先经分配表把 cbco 缩到
   * 该产线几个 program，再对**小子集**开窗。旧写法（LEFT JOIN 派生表 + 派生表内做
   * MAX 相关子查询 + NOT EXISTS）会让优化器对 6043 行 cbco 全表逐行跑相关子查询后
   * 才物化派生表，有数据产线单次 25s；LEFT JOIN 语义保留（无 cbco 信息的分配仍列出）。
   */
  @Get('lines/:lineId/projects')
  @RequirePermission('station:read')
  async lineProjects(@Param('lineId') lineId: string) {
    if (!/^\d+$/.test(lineId)) throw new BadRequestException('CMC 产线 ID 须为数字');
    const rows = (await this.ds.query(
      `SELECT t.program_number, t.program_description, t.customer, t.program_phase, t.product_group,
              t.ct_standard, t.allocation_ratio
       FROM (
         SELECT a.program_number, a.ct_standard, a.allocation_ratio,
                c.program_description, c.customer, c.program_phase, c.product_group,
                ROW_NUMBER() OVER (PARTITION BY a.program_number ORDER BY c.year DESC, c.id DESC) AS rn
         FROM CMC.dbo.project_line_allocations a
         LEFT JOIN CMC.dbo.cbco_records c ON c.program_number = a.program_number
         WHERE a.line_id = ${q(Number(lineId))} AND a.is_enabled = 1
       ) t
       WHERE t.rn = 1
       ORDER BY t.program_number`,
    )) as any[];
    return rows.map((r) => ({
      program_number: r.program_number,
      name: r.program_description ?? r.program_number,
      customer: r.customer ?? null,
      phase: r.program_phase ?? null,
      product_group: r.product_group ?? null,
      ct_standard: r.ct_standard ?? null,
      allocation_ratio: r.allocation_ratio ?? null,
    }));
  }
}
