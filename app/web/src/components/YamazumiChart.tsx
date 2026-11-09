import type { LineRow } from '../api';
import { VA_COLOR } from '../constants';

/** 山积图：三色分段堆叠 + TT线 + 瓶颈标记（文档02 §5） */
export default function YamazumiChart({ rows, tt }: { rows: LineRow[]; tt: number }) {
  const W = 860;
  const H = 300;
  const pad = { l: 46, r: 16, t: 14, b: 46 };
  const max = Math.max(...rows.map((r) => r.ct_s), tt, 1) * 1.16;
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const slot = innerW / Math.max(rows.length, 1);
  const bw = Math.min(64, slot - 16);
  const y = (v: number) => pad.t + innerH - (v / max) * innerH;

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="山积图">
      {[0.25, 0.5, 0.75, 1].map((k) => (
        <g key={k}>
          <line x1={pad.l} x2={W - pad.r} y1={y(max * k)} y2={y(max * k)} stroke="#eef1f6" strokeWidth="1" />
          <text x={pad.l - 6} y={y(max * k) + 3} textAnchor="end" fontSize="9" fill="#9aa5b5">
            {(max * k).toFixed(1)}
          </text>
        </g>
      ))}
      <line x1={pad.l} x2={W - pad.r} y1={y(tt)} y2={y(tt)} stroke="#b3372f" strokeWidth="1.3" strokeDasharray="6 4" />
      <text x={W - pad.r} y={y(tt) - 5} textAnchor="end" fontSize="10" fill="#b3372f">TT {tt}s</text>

      {rows.map((row, index) => {
        const x = pad.l + slot * index + (slot - bw) / 2;
        const segs = [
          { key: 'VA', value: row.va_s },
          { key: 'RNVA', value: row.rnva_s },
          { key: 'NVA', value: row.nva_s },
        ];
        let cursor = 0;
        return (
          <g key={row.station_id}>
            {segs.map((seg) => {
              const h = (seg.value / max) * innerH;
              const top = pad.t + innerH - ((cursor + seg.value) / max) * innerH;
              cursor += seg.value;
              return h > 0.5 ? (
                <rect key={seg.key} x={x} y={top} width={bw} height={h} fill={VA_COLOR[seg.key]} opacity={0.85} />
              ) : null;
            })}
            {row.is_bottleneck && (
              <text x={x + bw / 2} y={y(row.ct_s) - 6} textAnchor="middle" fontSize="10" fill="#b3372f" fontWeight="700">
                瓶颈
              </text>
            )}
            <text x={x + bw / 2} y={H - pad.b + 14} textAnchor="middle" fontSize="10" fill="#3d4a5c">
              {row.station_id.replace('L01-', '')}
            </text>
            <text x={x + bw / 2} y={H - pad.b + 27} textAnchor="middle" fontSize="9" fill="#6b7787">
              {row.ct_s}s / {row.va_pct}%
            </text>
            {row.outlier_count > 0 && (
              <text x={x + bw / 2} y={H - pad.b + 39} textAnchor="middle" fontSize="9" fill="#9a6a00">
                异常{row.outlier_count}
              </text>
            )}
          </g>
        );
      })}
      <line x1={pad.l} x2={W - pad.r} y1={pad.t + innerH} y2={pad.t + innerH} stroke="#cbd5e3" />
      <line x1={pad.l} x2={pad.l} y1={pad.t} y2={pad.t + innerH} stroke="#cbd5e3" />
      <text x={pad.l - 30} y={pad.t + 8} fontSize="9" fill="#9aa5b5">s</text>
    </svg>
  );
}
