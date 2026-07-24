import { useEffect, useState } from 'react';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

export default function TasksWidget({ canAssignOthers }) {
  const { user } = useAuth();
  const [tasks, setTasks] = useState([]);
  const [assignees, setAssignees] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [error, setError] = useState('');

  function load() {
    api.get('/tasks').then((res) => setTasks(res.data.tasks)).catch(() => {});
  }
  useEffect(load, []);

  useEffect(() => {
    if (!canAssignOthers) return;
    api.get('/employees').then((res) => {
      setAssignees(res.data.employees.filter((e) => e.user_id));
    }).catch(() => {});
  }, [canAssignOthers]);

  async function submit(e) {
    e.preventDefault();
    setError('');
    try {
      await api.post('/tasks', { title, due_date: dueDate || null, assigned_to: assignedTo || user.id });
      setTitle(''); setDueDate(''); setAssignedTo(''); setShowForm(false);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not add task.');
    }
  }

  async function toggleDone(task) {
    await api.put(`/tasks/${task.id}`, { status: task.status === 'Done' ? 'Pending' : 'Done' });
    load();
  }

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div className="feature-name">Pending Tasks &amp; Reminders</div>
        <button onClick={() => setShowForm((v) => !v)}>{showForm ? 'Cancel' : '+ Add task'}</button>
      </div>

      {error && <div className="banner error">{error}</div>}

      {showForm && (
        <form onSubmit={submit} className="row" style={{ flexWrap: 'wrap', marginBottom: 10 }}>
          <input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} required style={{ flex: '1 1 160px' }} />
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} style={{ flex: '1 1 140px' }} />
          {canAssignOthers && (
            <select value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)} style={{ flex: '1 1 160px' }}>
              <option value="">Assign to myself</option>
              {assignees.map((a) => <option key={a.user_id} value={a.user_id}>{a.name}</option>)}
            </select>
          )}
          <button className="primary" type="submit">Add</button>
        </form>
      )}

      {tasks.length === 0 && <div className="empty">No tasks.</div>}
      {tasks.map((t) => (
        <div key={t.id} className="rec-row">
          <span>
            <input type="checkbox" checked={t.status === 'Done'} onChange={() => toggleDone(t)} style={{ width: 14, height: 14, marginRight: 8 }} />
            <span style={{ textDecoration: t.status === 'Done' ? 'line-through' : 'none' }}>{t.title}</span>
            {t.due_date ? ` — due ${t.due_date}` : ''}
            {canAssignOthers ? ` (${t.assigned_to_name})` : ''}
          </span>
        </div>
      ))}
    </div>
  );
}
