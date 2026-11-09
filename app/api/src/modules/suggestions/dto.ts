import { Type } from 'class-transformer';
import { IsArray, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';

/**
 * 建议模块 DTO。设计口径与 elements 一致：DTO 只把关「形状」，
 * 业务规则（红线/三态流转）在 Service 层裁决并抛编码错误。
 * 每个字段都必须带装饰器：全局 ValidationPipe(whitelist:true) 会剥离无装饰器属性。
 */

/** 采纳的候选建议（来自 generate 响应，前端勾选后回传；数值字段信服务端重算口径） */
export class CandidateItemDto {
  @IsOptional() @IsString() mapping_id?: string | null;
  @IsString() waste_type!: string;
  @IsString() method!: string;
  @IsString() measure!: string;
  @IsOptional() @IsArray() @IsString({ each: true }) element_ids?: string[];
  @IsOptional() @IsString() evidence?: string;
  @IsNumber() est_save_s!: number;
  @IsOptional() @IsNumber() difficulty?: number;
  @IsOptional() @IsString() note?: string | null;
  @IsOptional() @IsNumber() priority?: number;
  @IsOptional() @IsString() owner?: string;
  @IsOptional() @IsString() due?: string;
}

/** 红线确认（填确认人+日期；name 缺失时前端必须拦截，服务端兜底按空串留痕） */
export class RedlineConfirmDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() date?: string;
}

export class AdoptConfirmationsDto {
  @IsOptional() @ValidateNested() @Type(() => RedlineConfirmDto) quality?: RedlineConfirmDto;
  @IsOptional() @ValidateNested() @Type(() => RedlineConfirmDto) ergonomics?: RedlineConfirmDto;
}

export class AdoptCandidatesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CandidateItemDto)
  candidates!: CandidateItemDto[];
  @IsOptional()
  @ValidateNested()
  @Type(() => AdoptConfirmationsDto)
  confirmations?: AdoptConfirmationsDto;
}

/** 三态流转：待实施→已完成→已验证 */
export class UpdateStatusDto {
  @IsString() status!: string;
}

/** 建议清单查询过滤（MVP listImprovements(ctx.query) 平移 + v3.3 维度扩展）。
 *  process/product_type 经工位→产线元数据内存过滤；project_type 直查 t_improvement 列。 */
export interface ImprovementQuery {
  station_id?: string;
  status?: string;
  line_id?: string;
  project_type?: string;
  process?: string;
  product_type?: string;
}
