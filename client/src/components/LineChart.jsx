const W = 320, H = 140, PAD = 24;

export default function LineChart({ title, data, exportFilename }) {
  if (!data || data.length === 0) {
    return (
      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>{title}</div>
        <div className="empty">No data yet.</div>
      </div>
    );
  }

  const max = Math.max(...data.map((d) => d.value), 1);
  const stepX = data.length > 1 ? (W - PAD * 2) / (data.length - 1) : 0;
  const points = data.map((d, i) => {
    const x = PAD + i * stepX;
    const y = H - PAD - (d.value / max) * (H - PAD * 2);
    return { x, y, ...d };
  });
  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  return (
    <div className="card">
      <div className="feature-name" style={{ marginBottom: 8 }}>{title}</div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
        <path d={pathD} fill="none" stroke="#2E5CB8" strokeWidth="2.5" />
        {points.map((p) => (
          <circle key={p.label} cx={p.x} cy={p.y} r="3.5" fill="#2E5CB8">
            <title>{p.label}: {p.value}</title>
          </circle>
        ))}
        {points.map((p) => (
          <text key={p.label + '-lbl'} x={p.x} y={H - 6} textAnchor="middle" fontSize="9" fill="#8A93A6">{p.label}</text>
        ))}
      </svg>
      <div className="feature-meta">Latest: <strong>{data[data.length - 1].value}</strong></div>
      {exportFilename && (
        <button style={{ marginTop: 8 }} onClick={() => exportCsv(exportFilename, data)}>Export</button>
      )}
    </div>
  );
}

export function exportCsv(filename, data) {
  const lines = ['label,value', ...data.map((d) => `${d.label},${d.value}`)];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
