import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import api from '../api.js';

const COLORS = [
  { bg: '#E8EEF9', fg: '#2E5CB8' },
  { bg: '#E4F5EC', fg: '#1E8E5A' },
  { bg: '#FBF2DE', fg: '#946E0A' },
  { bg: '#FBEAE5', fg: '#B3401E' }
];

// Positioned to scatter loosely around the hero's right column, each naming a real module of
// the platform (no invented stats/ratings — this is an internal company system, not a public
// SaaS product with metrics to show off).
const MODULE_CARDS = [
  { icon: '🕒', label: 'Attendance', desc: 'Check in/out & leave', top: 0, left: 30 },
  { icon: '💳', label: 'Payroll', desc: 'CTC & payslips', top: 20, right: 10 },
  { icon: '🧭', label: 'Recruitment', desc: 'Pipeline & offers', top: 150, left: 140 },
  { icon: '🎫', label: 'Helpdesk', desc: 'IT/HR tickets & SLAs', top: 170, right: 60 },
  { icon: '🎓', label: 'Learning', desc: 'Courses & assessments', top: 280, left: 10 }
];

const WHY = [
  { icon: '🔐', title: 'Role-based access', body: 'Every module respects who you are — Super Admin, Manager, HR, or Employee — with scoped visibility throughout.' },
  { icon: '🧩', title: 'All-in-one', body: 'No more juggling separate tools — attendance, payroll, recruitment and more, together in one system.' },
  { icon: '⚡', title: 'Built for every team', body: 'From day-to-day check-ins to company-wide reporting, Teamlink scales with how your organization works.' }
];

const ALL_MODULES = [
  { icon: '👤', title: 'Employee Management', body: 'Records, documents, onboarding & offboarding.' },
  { icon: '🕒', title: 'Attendance & Leave', body: 'Check in/out, regularization, leave approvals.' },
  { icon: '💳', title: 'Payroll & Expenses', body: 'CTC-driven salary structures, payslips, claims.' },
  { icon: '🧭', title: 'Recruitment & Performance', body: 'Requisitions, candidate pipelines, reviews & goals.' },
  { icon: '🎓', title: 'Learning & Assets', body: 'Training courses, assessments, asset tracking.' },
  { icon: '🎫', title: 'Helpdesk & Announcements', body: 'IT/HR ticketing with SLAs, company-wide notices.' },
  { icon: '📊', title: 'Dashboards & Reports', body: 'Real-time KPIs and analytics for every role.' },
  { icon: '🗓️', title: 'Shift & Roster', body: 'Scheduling and shift management across teams.' },
  { icon: '🏆', title: 'Recognition & Surveys', body: 'Rewards, feedback and engagement surveys.' }
];

// Public landing page shown before sign-in — the site root ("/"). An already-authenticated
// visitor is sent straight to their Dashboard instead of seeing this again.
export default function Home() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [branding, setBranding] = useState(null);

  useEffect(() => { api.get('/branding').then((r) => setBranding(r.data)).catch(() => {}); }, []);

  if (loading) return <div className="empty">Loading...</div>;
  if (user) return <Navigate to="/dashboard" replace />;

  const companyName = branding?.company_name?.trim() || '';
  const addressFirstLine = branding?.company_address ? branding.company_address.split('\n')[0] : '';

  return (
    <div className="home-page">
      <nav className="home-navbar">
        <div className="home-wordmark">
          {branding?.company_logo && <img src={branding.company_logo} alt="" className="brand-logo" style={{ height: 28 }} />}
          Teamlink
        </div>
        <button className="home-login-btn" onClick={() => navigate('/login')}>Login</button>
      </nav>

      <div className="home-hero-wrap">
        <div className="home-hero-glow" />
        <div className="home-hero">
          <div>
            <div className="home-badge">✨ ALL-IN-ONE HR PLATFORM</div>
            <h1>Everything you need to run a great HR team</h1>
            <div className="home-lede">
              Teamlink is {companyName ? `${companyName}'s` : 'your'} all-in-one HR platform — attendance, leave,
              payroll, recruitment, performance, learning, assets, and helpdesk, unified for every employee,
              manager, and HR admin in one place.
            </div>
            <div className="home-cta-row">
              <button className="home-cta-primary" onClick={() => navigate('/login')}>Login to your account</button>
              <button className="home-cta-secondary" onClick={() => document.getElementById('home-modules')?.scrollIntoView({ behavior: 'smooth' })}>
                Explore modules
              </button>
            </div>
            {(companyName || addressFirstLine) && (
              <div className="home-company-line">
                {[companyName, addressFirstLine].filter(Boolean).join(' · ')}
              </div>
            )}
          </div>

          <div className="home-cards">
            {MODULE_CARDS.map((c, i) => {
              const color = COLORS[i % COLORS.length];
              return (
                <div key={c.label} className="home-mod-card" style={{ top: c.top, left: c.left, right: c.right, animationDelay: `${0.15 + i * 0.08}s` }}>
                  <div className="icon-circle" style={{ background: color.bg, color: color.fg }}>{c.icon}</div>
                  <div className="label">{c.label}</div>
                  <div className="desc">{c.desc}</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="home-section">
        <div className="home-section-title">Why teams choose Teamlink</div>
        <div className="home-section-sub">Built to fit how your organization actually works</div>
        <div className="home-why-grid">
          {WHY.map((w, i) => {
            const color = COLORS[i % COLORS.length];
            return (
              <div key={w.title} className="home-why-card">
                <div className="icon-circle" style={{ background: color.bg, color: color.fg }}>{w.icon}</div>
                <div className="title">{w.title}</div>
                <div className="body">{w.body}</div>
              </div>
            );
          })}
        </div>

        <div id="home-modules">
          <div className="home-section-title">One platform, every module</div>
          <div className="home-section-sub">From onboarding to offboarding, and everything in between</div>
          <div className="home-modules-grid">
            {ALL_MODULES.map((m, i) => {
              const color = COLORS[i % COLORS.length];
              return (
                <div key={m.title} className="home-module-card">
                  <div className="icon-circle" style={{ background: color.bg, color: color.fg }}>{m.icon}</div>
                  <div className="title">{m.title}</div>
                  <div className="body">{m.body}</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="home-footer">
        <span>{companyName || 'Teamlink'}{addressFirstLine ? ` · ${addressFirstLine}` : ''}</span>
        <span>© {new Date().getFullYear()} · Internal HR Platform</span>
      </div>
    </div>
  );
}
