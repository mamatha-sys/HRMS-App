import { useEffect, useState } from 'react';
import api from '../api.js';

const SECTIONS = [
  { category: 'business', title: 'Business Policies', hint: 'Company-wide policies (probation, notice period, work week, leave).' },
  { category: 'rule', title: 'Custom Rules', hint: 'Automation rules that drive approvals and alerts.' },
  { category: 'setting', title: 'Configuration Settings', hint: 'System defaults used across modules.' }
];

export default function ConfigurationPolicies() {
  const [policies, setPolicies] = useState([]);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const [editValue, setEditValue] = useState('');
  const [adding, setAdding] = useState(null); // category being added to
  const [newName, setNewName] = useState('');
  const [newValue, setNewValue] = useState('');

  function load() {
    api.get('/policies').then((res) => setPolicies(res.data.policies)).catch(() => setError('Could not load policies.'));
  }
  useEffect(load, []);

  async function saveValue(p, e) {
    e.preventDefault();
    setError('');
    try {
      await api.put(`/policies/${p.id}`, { value: editValue });
      setEditing(null);
      load();
    } catch (err) { setError(err.response?.data?.error || 'Could not save.'); }
  }

  async function addPolicy(category, e) {
    e.preventDefault();
    setError('');
    try {
      await api.post('/policies', { category, name: newName, value: newValue });
      setNewName(''); setNewValue(''); setAdding(null);
      load();
    } catch (err) { setError(err.response?.data?.error || 'Could not add.'); }
  }

  async function remove(id) {
    if (!window.confirm('Remove this entry?')) return;
    setError('');
    try { await api.delete(`/policies/${id}`); load(); } catch (err) { setError(err.response?.data?.error || 'Could not remove.'); }
  }

  return (
    <div>
      <h1>Configuration Policies</h1>
      <div className="subtitle">Business policies, custom rules and configuration settings that govern how the HRMS behaves.</div>

      {error && <div className="banner error">{error}</div>}

      {SECTIONS.map((sec) => {
        const items = policies.filter((p) => p.category === sec.category);
        return (
          <div key={sec.category} className="card">
            <div className="feature-name">{sec.title}</div>
            <div className="feature-meta" style={{ marginBottom: 8 }}>{sec.hint}</div>

            {items.map((p) => (
              <div key={p.id} className="rec-row">
                <span>{p.name}{p.value ? <>: <strong>{p.value}</strong></> : ''}</span>
                {editing === p.id ? (
                  <form onSubmit={(e) => saveValue(p, e)} className="row" style={{ marginBottom: 0 }}>
                    <input value={editValue} onChange={(e) => setEditValue(e.target.value)} autoFocus />
                    <button className="primary" type="submit">Save</button>
                    <button type="button" onClick={() => setEditing(null)}>Cancel</button>
                  </form>
                ) : (
                  <span style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button onClick={() => { setEditing(p.id); setEditValue(p.value || ''); }}>Edit</button>
                    <button onClick={() => remove(p.id)}>Remove</button>
                  </span>
                )}
              </div>
            ))}
            {items.length === 0 && <div className="empty">Nothing here yet.</div>}

            {adding === sec.category ? (
              <form onSubmit={(e) => addPolicy(sec.category, e)} className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
                <input placeholder={sec.category === 'rule' ? 'Rule name' : 'Name'} value={newName} onChange={(e) => setNewName(e.target.value)} required style={{ flex: '2 1 180px' }} />
                <input placeholder="Value (e.g. Enabled, 30 days)" value={newValue} onChange={(e) => setNewValue(e.target.value)} style={{ flex: '2 1 180px' }} />
                <button className="primary" type="submit">Add</button>
                <button type="button" onClick={() => setAdding(null)}>Cancel</button>
              </form>
            ) : (
              <button style={{ marginTop: 12 }} onClick={() => { setAdding(sec.category); setNewName(''); setNewValue(''); }}>
                + Add {sec.category === 'rule' ? 'custom rule' : sec.category === 'business' ? 'policy' : 'setting'}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
