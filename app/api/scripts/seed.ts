/**
 * 种子数据：租户 / 用户 / 角色 / 权限点 / 绑定 / 规则集入库 / 演示工位。
 * 幂等：已存在则跳过。开发库（sqlite）直接跑；生产（mssql）需先 migrate。
 * 默认口令 123456（首次登录强制改密 must_change_pwd=1）。
 */
import 'dotenv/config'; // 从 .env 读取连接配置（与 main.ts 同一份配置）
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { loadConfig } from '../src/core/config/configuration';
import { typeOrmConfigFactory } from '../src/core/database/database.module';
import { RULE_CODES } from '../src/core/rules/rules.service';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PERMISSIONS: [string, string, string][] = [
  ['station:read', 'stations', '查看工位'], ['station:write', 'stations', '新建/编辑工位'], ['station:retest', 'stations', '开始复测'],
  ['element:read', 'elements', '查看要素'], ['element:write', 'elements', '提交分解'], ['element:va-override', 'elements', 'VA 改判'],
  ['analysis:read', 'analysis', '查看分析'], ['analysis:run', 'analysis', '执行分析'],
  ['suggestion:generate', 'suggestions', '生成候选建议'], ['suggestion:adopt', 'suggestions', '采纳建议'], ['suggestion:status', 'suggestions', '流转建议状态'],
  ['compare:read', 'compare', '查看对比'], ['compare:export', 'compare', '导出对比报告'],
  ['settings:benefit-read', 'settings', '查看收益参数'], ['settings:benefit-write', 'settings', '维护收益参数'],
  ['rule:read', 'rules', '查看规则'], ['rule:write', 'rules', '发布规则'],
  ['user:read', 'rbac', '查看用户'], ['user:write', 'rbac', '管理用户'],
  ['role:read', 'rbac', '查看角色权限'], ['role:write', 'rbac', '管理角色'],
  ['audit:read', 'audit', '查看审计'],
  ['auth:self', 'auth', '本人信息/改密'], ['ai:use', 'ai', '使用 AI 润色'],
  ['ai:governance', 'ai', 'AI 治理（配额+自定义类型）'],
  ['group:read', 'dashboard', '集团综合驾驶舱'],
];

const ROLE_PERMS: Record<string, string[]> = {
  sys_admin: ['*'],
  // v3.50：IE 主管可查看角色权限矩阵（role:read）但不可改动（role:write 仍仅 sys_admin）
  ie_admin: ['station:*', 'element:*', 'analysis:*', 'suggestion:*', 'compare:*', 'settings:*', 'rule:*', 'audit:read', 'role:read', 'auth:self', 'ai:use', 'ai:governance', 'group:read'],
  // v3.42 决策 #1：综合看板全角色可见（原「集团看板」改名并开放给普通用户）
  ie_engineer: ['station:read', 'station:write', 'station:retest', 'element:read', 'element:write', 'element:va-override',
    'analysis:read', 'analysis:run', 'suggestion:generate', 'suggestion:adopt', 'suggestion:status',
    'compare:read', 'compare:export', 'settings:benefit-read', 'rule:read', 'auth:self', 'ai:use', 'group:read'],
  line_leader: ['station:read', 'element:read', 'analysis:read', 'suggestion:generate', 'suggestion:status', 'compare:read', 'rule:read', 'auth:self', 'ai:use', 'group:read'],
  viewer: ['station:read', 'element:read', 'analysis:read', 'compare:read', 'rule:read', 'auth:self', 'group:read'],
};

const ROLES: [string, string][] = [
  ['sys_admin', '系统管理员'], ['ie_admin', 'IE 主管'], ['ie_engineer', 'IE 工程师'],
  ['line_leader', '产线班长'], ['viewer', '只读用户'],
];

/**
 * v3.50 自定义角色示例（is_system=0：可改权限、可删除）。
 * 意义：权限体系不再硬编码五档——管理员可按需建「岗位角色」，与 TiCon/MOST 的
 * 「按站点/按岗位配置访问范围」做法对齐。
 */
const CUSTOM_ROLES: [string, string, string, string[]][] = [
  ['quality_auditor', '质量审核员', '质量/体系口只读 + 审计追溯（自定义角色示例）',
    ['station:read', 'element:read', 'analysis:read', 'compare:read', 'compare:export', 'rule:read', 'audit:read', 'auth:self', 'group:read']],
];

const USERS: [string, string, string, string, string][] = [
  // user_id, username, display_name, tenant, role
  ['u_admin', 'admin', '系统管理员', 'DEFAULT', 'sys_admin'],
  ['u_ie1', 'ie1', 'IE 工程师 王工', 'DEFAULT', 'ie_engineer'],
  ['u_leader1', 'leader1', '产线班长 李班长', 'DEFAULT', 'line_leader'],
  ['u_viewer1', 'viewer1', '访客', 'DEFAULT', 'viewer'],
  ['u_other1', 'other1', '他租户工程师', 'OTHER', 'ie_engineer'],
];

/**
 * 示例项目主数据（v3.7）：新建分析对象向导的项目下拉。
 * 正式启用后由「标准化项目清单」导入替换，编码规则以客户为准（此处 P-年份-序号 仅为示例）。
 */
const PROJECTS: [string, string, string, string][] = [
  // project_id, name, customer, stage
  ['P-2025-001', '电机壳体总装项目', '华南客户A', '量产'],
  ['P-2025-033', '连接器自动化装配', '华东客户B', '量产'],
  ['P-2026-007', '壳体注塑冲压一体线', '华南客户A', 'NPI'],
  ['P-2026-012', '控制板 SMT 贴装', '华南客户C', '量产'],
  ['P-2026-019', '控制板二次组装', '华南客户C', 'NPI'],
  ['P-2026-024', '包装线自动化改造', '内部项目', '量产'],
];

function expand(specs: string[]): string[] {
  const out = new Set<string>();
  for (const s of specs) {
    if (s === '*') { PERMISSIONS.forEach(([c]) => out.add(c)); continue; }
    if (s.endsWith(':*')) {
      const mod = s.slice(0, -2);
      PERMISSIONS.filter(([c, m]) => m === mod).forEach(([c]) => out.add(c));
      continue;
    }
    out.add(s);
  }
  return [...out];
}

async function main() {
  const cfg = loadConfig();
  // synchronize 策略与 DatabaseModule 一致：生产（mssql）必须已执行 migrate:prod，
  // 避免种子脚本擅自改动生产表结构；开发（sqlite）仍可自动建表。
  const ds = new DataSource({ ...(typeOrmConfigFactory(cfg) as any), synchronize: cfg.nodeEnv !== 'production' });
  await ds.initialize();
  console.log(`数据库已连接: ${cfg.dbType}`);

  // 租户（v3.25 层级配置化：region 仅作**无 CMC 关联的本地线回退值**；
  // 大区显示一律以 CMC factories.region 实时读取为准——CMC 有线走派生，不落硬编码中文区域）
  await ds.getRepository('t_tenant').upsert([
    { tenant_id: 'DEFAULT', code: 'DEFAULT', name: '默认租户（本部）', region: 'China', status: 'active' },
    { tenant_id: 'OTHER', code: 'OTHER', name: '其他租户（隔离验证用）', region: 'Other', status: 'active' },
  ] as any, ['tenant_id']);

  // 权限点
  for (const [code, mod, name] of PERMISSIONS) {
    const cnt = await ds.getRepository('t_permission').countBy({ code } as any);
    if (cnt === 0) {
      await ds.getRepository('t_permission').save({ perm_id: `p_${code.replace(/:/g, '_')}`, code, module: mod, name } as any);
    }
  }
  const permByCode = new Map<string, string>();
  ((await ds.getRepository('t_permission').find()) as any[]).forEach((p) => permByCode.set(p.code, p.perm_id));

  // 角色（每租户一套）+ 角色-权限绑定：系统角色（is_system=1）+ 自定义角色（is_system=0，v3.50）
  for (const tenant of ['DEFAULT', 'OTHER']) {
    const ensureRole = async (code: string, name: string, desc: string | null, isSystem: number, specs: string[]) => {
      const roleId = `r_${tenant}_${code}`;
      const cnt = await ds.getRepository('t_role').countBy({ role_id: roleId } as any);
      if (cnt === 0) {
        await ds.getRepository('t_role').save({ role_id: roleId, tenant_id: tenant, code, name, description: desc, is_system: isSystem } as any);
      }
      for (const pcode of expand(specs)) {
        const pid = permByCode.get(pcode);
        if (!pid) continue;
        const rp = await ds.getRepository('t_role_permission').countBy({ role_id: roleId, perm_id: pid } as any);
        if (rp === 0) await ds.getRepository('t_role_permission').save({ role_id: roleId, perm_id: pid } as any);
      }
    };
    for (const [code, name] of ROLES) {
      await ensureRole(code, name, null, 1, ROLE_PERMS[code] ?? []);
    }
    for (const [code, name, desc, perms] of CUSTOM_ROLES) {
      await ensureRole(code, name, desc, 0, perms);
    }
  }

  // 用户 + 绑定角色
  for (const [uid, username, display, tenant, role] of USERS) {
    const cnt = await ds.getRepository('t_user').countBy({ user_id: uid } as any);
    if (cnt === 0) {
      await ds.getRepository('t_user').save({
        user_id: uid, tenant_id: tenant, username,
        password_hash: bcrypt.hashSync('123456', 10),
        display_name: display, status: 'active', failed_count: 0, must_change_pwd: 1,
      } as any);
    }
    const roleId = `r_${tenant}_${role}`;
    const ur = await ds.getRepository('t_user_role').countBy({ user_id: uid, role_id: roleId } as any);
    if (ur === 0) await ds.getRepository('t_user_role').save({ user_id: uid, role_id: roleId } as any);
  }

  // 项目主数据（示例；已有则跳过——正式导入标准化清单时替换本段）
  let projectCount = 0;
  for (const [pid, name, customer, stage] of PROJECTS) {
    const cnt = await ds.getRepository('t_project').countBy({ tenant_id: 'DEFAULT', project_id: pid } as any);
    if (cnt > 0) continue;
    await ds.getRepository('t_project').save({
      tenant_id: 'DEFAULT', project_id: pid, name, customer, stage, status: 'active',
    } as any);
    projectCount++;
  }
  if (projectCount > 0) console.log(`项目主数据：新增 ${projectCount} 条`);

  // 规则集入库（config/rules/*.json → t_rule_set）
  let ruleCount = 0;
  for (const code of RULE_CODES) {
    const cnt = await ds.getRepository('t_rule_set').countBy({ code } as any);
    if (cnt > 0) continue;
    const file = code === 'benefit_params'
      ? join(cfg.rulesDir, '..', `${code}.json`)
      : join(cfg.rulesDir, `${code}.json`);
    if (!existsSync(file)) { console.warn(`规则文件缺失，跳过: ${file}`); continue; }
    const raw = readFileSync(file, 'utf-8');
    await ds.getRepository('t_rule_set').save({
      rule_set_id: `rs_${code}_seed`, code, version: JSON.parse(raw).rv ?? 'RV1.0',
      content: raw, is_active: 1, created_by: 'seed',
    } as any);
    ruleCount++;
  }

  // 演示产线（v3.25 补种：v3.7 起工位创建强制产线先存在，smoke 依赖 L01/L02；
  // CMC 线 BJFA1/SHFA9 由 from-cmc 接口产生，这里只补无 CMC 关联的本地演示线）
  const demoLines = [
    { tenant_id: 'DEFAULT', line_id: 'L01', name: '示例装配线 L01', process_type: '装配', product_type: '待补充', product_project: '-' },
    { tenant_id: 'OTHER', line_id: 'L02', name: '他租户隔离线 L02', process_type: '装配', product_type: '待补充', product_project: '-' },
  ];
  for (const l of demoLines) {
    const cnt = await ds.getRepository('t_line').countBy({ tenant_id: l.tenant_id, line_id: l.line_id } as any);
    if (cnt > 0) continue;
    await ds.getRepository('t_line').save({ ...l, created_by: 'seed' } as any);
  }

  // 演示工位与要素（v3.42：owner 归属——演示工位归 admin；演示共享：L01-ST02 共享给 ie1 editor）
  const stations = [
    { station_id: 'L01-ST01', tenant_id: 'DEFAULT', line_id: 'L01', name: '上壳装配' },
    { station_id: 'L01-ST02', tenant_id: 'DEFAULT', line_id: 'L01', name: '锁螺丝' },
    { station_id: 'L02-ST01', tenant_id: 'OTHER', line_id: 'L02', name: '他租户工位（隔离验证）' },
  ];
  for (const s of stations) {
    const cnt = await ds.getRepository('t_station').countBy({ station_id: s.station_id } as any);
    if (cnt > 0) continue;
    await ds.getRepository('t_station').save({ ...s, version: 1, ct: null, tt: 60, owner_user_id: 'u_admin', updated_by: 'seed', updated_at: new Date(), created_by: 'seed' } as any);
  }
  // v3.42 演示共享：admin 把「锁螺丝」共享给 ie1（editor）——演示共享协作链路
  const collabCnt = await ds.getRepository('t_station_collaborator').countBy({ station_id: 'L01-ST02', user_id: 'u_ie1' } as any);
  if (collabCnt === 0) {
    await ds.getRepository('t_station_collaborator').save({ station_id: 'L01-ST02', user_id: 'u_ie1', acl_role: 'editor', granted_by: 'seed' } as any);
  }
  const elCnt = await ds.getRepository('t_element').count();
  if (elCnt === 0) {
    const elements: [string, string, number, number, number, string, string, string, string][] = [
      // element_id, station, seq, start_ms, dur, hand, type, desc, va
      ['L01-ST01-V1-001', 'L01-ST01', 1, 0, 3.2, 'R', '移物', '取前壳', 'VA'],
      ['L01-ST01-V1-002', 'L01-ST01', 2, 3200, 2.8, 'R', '装配', '装前壳到位', 'VA'],
      ['L01-ST01-V1-003', 'L01-ST01', 3, 6000, 2.5, 'L', '持住', '扶住壳体', 'NVA'],
    ];
    for (const [eid, sid, seq, start, dur, hand, type, desc, va] of elements) {
      const std = Math.round(dur * 1.0 * 1.15 * 100) / 100;
      await ds.getRepository('t_element').save({
        element_id: eid, tenant_id: 'DEFAULT', station_id: sid, seq, start_ms: start,
        dur_s: dur, hand, type, desc, va_class: va, outlier_flag: 0,
        video_id: `${sid.replace(/-/g, '_')}_demo.mp4`, rating: 1.0, allowance: 0.15,
        std_time: std, bol_version: 1,
      } as any);
    }
  }

  await ds.destroy();
  console.log(`种子完成：用户5 / 角色10 / 权限${PERMISSIONS.length} / 规则入库${ruleCount}组 / 工位3`);
}

main().catch((e) => { console.error('种子失败:', e); process.exit(1); });
