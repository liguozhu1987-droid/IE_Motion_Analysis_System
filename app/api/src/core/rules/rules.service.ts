import { Injectable, Logger, OnModuleInit, BadRequestException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { RuleSet } from '../../entities/rule-set.entity';
import { RuleSetRepository } from './rule-set.repository';
import { validate as dslValidate } from './dsl';
import { APP_CONFIG } from '../config/configuration';
import { AppConfig } from '../config/configuration';
import { Inject } from '@nestjs/common';

export const RULE_CODES = ['va_rules', 'waste_triggers', 'ecrsa_map', 'redline_keywords', 'benefit_params', 'motion_standard'] as const;

/** 规则文件路径解析：benefit_params 位于 config/（MVP 资产位置），其余在 config/rules/ */
function ruleFilePath(rulesDir: string, code: string): string {
  return code === 'benefit_params'
    ? join(rulesDir, '..', FILE_NAMES[code])
    : join(rulesDir, FILE_NAMES[code]);
}

/** 规则文件名清单（RV1.0 资产；motion_standard=公司动作分解标准 v3.16 起） */
const FILE_NAMES: Record<string, string> = {
  va_rules: 'va_rules.json',
  waste_triggers: 'waste_triggers.json',
  ecrsa_map: 'ecrsa_map.json',
  redline_keywords: 'redline_keywords.json',
  benefit_params: 'benefit_params.json',
  motion_standard: 'motion_standard.json',
};

interface RuleEntry { json: any; raw: string; version: string; source: 'db' | 'file' }

/** 版本号格式：RV3.1 / MS1.1 语义化（发布治理见 publish：格式非法 400、撞车自动顺延） */
const VERSION_RE = /^[A-Z]{1,4}\d+\.\d+$/;

/**
 * 规则服务：双源加载（DB 优先 → 文件兜底），启动自检 fail-fast（延续 MVP 纪律）。
 * 加载时序：onModuleInit → preloadFromDb（DB→dbCache）→ loadAll（内存缓存+自检）。
 * 发布/回滚 → invalidate。
 */
@Injectable()
export class RulesService implements OnModuleInit {
  private readonly log = new Logger('Rules');
  private cache = new Map<string, RuleEntry>();
  private dbCache = new Map<string, RuleEntry>();

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.preloadFromDb();
    await this.loadAll();
  }

  /** DB 预载（失败不阻塞，回退文件源） */
  async preloadFromDb(): Promise<void> {
    try {
      const repo = this.ds.getRepository(RuleSet);
      const rows = (await repo.find()) as any[];
      for (const r of rows) {
        if (!r.is_active) continue;
        this.dbCache.set(r.code, { json: JSON.parse(r.content), raw: r.content, version: r.version, source: 'db' });
      }
      this.log.log(`DB 规则预载 ${this.dbCache.size} 组`);
    } catch (e) {
      this.log.warn(`DB 规则预载失败，回退文件源：${(e as Error).message}`);
    }
  }

  /** 启动自检：全部规则可加载 + DSL 表达式全部可编译，否则拒绝启动 */
  async loadAll(): Promise<void> {
    this.cache.clear();
    for (const code of RULE_CODES) {
      this.getActive(code); // 触发加载与校验
    }
    this.log.log(`规则自检通过（${this.cache.size} 组）`);
  }

  /** 取生效规则（同步读缓存；未加载则立即从文件加载） */
  getActive(code: string): RuleEntry {
    const hit = this.cache.get(code);
    if (hit) return hit;
    let entry = this.dbCache.get(code) ?? null;
    if (!entry) {
      const file = ruleFilePath(this.cfg.rulesDir, code);
      if (!existsSync(file)) throw new Error(`规则缺失：DB 与文件均无 ${code}（期望 ${file}）`);
      const raw = readFileSync(file, 'utf-8');
      const json = JSON.parse(raw);
      entry = { json, raw, version: json.rv ?? 'RV1.0', source: 'file' };
    }
    this.selfCheck(code, entry.json);
    this.cache.set(code, entry);
    return entry;
  }

  /**
   * 发布新版本（原子事务：旧 active 置 0 + 插新行 + 刷新缓存；可回滚）。
   *
   * v3.19 版本号治理（用户反馈「版本区域一长串版本号」的规则侧根因）：
   * ① rv 须符合语义化格式（RV3.1 / MS1.1），否则 400——防止 'X' 这类无意义版本号入库；
   * ② 同 code 版本号不得重复：此前 rv 靠人工递增、不递增也不报错，收益参数已堆积
   *    56 条同名 RV1.0，版本历史彻底失真。撞车时**自动顺延次版本号**（RV1.0→RV1.1），
   *    实际发布版本随响应返回（bumped=true），调用方据此提示，避免"发了 MS1.1 实际是 MS1.2"的隐瞒。
   */
  async publish(code: string, content: any, operator: string): Promise<{ rule_set_id: string; version: string; bumped: boolean }> {
    const requested = typeof content?.rv === 'string' && content.rv.trim() ? content.rv.trim() : null;
    if (requested !== null && !VERSION_RE.test(requested)) {
      throw new BadRequestException(`版本号格式应为「字母+数字.数字」（如 RV3.1 / MS1.1），当前为「${requested}」`);
    }
    const repo = new RuleSetRepository(this.ds);
    const rows = (await this.ds.getRepository(RuleSet).find({ where: { code } as any, select: ['version'] as any })) as any[];
    const used = new Set(rows.map((r) => String(r.version)));
    let version = requested ?? 'RV1.0';
    let bumped = false;
    if (used.has(version)) {
      const m = /^([A-Z]{1,4})(\d+)\.(\d+)$/.exec(version);
      if (m) {
        let minor = Number(m[3]) + 1;
        while (used.has(`${m[1]}${m[2]}.${minor}`)) minor += 1;
        version = `${m[1]}${m[2]}.${minor}`;
      } else {
        version = `${version}.2`;
      }
      bumped = true;
    }
    const finalContent = { ...content, rv: version };
    const id = await repo.transaction(async (mgr) => {
      await mgr.update(RuleSet, { code, is_active: 1 } as any, { is_active: 0 } as any);
      const row: any = mgr.create(RuleSet, {
        rule_set_id: `rs_${code}_${Date.now()}`,
        code,
        version,
        content: JSON.stringify(finalContent),
        is_active: 1,
        created_by: operator,
      } as any);
      await mgr.save(row);
      return row.rule_set_id;
    });
    // 关键：把新版本同步进 DB 缓存——否则 getActive 回退文件源，发布不生效
    this.dbCache.set(code, { json: finalContent, raw: JSON.stringify(finalContent), version, source: 'db' });
    this.cache.delete(code);
    return { rule_set_id: id, version, bumped };
  }

  /** 当前生效规则快照（供 GET /api/rules） */
  snapshot(): Record<string, { version: string; source: string }> {
    const out: Record<string, any> = {};
    for (const code of RULE_CODES) {
      const e = this.getActive(code);
      out[code] = { version: e.version, source: e.source };
    }
    return out;
  }

  /** 规则集列表（含历史版本，供管理页） */
  async listAll(): Promise<Pick<RuleSet, 'rule_set_id' | 'code' | 'version' | 'is_active' | 'created_by' | 'created_at'>[]> {
    const repo = this.ds.getRepository(RuleSet);
    const rows = (await repo.find({ order: { created_at: 'DESC' } as any })) as any[];
    return rows.map((r) => ({
      rule_set_id: r.rule_set_id, code: r.code, version: r.version,
      is_active: r.is_active, created_by: r.created_by, created_at: r.created_at,
    }));
  }

  /** 供 seed：DB 无记录时从文件灌入 */
  async seedFromFilesIfEmpty(): Promise<number> {
    const repo = this.ds.getRepository(RuleSet);
    let n = 0;
    for (const code of RULE_CODES) {
      const cnt = await repo.countBy({ code } as any);
      if (cnt > 0) continue;
      const file = ruleFilePath(this.cfg.rulesDir, code);
      if (!existsSync(file)) continue;
      const raw = readFileSync(file, 'utf-8');
      const json = JSON.parse(raw);
      await repo.save(repo.create({
        rule_set_id: `rs_${code}_seed`,
        code,
        version: json.rv ?? 'RV1.0',
        content: raw,
        is_active: 1,
        created_by: 'seed',
      } as any));
      n++;
    }
    return n;
  }

  /** 自检：va_rules 必须 10 类要素；所有条件表达式可编译 */
  private selfCheck(code: string, json: any): void {
    if (code === 'va_rules') {
      const rules = json?.types ?? json?.rules ?? json?.va_rules ?? [];
      const types = rules.map((r: any) => r.type);
      if (types.length < 10) throw new Error(`va_rules 自检失败：要素类型不足 10 类（实际 ${types.length}）`);
      for (const r of rules) {
        for (const ex of r.exceptions ?? []) if (ex.when) dslValidate(ex.when);
      }
    }
    if (code === 'waste_triggers') {
      for (const t of json.triggers ?? json.wastes ?? []) {
        if (t.when) dslValidate(t.when);
        if (t.agg_when) dslValidate(t.agg_when);
        for (const f of t.filter ?? []) if (typeof f === 'string') dslValidate(f);
      }
    }
    if (json.rv && typeof json.rv !== 'string') throw new Error(`${code}: rv 必须为字符串`);
  }
}
