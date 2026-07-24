import { useEffect, useState } from 'react';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

export default function Recruitment() {
  const { user } = useAuth();
  const canManage = user?.role === 'super_admin' || user?.role === 'manager';

  const [vacancies, setVacancies] = useState([]);
  const [positions, setPositions] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [departmentId, setDepartmentId] = useState('');
  const [title, setTitle] = useState('');
  const [targetHeadcount, setTargetHeadcount] = useState(1);

  function load() {
    api.get('/positions/vacancies').then((res) => setVacancies(res.data.vacancies)).catch(() => {});
    api.get('/positions').then((res) => setPositions(res.data.positions)).catch(() => setError('Could not load positions.'));
  }
  useEffect(load, []);
  useEffect(() => {
    if (!canManage) return;
    api.get('/org/departments').then((res) => setDepartments(res.data.departments)).catch(() => {});
  }, [canManage]);

  async function submit(e) {
    e.preventDefault();
    setError('');
    try {
      await api.post('/positions', { department_id: departmentId, title, target_headcount: targetHeadcount });
      setDepartmentId(''); setTitle(''); setTargetHeadcount(1); setShowForm(false);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not create position.');
    }
  }

  async function closePosition(id) {
    await api.put(`/positions/${id}`, { status: 'Closed' });
    load();
  }

  return (
    <div>
      <h1>Recruitment</h1>
      <div className="subtitle">Department-wise vacancies computed from real employee headcount and open positions.</div>

      {error && <div className="banner error">{error}</div>}

      <div className="card">
        <div className="feature-name" style={{ marginBottom: 10 }}>Department-wise Vacancies</div>
        {vacancies.length === 0 && <div className="empty">No headcount data yet.</div>}
        {vacancies.map((v) => {
          const pct = v.target > 0 ? Math.round((v.current / v.target) * 100) : 100;
          return (
            <div key={v.department_id} style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                <span><strong>{v.department}</strong> — {v.current} / {v.target}</span>
                <span style={{ color: v.vacancies > 0 ? '#B3401E' : '#1E8E5A' }}>{v.vacancies} vacancies</span>
              </div>
              <div style={{ height: 8, background: '#EEF0F3', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: v.vacancies > 0 ? '#946E0A' : '#1E8E5A' }} />
              </div>
            </div>
          );
        })}
      </div>

      {canManage && (
        <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 14 }}>
          <button className="primary" onClick={() => setShowForm((v) => !v)}>{showForm ? 'Cancel' : '+ Open position'}</button>
        </div>
      )}

      {showForm && (
        <div className="card">
          <form onSubmit={submit} className="row" style={{ flexWrap: 'wrap' }}>
            <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} required style={{ flex: '1 1 160px' }}>
              <option value="">Select department</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <input placeholder="Position title" value={title} onChange={(e) => setTitle(e.target.value)} required style={{ flex: '1 1 200px' }} />
            <input type="number" min="1" placeholder="Openings" value={targetHeadcount} onChange={(e) => setTargetHeadcount(e.target.value)} style={{ flex: '0 1 100px' }} />
            <button className="primary" type="submit">Create</button>
          </form>
        </div>
      )}

      <div className="card">
        <div className="feature-name" style={{ marginBottom: 10 }}>Open positions</div>
        {positions.filter((p) => p.status === 'Open').length === 0 && <div className="empty">No open positions.</div>}
        {positions.filter((p) => p.status === 'Open').map((p) => (
          <div key={p.id} className="rec-row">
            <span>{p.title} — {p.department_name} ({p.target_headcount} openings)</span>
            {canManage && <button onClick={() => closePosition(p.id)}>Close</button>}
          </div>
        ))}
      </div>
    </div>
  );
}
