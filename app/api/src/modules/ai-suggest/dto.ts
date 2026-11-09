import { Type } from 'class-transformer';
import {
  IsArray, IsBoolean, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID,
  Length, Matches, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';

/**
 * AI 建议模块 DTO（规格书 §4）。
 * 纪律：每个字段必须带装饰器——全局 ValidationPipe(whitelist:true) 会剥离无装饰器属性。
 * 业务规则（红线/幂等/配额）在 Service 层裁决并抛编码错误。
 */

/** 红线确认（复用现有 suggestions 语义：确认人+日期） */
export class RedlineConfirmDto {
  @IsOptional() @IsString() @Length(1, 32) name?: string;
  @IsOptional() @IsString() @Length(1, 32) date?: string;
}

export class AdoptConfirmationsDto {
  @IsOptional() @ValidateNested() @Type(() => RedlineConfirmDto) quality?: RedlineConfirmDto;
  @IsOptional() @ValidateNested() @Type(() => RedlineConfirmDto) ergonomics?: RedlineConfirmDto;
}

/** 采纳 AI 建议 */
export class AdoptAiSuggestionDto {
  @IsOptional() @ValidateNested() @Type(() => AdoptConfirmationsDto) confirmations?: AdoptConfirmationsDto;
}

/** 否决 AI 建议（理由可选，仅留审计） */
export class RejectAiSuggestionDto {
  @IsOptional() @IsString() @Length(0, 256) reason?: string;
}

/** 自定义字典创建（规格书 §4：code 正则/name≤16/waste_type 必填 va_class/measure_type 必填 method_hint+action_class） */
export class CreateDictDto {
  @IsIn(['waste_type', 'measure_type']) dict_type!: string;
  @IsString() @Matches(/^[a-z][a-z0-9_]{2,31}$/, { message: 'code 须为小写字母开头的 3~32 位 [a-z0-9_]' }) code!: string;
  @IsString() @IsNotEmpty() @Length(1, 16) name!: string;
  @IsOptional() @IsIn(['VA', 'RNVA', 'NVA']) va_class?: string;
  @IsOptional() @IsIn(['E', 'C', 'R', 'S']) method_hint?: string;
  @IsOptional() @IsIn(['取消', '合并', '压缩', '重排', '自动化', '简化']) action_class?: string;
  @IsOptional() @IsString() @Length(1, 32) alias_of?: string;
}

/** 自定义字典更新（部分列；status 仅 active|disabled） */
export class UpdateDictDto {
  @IsOptional() @IsString() @Length(1, 16) name?: string;
  @IsOptional() @IsIn(['VA', 'RNVA', 'NVA']) va_class?: string;
  @IsOptional() @IsIn(['E', 'C', 'R', 'S']) method_hint?: string;
  @IsOptional() @IsIn(['取消', '合并', '压缩', '重排', '自动化', '简化']) action_class?: string;
  @IsOptional() @IsIn(['active', 'disabled']) status?: string;
}

/** 配额设置（0=禁用 / -1=无限 / N=次数） */
export class SetQuotaDto {
  @IsInt() @Min(-1) @Max(9999) ai_quota!: number;
}

/** LLM 网关配置写入（v3.31；全可选——只更新给出的字段；api_key 传空串=清除覆盖回落 .env） */
export class UpdateLlmConfigDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @MaxLength(256) base_url?: string;
  @IsOptional() @IsString() @MaxLength(256) api_key?: string;
  @IsOptional() @IsString() @Length(1, 128) model?: string;
}

/** LLM 连接配置 profiles（v3.40：多配置单活；全 snake_case——whitelist 会剥无装饰器字段） */
export class CreateLlmProfileDto {
  @IsString() @Length(1, 64) name!: string;
  @IsString() @MaxLength(256) base_url!: string;
  @IsOptional() @IsString() @MaxLength(256) api_key?: string;
  @IsString() @Length(1, 128) model!: string;
}

export class UpdateLlmProfileDto {
  @IsOptional() @IsString() @Length(1, 64) name?: string;
  @IsOptional() @IsString() @MaxLength(256) base_url?: string;
  @IsOptional() @IsString() @MaxLength(256) api_key?: string;
  @IsOptional() @IsString() @Length(1, 128) model?: string;
}

/** LLM 连接测试（v3.32；表单值 dry-run，不落库。api_key 留空=用已存值；v3.40 增 profile_id 按配置测） */
export class TestLlmConfigDto {
  @IsOptional() @IsString() @IsUUID() profile_id?: string;
  @IsOptional() @IsString() @MaxLength(256) base_url?: string;
  @IsOptional() @IsString() @MaxLength(256) api_key?: string;
  @IsOptional() @IsString() @Length(1, 128) model?: string;
}

/** 生成查询（source 可选；缺省 mixed=legacy 全量口径，契约不变） */
export class GenerateSuggestionsQuery {
  @IsOptional() @IsIn(['mixed', 'manual', 'ai_assisted']) source?: string;
}

/** 建议列表查询（version 可选，默认当前版本；source 可选——v3.46 双来源线，缺省=legacy 全量不过滤） */
export class ListSuggestionsQuery {
  @IsOptional() @IsNumber() @Type(() => Number) version?: number;
  @IsOptional() @IsIn(['mixed', 'manual', 'ai_assisted']) source?: string;
}
