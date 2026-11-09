import type { Hands } from '../api';
import { VA_COLOR } from '../constants';

/** 双手作业图：左右手两行，橙色块=各要素，灰色=空闲段（文档02 §7） */
export default function HandsChart({ hands }: { hands: Hands }) {
  const cycle = Math.max(hands.cycle_ms, 1000);
  const W = 860;
  const rowH = 34;
  const labelW = 44;
  const H = rowH * 2 + 34;
  const scale = (ms: number) => labelW + (ms / cycle) * (W - labelW - 14);
  const rows: { key: 'L' | 'R'; label: string; blocks: Hands['L'] }[] = [
    { key: 'L', label: '左手', blocks: hands.L },
    { key: 'R', label: '右手', blocks: hands.R },
  ];

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="双手作业图">
      {[0, 0.25, 0.5, 0.75, 1].map((k) => (
        <g key={k}>
          <line x1={scale(cycle * k)} x2={scale(cycle * k)} y1={18} y2={H - 12} stroke="#f0f3f8" />
          <text x={scale(cycle * k)} y={12} textAnchor="middle" fontSize="9" fill="#9aa5b5">
            {(cycle * k / 1000).toFixed(1)}s
          </text>
        </g>
      ))}
      {rows.map((row, index) => {
        const top = 24 + index * rowH;
        const idle = index === 0 ? hands.idle.L : hands.idle.R;
        return (
          <g key={row.key}>
            <text x={8} y={top + 20} fontSize="11" fill="#3d4a5c">{row.label}</text>
            <rect x={labelW} y={top} width={W - labelW - 14} height={rowH - 6} fill="#f7f9fc" rx="4" />
            {idle.map((gap, i) => (
              <rect key={`idle-${i}`} x={scale(gap.start_ms)} y={top} width={Math.max(1, scale(gap.end_ms) - scale(gap.start_ms))} height={rowH - 6} fill="#e6eaf0" rx="3" />
            ))}
            {row.blocks.map((block) => (
              <g key={block.element_id}>
                <rect
                  x={scale(block.start_ms)}
                  y={top + 2}
                  width={Math.max(4, scale(block.end_ms) - scale(block.start_ms))}
                  height={rowH - 10}
                  rx="4"
                  fill={VA_COLOR[block.va] ?? '#1f5fd0'}
                  opacity={0.85}
                />
                <title>{`#${block.seq} ${block.desc} ${((block.end_ms - block.start_ms) / 1000).toFixed(2)}s`}</title>
              </g>
            ))}
          </g>
        );
      })}
      <text x={labelW} y={H - 2} fontSize="9" fill="#9aa5b5">
        灰色=单手空闲；双手同时空闲 {hands.idle.both.length} 段
      </text>
    </svg>
  );
}
