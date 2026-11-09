import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min,
} from 'class-validator';

/**
 * P3-9 浪费识别模块 DTO。
 * 纪律：每个字段必须带装饰器——全局 ValidationPipe(whitelist:true) 会剥离无装饰器属性。
 */

/** 要素来源线（v3.45 手工分解线）：manual=手工分解写入 / ai_assisted=AI 自动分解写入 */
export type WasteSource = 'manual' | 'ai_assisted';

/** v3.51 条目来源：ai=LLM 识别产出 / manual=人工录入 */
export type WasteOrigin = 'ai' | 'manual';

/** 浪费点状态流转（确认→t_improvement；忽略→终态） */
export class UpdateWasteIssueDto {
  @IsIn(['已确认', '已忽略']) status!: '已确认' | '已忽略';
}

/**
 * 批次列表查询（version 可选；source 可选）。
 * 缺省/不传 source = 旧行为逐字节不变（服务端默认 ai_assisted）——53/53 契约回归安全。
 */
export class ListWasteBatchesQuery {
  @IsOptional() version?: number;
  @IsOptional() @IsIn(['manual', 'ai_assisted']) source?: WasteSource;
}

/** 最新批次视图查询（同款 source 字段；缺省 ai_assisted） */
export class WasteLatestQuery {
  @IsOptional() @IsIn(['manual', 'ai_assisted']) source?: WasteSource;
}

// ───────────────────────── v3.51 人工录入与改善知识库 ─────────────────────────

/**
 * 合并清单查询（跨批次 + 人工；查询路径不依赖 AI 开关——AI 关闭时历史与人工清单仍可查）。
 * origin：ai|manual|all（缺省 all）；scope：latest=仅最新批次 / all=全部历史批次（缺省 latest）
 */
export class WasteItemsQuery {
  @IsOptional() @IsIn(['ai', 'manual', 'all']) origin?: string;
  @IsOptional() @IsIn(['latest', 'all']) scope?: string;
  @IsOptional() @IsIn(['manual', 'ai_assisted']) source?: WasteSource;
}

/** 人工录入·浪费点（element_seqs 可选：全局性浪费可不挂要素，此时涉及时长记 0） */
export class CreateManualFindingDto {
  @IsString() waste_type!: string;
  @IsString() evidence!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(30) element_seqs?: number[];
  /** v3.57：路由——finding=确定性命中计收益（缺省）/ pool=待标定观察项仍进清单、est 不计值 */
  @IsOptional() @IsIn(['finding', 'pool']) route?: string;
}

export class UpdateManualFindingDto {
  @IsOptional() @IsString() waste_type?: string;
  @IsOptional() @IsString() evidence?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(30) element_seqs?: number[];
  @IsOptional() @IsIn(['finding', 'pool']) route?: string;
}

/**
 * 人工录入·改善措施（ECRS 枚举；est_save_s 可选——
 * 不填且挂了要素则服务端按 E 全额 / C·R·S 半折口径计算；填了由服务端 clamp 到 [0, CT]）
 */
export class CreateManualIssueDto {
  @IsString() waste_type!: string;
  @IsString() problem!: string;
  @IsIn(['E', 'C', 'R', 'S']) ecrs!: string;
  @IsString() suggestion!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(30) element_seqs?: number[];
  @IsOptional() @IsNumber() @Min(0) @Max(3600) est_save_s?: number;
}

export class UpdateManualIssueDto {
  @IsOptional() @IsString() waste_type?: string;
  @IsOptional() @IsString() problem?: string;
  @IsOptional() @IsIn(['E', 'C', 'R', 'S']) ecrs?: string;
  @IsOptional() @IsString() suggestion?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(30) element_seqs?: number[];
  @IsOptional() @IsNumber() @Min(0) @Max(3600) est_save_s?: number;
}

/** 手动整理进知识库（去重按 source_ref 幂等更新，重复整理不产生重复行） */
export class ArchiveKbDto {
  /** 整理哪些类型：缺省 ['finding','issue'] */
  @IsOptional() @IsArray() @IsIn(['finding', 'issue'], { each: true }) kinds?: string[];
  /** 是否纳入「已确认」的 AI 条目（缺省 true）——只沉淀经过确认的经验，待处理/已忽略不纳入 */
  @IsOptional() @IsBoolean() include_ai_confirmed?: boolean;
  /** 是否按租户通用整理（station_id 置空 → 跨工位检索命中） */
  @IsOptional() @IsBoolean() general?: boolean;
}

/** 知识库列表查询 */
export class ListKbQuery {
  @IsOptional() @IsString() station_id?: string;
  @IsOptional() @IsString() waste_type?: string;
  @IsOptional() @IsIn(['finding', 'issue']) kind?: string;
  @IsOptional() @IsIn(['active', 'archived', 'all']) status?: string;
  @IsOptional() @IsString() q?: string;
  @IsOptional() @IsInt() @Min(1) @Max(200) limit?: number;
}

export class UpdateKbDto {
  @IsOptional() @IsIn(['active', 'archived']) status?: string;
  @IsOptional() @IsString() waste_type?: string;
  @IsOptional() @IsString() problem?: string;
  @IsOptional() @IsString() suggestion?: string;
  @IsOptional() @IsString() evidence?: string;
  @IsOptional() @IsIn(['E', 'C', 'R', 'S']) ecrs?: string;
  @IsOptional() @IsBoolean() general?: boolean;
}
