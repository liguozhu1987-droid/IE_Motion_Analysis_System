/**
 * 自动消失横幅（v3.20）：校验/成功/警告提示一律可手动关闭 + 到时自动消失。
 *
 * 背景（用户反馈）：提交校验后的错误提示常驻界面且无法关闭，遮挡操作面板——
 * 按 IE 动作经济，提示是"持住（Hold）"型浪费：占着版面与注意力却不产生价值。
 * 治理口径：① 每条右上角 × 手动关闭；② 分类超时自动消失（错误 10s / 成功 6s /
 * 警告 10s / 校验问题 12s）；③ 内容变更 = 新实例（key 变化），计时器自然重置；
 * ④ 容器 pointer-events:none，仅横幅本体可点——视频区不被遮挡仍可操作。
 *
 * onClose 用 ref 持有：父组件每次渲染都会传新的箭头函数，直接进依赖会无限重置计时器。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

interface Props {
  kind: 'error' | 'success' | 'warn';
  /** 自动消失毫秒数（<=0 不自动消失） */
  ms?: number;
  onClose: () => void;
  children: ReactNode;
}

export default function AutoBanner({ kind, ms = 10000, onClose, children }: Props) {
  const [gone, setGone] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (ms <= 0) return;
    const t = setTimeout(() => { setGone(true); closeRef.current(); }, ms);
    return () => clearTimeout(t);
  }, [ms]);

  if (gone) return null;
  return (
    <div className={`banner-${kind} wb-banner`}>
      <span
        className="wb-banner-x"
        role="button"
        tabIndex={0}
        title="关闭提示"
        aria-label="关闭提示"
        onClick={() => { setGone(true); closeRef.current(); }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setGone(true); closeRef.current(); } }}
      >
        ×
      </span>
      {children}
    </div>
  );
}
