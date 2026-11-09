/**
 * 动作要素（动素类型）自定义下拉（v3.18 → v3.20 录入加速版）。
 *
 * 为什么替换原生 <select>：① 原生下拉列表由浏览器按**视口坐标**渲染，而类型控件位于
 * 可滚动的属性检查器内——检查器一滚动，弹窗就留在原处“飞走”；② 检查器入场动画
 * （wb-in，fill 模式 both）在元素上留下恒等 transform，使其成为 fixed 元素的包含块，
 * 弹窗坐标被错算到屏幕外——这就是用户看到的“自动漂移、像飞了一样”。
 *
 * 本组件双保险：① 弹窗经 **createPortal 挂到 document.body**，position:fixed 以视口为
 * 基准，不受任何祖先 transform/滚动容器影响；② scroll/resize 实时重算 + rAF 循环
 * 帧级跟随按钮，任何布局变化下弹窗始终贴着按钮。
 * 分组（一级分类）+ 经典动素兼容组；键盘 ↑↓/Home/End/Enter/Esc 全支持；
 * 打开期间由调用方屏蔽全局快捷键（onOpenChange），Esc 只关下拉不取消要素选中。
 *
 * v3.20 录入加速（用户反馈：43 项冗长下拉，靠后的“转身”们难找，拖慢录入）：
 *  ① 顶部搜索框：输入即过滤——中文子串（"转身"/"转"）+ 拼音首字母（"zs"）+ 车间口语
 *     别名（"拧"→装配），命中高亮；无查询时按使用频次智能排序（常用置顶）；
 *  ② 手动录入：查无此选项时给出「↵ 录入“xxx”→ 识别为“转身”」行——句首动词自动
 *     归类到对应类型，残留文本交回调用方回填字段/描述（识别不出归「其他」）；
 *  ③ 零点击流：按钮聚焦后直接敲字母即打开并开始检索（typeahead），Enter 选中。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MotionEntry, MotionGroup } from '../motionStandard';
import { bumpFreq, freqScore, identifyVerb, loadFreq, matchType, topFreqTypes, visibleHit } from '../typeFreq';

interface Props {
  value: string;
  /** 公司动作标准分组（一级→二级） */
  groups: MotionGroup[];
  /** 经典动素兼容组选项（旧数据） */
  classicOptions: string[];
  /** 类型 → 条目（用于当前值回显） */
  byType: Record<string, MotionEntry>;
  onChange: (type: string) => void;
  /** 手动录入（v3.20）：识别出的动词 + 残留文本 + 原始输入 */
  onManual?: (verb: string, rest: string, raw: string) => void;
  /** 开合状态回调：调用方据此暂停全局快捷键，避免 ↑↓/Enter 被双重消费 */
  onOpenChange?: (open: boolean) => void;
  /** 按钮聚焦状态（typeahead 检索期）：调用方据此让位单键快捷键 */
  onFocusChange?: (focused: boolean) => void;
}

interface Row {
  kind: 'h' | 'o' | 'm';
  label: string;
  type?: string;
  /** 一级要素行（v3.49 可选）：加粗样式，作为其下二级的分组入口 */
  top?: boolean;
  /** 二级选项（挂在其一级行下，缩进显示） */
  sub?: boolean;
  /** 手动录入行携带的识别结果 */
  manual?: { verb: string; rest: string; recognized?: boolean };
  /** 可导航行（选项/手动行）的扁平索引——同类型在「常用+全量」两区出现时高亮唯一 */
  navIdx?: number;
}

const MENU_MIN_W = 190;
const MENU_MAX_H = 330;

export default function TypeSelect({ value, groups, classicOptions, byType, onChange, onManual, onOpenChange, onFocusChange }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; minW: number } | null>(null);
  const [query, setQuery] = useState('');
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** typeahead 初始查询：聚焦按钮敲字母即打开——打开效应默认清空查询，
   *  此 ref 让"打开时带来的首个字符"不被清掉（零点击流的关键一环） */
  const initQueryRef = useRef<string | null>(null);

  /** 基础行序列（全量）：一级选项 + 缩进二级（active 索引只在选项行上前移）。
   *  v3.49 一级要素可选（用户需求）：一级本身即选项（加粗行，充当分组入口），其下二级缩进排列
   *  ——替换 v3.19「有二级 → 一级作不可选分组头」规则（该规则下 装配/操作/移动/检查 无法直选）。
   *  词表侧由 motionStandard.parseMotionStandard 为有二级的分组建 level1 条目保证描述链路一致。
   *  v3.19 反面教训仍有效：不再渲染与选项同名的分组头，一级行只有一条、不会出现两个"拿取"。 */
  const { rows, opts } = useMemo(() => {
    const rows: Row[] = [];
    const opts: string[] = [];
    for (const g of groups) {
      rows.push({ kind: 'o', label: g.level1, type: g.level1, top: true });
      opts.push(g.level1);
      for (const s of g.subs) {
        rows.push({ kind: 'o', label: s.type, type: s.type, sub: true });
        opts.push(s.type);
      }
    }
    if (classicOptions.length > 0) {
      rows.push({ kind: 'h', label: '经典动素（旧数据兼容）' });
      for (const t of classicOptions) { rows.push({ kind: 'o', label: t, type: t }); opts.push(t); }
    }
    return { rows, opts };
  }, [groups, classicOptions]);

  /** 常用区（无查询时）：有历史才出，取频次前 5——最高频类型永远排最前、路径最短 */
  const favTypes = useMemo(() => (query.trim() ? [] : topFreqTypes(5)), [query]);

  /** 查询结果：匹配层级升序 + 同层频次降序；分组头在查询态一律不渲染 */
  const filtered = useMemo(() => {
    const s = query.trim();
    if (!s) return null;
    return opts
      .map((t) => ({ t, tier: matchType(t, s) }))
      .filter((x) => x.tier >= 0)
      .sort((a, b) => a.tier - b.tier || freqScore(b.t) - freqScore(a.t))
      .map((x) => x.t);
  }, [query, opts]);

  /** 手动录入行：有查询且无精确同名项时给出——动词识别归类，残留文本回填。
   *  出现条件（避免打扰纯检索）：① 动词+残留内容（"转身180"）= 明确录入意图；
   *  ② 查无此项 = 兜底录入；③ 中文短语但动词识别不出 = 归「其他」录入。
   *  纯检索词（拼音"zs"/别名"拧"/子串"转"命中选项）不出现录入行——回车选首项即可。 */
  const manualRow = useMemo(() => {
    const s = query.trim();
    if (!s || !onManual) return null;
    if (opts.some((t) => t === s)) return null; // 精确同名 = 正常选项，无需录入行
    const hit = identifyVerb(s, opts);
    const anyMatch = opts.some((t) => matchType(t, s) >= 0);
    if (hit && hit.rest) return { verb: hit.verb, rest: hit.rest, recognized: true };
    if (!anyMatch) return { verb: hit?.verb ?? '其他', rest: hit?.rest ?? s, recognized: !!hit };
    if (!hit && /[\u4e00-\u9fff]/.test(s)) return { verb: '其他', rest: s, recognized: false };
    return null;
  }, [query, opts, onManual]);

  /** 当前可见行序列（渲染 + 键盘导航共用；分组头不占 active，navIdx 保证高亮唯一） */
  const viewRows: Row[] = useMemo(() => {
    const list: Row[] = [];
    let nav = 0;
    const pushNav = (r: Row) => { list.push({ ...r, navIdx: nav }); nav += 1; };
    if (filtered) {
      const optList = [...filtered];
      // 识别出动词时，把动词本身也作为普通选项露出（"转身180" → 除录入行外还能直接选"转身"）
      if (manualRow?.recognized && !optList.includes(manualRow.verb)) optList.unshift(manualRow.verb);
      // 录入行置顶：查询带残留内容 = 整句录入意图，回车优先走"识别+回填"全链路
      if (manualRow) {
        pushNav({
          kind: 'm',
          label: `录入“${query.trim()}”→ ${manualRow.recognized ? `识别为“${manualRow.verb}”` : '归入“其他”（描述手写）'}${manualRow.rest ? `，残留“${manualRow.rest}”回填` : ''}`,
          manual: manualRow,
        });
      }
      for (const t of optList) pushNav({ kind: 'o', label: t, type: t });
      return list;
    }
    if (favTypes.length > 0) {
      list.push({ kind: 'h', label: '常用 · 按你的使用频次' });
      for (const t of favTypes) pushNav({ kind: 'o', label: t, type: t });
    }
    for (const r of rows) {
      if (r.kind === 'h') list.push(r);
      else pushNav(r);
    }
    return list;
  }, [filtered, manualRow, favTypes, query, rows]);

  /** 可导航行（选项 + 手动行）的扁平索引 */
  const navRows = useMemo(() => viewRows.filter((r) => r.kind !== 'h'), [viewRows]);

  useEffect(() => { onOpenChange?.(open); }, [open, onOpenChange]);

  /** 锚定定位：贴按钮下方；空间不足翻到上方；左右不超出视口 */
  const place = useCallback(() => {
    const btn = btnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const menuH = menuRef.current?.offsetHeight ?? MENU_MAX_H;
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    let top = r.bottom + 4;
    if (top + menuH > vh - 8) top = Math.max(8, r.top - menuH - 4);
    const left = Math.min(Math.max(8, r.left), Math.max(8, vw - MENU_MIN_W - 8));
    setPos({ left, top, minW: Math.max(r.width, MENU_MIN_W) });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    // capture 捕获检查器内部滚动——弹窗即时跟随按钮
    const onScroll = () => place();
    const onResize = () => place();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!btnRef.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, place]);

  /** 锚定跟随（rAF 循环，v3.18 漂移修复的关键）：
   *  滚动/重排/其他副作用都可能移动按钮（原生 select 的弹窗按视口坐标渲染，此时就会"飞走"）；
   *  打开期间每帧比对按钮视口位置，一旦变化立即重算弹窗位置——弹窗永远贴着按钮。 */
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    let lastL = Number.NaN;
    let lastT = Number.NaN;
    const tick = () => {
      const btn = btnRef.current;
      if (btn) {
        const r = btn.getBoundingClientRect();
        if (r.left !== lastL || r.top !== lastT) {
          lastL = r.left;
          lastT = r.top;
          place();
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [open, place]);

  /** 打开时：定位到当前值 + 搜索框聚焦（键入即检索，零点击流） */
  useEffect(() => {
    if (!open) return;
    setQuery(initQueryRef.current ?? '');
    initQueryRef.current = null;
    const i = navRows.findIndex((r) => r.type === value);
    setActive(i >= 0 ? i : 0);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** 激活项滚入菜单可视区：手动算 scrollTop，不用 scrollIntoView——
   *  scrollIntoView 会连带滚动外层滚动容器（检查器），导致打开下拉时页面莫名跳动 */
  const revealActive = useCallback(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const el = menu.querySelector<HTMLElement>('[data-active="1"]');
    if (!el) return;
    const viewTop = menu.scrollTop;
    const viewBottom = viewTop + menu.clientHeight;
    const elTop = el.offsetTop;
    const elBottom = elTop + el.offsetHeight;
    if (elTop < viewTop + 4) menu.scrollTop = Math.max(0, elTop - 4);
    else if (elBottom > viewBottom - 4) menu.scrollTop = elBottom - menu.clientHeight + 4;
  }, []);

  useEffect(() => {
    if (!open) return;
    revealActive();
  }, [active, open, revealActive, viewRows]);

  const pick = (t?: string) => {
    setOpen(false);
    btnRef.current?.focus();
    if (!t) return;
    // 同值重选也记频次（用户又选了一次 = 一次真实使用；onChange 仍按需触发）
    bumpFreq(t);
    if (t !== value) onChange(t);
  };

  const commitManual = () => {
    if (!manualRow) return;
    const raw = query.trim();
    setOpen(false);
    btnRef.current?.focus();
    bumpFreq(manualRow.verb);
    onManual?.(manualRow.verb, manualRow.rest, raw);
  };

  const onKey = (e: React.KeyboardEvent) => {
    const k = e.key;
    if (!open) {
      // 可打印字符 = typeahead：聚焦按钮后直接敲字母即打开并开始检索（不再先点开再找）
      if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        initQueryRef.current = k;
        setQuery(k);
        setOpen(true);
        return;
      }
      // 组合键（Ctrl/Cmd+Enter 等）不消费——交给全局「完成·下一个」等快捷键：
      // 否则焦点在类型按钮上按 Ctrl+Enter 会先被这里重开菜单，React 同步刷新把
      // typeMenuOpenRef 置 true，随后的 window handler 被拦截，「完成·下一个」静默失效（v3.26 实测）
      if ((k === 'Enter' || k === ' ' || k === 'ArrowDown') && !e.ctrlKey && !e.metaKey) { e.preventDefault(); setOpen(true); }
      return;
    }
    const n = navRows.length;
    if (k === 'ArrowDown') { e.preventDefault(); setActive((i) => (n ? Math.min(n - 1, i + 1) : 0)); }
    else if (k === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (k === 'Home') { e.preventDefault(); setActive(0); }
    else if (k === 'End') { e.preventDefault(); setActive(Math.max(0, n - 1)); }
    else if (k === 'Enter' || k === ' ') {
      e.preventDefault();
      const row = navRows[active];
      if (row?.kind === 'm') commitManual();
      else pick(row?.type);
    }
    else if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); }
  };

  /** 菜单内搜索框按键：↑↓/Enter/Esc 与按钮版同义；其余字符交给输入框自身 */
  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const k = e.key;
    if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Home' || k === 'End' || k === 'Enter' || k === ' ') {
      e.preventDefault();
      onKey(e as unknown as React.KeyboardEvent);
      return;
    }
    if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); btnRef.current?.focus(); }
  };

  /** 标签高亮：查询串的可见子串部分包 <mark>；拼音/别名命中无可见子串则原样 */
  const renderLabel = (label: string) => {
    const s = query.trim();
    if (!s) return label;
    const idx = visibleHit(label, s);
    if (idx < 0) return label;
    return (
      <>
        {label.slice(0, idx)}<mark className="wb-tsel-mark">{label.slice(idx, idx + s.length)}</mark>{label.slice(idx + s.length)}
      </>
    );
  };

  return (
    <div className="wb-tsel">
      <button
        ref={btnRef}
        type="button"
        className={`wb-tsel-btn${open ? ' open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKey}
        onFocus={() => onFocusChange?.(true)}
        onBlur={() => onFocusChange?.(false)}
        title="动作要素（= 描述句首动词）：聚焦后直接输入即可检索（支持拼音首字母/口语别名），也可手动录入整句自动归类"
      >
        <span className="wb-tsel-v">{value}</span>
        <i className="wb-tsel-caret" aria-hidden>▾</i>
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          className="wb-tsel-menu"
          role="listbox"
          style={{ left: pos.left, top: pos.top, minWidth: pos.minW }}
        >
          {/* 搜索框（v3.20）：输入即匹配——中文/拼音首字母/口语别名三路模糊 */}
          <input
            ref={inputRef}
            className="wb-tsel-q"
            value={query}
            placeholder="检索类型：转身 / zs / 拧…"
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={onInputKey}
            onMouseDown={(e) => e.stopPropagation()}
          />
          {viewRows.map((r, ri) => {
            if (r.kind === 'h') return <div key={`h-${ri}`} className="wb-tsel-h">{r.label}</div>;
            if (r.kind === 'm') {
              return (
                <div
                  key="manual"
                  role="option"
                  aria-selected={false}
                  className="wb-tsel-o wb-tsel-manual"
                  data-active={r.navIdx === active ? '1' : undefined}
                  onMouseEnter={() => setActive(r.navIdx ?? 0)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={commitManual}
                  title="手动录入：句首动词自动归类，其余文本回填描述字段"
                >
                  <i className="wb-tsel-manual-k">↵</i>
                  <span>{r.label}</span>
                </div>
              );
            }
            const f = loadFreq()[r.type ?? ''];
            return (
              <div
                key={`o-${r.type}-${r.navIdx}`}
                role="option"
                aria-selected={r.type === value}
                className={`wb-tsel-o${r.top ? ' top' : ''}${r.sub ? ' sub' : ''}${r.type === value ? ' on' : ''}`}
                data-active={r.navIdx === active ? '1' : undefined}
                onMouseEnter={() => setActive(r.navIdx ?? 0)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(r.type)}
                title={f ? `已选用 ${f.n} 次` : (byType[r.type ?? '']?.desc || undefined)}
              >
                {renderLabel(r.label)}
              </div>
            );
          })}
          {navRows.length === 0 && (
            <div className="wb-tsel-none">无匹配项{onManual ? '——可直接回车录入' : ''}</div>
          )}
          <div className="wb-tsel-foot">输入即筛选 · <kbd>↑</kbd><kbd>↓</kbd> 选择 · <kbd>↵</kbd> 选定/录入 · <kbd>Esc</kbd> 关闭</div>
        </div>,
        document.body,
      )}
    </div>
  );
}
