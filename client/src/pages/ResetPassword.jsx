import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../api.js';

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (password.length < 6) { setError('Password must be at least 6 characters.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }

    setSubmitting(true);
    try {
      await api.post('/auth/reset-password', { token, password });
      setDone(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not reset password.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">Reset your password</div>

        {!token && <div className="banner error">This link is missing its reset token — request a new one from the login page.</div>}
        {error && <div className="banner error">{error}</div>}

        {done ? (
          <>
            <div className="banner" style={{ background: '#E8EEF9', border: '1px solid #2E5CB8', color: '#2E5CB8' }}>
              Password updated — you can now sign in with your new password.
            </div>
            <Link to="/login"><button className="primary login-submit" style={{ marginTop: 10 }}>Back to sign in</button></Link>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            <label className="field-label" htmlFor="password">New password</label>
            <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} disabled={!token} />
            <label className="field-label" htmlFor="confirm">Confirm new password</label>
            <input id="confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={6} disabled={!token} />
            <button className="primary login-submit" type="submit" disabled={submitting || !token} style={{ marginTop: 10 }}>
              {submitting ? 'Saving...' : 'Reset password'}
            </button>
          </form>
        )}

        <div className="note login-hint">
          <Link to="/login">Back to sign in</Link>
        </div>
      </div>
    </div>
  );
}
