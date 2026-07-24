import { exportCsv } from './LineChart.jsx';

const CHART_COLORS = ['#2E5CB8', '#1B7F79', '#946E0A', '#B3401E', '#5B3A8E', '#1E8E5A'];
const W = 320, H = 140, PAD = 24;

export default function BarChart({ title, data, exportFilename }) {
  if (!data || data.length === 0) {
    return (
      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>{title}</div>
        <div className="empty">No data yet.</div>
      </div>
    );
  }

  const max = Math.max(...data.map((d) => d.value), 1);
  const slot = (W - PAD * 2) / data.length;
  const barWidth = Math.min(36, slot * 0.6);

  return (
    <div className="card">
      <div className="feature-name" style={{ marginBottom: 8 }}>{title}</div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
        {data.map((d, i) => {
          const barHeight = (d.value / max) * (H - PAD * 2);
          const x = PAD + i * slot + (slot - barWidth) / 2;
          const y = H - PAD - barHeight;
          return (
            <g key={d.label}>
              <rect x={x} y={y} width={barWidth} height={barHeight} fill={CHART_COLORS[i % CHART_COLORS.length]} rx="3">
                <title>{d.label}: {d.value}</title>
              </rect>
              <text x={x + barWidth / 2} y={y - 4} textAnchor="middle" fontSize="10" fontWeight="700" fill="#1F2A44">{d.value}</text>
              <text x={x + barWidth / 2} y={H - 6} textAnchor="middle" fontSize="9" fill="#8A93A6">{d.label}</text>
            </g>
          );
        })}
      </svg>
      {exportFilename && (
        <button style={{ marginTop: 8 }} onClick={() => exportCsv(exportFilename, data)}>Export</button>
      )}
    </div>
  );
}
