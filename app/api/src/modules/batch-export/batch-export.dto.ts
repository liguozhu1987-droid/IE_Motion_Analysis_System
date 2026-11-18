import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

/**
 * GET /api/export/batch.xlsx 查询参数。
 * 全局 ValidationPipe(whitelist:true) 会剥离无装饰器字段 —— 每个入参必须有装饰器。
 * 0/1 开关用字符串而非 boolean：query 原始值恒为 string，class-transformer 对
 * boolean 的隐式转换在两种方言下行为不一致，显式 '0'|'1' 更可审计。
 */
export class BatchExportQueryDto {
  /** 产线编码：Phase 2 起降级为任务下拉的筛选器（仍必填，用于校验任务归属与向后兼容） */
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  line_id!: string;

  /** Phase 2：分解任务 ID；指定时一个工作簿 = 一个任务，只取任务锁定的 bol_version。
   *  省略 = 按产线的兼容模式（v3.61/62 契约依赖此路径），封面如实标注。 */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  task_id?: string;

  /** 逗号分隔的工位编码白名单；省略 = 该产线全部可见工位（后端仍会做可见性过滤） */
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  stations?: string;

  /** 全任务焦点上限（20/30/50），每工位固定 Top5 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(100)
  focus_top?: number = 30;

  /** 03/02 表是否列出异常要素（异常要素恒不计入任何合计） */
  @IsOptional()
  @Matches(/^[01]$/)
  include_outliers?: string = '0';

  /** 01 表是否列出未分解工位（0 要素） */
  @IsOptional()
  @Matches(/^[01]$/)
  include_undecomposed?: string = '0';

  /** 是否生成 04_动作分析（无 analysis:read 权限时后端强制关闭） */
  @IsOptional()
  @Matches(/^[01]$/)
  with_focus?: string = '1';
}

export const flagOf = (v: string | undefined, fallback: boolean): boolean =>
  v === undefined ? fallback : v === '1';
