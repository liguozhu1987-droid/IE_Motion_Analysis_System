/**
 * 批量确认弹窗（v3.33）
 * 防误操作：批量接受不可逆，必须二次确认并告知影响面。
 * 关键实现点（对应 DESIGN C13/F6）：
 * 1) createPortal(document.body) —— 避免父级任何 transform 造成 fixed 定位错算
 * 2) 默认焦点在「取消」，Esc = 取消（不是确认）
 * 3) 关闭后焦点归 body，绝不归还触发按钮（否则空格/回车会重复触发；v3.27 铁律）
 */
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Candidate, HAND_LABEL } from './types';

interface Props {
  open: boolean;
  items: Candidate[];
  onCancel: () => void;
  onConfirm: () => void;
}

function fmt(ms: number): string {
  const s = Math.round(ms / 100) / 10;
  return `${s.toFixed(1)}s`;
}

export default function AiBatchConfirm({ open, items, onCancel, onConfirm }: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      // 捕获阶段拦截，防止工作台全局快捷键同时响应
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      const el = document.activeElement as HTMLElement | null;
      el?.blur?.();
      document.body.focus?.();
    };
  }, [open, onCancel]);

  if (!open) return null;

  const count = items.length;
  const start = count ? Math.min(...items.map((c) => c.start_ms)) : 0;
  const end = count ? Math.max(...items.map((c) => c.end_ms)) : 0;
  const weak = items.filter((c) => c.tier === 'low').length;
  const byHand = items.reduce<Record<string, number>>((acc, c) => {
    acc[c.hand] = (acc[c.hand] ?? 0) + 1;
    return acc;
  }, {});
  const handText = (['B', 'L', 'R'] as const)
    .filter((h) => byHand[h])
    .map((h) => `${HAND_LABEL[h]} ${byHand[h]}`)
    .join(' / ');

  const body = (
    <div className="ais-modal-mask" role="presentation" onMouseDown={onCancel}>
      <div
        className="ais-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ais-batch-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h4 id="ais-batch-title">接受 {count} 条 AI 候选</h4>
        <dl>
          <dt>影响范围</dt>
          <dd>
            {fmt(start)} – {fmt(end)}（跨度 {fmt(end - start)}）
          </dd>
          <dt>手别分布</dt>
          <dd>{handText || '—'}</dd>
          <dt>需复核</dt>
          <dd>{weak > 0 ? `${weak} 条低置信` : '无'}</dd>
          <dt>可撤回</dt>
          <dd>可用 Ctrl+Z 整批撤销</dd>
        </dl>
        {weak > 0 && (
          <div className="ais-warn">
            其中 {weak} 条置信度偏低，接受后请逐条核对起止点，再提交。
          </div>
        )}
        <div className="ais-modal-foot">
          <button ref={cancelRef} className="btn" type="button" onClick={onCancel}>
            取消
          </button>
          <button className="btn primary" type="button" onClick={onConfirm}>
            确认接受
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(body, document.body);
}
