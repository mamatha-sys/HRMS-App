import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api.js';

export default function VacanciesWidget({ badge, department = '' }) {
  const [vacancies, setVacancies] = useState([]);

  useEffect(() => {
    api.get('/positions/vacancies', { params: department ? { department } : {} })
      .then((res) => setVacancies(res.data.vacancies)).catch(() => {});
  }, [department]);

  return (
    <div className="card">
      <div className="feature-name" style={{ marginBottom: 10 }}>
        {badge && <span className="widget-badge">{badge}</span>}Department-wise Vacancies
      </div>
      {vacancies.length === 0 && <div className="empty">No headcount data yet.</div>}
      {vacancies.map((v) => {
        const pct = v.target > 0 ? Math.round((v.current / v.target) * 100) : 100;
        return (
          <div key={v.department_id} style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
              <span>{v.department} — {v.current}/{v.target}</span>
              <span style={{ color: v.vacancies > 0 ? '#B3401E' : '#1E8E5A' }}>{v.vacancies} vacancies</span>
            </div>
            <div className="mini-progress">
              <div className="fill" style={{ width: `${pct}%`, background: v.vacancies > 0 ? '#946E0A' : '#1E8E5A' }} />
            </div>
          </div>
        );
      })}
      <Link to="/recruitment">View Recruitment →</Link>
    </div>
  );
}
