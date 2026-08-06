import { useEffect, useState } from 'react';
import api from '../api.js';
import ChainStepper from './ChainStepper.jsx';

export default function ApprovalsWidget({ canDecide, badge }) {
  const [approvals, setApprovals] = useState([]);
  const [chainLabel, setChainLabel] = useState('');
  const [error, setError] = useState('');

  function load() {
    api.get('/approvals').then((res) => { setApprovals(res.data.approvals); setChainLabel(res.data.chainLabel || ''); }).catch(() => {});
  }
  useEffect(load, []);

  async function decide(id, verb) {
    setError('');
    try {
      await api.post(`/approvals/${id}/${verb}`);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not update approval.');
    }
  }

  const pending = approvals.filter((a) => a.status === 'Pending');

  return (
    <div className="card">
      <div className="feature-name" style={{ marginBottom: 10 }}>
        {badge && <span className="widget-badge">{badge}</span>}Pending Approvals
      </div>

      {error && <div className="banner error">{error}</div>}

      {pending.length === 0 && <div className="empty">No pending approvals.</div>}
      {pending.map((a) => (
        <div key={a.id} style={{ borderTop: '1px solid #EEF0F3', padding: '8px 0' }}>
          <div className="rec-row" style={{ borderTop: 'none', padding: '0 0 4px' }}>
            <span>
              {a.type} — {a.requester}{a.team_name && <span className="feature-meta"> ({a.team_name})</span>}
              {a.edit_request_count > 0 && <span className="feature-meta"> · {a.edit_request_count} edit request{a.edit_request_count === 1 ? '' : 's'} raised total</span>}
              <div className="feature-meta">{a.detail}</div>
            </span>
            {canDecide && (
              <span style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <button className="btn-approve" onClick={() => decide(a.id, 'approve')}>Approve</button>
                <button className="btn-reject" onClick={() => decide(a.id, 'reject')}>Reject</button>
              </span>
            )}
          </div>
          {/* Only Leave/Regularization/Profile Edit ride the hierarchy chain — Expense/
              Requisition don't set current_stage_name, so no stepper renders for those. */}
          {a.current_stage_name && chainLabel && (
            <ChainStepper chainLabel={chainLabel} currentStageName={a.current_stage_name} status={a.status} />
          )}
        </div>
      ))}

      {approvals.some((a) => a.status !== 'Pending') && (
        <div className="feature-meta" style={{ marginTop: 10 }}>
          Recently decided: {approvals.filter((a) => a.status !== 'Pending').slice(0, 3).map((a) => `${a.type} (${a.status})`).join(', ')}
        </div>
      )}
    </div>
  );
}
