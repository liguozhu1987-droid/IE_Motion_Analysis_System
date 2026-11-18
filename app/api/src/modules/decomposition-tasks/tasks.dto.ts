import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

/** ISO 日期（DATE 列两种方言读回形态不同，统一用 'YYYY-MM-DD' 字符串入库与回传） */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ROUND_TYPES = ['baseline', 'kaizen_after', 'recheck', 'other'] as const;

/** GET /api/tasks 查询参数（ValidationPipe whitelist：每个字段必须有装饰器） */
export class ListTasksDto {
  /** 产线筛选（方案 §3.8：产线降级为任务下拉的筛选器，不再是独立导出范围） */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  line_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  project_id?: string;

  /** Phase 3 #107：只列包含该工位的任务（t_task_station 成员过滤，#/diff 任务下拉用） */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  station_id?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** POST /api/tasks：任务号由服务端生成（DT-{YYYY}-{NNN}），不接受自定义 */
export class CreateTaskDto {
  @IsString()
  @MaxLength(32)
  line_id!: string;

  @IsString()
  @MaxLength(64)
  name!: string;

  @IsOptional()
  @Matches(ISO_DATE)
  period_start?: string;

  @IsOptional()
  @Matches(ISO_DATE)
  period_end?: string;

  @IsOptional()
  @IsIn(ROUND_TYPES as unknown as string[])
  round_type?: string;

  /** 改善前基线任务指针（跨期对比用，不合并导出） */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  baseline_task_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  project_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  project_no_snapshot?: string;

  /** 纳入任务的工位；省略 = 该产线全部可见工位（后端仍逐工位 assertReadable） */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(200)
  station_ids?: string[];
}

/** POST /api/tasks/:id/stations：把已有工位纳入任务并锁定其当前生效版本 */
export class AddStationsDto {
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(200)
  station_ids!: string[];
}

/** POST /api/tasks/:id/clone-elements：从基线任务复制要素快照作为新任务起点 */
export class CloneElementsDto {
  @IsString()
  @MaxLength(32)
  from_task_id!: string;
}
