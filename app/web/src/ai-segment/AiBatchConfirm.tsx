/**
 * 批量确认弹窗（v3.33，2026-11-22 改原生 <dialog>）
 * 防误操作：批量接受不可逆，必须二次确认并告知影响面。
 * 关键实现点：
 * 1) 原生 <dialog> + showModal()：浏览器提供 top-layer、::backdrop、Esc/返回手势、
 *    焦点限制与背景 inert —— 不再手写 role="dialog"/aria-modal/焦点陷阱/Esc 监听。
 * 2) 默认焦点在「取消」。
 * 3) v3.27 铁律不变：关闭后焦点归 body，绝不归还触发按钮
 *    （原生 dialog 默认会把焦点还给调用元素，这里在 close 事件里主动 blur 覆盖它）。
 */
import { useEffect, useRef } from 'react';
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
  const dlgRef = useRef<HTMLDialogElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  /** 本次打开内是否已处理过确认/取消，避免 close 事件重复回调 */
  const handledRef = useRef<'confirm' | 'cancel' | null>(null);

  useEffect(() => {
    const dlg = dlgRef.current;
    if (!dlg) return;
    if (open) {
      handledRef.current = null;
      if (!dlg.open) {
        dlg.showModal();
        cancelRef.current?.focus();
      }
    } else if (dlg.open) {
      dlg.close();
    }
  }, [open]);

  useEffect(() => {
    const dlg = dlgRef.current;
    if (!dlg) return;
    const onClose = () => {
      // v3.27 铁律：焦点归 body（覆盖原生 dialog 的「还给调用元素」）
      (document.activeElement as HTMLElement | null)?.blur?.();
      if (!handledRef.current) {
        handledRef.current = 'cancel';
        onCancel();
      }
    };
    dlg.addEventListener('close', onClose);
    return () => dlg.removeEventListener('close', onClose);
  }, [onCancel]);

  const doCancel = () => {
    if (handledRef.current) return;
    handledRef.current = 'cancel';
    onCancel();
  };
  const doConfirm = () => {
    if (handledRef.current) return;
    handledRef.current = 'confirm';
    onConfirm();
  };

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

  return (
    <dialog
      ref={dlgRef}
      className="ais-modal"
      aria-labelledby="ais-batch-title"
      // 点击 ::backdrop（事件目标是 dialog 本身）等同取消
      onClick={(e) => { if (e.target === dlgRef.current) doCancel(); }}
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
        <button ref={cancelRef} className="btn" type="button" onClick={doCancel}>
          取消
        </button>
        <button className="btn primary" type="button" onClick={doConfirm}>
          确认接受
        </button>
      </div>
    </dialog>
  );
}