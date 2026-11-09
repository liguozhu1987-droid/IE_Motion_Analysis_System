/**
 * 快捷工具箱（v3.20，Ctrl+K 唤起）：命令面板式"可调用工具箱"。
 *
 * 设计依据（IE 动作经济 + 人机工程学）：
 *  ① 工具向人聚拢，而非人找工具——顶栏/检查器/时间线/传输栏四处的操作收进一个面板，
 *     一次唤起、打字过滤、回车执行；鼠标移动距离与点击次数同时下降；
 *  ② 与类型检索同构的交互（输入即过滤 + ↑↓ + Enter + Esc）——用户只需学一次；
 *  ③ 每个动作带快捷键徽标：面板即"活文档"，常用后自然迁移到纯键盘流（零点击）。
 *
 * 组件只做呈现与调度，业务逻辑全部由调用方以 run 回调注入（不新增任何状态源）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';

export interface ToolAction {
  id: string;
  /** 所属分组（按首次出现顺序排列） */
  group: string;
  label: string;
  /** 补充说明（何时用/注意点） */
  hint?: string;
  /** 快捷键徽标（纯展示） */
  kbd?: string;
  run: () => void;
  disabled?: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  actions: ToolAction[];
}

export default function Toolbox({ open, onClose, actions }: Props) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  /** 过滤：标签/分组/提示/快捷键四路子串（大小写不敏感） */
  const matched = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return actions;
    return actions.filter((a) =>
      [a.label, a.group, a.hint ?? '', a.kbd ?? ''].some((f) => f.toLowerCase().includes(s)),
    );
  }, [q, actions]);

  /** 分组（保持 actions 内的原始顺序） */
  const groups = useMemo(() => {
    const order: string[] = [];
    for (const a of matched) if (!order.includes(a.group)) order.push(a.group);
    return order.map((g) => ({ g, items: matched.filter((a) => a.group === g) }));
  }, [matched]);

  const flat = useMemo(() => groups.flatMap((x) => x.items), [groups]);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setActive(0);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  /** 激活项滚入可视区（手算 scrollTop，避免 scrollIntoView 连带滚动外层） */
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLElement>('[data-active="1"]');
    if (!el) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < list.scrollTop + 4) list.scrollTop = Math.max(0, top - 4);
    else if (bottom > list.scrollTop + list.clientHeight - 4) list.scrollTop = bottom - list.clientHeight + 4;
  }, [active, flat]);

  if (!open) return null;

  const runAt = (i: number) => {
    const a = flat[i];
    if (!a || a.disabled) return;
    onClose();
    a.run();
  };

  const onKey = (e: React.KeyboardEvent) => {
    const k = e.key;
    if (k === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(flat.length - 1, i + 1)); }
    else if (k === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (k === 'Enter') { e.preventDefault(); runAt(active); }
    else if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
  };

  return (
    <div className="wb-tbx-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="wb-tbx" role="dialog" aria-label="快捷工具箱">
        <input
          ref={inputRef}
          className="wb-tbx-q"
          value={q}
          placeholder="工具箱：输入即过滤（删除 / 起点 / 批量…），回车执行"
          onChange={(e) => { setQ(e.target.value); setActive(0); }}
          onKeyDown={onKey}
        />
        <div className="wb-tbx-list" ref={listRef}>
          {groups.map((x) => (
            <div key={x.g} className="wb-tbx-g">
              <div className="wb-tbx-gh">{x.g}</div>
              {x.items.map((a) => {
                const i = flat.indexOf(a);
                return (
                  <div
                    key={a.id}
                    className={`wb-tbx-i${a.disabled ? ' disabled' : ''}`}
                    data-active={i === active ? '1' : undefined}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => runAt(i)}
                  >
                    <span className="wb-tbx-label">{a.label}</span>
                    {a.hint && <span className="wb-tbx-hint">{a.hint}</span>}
                    {a.kbd && <span className="wb-tbx-kbd">{a.kbd}</span>}
                  </div>
                );
              })}
            </div>
          ))}
          {flat.length === 0 && <div className="wb-tbx-none">无匹配动作</div>}
        </div>
        <div className="wb-tbx-foot"><kbd>↑</kbd><kbd>↓</kbd> 选择 · <kbd>↵</kbd> 执行 · <kbd>Esc</kbd> 关闭 · 常用操作建议改用对应快捷键（零点击）</div>
      </div>
    </div>
  );
}
