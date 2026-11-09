import { Type } from 'class-transformer';
import { IsArray, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';

/**
 * 要素提交 DTO。
 * 设计口径：DTO 只把关「形状」（数组/数字/字符串），业务规则全部交给
 * validateSubmission 产出 V1/V2/V3 编码错误——与 MVP 前端契约逐字一致。
 * 每个字段都必须带装饰器：全局 ValidationPipe(whitelist:true) 会剥离无装饰器属性。
 */
export class ElementItemDto {
  @IsOptional() @IsNumber() seq?: number;
  @IsNumber() start_ms!: number;
  @IsNumber() dur_s!: number;
  @IsOptional() @IsString() hand?: string;
  @IsOptional() @IsString() type?: string;
  @IsOptional() @IsString() desc?: string;
  @IsOptional() @IsString() va_class?: string;
  @IsOptional() @IsNumber() outlier_flag?: number;
  @IsOptional() @IsString() outlier_reason?: string;
  @IsOptional() @IsNumber() rating?: number;
  @IsOptional() @IsNumber() allowance?: number;
  /** 来源：manual（默认）/ ai_assisted（AI 切分接受）。逐条透传，统计采纳率 */
  @IsOptional() @IsString() source?: 'manual' | 'ai_assisted';
}

export class SubmitElementsDto {
  /** 写守卫：必须等于工位当前 version（封存版本只读），缺省视为当前版本 */
  @IsOptional() @IsNumber() bol_version?: number;
  /** 有效循环数（V3 规则的服务端裁决字段，缺失由 V3 报"不足15个"，与 MVP 口径一致） */
  @IsOptional() @IsNumber() cycle_count?: number;
  @IsOptional() @IsNumber() cv?: number;
  @IsOptional() @IsString() video_id?: string;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ElementItemDto)
  elements!: ElementItemDto[];
}

export class ImportCsvDto {
  @IsString() csv!: string;
}

export class UpdateVaClassDto {
  @IsString() va_class!: string;
  @IsString() reason!: string;
}

export class ConfirmVaClassDto {
  @IsOptional() @IsString() va_class?: string;
}
