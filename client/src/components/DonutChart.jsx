const CHART_COLORS = ['#2E5CB8', '#1B7F79', '#946E0A', '#B3401E', '#5B3A8E', '#1E8E5A'];
const CX = 70;
const CY = 70;
const R = 52;
const CIRCUMFERENCE = 2 * Math.PI * R;

export default function DonutChart({ title, data }) {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  let offset = 0;

  return (
    <div className="card">
      <div className="feature-name" style={{ marginBottom: 10 }}>{title}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
        <svg width="140" height="140" viewBox="0 0 140 140">
          {total === 0 && <circle cx={CX} cy={CY} r={R} fill="none" stroke="#EEF0F3" strokeWidth="18" />}
          {data.map((d, i) => {
            const fraction = total === 0 ? 0 : d.value / total;
            const len = fraction * CIRCUMFERENCE;
            const dasharray = `${len.toFixed(2)} ${(CIRCUMFERENCE - len).toFixed(2)}`;
            const dashoffset = -offset;
            offset += len;
            return (
              <circle
                key={d.label}
                cx={CX} cy={CY} r={R}
                fill="none"
                stroke={CHART_COLORS[i % CHART_COLORS.length]}
                strokeWidth="18"
                strokeDasharray={dasharray}
                strokeDashoffset={dashoffset}
                transform={`rotate(-90 ${CX} ${CY})`}
              >
                <title>{d.label}: {d.value}</title>
              </circle>
            );
          })}
          <text x={CX} y={CY} textAnchor="middle" dominantBaseline="middle" fontSize="20" fontWeight="700" fill="#1F2A44">
            {total}
          </text>
        </svg>
        <div style={{ flex: 1, minWidth: 140 }}>
          {data.map((d, i) => (
            <div key={d.label} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, marginBottom: 6 }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: CHART_COLORS[i % CHART_COLORS.length], display: 'inline-block' }} />
              <span style={{ flex: 1 }}>{d.label}</span>
              <span style={{ color: '#8A93A6' }}>{d.value}{total ? ` (${Math.round((d.value / total) * 100)}%)` : ''}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
