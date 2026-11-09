import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface SelectOption {
  value: string;
  label: string;
  /** 右侧灰色补充信息（如「· 2 工位」「NPI · 华南客户A」） */
  hint?: string;
  /** 强调项（如「＋ 新建产线…」）：蓝色 + 顶部分隔线 */
  accent?: boolean;
}

interface Props {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  /** 无障碍标签（弹窗内多个下拉共存时必须给） */
  ariaLabel?: string;
  disabled?: boolean;
  /** 触发器按钮内联样式（替换非 .filter-item 容器里的原生 select 时用来保持原宽度） */
  triggerStyle?: React.CSSProperties;
  /** 触发器按钮附加 class（用于按容器定制宽度/底色等） */
  triggerClassName?: string;
  /** 错误态：红框红底（替代原生 select 的 in-err，如表单必填校验失败） */
  error?: boolean;
}

/**
 * 自绘下拉（v3.21）：替代原生 <select>。
 * 为什么必须换掉：用户在「新建分析对象」弹窗里实测原生下拉弹出列表飘到浏览器窗口左上角
 * （Chromium 在特定 DPI/缩放/版本组合下原生 popup 定位 bug，本仓库无头环境无法复现、
 * CSS 侧无解——transform/filter/zoom 排查均干净）。自绘浮层用 JS 算坐标 + portal 挂 body，
 * 定位完全自主可控，顺带获得：弹窗内不被 overflow 裁剪、列表可加 hint、键盘行为统一。
 * 交互对齐原生 select：↑↓/Enter/Esc/Home/End、可打印字符 typeahead 跳到匹配项、
 * 点击外部关闭、下方空间不足自动向上翻转（Flip）。
 */
export default function SelectMenu({ value, options, onChange, placeholder = '请选择', ariaLabel, disabled, triggerStyle, triggerClassName, error }: Props) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; up: boolean } | null>(null);
  const [active, setActive] = useState(0);
  const taRef = useRef({ buf: '', t: 0 });

  const current = options.find((o) => o.value === value);
  const idx = Math.max(0, options.findIndex((o) => o.value === value));

  /* 打开时：坐标 = 触发器视口位置（fixed）；空间不足向上翻转；激活当前项 */
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const btn = btnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom - 8;
    const need = Math.min(320, options.length * 32 + 16);
    const up = spaceBelow < need && r.top > spaceBelow;
    setPos({
      top: up ? r.top - need - 4 : r.bottom + 4,
      left: r.left,
      width: Math.max(r.width, 220),
      up,
    });
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
  }, [open, options, value]);

  /* 打开时滚动激活项进入可视区 */
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>('[data-active="1"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  /* 点击外部关闭（pointerdown 比 click 更早，避免与选项 click 竞争） */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || listRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  const commit = (v: string) => {
    setOpen(false);
    btnRef.current?.focus();
    onChange(v);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(options.length - 1, i + 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); return; }
    if (e.key === 'Home') { e.preventDefault(); setActive(0); return; }
    if (e.key === 'End') { e.preventDefault(); setActive(options.length - 1); return; }
    if (e.key === 'Enter') { e.preventDefault(); commit(options[active]?.value ?? ''); return; }
    // typeahead：可打印字符跳到下一个匹配项（原生 select 行为）
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = Date.now();
      const buf = now - taRef.current.t < 800 ? taRef.current.buf + e.key : e.key;
      taRef.current = { buf, t: now };
      const from = buf.length === 1 ? active + 1 : active;
      const pool = from >= options.length ? options : [...options.slice(from), ...options.slice(0, from)];
      const hit = pool.find((o) => o.label.toLowerCase().startsWith(buf.toLowerCase()));
      if (hit) setActive(options.indexOf(hit));
    }
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`sm-trigger${triggerClassName ? ` ${triggerClassName}` : ''}${error ? ' sm-err' : ''}`}
        style={triggerStyle}
        aria-label={ariaLabel}
        aria-invalid={error || undefined}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
      >
        <span className={`sm-value${current ? '' : ' sm-ph'}`}>{current?.label ?? placeholder}</span>
        {current?.hint && <span className="sm-hint">{current.hint}</span>}
        <span className="sm-caret">▾</span>
      </button>
      {open && pos && createPortal(
        <div
          ref={listRef}
          className="sm-menu"
          role="listbox"
          style={{ top: pos.top, left: pos.left, width: pos.width }}
          onKeyDown={onKeyDown}
        >
          {options.map((o, i) => (
            <div
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={`sm-option${o.value === value ? ' on' : ''}${o.accent ? ' accent' : ''}`}
              data-active={i === active ? '1' : undefined}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => commit(o.value)}
            >
              <span className="sm-o-label">{o.label}</span>
              {o.hint && <span className="sm-o-hint">{o.hint}</span>}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
