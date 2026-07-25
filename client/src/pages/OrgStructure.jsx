import { useEffect, useRef, useState } from 'react';
import api from '../api.js';

// The role hierarchy is the escalation/approval workflow: a request (leave, attendance
// regularization, alert, issue) flows top-to-bottom through these roles. Reorder by dragging.
export default function OrgStructure() {
  const [roles, setRoles] = useState([]);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const [editName, setEditName] = useState('');
  const [editScope, setEditScope] = useState('');
  const [editMaxDays, setEditMaxDays] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newScope, setNewScope] = useState('');
  const dragIndex = useRef(null);

  function load() {
    api.get('/roles').then((res) => setRoles(res.data.roles)).catch(() => setError('Could not load roles.'));
  }
  useEffect(load, []);

  function onDragStart(i) { dragIndex.current = i; }
  function onDragOver(e) { e.preventDefault(); }
  async function onDrop(i) {
    const from = dragIndex.current;
    dragIndex.current = null;
    if (from === null || from === i) return;
    const next = [...roles];
    const [moved] = next.splice(from, 1);
    next.splice(i, 0, moved);
    setRoles(next); // optimistic
    try {
      await api.put('/roles/reorder', { order: next.map((r) => r.id) });
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save order.');
      load();
    }
  }

  async function togglePause(role) {
    setError('');
    try {
      await api.put(`/roles/${role.id}/pause`, { paused: !role.paused });
      load();
    } catch (err) { setError(err.response?.data?.error || 'Could not update role.'); }
  }

  function startEdit(role) {
    setEditing(role.id); setEditName(role.name); setEditScope(role.scope_description || '');
    setEditMaxDays(role.max_leave_approval_days ?? '');
  }

  async function saveEdit(e) {
    e.preventDefault();
    setError('');
    try {
      await api.put(`/roles/${editing}`, { name: editName, scope_description: editScope, max_leave_approval_days: editMaxDays === '' ? null : editMaxDays });
      setEditing(null);
      load();
    } catch (err) { setError(err.response?.data?.error || 'Could not save role.'); }
  }

  async function addRole(e) {
    e.preventDefault();
    setError('');
    try {
      await api.post('/roles', { name: newName, scope_description: newScope });
      setNewName(''); setNewScope(''); setShowAdd(false);
      load();
    } catch (err) { setError(err.response?.data?.error || 'Could not add role.'); }
  }

  return (
    <div>
      <h1>Organization Structure</h1>
      <div className="subtitle">
        Your office hierarchy and approval workflow. Requests — leave, attendance, alerts, issues — escalate top-to-bottom through this chain.
        Drag a role to reorder the workflow. Roles can be edited or paused, but not deleted.
      </div>

      {error && <div className="banner error">{error}</div>}

      <div className="card">
        <div className="feature-name" style={{ marginBottom: 4 }}>Approval &amp; escalation workflow</div>
        <div className="feature-meta" style={{ marginBottom: 12 }}>Top = highest authority. Drag the ⠿ handle to change the order.</div>

        {roles.map((role, i) => (
          <div key={role.id}>
            <div
              className="workflow-node"
              draggable
              onDragStart={() => onDragStart(i)}
              onDragOver={onDragOver}
              onDrop={() => onDrop(i)}
              style={{ opacity: role.paused ? 0.55 : 1 }}
            >
              <span className="drag-handle" title="Drag to reorder">⠿</span>
              <span className="step-num">{i + 1}</span>
              {editing === role.id ? (
                <form onSubmit={saveEdit} style={{ flex: 1, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Role name" style={{ flex: '1 1 140px' }} autoFocus />
                  <input value={editScope} onChange={(e) => setEditScope(e.target.value)} placeholder="Data scope" style={{ flex: '2 1 200px' }} />
                  <input type="number" min="0" value={editMaxDays} onChange={(e) => setEditMaxDays(e.target.value)} placeholder="Max leave days approvable (blank = unlimited)" style={{ flex: '1 1 220px' }} />
                  <button className="primary" type="submit">Save</button>
                  <button type="button" onClick={() => setEditing(null)}>Cancel</button>
                </form>
              ) : (
                <>
                  <span style={{ flex: 1 }}>
                    <strong>{role.name}</strong>
                    {role.paused && <span className="status-tag pending" style={{ marginLeft: 8 }}>Paused</span>}
                    {role.is_system && <span className="status-tag present" style={{ marginLeft: 8 }}>System</span>}
                    <div className="feature-meta">
                      {role.scope_description}
                      {role.max_leave_approval_days != null && <span> · Can approve leave up to <strong>{role.max_leave_approval_days} day(s)</strong>; longer requests escalate.</span>}
                    </div>
                  </span>
                  <span style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button onClick={() => startEdit(role)}>Edit</button>
                    {!role.is_system && <button onClick={() => togglePause(role)}>{role.paused ? 'Resume' : 'Pause'}</button>}
                  </span>
                </>
              )}
            </div>
            {i < roles.length - 1 && <div className="workflow-arrow">↓</div>}
          </div>
        ))}

        {showAdd ? (
          <form onSubmit={addRole} className="row" style={{ marginTop: 14, flexWrap: 'wrap' }}>
            <input placeholder="New role name" value={newName} onChange={(e) => setNewName(e.target.value)} required style={{ flex: '1 1 160px' }} />
            <input placeholder="Data scope description" value={newScope} onChange={(e) => setNewScope(e.target.value)} style={{ flex: '2 1 200px' }} />
            <button className="primary" type="submit">Add role</button>
            <button type="button" onClick={() => setShowAdd(false)}>Cancel</button>
          </form>
        ) : (
          <button className="primary" style={{ marginTop: 14 }} onClick={() => setShowAdd(true)}>+ Add role</button>
        )}
      </div>
    </div>
  );
}
