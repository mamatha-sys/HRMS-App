import { useEffect, useState } from 'react';
import api from '../api.js';

export default function Reports() {
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    api.get('/reports/summary').then((res) => setSummary(res.data)).catch(() => setError('Could not load report summary.'));
  }, []);

  async function downloadCsv() {
    setDownloading(true);
    try {
      const res = await api.get('/reports/employees.csv', { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'employees.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('Could not download report.');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div>
      <h1>Reports</h1>
      <div className="subtitle">Employee headcount summary and exportable records.</div>

      {error && <div className="banner error">{error}</div>}

      {summary && (
        <div className="kpi-row">
          <div className="kpi-card blue"><div className="kpi-label">Total Employees</div><div className="kpi-value">{summary.totalEmployees}</div></div>
          <div className="kpi-card gold"><div className="kpi-label">Open Positions</div><div className="kpi-value">{summary.openPositions}</div></div>
        </div>
      )}

      {summary && (
        <div className="grid2">
          <div className="card">
            <div className="feature-name" style={{ marginBottom: 8 }}>By department</div>
            {summary.byDepartment.map((d) => (
              <div key={d.department} className="rec-row"><span>{d.department}</span><span>{d.count}</span></div>
            ))}
          </div>
          <div className="card">
            <div className="feature-name" style={{ marginBottom: 8 }}>By status</div>
            {summary.byStatus.map((s) => (
              <div key={s.status} className="rec-row"><span>{s.status}</span><span>{s.count}</span></div>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>Export</div>
        <div className="feature-meta" style={{ marginBottom: 10 }}>Download the full employee list as CSV.</div>
        <button className="primary" onClick={downloadCsv} disabled={downloading}>
          {downloading ? 'Preparing...' : 'Download employees.csv'}
        </button>
      </div>
    </div>
  );
}
