interface Segment { label: string; value: number; color: string }

export default function PieChart({ segments, size = 190, centerLabel, centerValue }: {
  segments: Segment[]; size?: number; centerLabel?: string; centerValue?: string;
}) {
  const total = segments.reduce((acc, s) => acc + s.value, 0);
  const r = size / 2 - 12;
  const cx = size / 2;
  const cy = size / 2;
  let acc = 0;

  const arcs = total > 0
    ? segments.filter((s) => s.value > 0).map((segment) => {
      const start = (acc / total) * Math.PI * 2 - Math.PI / 2;
      acc += segment.value;
      const end = (acc / total) * Math.PI * 2 - Math.PI / 2;
      const large = end - start > Math.PI ? 1 : 0;
      const x1 = cx + r * Math.cos(start);
      const y1 = cy + r * Math.sin(start);
      const x2 = cx + r * Math.cos(end);
      const y2 = cy + r * Math.sin(end);
      return (
        <path
          key={segment.label}
          d={`M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`}
          fill={segment.color}
          opacity={0.9}
        />
      );
    })
    : [<circle key="empty" cx={cx} cy={cy} r={r} fill="#eef1f6" />];

  return (
    <div>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="VA占比饼图">
        {arcs}
        <circle cx={cx} cy={cy} r={r * 0.55} fill="#fff" />
        <text x={cx} y={cy - 2} textAnchor="middle" fontSize="17" fontWeight="700" fill="#1a2332">
          {centerValue ?? ''}
        </text>
        <text x={cx} y={cy + 15} textAnchor="middle" fontSize="10" fill="#6b7787">
          {centerLabel ?? ''}
        </text>
      </svg>
      <div className="legend">
        {segments.map((s) => (
          <span key={s.label}>
            <i style={{ background: s.color }} />
            {s.label} {total > 0 ? Math.round((s.value / total) * 1000) / 10 : 0}%
          </span>
        ))}
      </div>
    </div>
  );
}
