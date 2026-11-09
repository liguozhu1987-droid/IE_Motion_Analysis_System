import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * AI 调用全局横幅（所有 AI 生成入口的统一反馈件，v3.61）：
 *  - fixed 悬浮于顶栏下方居中；portal 挂 body（浮层铁律：规避 transform/zoom 容器定位漂移）；
 *  - 调用中 = 旋转指示 + 调用名称 + 阶段说明 + 已进行秒数 + 不定长进度条；
 *  - active=false 时不渲染（结果反馈仍走各页 success/error-banner，横幅只管"正在调用"）；
 *  - 纯展示组件，不持有业务状态；同一页面可叠放多个实例（同时只会有一个 active）。
 */
export default function AiCallBanner(
  { active, label, phase }: { active: boolean; label: string; phase?: string | null },
) {
  const startRef = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!active) { startRef.current = null; setElapsed(0); return; }
    startRef.current = Date.now();
    const timer = setInterval(() => {
      if (startRef.current != null) {
        setElapsed(Math.round((Date.now() - startRef.current) / 1000));
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [active]);

  if (!active) return null;
  return createPortal(
    <div className="ai-call-banner" role="status" aria-live="polite">
      <span className="ai-call-spinner" aria-hidden="true" />
      <div className="ai-call-body">
        <div className="ai-call-line">
          <b>{label}</b>
          {phase ? <span className="muted">{phase}</span> : null}
          {elapsed > 0 && <span className="ai-call-elapsed">已进行 {elapsed}s</span>}
        </div>
        <div className="ai-call-track" aria-hidden="true" />
      </div>
    </div>,
    document.body,
  );
}
