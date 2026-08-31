import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import api from '../api.js';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [branding, setBranding] = useState(null);
  const [showForgot, setShowForgot] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotMessage, setForgotMessage] = useState('');
  const [sendingForgot, setSendingForgot] = useState(false);

  useEffect(() => { api.get('/branding').then((r) => setBranding(r.data)).catch(() => {}); }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await login(email, password);
      navigate(location.state?.from || '/dashboard', { replace: true });
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleForgotPassword(e) {
    e.preventDefault();
    setSendingForgot(true);
    setForgotMessage('');
    try {
      const res = await api.post('/auth/forgot-password', { email: forgotEmail });
      setForgotMessage(res.data.message);
    } catch (err) {
      setForgotMessage(err.response?.data?.error || 'Could not send reset link.');
    } finally {
      setSendingForgot(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          {branding?.company_logo && <img src={branding.company_logo} alt="" className="brand-logo" />}
          {branding?.company_name || 'HRMS'}
        </div>
        <div className="login-subtitle">Sign in with email &amp; password</div>

        {error && <div className="banner error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <label className="field-label" htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <label className="field-label" htmlFor="password">Password</label>
          <div style={{ position: 'relative' }}>
            <input
              id="password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              style={{ paddingRight: 36 }}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              title={showPassword ? 'Hide password' : 'Show password'}
              style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', width: 26, height: 26, padding: 0, border: 'none', background: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8A93A6', cursor: 'pointer' }}
            >
              {showPassword ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.6 18.6 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a18.6 18.6 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              )}
            </button>
          </div>
          <div style={{ textAlign: 'right', marginTop: -6, marginBottom: 10 }}>
            <button type="button" onClick={() => { setShowForgot(!showForgot); setForgotMessage(''); }}
              style={{ border: 'none', background: 'none', color: '#2E5CB8', textDecoration: 'underline', padding: 0, fontSize: 13 }}>
              Forgot password?
            </button>
          </div>
          {showForgot && (
            <div className="banner" style={{ background: '#F7F8FA', border: '1px solid #E2E5EA' }}>
              <div className="row">
                <input type="email" placeholder="Your account email" value={forgotEmail}
                  onChange={(e) => setForgotEmail(e.target.value)} style={{ flex: '1 1 200px' }} required />
                <button type="button" onClick={handleForgotPassword} disabled={sendingForgot || !forgotEmail}>
                  {sendingForgot ? 'Sending...' : 'Send reset link'}
                </button>
              </div>
              {forgotMessage && <div className="note" style={{ marginTop: 6 }}>{forgotMessage}</div>}
            </div>
          )}

          <button className="primary login-submit" type="submit" disabled={submitting}>
            {submitting ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
