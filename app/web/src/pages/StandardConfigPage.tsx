/**
 * 动作标准配置页（#/standard，用户 2026-10-23 需求：标准数据库配置更改界面）。
 * 维护公司动作分解标准（motion_standard 规则集）：一级/二级类型、定义、起止点（分界标准）、
 * 描述格式（决定结构化描述字段）、影响因素、默认增值判定（VA/RNVA/NVA）。
 * 保存=发布新版本（POST /api/rules/motion_standard/publish，rule:write），发布后分解工作台即时生效。
 * 权限：查看 rule:read；编辑发布 rule:write。
 *
 * 双态设计（2026-10-28 显示优化）：
 *  - 查看态（默认）：纯文本展示，所有字段自动换行、完整呈现；VA 用彩色徽章、判定说明可滚动不堆积；
 *    表格区域带横纵滚动条。此态下无任何可编辑控件，杜绝误改观感。
 *  - 编辑态：仅点击「编辑标准」后进入，字段渲染为 input/textarea/select 方可修改；
 *    顶部明确提示「编辑模式」，改动仅在点击「保存并发布」后才生效。
 */
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth';
import SelectMenu from '../components/SelectMenu';
import { api, RULE_META } from '../api';
import { parseMotionStandard, type MotionStandard } from '../motionStandard';
import { MOTION_STANDARD_DEFAULT } from '../motionStandardDefault';

type EditGroup = MotionStandard['groups'][number];
type EditEntry = MotionStandard['entries'][number];

const VA_OPTIONS = [
  { v: 'VA', label: 'VA 增值' },
  { v: 'RNVA', label: 'RNVA 必要非增值' },
  { v: 'NVA', label: 'NVA 非增值' },
];

const EMPTY = '—';

export default function StandardConfigPage() {
  const { user, can } = useAuth();
  const canWrite = can('rule:write');
  const [std, setStd] = useState<MotionStandard | null>(null);
  const [version, setVersion] = useState('');
  const [source, setSource] = useState('');
  const [dirty, setDirty] = useState(false);
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.rules.content('motion_standard');
      const parsed = parseMotionStandard((res as any)?.content);
      if (parsed) { setStd(parsed); setVersion(res.version); setSource(parsed.source); setEditing(false); setDirty(false); return; }
      throw new Error('内容结构非法');
    } catch {
      const fallback = parseMotionStandard(MOTION_STANDARD_DEFAULT);
      setStd(fallback);
      setVersion('内置默认（DB 未发布）');
      setSource(fallback?.source ?? '');
      setEditing(false);
      setDirty(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const mutate = (fn: (draft: EditGroup[]) => void) => {
    if (!std) return;
    const groups = JSON.parse(JSON.stringify(std.groups)) as EditGroup[];
    fn(groups);
    setStd({ ...std, groups });
    setDirty(true);
  };

  const publish = async () => {
    if (!std || !canWrite || !editing) return;
    setSaving(true);
    setMsg(null);
    try {
      // 版本号自动递增：MS1.0 → MS1.1（次版本）；服务端撞车仍会再顺延（bumped），以响应版本为准
      const m = /^MS(\d+)\.(\d+)$/.exec(std.rv);
      const rv = m ? `MS${m[1]}.${Number(m[2]) + 1}` : 'MS1.1';
      const content = {
        rv,
        source: source || '动作分解标准.xlsx；VA N-VA Defination v00 20190429.xlsx',
        groups: std.groups,
      };
      const res = await api.rules.publish('motion_standard', content as Record<string, unknown>, user?.username ?? 'unknown');
      setMsg({ ok: true, text: `已发布 ${res.version ?? rv}：分解工作台即时生效（类型下拉/描述格式/分界标准/VA 默认全部更新）` });
      await load();
      setDirty(false);
    } catch (e) {
      setMsg({ ok: false, text: `发布失败：${(e as Error).message}` });
    } finally {
      setSaving(false);
    }
  };

  if (!std) return <div className="card empty">正在加载动作标准库…</div>;

  const totalTypes = std.groups.reduce((n, g) => n + (g.subs.length > 0 ? g.subs.length : 1), 0);
  const COLS = editing && canWrite ? 9 : 8;

  return (
    <div className={'std-page' + (editing ? ' is-editing' : '')}>
      <div className="std-head">
        <div>
          <h2>动作标准库</h2>
          <p className="std-sub">
            结构化描述格式 / 分界标准（起止点）/ 默认增值判定的单一数据源——改动发布后，分解工作台即时生效。
            当前版本 <b className="mono">{version}</b> · 可选类型 <b>{totalTypes}</b> 个 · 来源：{source || '—'}
          </p>
        </div>
        <div className="std-actions">
          <span className={'std-mode-pill' + (editing ? ' editing' : '')}>{editing ? '编辑模式' : '查看模式'}</span>
          {editing && dirty && <span className="std-dirty">有未发布修改</span>}
          {canWrite ? (
            editing ? (
              <>
                <button className="btn" onClick={() => { setEditing(false); setDirty(false); void load(); }}>取消编辑</button>
                <button className="btn primary" disabled={!dirty || saving} onClick={() => void publish()}>
                  {saving ? '发布中…' : '保存并发布'}
                </button>
              </>
            ) : (
              <button className="btn primary" onClick={() => setEditing(true)}>编辑标准</button>
            )
          ) : (
            <span className="std-ro">只读（需 rule:write 权限才能修改发布）</span>
          )}
        </div>
      </div>

      {msg && <div className={msg.ok ? 'success-banner' : 'error-banner'}>{msg.text}</div>}

      {editing && canWrite && (
        <div className="std-edit-banner">
          <b>编辑模式</b>：以下字段已可修改，改动仅在点击「保存并发布」后才写入规则库并同步到分解工作台；未保存直接「取消编辑」将丢弃全部改动。
        </div>
      )}

      <div className="std-tip">
        描述格式语法：<code>动词 +字段 +字段介词</code>（如 <code>拿取 +对象于 +位置 +距离</code>）——「+」后每段是一个字段，
        段尾的 于/至/到/自/向 会作为该字段后的介词出现在描述里（实例：拿取 后横梁 <b>于</b> 料箱 150）；
        分解工作台的结构化描述输入框按此格式动态生成，预览组合后自动写入描述。
        操作族（按/压/推/拉/插/拔）按对象条件判定：工具/按钮/工装=RNVA，直接作用于装入产品的物料或借助工具压装配零部件=VA，不能一概当作非增值。
        修改默认判定（va）时请同步维护「设置 → VA 归类规则（va_rules）」中对应类型的 default。
      </div>

      <div className="std-table-wrap card">
        <table className="std-table">
          <thead>
            <tr>
              <th style={{ width: '12%' }}>一级</th>
              <th style={{ width: '7%' }}>二级</th>
              <th style={{ width: '18%' }}>定义</th>
              <th style={{ width: '11%' }}>起（分界）</th>
              <th style={{ width: '11%' }}>止（分界）</th>
              <th style={{ width: '14%' }}>描述格式</th>
              <th style={{ width: '9%' }}>影响因素</th>
              <th style={{ width: '18%' }}>默认判定</th>
              {editing && canWrite && <th style={{ width: 56 }} aria-label="操作" className="std-col-act" />}
            </tr>
          </thead>
          {std.groups.map((g, gi) => (
            <tbody key={gi}>
              {g.subs.length === 0 ? (
                /* 一级自身即可选类型（拿取/放置/清洁…）：保留二级空位，避免列偏移 */
                <tr className="std-row-l1">
                  <TdGroup g={g} idx={gi} canWrite={canWrite} editing={editing} rows={1} mutate={mutate} />
                  <td className="std-td-empty" aria-label="二级" />
                  <FieldTds entry={g} canWrite={canWrite} editing={editing}
                    onSet={(patch) => mutate((gs) => { Object.assign(gs[gi], patch); })} />
                  {editing && canWrite && (
                    <td className="std-col-act">
                      <button className="std-del" title="删除该一级分类" onClick={() => mutate((gs) => { gs.splice(gi, 1); })}>删</button>
                    </td>
                  )}
                </tr>
              ) : (
                g.subs.map((s, si) => (
                  <tr key={si} className={si === 0 ? 'std-row-l1' : ''}>
                    {si === 0 && <TdGroup g={g} idx={gi} canWrite={canWrite} editing={editing} rows={g.subs.length} mutate={mutate} />}
                    <td>
                      {editing && canWrite && (
                        <button className="std-del" title="删除该二级类型" onClick={() => mutate((gs) => { gs[gi].subs.splice(si, 1); })}>×</button>
                      )}
                      <FieldText editing={editing && canWrite} value={s.level2 ?? ''} mono
                        onChange={(v) => mutate((gs) => { gs[gi].subs[si].level2 = v; gs[gi].subs[si].type = v; })} placeholder="二级名" />
                    </td>
                    <FieldTds entry={s} canWrite={canWrite} editing={editing}
                      onSet={(patch) => mutate((gs) => { Object.assign(gs[gi].subs[si], patch); })} />
                    {editing && canWrite && si === 0 && (
                      <td className="std-col-act" rowSpan={g.subs.length}>
                        <button className="std-del" title="删除整个一级分类（含全部二级）" onClick={() => mutate((gs) => { gs.splice(gi, 1); })}>删</button>
                      </td>
                    )}
                  </tr>
                ))
              )}
              {editing && canWrite && (
                <tr className="std-row-add">
                  <td colSpan={COLS}>
                    <button className="std-add" onClick={() => mutate((gs) => {
                      gs[gi].subs.push({ type: '新二级', level1: gs[gi].level1, level2: '新二级', desc: '', sp: gs[gi].sp, ep: gs[gi].ep, format: gs[gi].format, factors: gs[gi].factors, va: gs[gi].va, vaNote: null });
                    })}>+ 给「{g.level1}」加二级类型</button>
                  </td>
                </tr>
              )}
            </tbody>
          ))}
        </table>
        {editing && canWrite && (
          <button className="std-add std-add-l1" onClick={() => mutate((gs) => {
            gs.push({ level1: '新一级', desc: '', sp: '', ep: '', format: '新一级 +对象', factors: '', va: 'RNVA', vaNote: null, subs: [] });
          })}>+ 新增一级分类</button>
        )}
      </div>

      <p className="std-foot">
        关联规则集：{RULE_META['motion_standard']?.name ?? 'motion_standard'} —— 判定表的完整清单（含插/压/推/拉按对象条件判定、
        判定表备注）由各类型的「默认判定 + vaNote」承载；运行时默认值以 va_rules（VR01~VR41）为准，此处修改 va 后请到「设置 → 规则库」同步 va_rules。
      </p>
    </div>
  );
}

/** 一级列（rowSpan 跨其二级行）：一级名 / 定义摘要 / 判定说明 */
function TdGroup({ g, idx, canWrite, editing, rows, mutate }: {
  g: EditGroup; idx: number; canWrite: boolean; editing: boolean; rows: number; mutate: (fn: (gs: EditGroup[]) => void) => void;
}) {
  const set = (patch: Partial<EditGroup>) => mutate((gs) => { Object.assign(gs[idx], patch); });
  const edit = editing && canWrite;
  return (
    <td rowSpan={rows} className="std-td-l1" data-va={g.va}>
      {edit && rows === 1 && (
        <button className="std-del" title="删除该一级分类" onClick={() => mutate((gs) => { gs.splice(idx, 1); })}>×</button>
      )}
      {edit ? (
        <input className="std-l1 mono" value={g.level1} onChange={(e) => set({ level1: e.target.value })} />
      ) : (
        <div className="std-l1-txt">{g.level1}</div>
      )}
      {rows === 1 && (
        edit ? (
          <textarea value={g.desc} rows={2} placeholder="定义" onChange={(e) => set({ desc: e.target.value })} />
        ) : (
          <div className="std-cell std-desc">{g.desc || EMPTY}</div>
        )
      )}
      {g.vaNote && (
        edit ? (
          <textarea className="std-vanote-edit" value={g.vaNote} rows={2} placeholder="条件判定说明" onChange={(e) => set({ vaNote: e.target.value || null })} />
        ) : (
          <div className="std-vanote" title={g.vaNote}>{g.vaNote}</div>
        )
      )}
    </td>
  );
}

/** 字段列：定义 / 起（分界）/ 止（分界）/ 描述格式 / 影响因素 / 默认判定（一级行与二级行共用） */
type FieldOwner = Pick<EditEntry, 'desc' | 'sp' | 'ep' | 'format' | 'factors' | 'va' | 'vaNote'>;
function FieldTds({ entry, canWrite, editing, onSet }: {
  entry: FieldOwner; canWrite: boolean; editing: boolean; onSet: (patch: Partial<FieldOwner>) => void;
}) {
  const edit = editing && canWrite;
  return (
    <>
      <td><FieldText editing={edit} value={entry.desc ?? ''} onChange={(v) => onSet({ desc: v })} placeholder="定义" /></td>
      <td><FieldText editing={edit} value={entry.sp ?? ''} onChange={(v) => onSet({ sp: v })} placeholder="动作开始" /></td>
      <td><FieldText editing={edit} value={entry.ep ?? ''} onChange={(v) => onSet({ ep: v })} placeholder="动作结束" /></td>
      <td><FieldText editing={edit} mono value={entry.format ?? ''} onChange={(v) => onSet({ format: v || null })} placeholder="（无标准格式，描述手写）" /></td>
      <td><FieldText editing={edit} value={entry.factors ?? ''} onChange={(v) => onSet({ factors: v || null })} placeholder="如：转身/尺寸" /></td>
      <td>
        {edit ? (
          <>
            {/* v3.59.1 SelectMenu 自绘，根治原生 popup 漂移飞走 */}
            <SelectMenu ariaLabel="VA 类别"
              value={entry.va ?? ''}
              onChange={(v) => onSet({ va: v || null })}
              options={VA_OPTIONS.map((o) => ({ value: o.v, label: o.label }))} />
            {entry.vaNote && <textarea className="std-vanote-edit" value={entry.vaNote} rows={2} placeholder="条件判定说明" onChange={(e) => onSet({ vaNote: e.target.value || null })} />}
          </>
        ) : (
          <div className="std-va-cell">
            <VaBadge va={entry.va} />
            {entry.vaNote && <div className="std-vanote" title={entry.vaNote}>{entry.vaNote}</div>}
          </div>
        )}
      </td>
    </>
  );
}

/** 通用文本单元格：查看态渲染纯文本（自动换行），编辑态渲染 input */
function FieldText({ editing, value, onChange, placeholder, mono }: {
  editing: boolean; value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean;
}) {
  if (!editing) {
    return <div className={'std-cell' + (mono ? ' mono' : '')}>{value || <span className="std-empty">{EMPTY}</span>}</div>;
  }
  return <input className={'std-cell-input' + (mono ? ' mono' : '')} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

/** VA 三分彩色徽章（绿=增值 / 琥珀=必要非增值 / 红=非增值） */
function VaBadge({ va }: { va?: string | null }) {
  const cls = va === 'VA' ? 'va' : va === 'RNVA' ? 'rnva' : va === 'NVA' ? 'nva' : 'na';
  const txt = va === 'VA' ? 'VA 增值' : va === 'RNVA' ? 'RNVA 必要非增值' : va === 'NVA' ? 'NVA 非增值' : (va || EMPTY);
  return <span className={'std-va-badge ' + cls}>{txt}</span>;
}
