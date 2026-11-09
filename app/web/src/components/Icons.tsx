/* ============================================================
 * Icons.tsx · 通用行内 SVG 图标（v3.60）
 * ------------------------------------------------------------
 * 收口页面里散落的装饰性 emoji（☰ / ✅ / ❌），统一为单色描边 SVG：
 *   · 用 currentColor，自动跟随语义色（成功松绿 / 失败砖红 / 次要墨色）
 *   · 与字号解耦、不依赖系统字体是否带该字形——内网机器缺字形时 emoji 会变豆腐块
 *   · 柔和工业风：细描边（1.8~2）、圆角线帽，不做实心色块
 * ============================================================ */

/** 汉堡菜单（侧栏收起后的展开入口） */
export const IconMenu = (p: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={p.size ?? 14} height={p.size ?? 14} aria-hidden="true"
    style={{ verticalAlign: '-2px' }}>
    <path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

/** 通过 / 成功（细描边对勾圆圈） */
export const IconCheck = (p: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={p.size ?? 13} height={p.size ?? 13} aria-hidden="true"
    style={{ verticalAlign: '-1px', marginRight: 3 }}>
    <circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
    <path d="M7.9 12.3l2.9 2.9 5.4-6" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** 失败 / 未通过（细描边叉号圆圈） */
export const IconCross = (p: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={p.size ?? 13} height={p.size ?? 13} aria-hidden="true"
    style={{ verticalAlign: '-1px', marginRight: 3 }}>
    <circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
    <path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" />
  </svg>
);
