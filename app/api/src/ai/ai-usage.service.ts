import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AiUsageEvent } from '../entities/ai-usage-event.entity';
import { AuthUser } from '../auth/auth-user.interface';
import { StationsService } from '../modules/stations/stations.service';
import type { LlmUsageContext } from './llm-gateway.service';

export interface AiUsageQuery {
  from?: string;
  to?: string;
  user_id?: string;
  line_id?: string;
  station_id?: string;
  feature?: string;
  model?: string;
  group_by?: string;
  sort?: string;
  order?: string;
  page?: string | number;
  page_size?: string | number;
}

interface RecordUsage {
  provider: string;
  model: string;
  internalRetry: number;
  requestId?: string | null;
  status: 'success' | 'error';
  httpStatus: number | null;
  latencyMs: number;
  errorCode?: string | null;
  usage: {
    prompt: number | null;
    completion: number | null;
    total: number | null;
    cached: number | null;
  } | null;
}

const DIMENSIONS = ['user', 'line', 'station', 'feature', 'model'] as const;
type Dimension = typeof DIMENSIONS[number];
const DIMENSION_COLUMN: Record<Dimension, string> = {
  user: 'user_id', line: 'line_id', station: 'station_id', feature: 'feature', model: 'model',
};
const SORTS = new Set(['total_tokens', 'prompt_tokens', 'completion_tokens', 'api_call_count', 'batch_count']);
const FEATURES = new Set(['waste_analysis', 'improvement_suggestion']);

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
}
function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function numberValue(value: unknown): number {
  return numberOrNull(value) ?? 0;
}
/** TypeORM SQLite/SQL Server 的 datetime 均按 UTC 保存；使用可比较的 SQL datetime 文本。 */
function sqlDate(date: Date): string {
  // TypeORM SQLite datetime 秒级存储；边界也统一为秒级，避免等值记录因 '.000' 后缀落入错误一侧。
  return date.toISOString().slice(0, 19).replace('T', ' ');
}
function businessDate(raw: string, endOfDay: boolean): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new BadRequestException('日期格式须为 YYYY-MM-DD');
  const [year, month, day] = raw.split('-').map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) {
    throw new BadRequestException(`无效日期：${raw}`);
  }
  const base = new Date(`${raw}T00:00:00+08:00`);
  if (endOfDay) base.setUTCDate(base.getUTCDate() + 1);
  return base;
}

@Injectable()
export class AiUsageService {
  private readonly log = new Logger('AiUsage');

  constructor(
    private readonly ds: DataSource,
    private readonly stations: StationsService,
  ) {}

  async recordSafe(context: LlmUsageContext | undefined, input: RecordUsage): Promise<void> {
    if (!context || !input) return;
    try {
      await this.ds.getRepository(AiUsageEvent).save({
        usage_id: randomUUID(),
        tenant_id: context.tenantId,
        feature: context.feature,
        purpose: 'business',
        batch_id: context.batchId,
        user_id: context.userId,
        station_id: context.stationId,
        line_id: context.lineId,
        provider: input.provider.slice(0, 32),
        model: input.model.slice(0, 128),
        attempt_no: context.attemptNo ?? 1,
        internal_retry: input.internalRetry,
        request_id: input.requestId?.slice(0, 128) ?? null,
        status: input.status,
        http_status: input.httpStatus,
        latency_ms: Math.max(0, Math.trunc(input.latencyMs)),
        error_code: input.errorCode?.slice(0, 64) ?? null,
        prompt_tokens: input.usage?.prompt ?? null,
        completion_tokens: input.usage?.completion ?? null,
        total_tokens: input.usage?.total ?? null,
        cached_tokens: input.usage?.cached ?? null,
        usage_status: input.usage?.total !== null && input.usage?.total !== undefined ? 'reported' : 'missing',
      });
    } catch (e: any) {
      // 不用量写失败反向打断 IE 生成业务，但必须留下可告警的错误日志。
      this.log.error(`用量事件写入失败 feature=${context.feature} batch=${context.batchId}: ${String(e?.message ?? e)}`);
    }
  }

  /** TypeORM 原生 SQL Server 查询不转换 '?'，统一绑定为 @0/@1；SQLite 保持问号占位。 */
  private rawQuery(sql: string, params: any[]) {
    if (this.ds.options.type !== 'mssql') return this.ds.query(sql, params);
    let index = 0;
    return this.ds.query(sql.replace(/\?/g, () => `@${index++}`), params);
  }

  /**
   * 新事件按真实 HTTP 调用统计；未被任何新事件覆盖的历史批次按批次总 Token 合并。
   * NOT EXISTS 同时防止上线后同一批次被“事件＋批次 tokens_used”重复计算。
   */
  private usageCte(): string {
    return `WITH usage_rows AS (
      SELECT u.tenant_id, u.feature, u.batch_id, u.user_id, u.station_id, u.line_id, u.model, u.created_at,
        CAST(u.prompt_tokens AS BIGINT) AS prompt_tokens, CAST(u.completion_tokens AS BIGINT) AS completion_tokens,
        CAST(u.total_tokens AS BIGINT) AS total_tokens, CAST(u.cached_tokens AS BIGINT) AS cached_tokens,
        1 AS api_call_count, CASE WHEN u.status = 'success' THEN 1 ELSE 0 END AS success_call_count,
        CASE WHEN u.status = 'error' THEN 1 ELSE 0 END AS failed_call_count,
        0 AS legacy_batch_count, CASE WHEN u.usage_status = 'missing' THEN 1 ELSE 0 END AS usage_missing_count
      FROM t_ai_usage_event u WHERE u.purpose = 'business'
      UNION ALL
      SELECT b.tenant_id, 'improvement_suggestion' AS feature, b.batch_id, b.user_id, b.station_id, s.line_id, b.model, b.created_at,
        NULL AS prompt_tokens, NULL AS completion_tokens, CAST(b.tokens_used AS BIGINT) AS total_tokens, NULL AS cached_tokens,
        0 AS api_call_count, 0 AS success_call_count, 0 AS failed_call_count, 1 AS legacy_batch_count, 0 AS usage_missing_count
      FROM t_ai_suggestion_batch b JOIN t_station s ON s.station_id = b.station_id AND s.tenant_id = b.tenant_id
      WHERE b.tokens_used > 0 AND NOT EXISTS (
        SELECT 1 FROM t_ai_usage_event u
        WHERE u.batch_id = b.batch_id AND u.tenant_id = b.tenant_id AND u.purpose = 'business'
      )
      UNION ALL
      SELECT b.tenant_id, 'waste_analysis' AS feature, b.batch_id, b.user_id, b.station_id, s.line_id, b.model, b.created_at,
        NULL AS prompt_tokens, NULL AS completion_tokens, CAST(b.tokens_used AS BIGINT) AS total_tokens, NULL AS cached_tokens,
        0 AS api_call_count, 0 AS success_call_count, 0 AS failed_call_count, 1 AS legacy_batch_count, 0 AS usage_missing_count
      FROM t_ai_waste_batch b JOIN t_station s ON s.station_id = b.station_id AND s.tenant_id = b.tenant_id
      WHERE b.tokens_used > 0 AND NOT EXISTS (
        SELECT 1 FROM t_ai_usage_event u
        WHERE u.batch_id = b.batch_id AND u.tenant_id = b.tenant_id AND u.purpose = 'business'
      )
    )`;
  }

  private async emptyResult(query: AiUsageQuery, groups: Dimension[], page: number, pageSize: number) {
    const zero = {
      batch_count: 0, api_call_count: 0, success_call_count: 0, failed_call_count: 0,
      prompt_tokens: null, completion_tokens: null, total_tokens: 0, cached_tokens: null,
      legacy_batch_count: 0, usage_missing_count: 0, data_quality: 'complete',
    };
    return {
      range: { from: query.from ?? null, to: query.to ?? null, timezone: 'Asia/Shanghai', to_exclusive: true },
      group_by: groups, totals: zero, rows: [], page, page_size: pageSize, total_rows: 0,
      notes: ['浪费清单与问题清单共用 waste_analysis 调用成本，不重复拆分。', '缓存与幂等命中不新增 Token。'],
    };
  }

  async summary(query: AiUsageQuery, user: AuthUser) {
    const page = integer(query.page, 1, 1, 100000);
    const pageSize = integer(query.page_size, 50, 1, 200);
    const groups = String(query.group_by ?? 'user,line,station,feature').split(',')
      .map((g) => g.trim()).filter(Boolean) as Dimension[];
    if (groups.length === 0 || groups.some((g) => !DIMENSIONS.includes(g)) || new Set(groups).size !== groups.length) {
      throw new BadRequestException(`group_by 仅支持：${DIMENSIONS.join(',')}`);
    }
    if (query.feature && !FEATURES.has(query.feature)) throw new BadRequestException('未知 AI 功能类型');
    const sort = SORTS.has(String(query.sort)) ? String(query.sort) : 'total_tokens';
    const direction = String(query.order ?? 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    let from: Date | null = null;
    let toExclusive: Date | null = null;
    if (query.from) from = businessDate(query.from, false);
    if (query.to) toExclusive = businessDate(query.to, true);
    if (from && toExclusive && from >= toExclusive) throw new BadRequestException('开始日期不能晚于结束日期');
    if (from && toExclusive && toExclusive.getTime() - from.getTime() > 367 * 86400000) {
      throw new BadRequestException('单次查询时间范围不能超过 366 天');
    }

    const visible = await this.stations.visibleStationIds(user.userId, user.roles, user.tenantId, user.dataScope);
    if (visible && visible.length === 0) return this.emptyResult(query, groups, page, pageSize);
    const where = ['r.tenant_id = ?'];
    const params: any[] = [user.tenantId];
    if (from) { where.push('r.created_at >= ?'); params.push(sqlDate(from)); }
    if (toExclusive) { where.push('r.created_at < ?'); params.push(sqlDate(toExclusive)); }
    if (visible) {
      where.push(`r.station_id IN (${visible.map(() => '?').join(',')})`);
      params.push(...visible);
    }
    for (const key of ['user_id', 'line_id', 'station_id', 'feature', 'model'] as const) {
      const value = query[key]?.trim();
      if (value) { where.push(`r.${key} = ?`); params.push(value); }
    }

    const dimSelect = DIMENSIONS.map((d) => groups.includes(d)
      ? `r.${DIMENSION_COLUMN[d]} AS ${DIMENSION_COLUMN[d]}`
      : `NULL AS ${DIMENSION_COLUMN[d]}`).join(', ');
    const groupBy = groups.length ? `GROUP BY ${groups.map((d) => `r.${DIMENSION_COLUMN[d]}`).join(', ')}` : '';
    const measures = `COUNT(DISTINCT r.batch_id) AS batch_count,
      COALESCE(SUM(r.api_call_count), 0) AS api_call_count,
      COALESCE(SUM(r.success_call_count), 0) AS success_call_count,
      COALESCE(SUM(r.failed_call_count), 0) AS failed_call_count,
      SUM(r.prompt_tokens) AS prompt_tokens, SUM(r.completion_tokens) AS completion_tokens,
      COALESCE(SUM(r.total_tokens), 0) AS total_tokens, SUM(r.cached_tokens) AS cached_tokens,
      COALESCE(SUM(r.legacy_batch_count), 0) AS legacy_batch_count,
      COALESCE(SUM(r.usage_missing_count), 0) AS usage_missing_count`;
    const aggregate = `SELECT ${dimSelect}, ${measures}
      FROM usage_rows r WHERE ${where.join(' AND ')} ${groupBy}`;
    const totalsAggregate = `SELECT NULL AS user_id, NULL AS line_id, NULL AS station_id,
      NULL AS feature, NULL AS model, ${measures} FROM usage_rows r WHERE ${where.join(' AND ')}`;
    const cte = this.usageCte();

    // KPI 是整个筛选范围的总计，不能从分组结果第一行取值。
    const totalRows = await this.rawQuery(`${cte} ${totalsAggregate}`, params);
    const mapRow = (row: any) => ({
      user_id: row.user_id ?? null, line_id: row.line_id ?? null, station_id: row.station_id ?? null,
      feature: row.feature ?? null, model: row.model ?? null,
      batch_count: numberValue(row.batch_count), api_call_count: numberValue(row.api_call_count),
      success_call_count: numberValue(row.success_call_count), failed_call_count: numberValue(row.failed_call_count),
      prompt_tokens: numberOrNull(row.prompt_tokens), completion_tokens: numberOrNull(row.completion_tokens),
      total_tokens: numberValue(row.total_tokens), cached_tokens: numberOrNull(row.cached_tokens),
      legacy_batch_count: numberValue(row.legacy_batch_count), usage_missing_count: numberValue(row.usage_missing_count),
      data_quality: numberValue(row.usage_missing_count) > 0
        ? 'partial'
        : numberValue(row.legacy_batch_count) > 0
          ? (numberValue(row.api_call_count) > 0 ? 'partial' : 'legacy_total_only')
          : 'complete',
    });
    const totals = mapRow(totalRows[0] ?? {});

    const countRows = await this.rawQuery(`${cte} SELECT COUNT(1) AS n FROM (${aggregate}) g`, params);
    const totalGroups = numberValue(countRows[0]?.n);
    const paging = this.ds.options.type === 'mssql'
      ? 'OFFSET ? ROWS FETCH NEXT ? ROWS ONLY'
      : 'LIMIT ? OFFSET ?';
    const pagingParams = this.ds.options.type === 'mssql'
      ? [(page - 1) * pageSize, pageSize]
      : [pageSize, (page - 1) * pageSize];
    const grouped = `${cte} SELECT g.*, u.display_name, u.username, s.name AS station_name, l.name AS line_name
      FROM (${aggregate}) g
      LEFT JOIN t_user u ON u.user_id = g.user_id
      LEFT JOIN t_station s ON s.station_id = g.station_id AND s.tenant_id = ?
      LEFT JOIN t_line l ON l.line_id = g.line_id AND l.tenant_id = ?
      ORDER BY g.${sort} ${direction}, g.station_id ASC, g.user_id ASC, g.feature ASC ${paging}`;
    const rows = await this.rawQuery(grouped, [...params, user.tenantId, user.tenantId, ...pagingParams]);
    const mappedRows = rows.map((row: any) => ({
      ...mapRow(row), display_name: row.display_name ?? null,
      username: row.username ?? null, station_name: row.station_name ?? null, line_name: row.line_name ?? null,
    }));
    return {
      range: { from: query.from ?? null, to: query.to ?? null, timezone: 'Asia/Shanghai', to_exclusive: true },
      group_by: groups, totals, rows: mappedRows, page, page_size: pageSize, total_rows: totalGroups,
      notes: [
        '总 Token 与是否采纳无关；失败、重试和业务校验失败前已发生的调用均计入。',
        'legacy_total_only 表示历史批次只有总 Token；partial 表示含历史明细或上游缺失 usage。',
        '浪费清单与问题清单共用 waste_analysis 调用成本；缓存与幂等命中不新增 Token。',
      ],
    };
  }
}
