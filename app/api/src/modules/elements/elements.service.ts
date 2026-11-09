import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Element } from '../../entities/element.entity';
import { Station } from '../../entities/station.entity';
import { RulesService } from '../../core/rules/rules.service';
import { StationsService } from '../stations/stations.service';
import { ElementRepository } from './element.repository';
import { computeStd, validateSubmission, ValidateInput } from './validation';
import { ElementItemDto, SubmitElementsDto } from './dto';
import { ELEMENT_TYPES, HANDS, VA_CLASSES, elementId, round2, round3, stripVaMarker, today } from '../../core/shared/util';
import { parseCsv, toCsv } from '../../core/shared/csv';
import { currentTenantId } from '../../tenant/tenant-context';
import { DataScope } from '../../auth/auth-user.interface';

/**
 * 要素分解服务（MVP elements/service.js 1:1 平移）。
 * 平移纪律：只换 I/O 层（SQLite→TypeORM），计算与校验口径零变化；
 * 三条铁律落地：写守卫（bol_version=当前版本才可写）/ VA 改判留痕 / 事务原子提交。
 */
@Injectable()
export class ElementsService {
  private readonly repo: ElementRepository;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly stations: StationsService,
    private readonly rules: RulesService,
  ) {
    this.repo = new ElementRepository(ds);
  }

  /** 类型→默认 VA 映射（单一来源：va_rules 规则集，含 DB/文件双源与版本号） */
  private defaultVaMap(): Record<string, string> {
    const entry = this.rules.getActive('va_rules');
    const map: Record<string, string> = {};
    for (const t of entry.json?.types ?? []) map[t.type] = t.default;
    return map;
  }

  /** 类型 → 描述格式模板（单一来源：motion_standard 规则集）。用于 V1「描述完整性」校验——
   *  判定某类型是否要求「对象」字段（拿取/放置/移物/装配/粘贴/按/压/插/拔/目检… 等）。
   *  一级分组 + 二级子类型都展开进映射；无 format 的类型值为 null。 */
  private typeFormats(): Record<string, string | null> {
    const entry = this.rules.getActive('motion_standard');
    const map: Record<string, string | null> = {};
    for (const g of entry.json?.groups ?? []) {
      if (g?.level1) map[g.level1] = g.format ?? null;
      for (const s of g?.subs ?? []) {
        if (s?.level2) map[s.level2] = s.format ?? null;
      }
    }
    return map;
  }

  /** 当前版本要素列表（按 seq 升序；工位不存在 → 404） */
  /** 取要素：默认当前版本；version 指定时取历史版本（跨循环/上一版复用要素的数据源） */
  async list(stationId: string, version?: number) {
    const station = await this.stations.get(stationId);
    const target = Number.isFinite(version) && (version as number) > 0 ? (version as number) : station.version;
    const elements = await this.repo.find(
      { station_id: stationId, bol_version: target },
      { order: { seq: 'ASC' } },
    );
    return { station_id: stationId, version: target, current_version: station.version, elements };
  }

  /** 干跑校验（不落库）：前端"提交前预检"用 */
  async validate(stationId: string, payload: SubmitElementsDto) {
    await this.stations.get(stationId); // 工位不存在 → 404
    const input: ValidateInput = { elements: payload.elements as any[], cycle_count: payload.cycle_count, cv: payload.cv };
    const { errors, warnings } = validateSubmission(input, this.defaultVaMap(), this.typeFormats());
    return { ok: errors.length === 0, errors, warnings };
  }

  /**
   * v3.47 资源级写权校验转发（P0-B6）。
   * elements 端点此前只有 RBAC 全局守卫，导致同租户内任意 IE 工程师都能对别人名下
   * （且未共享给他的）工位写要素/导入 CSV。此处透传给 StationsService 统一的
   * owner / admin / editor 协作者 / 产线级授权判定，与 stations.patch/remove 同口径。
   */
  async assertWritable(stationId: string, userId: string, roles: string[]) {
    return this.stations.assertWritable(stationId, userId, roles);
  }

  /**
   * v3.55 对象级写守卫（VA 改判 / VA 确认）。
   * 这两个端点的路径参数是 elementId（不是 stationId），此前完全没有资源级校验 →
   * 任何持有 element:va-override 的用户都能改判**他人工位**的 VA 分类，
   * 且会连带触发该工位 CT 重算（recalcCt）——等于间接改写他人工位的分析结论。
   * 现按 element_id 反查所属工位 → 走 assertWritable（owner / editor 协作者 / admin）。
   */
  async assertElementWritable(elementId: string, userId: string, roles: string[]) {
    const element = await this.repo.findOne({ element_id: elementId });
    if (!element) throw new NotFoundException(`要素 ${elementId} 不存在`);
    await this.stations.assertWritable(element.station_id, userId, roles);
    return element;
  }

  /**
   * v3.55 资源级读权校验转发。
   * 要素明细/导出此前只受 RBAC「element:read」保护 → 同租户任意用户可按 id 拉取他人工位要素。
   * 透传给 StationsService 的可见范围判定（owner / 协作者 / 产线共享 / data_scope）。
   */
  async assertReadable(stationId: string, userId: string, roles: string[], scope: DataScope = 'own') {
    return this.stations.assertReadable(stationId, userId, roles, scope);
  }

  /**
   * 提交分解（事务：清当前版本 → 写入 → 重算 CT → 回写工位；文档01 §10）。
   * 写守卫：bol_version 必须等于工位当前 version（封存版本只读）。
   */
  async submit(stationId: string, payload: SubmitElementsDto, user: string) {
    const station = await this.stations.get(stationId);
    const version = station.version;
    if (payload.bol_version !== undefined && Number(payload.bol_version) !== version) {
      throw new ConflictException(`只能提交当前版本 v${version}（封存版本只读）`);
    }

    const { errors, warnings } = validateSubmission(
      { elements: payload.elements as any[], cycle_count: payload.cycle_count, cv: payload.cv },
      this.defaultVaMap(),
      this.typeFormats(),
    );
    if (errors.length) {
      // 业务校验失败：携带 V 编码错误清单（前端逐条定位），与 MVP 契约一致
      throw new BadRequestException({ message: '提交被拦截：请修正以下问题后重新提交', errors, warnings });
    }

    const sorted = [...(payload.elements as ElementItemDto[])].sort((a, b) => Number(a.start_ms) - Number(b.start_ms));
    const defaults = this.defaultVaMap();
    const tenantId = currentTenantId() ?? 'DEFAULT';

    /* v3.47 双线隔离守卫（P0-B1/B5）：当前版本若含 AI 自动分解写入的要素（source='ai_assisted'），
       本次提交必须原样带回全部 AI 要素，否则判为跨线覆盖/销毁并直接拒绝。
       一次性封死三条销毁路径：
         ① 手工线打开 AI 版本后回写且丢失来源（缺 source 会被下方三元式兜底成 manual）
         ② CSV 导入整版覆盖 AI 版本（importCsv 构造的载荷不带 source）
         ③ 任何绕过 UI 直接打接口的无来源标记整版提交
       放行条件：AI 要素条数不减少——AI 成果可被手工线引用/精修，但不得被吞掉。 */
    const aiExisting = await this.ds.getRepository(Element).countBy({
      station_id: stationId, bol_version: version, tenant_id: tenantId, source: 'ai_assisted',
    });
    if (aiExisting > 0) {
      const aiSubmitted = sorted.filter((el) => el.source === 'ai_assisted').length;
      if (aiSubmitted < aiExisting) {
        throw new ConflictException(
          `当前版本 v${version} 含 ${aiExisting} 条 AI 自动分解要素，本次提交仅带回 ${aiSubmitted} 条。` +
          `为保护 AI 成果不被覆盖或删除，请保留全部 AI 要素后重新提交；` +
          `若确需以手工分解接管本版本，请先「复测」开新版本，或先作废复测回到上一版本再操作。`,
        );
      }
    }

    const result = await this.repo.transaction(async (mgr) => {
      await mgr.delete(Element, { station_id: stationId, bol_version: version, tenant_id: tenantId });
      for (let i = 0; i < sorted.length; i += 1) {
        const el = sorted[i];
        const seq = i + 1;
        const rating = round3(Number(el.rating ?? 1));
        const allowance = round3(Number(el.allowance ?? 0.15));
        const row = mgr.create(Element, {
          element_id: elementId(stationId, version, seq),
          tenant_id: tenantId,
          station_id: stationId,
          seq,
          start_ms: Math.round(Number(el.start_ms)),
          dur_s: round2(Number(el.dur_s)),
          hand: el.hand,
          type: el.type,
          desc: String(el.desc ?? '').trim().slice(0, 120),
          va_class: el.va_class ?? defaults[el.type] ?? 'RNVA',
          outlier_flag: Number(el.outlier_flag) === 1 ? 1 : 0,
          outlier_reason: Number(el.outlier_flag) === 1 ? String(el.outlier_reason ?? '').slice(0, 100) : null,
          video_id: payload.video_id ?? 'manual',
          source: (el.source === 'ai_assisted' ? 'ai_assisted' : 'manual'),
          rating,
          allowance,
          std_time: computeStd(el.dur_s as number, rating, allowance),
          bol_version: version,
        });
        await mgr.save(row);
      }
      const agg = await mgr.createQueryBuilder(Element, 'e')
        .select('COALESCE(SUM(e.std_time), 0)', 'ct')
        .where('e.station_id = :sid AND e.bol_version = :ver AND e.outlier_flag = 0 AND e.tenant_id = :tid',
          { sid: stationId, ver: version, tid: tenantId })
        .getRawOne();
      const ct = round2(Number(agg?.ct ?? 0));
      await mgr.update(Station, { station_id: stationId, tenant_id: tenantId }, { ct, updated_by: user, updated_at: new Date() });
      return { ct, count: sorted.length };
    });

    return { station_id: stationId, version, ct: result.ct, element_count: result.count, warnings: warnings ?? [] };
  }

  /**
   * Excel/CSV 导入：任一行失败整批不入库（文档01 §9.3）。
   * 表头中文/英文均可；无起点列，按顺序累加时长生成时间轴；循环数按 15 计。
   */
  async importCsv(stationId: string, csvText: string, user: string) {
    const station = await this.stations.get(stationId);
    const rows = parseCsv(csvText);
    if (rows.length < 2) {
      throw new BadRequestException({ message: 'CSV 为空或缺少表头', errors: [{ code: 'IMPORT', message: '至少需要表头+1行数据' }] });
    }
    const header = rows[0].map((h) => String(h).trim().toLowerCase());
    const find = (names: string[]) => header.findIndex((h) => names.some((n) => h === n.toLowerCase()));
    const iSeq = find(['序号', 'seq']);
    const iHand = find(['手别', 'hand']);
    const iType = find(['类型', 'type']);
    const iDesc = find(['描述', 'desc']);
    const iDur = find(['时长s', '时长(秒)', '时长', 'dur_s']);
    if ([iSeq, iHand, iType, iDesc, iDur].some((i) => i < 0)) {
      throw new BadRequestException({
        message: 'CSV 缺少必需列：序号 / 手别 / 类型 / 描述 / 时长s',
        errors: [{ code: 'IMPORT', message: `实际表头：${rows[0].join(', ')}` }],
      });
    }
    const iVa = find(['va类别', 'va_class']);
    const iOut = find(['异常标记', 'outlier_flag']);
    const iReason = find(['异常原因', 'outlier_reason']);
    const iRating = find(['评比', 'rating']);
    const iAllowance = find(['宽放', 'allowance']);

    const defaults = this.defaultVaMap();
    const errors: { code: string; line: number; message: string }[] = [];
    const parsed: any[] = [];
    for (let r = 1; r < rows.length; r += 1) {
      const cells = rows[r];
      const line = r + 1;
      const dur = Number(cells[iDur]);
      const type = String(cells[iType] ?? '').trim();
      const hand = String(cells[iHand] ?? 'R').trim().toUpperCase();
      if (!Number.isFinite(dur) || dur <= 0) { errors.push({ code: 'IMPORT', line, message: `第${line}行：时长必须是>0的数字` }); continue; }
      if (!ELEMENT_TYPES.includes(type)) { errors.push({ code: 'IMPORT', line, message: `第${line}行：类型「${type}」不在动作词表（经典动素+公司动作标准）` }); continue; }
      if (!HANDS.includes(hand)) { errors.push({ code: 'IMPORT', line, message: `第${line}行：手别必须是 L/R/B` }); continue; }
      let va = iVa >= 0 ? String(cells[iVa] ?? '').trim() : '';
      if (!VA_CLASSES.includes(va)) va = defaults[type];
      parsed.push({
        seq: Number(cells[iSeq]) || parsed.length + 1,
        hand,
        type,
        desc: String(cells[iDesc] ?? '').trim(),
        dur_s: dur,
        va_class: va,
        outlier_flag: iOut >= 0 && ['1', '是', 'y', 'yes'].includes(String(cells[iOut]).trim().toLowerCase()) ? 1 : 0,
        outlier_reason: iReason >= 0 ? String(cells[iReason] ?? '').trim() : '',
        rating: iRating >= 0 && Number(cells[iRating]) ? Number(cells[iRating]) : 1.0,
        allowance: iAllowance >= 0 && Number(cells[iAllowance]) ? Number(cells[iAllowance]) : 0.15,
      });
    }
    if (errors.length) {
      throw new BadRequestException({ message: 'CSV 导入整批失败（任一行不合法则整批不入库）', errors });
    }

    parsed.sort((a, b) => a.seq - b.seq);
    let cursor = 0;
    const elements = parsed.map((row, index) => {
      /* v3.29：时长先量化到 10ms 网格（与落库 round2 一致），链接累加按量化后的值——
         旧实现按原始值累加（如 1.996s→1996ms）而落库 round2→2.0s（2000ms），
         重载后与下一行起点错位产生幻影"时间重叠"（端到端复现实锤，见 deliverables/v329） */
      const dur = round2(row.dur_s);
      const el = {
        seq: index + 1,
        start_ms: cursor,
        dur_s: dur,
        hand: row.hand,
        type: row.type,
        desc: row.desc,
        va_class: row.va_class,
        outlier_flag: row.outlier_flag,
        outlier_reason: row.outlier_reason,
        rating: row.rating,
        allowance: row.allowance,
      };
      cursor += Math.round(dur * 1000);
      return el;
    });

    return this.submit(
      stationId,
      { bol_version: station.version, cycle_count: 15, cv: 0, video_id: 'excel-import', elements } as SubmitElementsDto,
      user,
    );
  }

  /** 导出当前版本要素为 CSV（Excel 可直接打开） */
  async exportCsv(stationId: string): Promise<string> {
    const station = await this.stations.get(stationId);
    const elements = await this.repo.find({ station_id: stationId, bol_version: station.version }, { order: { seq: 'ASC' } });
    const header = ['工位编码', '版本', '序号', '手别', '类型', '描述', '时长s', 'VA类别', '异常标记', '异常原因', '评比', '宽放', '标准工时', '起点ms'];
    const rows = [header, ...elements.map((el) => [
      station.station_id, station.version, el.seq, el.hand, el.type, el.desc, el.dur_s, el.va_class,
      el.outlier_flag, el.outlier_reason ?? '', el.rating, el.allowance, el.std_time, el.start_ms,
    ])];
    return toCsv(rows);
  }

  /** 人工改判：写 va_class + desc 结构化标记（文档02 §2.2 同格式），封存版本拒绝写入 */
  async updateVAClass(elementIdValue: string, payload: { va_class: string; reason: string }, user: string) {
    const element = await this.repo.findOne({ element_id: elementIdValue });
    if (!element) throw new NotFoundException(`要素 ${elementIdValue} 不存在`);
    const station = await this.stations.get(element.station_id);
    if (element.bol_version !== station.version) {
      throw new ConflictException(`v${element.bol_version} 已封存只读，不能改判`);
    }
    const next = payload.va_class;
    if (!VA_CLASSES.includes(next)) throw new BadRequestException('VA类别必须是 VA/RNVA/NVA');
    const reason = String(payload.reason ?? '').trim();
    if (reason.length < 5) throw new BadRequestException('改判理由至少5个字');
    const who = user.slice(0, 20);
    const marker = `[VA改判|原:${element.va_class}|新:${next}|理由:${reason}|人:${who}|${today()}]`;
    const desc = `${stripVaMarker(element.desc)} ${marker}`.slice(0, 120);
    await this.repo.update({ element_id: elementIdValue }, { va_class: next, desc });
    const ct = await this.stations.recalcCt(station.station_id, user);
    return { element_id: elementIdValue, va_class: next, desc, ct };
  }

  /** 确认暂定归类（接受规则建议值并留痕），封存版本拒绝写入 */
  async confirmVAClass(elementIdValue: string, payload: { va_class?: string }, user: string) {
    const element = await this.repo.findOne({ element_id: elementIdValue });
    if (!element) throw new NotFoundException(`要素 ${elementIdValue} 不存在`);
    const station = await this.stations.get(element.station_id);
    if (element.bol_version !== station.version) {
      throw new ConflictException(`v${element.bol_version} 已封存只读，不能确认`);
    }
    const value = VA_CLASSES.includes(payload.va_class ?? '') ? (payload.va_class as string) : element.va_class;
    const who = user.slice(0, 20);
    const marker = `[VA确认|类:${value}|人:${who}|${today()}]`;
    const desc = `${stripVaMarker(element.desc)} ${marker}`.slice(0, 120);
    await this.repo.update({ element_id: elementIdValue }, { va_class: value, desc });
    const ct = await this.stations.recalcCt(station.station_id, user);
    return { element_id: elementIdValue, va_class: value, desc, ct };
  }
}
