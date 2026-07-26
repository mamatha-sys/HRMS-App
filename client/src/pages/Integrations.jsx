import { useEffect, useState } from 'react';
import api from '../api.js';

const KEY_FEATURES = [
  { key: 'channels', label: 'Email, SMS & WhatsApp' },
  { key: 'biometric', label: 'Biometric Device Integration (eSSL)' },
  { key: 'webhooks', label: 'Slack & Microsoft Teams Alerts' },
  { key: 'calendar', label: 'Calendar Sync (Google)' },
  { key: 'payroll-export', label: 'Payroll Bank-Transfer Export' }
];

export default function Integrations() {
  const [screen, setScreen] = useState('dashboard');
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState('');

  function load() { api.get('/integrations/overview').then((r) => setOverview(r.data)).catch(() => setError('Could not load integrations overview.')); }
  useEffect(load, []);

  if (screen === 'channels') return <ChannelsScreen onBack={() => setScreen('dashboard')} />;
  if (screen === 'biometric') return <BiometricScreen onBack={() => { load(); setScreen('dashboard'); }} />;
  if (screen === 'webhooks') return <WebhooksScreen onBack={() => { load(); setScreen('dashboard'); }} />;
  if (screen === 'calendar') return <CalendarScreen onBack={() => { load(); setScreen('dashboard'); }} />;
  if (screen === 'payroll-export') return <PayrollExportScreen onBack={() => setScreen('dashboard')} />;

  const s = overview?.status;
  return (
    <div>
      <h1>Integrations</h1>
      <div className="subtitle">Connect the HRMS to real biometric attendance hardware, messaging channels, and external tools.</div>
      {error && <div className="banner error">{error}</div>}

      {s && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="feature-name" style={{ marginBottom: 8 }}>Status</div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
            <StatusPill label="Email" ok={s.email} />
            <StatusPill label="SMS" ok={s.sms} />
            <StatusPill label="WhatsApp" ok={s.whatsapp} />
            <StatusPill label={`Biometric Devices (${s.biometricDevices})`} ok={s.biometricDevices > 0} />
            <StatusPill label="Slack" ok={s.slack} />
            <StatusPill label="Teams" ok={s.teams} />
            <StatusPill label="Google Calendar" ok={s.calendarConnected} />
          </div>
        </div>
      )}

      <div className="card">
        <div className="feature-name">Key Features</div>
        <div className="feature-meta" style={{ marginBottom: 8 }}>{KEY_FEATURES.length} features in this module — click any tile to open its screen.</div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          {KEY_FEATURES.map((f) => <button key={f.key} className="pill" onClick={() => setScreen(f.key)}>{f.label}</button>)}
        </div>
      </div>
    </div>
  );
}

function StatusPill({ label, ok }) {
  return <span className={'status-tag ' + (ok ? 'present' : 'locked')}>{label}: {ok ? 'Configured' : 'Not configured'}</span>;
}

// ---------- Email / SMS / WhatsApp status ----------
function ChannelsScreen({ onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api.get('/integrations/channels/status').then((r) => setData(r.data)).catch(() => setError('Could not load channel status.')); }, []);

  return (
    <div>
      <button onClick={onBack} style={{ marginBottom: 10 }}>← Back to Integrations</button>
      <h1>Email, SMS & WhatsApp</h1>
      <div className="subtitle">Real delivery already wired into Announcements &amp; Notifications — this is a status view.</div>
      {error && <div className="banner error">{error}</div>}
      {data && (
        <div className="card" style={{ marginBottom: 14 }}>
          {['email', 'sms', 'whatsapp'].map((k) => (
            <div key={k} className="rec-row">
              <span style={{ textTransform: 'capitalize' }}>{k}</span>
              <span>
                <span className={'status-tag ' + (data[k].configured ? 'present' : 'locked')} style={{ marginRight: 8 }}>{data[k].configured ? 'Configured' : 'Not configured'}</span>
                <span className="feature-meta">env: {data[k].envVars.join(', ')}</span>
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>Recent deliveries</div>
        {(!data?.recentDeliveries?.length) && <div className="empty">No deliveries yet.</div>}
        {data?.recentDeliveries?.map((d) => (
          <div key={d.id} className="rec-row">
            <span><strong>{d.channel}</strong> → {d.employee_name || 'Unknown'}: {d.title}</span>
            <span className={'status-tag ' + (d.status === 'Sent' ? 'present' : 'absent')}>{d.status}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Biometric Device Integration (eSSL) ----------
function BiometricScreen({ onBack }) {
  const [devices, setDevices] = useState([]);
  const [mappings, setMappings] = useState([]);
  const [unmapped, setUnmapped] = useState([]);
  const [punches, setPunches] = useState([]);
  const [error, setError] = useState('');
  const [deviceForm, setDeviceForm] = useState({ name: '', serial_number: '', location: '' });
  const [mapForm, setMapForm] = useState({ employee_id: '', device_user_id: '' });
  const [simForm, setSimForm] = useState({ device_serial: '', device_user_id: '', punch_type: 'check-in' });

  function load() {
    api.get('/integrations/biometric/devices').then((r) => setDevices(r.data.devices)).catch(() => {});
    api.get('/integrations/biometric/mappings').then((r) => { setMappings(r.data.mappings); setUnmapped(r.data.unmappedEmployees); }).catch(() => {});
    api.get('/integrations/biometric/punches').then((r) => setPunches(r.data.punches)).catch(() => {});
  }
  useEffect(load, []);

  async function addDevice(e) {
    e.preventDefault(); setError('');
    try { await api.post('/integrations/biometric/devices', deviceForm); setDeviceForm({ name: '', serial_number: '', location: '' }); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not add device.'); }
  }
  async function toggleDevice(d) {
    try { await api.put(`/integrations/biometric/devices/${d.id}`, { status: d.status === 'Active' ? 'Paused' : 'Active' }); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not update device.'); }
  }
  async function addMapping(e) {
    e.preventDefault(); setError('');
    try { await api.post('/integrations/biometric/mappings', mapForm); setMapForm({ employee_id: '', device_user_id: '' }); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not save mapping.'); }
  }
  async function removeMapping(employeeId) {
    try { await api.delete(`/integrations/biometric/mappings/${employeeId}`); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not remove mapping.'); }
  }
  async function simulate(e) {
    e.preventDefault(); setError('');
    try { await api.post('/integrations/biometric/simulate', simForm); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not simulate punch.'); }
  }
  async function mapPunch(punchId, employeeId) {
    if (!employeeId) return;
    try { await api.post(`/integrations/biometric/punches/${punchId}/map`, { employee_id: employeeId }); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not map punch.'); }
  }

  return (
    <div>
      <button onClick={onBack} style={{ marginBottom: 10 }}>← Back to Integrations</button>
      <h1>Biometric Device Integration (eSSL)</h1>
      <div className="subtitle">Real fingerprint/face terminals push attendance punches over HTTP to <code>/api/biometric-device/cdata</code> (the ADMS/iClock protocol — no vendor SDK required). Register your device's serial number below to accept its punches.</div>
      {error && <div className="banner error">{error}</div>}

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="feature-name" style={{ marginBottom: 8 }}>Registered devices</div>
        {devices.length === 0 && <div className="empty">No devices registered yet.</div>}
        {devices.map((d) => (
          <div key={d.id} className="rec-row">
            <span><strong>{d.name}</strong> — {d.vendor}, serial <code>{d.serial_number}</code>{d.location ? ` · ${d.location}` : ''}
              <div className="feature-meta">Last seen: {d.last_seen_at || 'never'}</div>
            </span>
            <span className="row" style={{ gap: 6 }}>
              <span className={'status-tag ' + (d.status === 'Active' ? 'present' : 'locked')}>{d.status}</span>
              <button onClick={() => toggleDevice(d)}>{d.status === 'Active' ? 'Pause' : 'Resume'}</button>
            </span>
          </div>
        ))}
        <form onSubmit={addDevice} className="row" style={{ flexWrap: 'wrap', marginTop: 10 }}>
          <input placeholder="Device name (e.g. Main Gate eSSL)" value={deviceForm.name} onChange={(e) => setDeviceForm({ ...deviceForm, name: e.target.value })} required style={{ flex: '1 1 180px' }} />
          <input placeholder="Serial number" value={deviceForm.serial_number} onChange={(e) => setDeviceForm({ ...deviceForm, serial_number: e.target.value })} required style={{ flex: '1 1 140px' }} />
          <input placeholder="Location (optional)" value={deviceForm.location} onChange={(e) => setDeviceForm({ ...deviceForm, location: e.target.value })} style={{ flex: '1 1 140px' }} />
          <button className="primary" type="submit">+ Register Device</button>
        </form>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="feature-name" style={{ marginBottom: 8 }}>Employee ID mapping</div>
        {mappings.map((m) => (
          <div key={m.employee_id} className="rec-row">
            <span>{m.employee_name} ({m.employee_code}) → device user ID <code>{m.device_user_id}</code></span>
            <button onClick={() => removeMapping(m.employee_id)}>Remove</button>
          </div>
        ))}
        <form onSubmit={addMapping} className="row" style={{ flexWrap: 'wrap', marginTop: 10 }}>
          <select value={mapForm.employee_id} onChange={(e) => setMapForm({ ...mapForm, employee_id: e.target.value })} required style={{ flex: '1 1 200px' }}>
            <option value="">Select employee…</option>
            {unmapped.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.employee_code})</option>)}
          </select>
          <input placeholder="Device enrollment ID (e.g. 16)" value={mapForm.device_user_id} onChange={(e) => setMapForm({ ...mapForm, device_user_id: e.target.value })} required style={{ flex: '1 1 160px' }} />
          <button className="primary" type="submit">Map</button>
        </form>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="feature-name" style={{ marginBottom: 8 }}>Simulate a punch (no hardware needed)</div>
        <div className="feature-meta" style={{ marginBottom: 8 }}>Sends the same tab-separated payload a real device would, through the exact same receive → map → attendance pipeline — use this to prove the integration works end-to-end before hardware arrives.</div>
        <form onSubmit={simulate} className="row" style={{ flexWrap: 'wrap' }}>
          <select value={simForm.device_serial} onChange={(e) => setSimForm({ ...simForm, device_serial: e.target.value })} required style={{ flex: '1 1 160px' }}>
            <option value="">Select device…</option>
            {devices.map((d) => <option key={d.id} value={d.serial_number}>{d.name}</option>)}
          </select>
          <input placeholder="Device enrollment ID" value={simForm.device_user_id} onChange={(e) => setSimForm({ ...simForm, device_user_id: e.target.value })} required style={{ flex: '1 1 140px' }} />
          <select value={simForm.punch_type} onChange={(e) => setSimForm({ ...simForm, punch_type: e.target.value })} style={{ flex: '1 1 120px' }}>
            <option value="check-in">Check-in</option>
            <option value="check-out">Check-out</option>
          </select>
          <button className="primary" type="submit">Send Test Punch</button>
        </form>
      </div>

      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>Recent punches</div>
        {punches.length === 0 && <div className="empty">No punches received yet.</div>}
        {punches.map((p) => (
          <div key={p.id} className="rec-row">
            <span>Device <code>{p.device_serial}</code>, ID <code>{p.device_user_id}</code> — {p.punch_time} ({p.punch_type})
              <div className="feature-meta">{p.employee_name ? `Mapped to ${p.employee_name}` : 'Unmapped'}</div>
            </span>
            {!p.employee_id && (
              <select defaultValue="" onChange={(e) => mapPunch(p.id, e.target.value)}>
                <option value="" disabled>Map to…</option>
                {unmapped.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Slack / Microsoft Teams Alerts ----------
function WebhooksScreen({ onBack }) {
  const [form, setForm] = useState({ slack_webhook_url: '', teams_webhook_url: '' });
  const [log, setLog] = useState([]);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  function load() {
    api.get('/integrations/webhooks/settings').then((r) => setForm(r.data)).catch(() => {});
    api.get('/integrations/webhooks/log').then((r) => setLog(r.data.deliveries)).catch(() => {});
  }
  useEffect(load, []);

  async function save(e) {
    e.preventDefault(); setError(''); setSaved(false);
    try { await api.put('/integrations/webhooks/settings', form); setSaved(true); }
    catch (err) { setError(err.response?.data?.error || 'Could not save.'); }
  }
  async function test() {
    setError('');
    try { await api.post('/integrations/webhooks/test'); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not send test message.'); }
  }

  return (
    <div>
      <button onClick={onBack} style={{ marginBottom: 10 }}>← Back to Integrations</button>
      <h1>Slack &amp; Microsoft Teams Alerts</h1>
      <div className="subtitle">Mirrors new Helpdesk tickets and new Announcements into a Slack or Teams channel via an incoming webhook URL.</div>
      {error && <div className="banner error">{error}</div>}
      {saved && <div className="banner" style={{ background: '#E4F5EC', color: '#1E8E5A' }}>Saved.</div>}

      <div className="card" style={{ marginBottom: 14 }}>
        <form onSubmit={save}>
          <label className="field-label">Slack incoming webhook URL</label>
          <input placeholder="https://hooks.slack.com/services/…" value={form.slack_webhook_url || ''} onChange={(e) => setForm({ ...form, slack_webhook_url: e.target.value })} style={{ marginBottom: 10 }} />
          <label className="field-label">Microsoft Teams incoming webhook URL</label>
          <input placeholder="https://…webhook.office.com/…" value={form.teams_webhook_url || ''} onChange={(e) => setForm({ ...form, teams_webhook_url: e.target.value })} style={{ marginBottom: 10 }} />
          <div className="row">
            <button className="primary" type="submit">Save</button>
            <button type="button" onClick={test}>Send Test Message</button>
          </div>
        </form>
      </div>

      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>Delivery log</div>
        {log.length === 0 && <div className="empty">No webhook sends yet.</div>}
        {log.map((d) => (
          <div key={d.id} className="rec-row">
            <span><strong>{d.target}</strong> — {d.event}: {d.message}</span>
            <span className={'status-tag ' + (d.status === 'Sent' ? 'present' : 'absent')} title={d.error || ''}>{d.status}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Calendar Sync (Google) ----------
function CalendarScreen({ onBack }) {
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState({ google_client_id: '', google_client_secret: '' });
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  function load() { api.get('/integrations/calendar/settings').then((r) => { setSettings(r.data); setForm({ google_client_id: r.data.google_client_id, google_client_secret: '' }); }).catch(() => {}); }
  useEffect(load, []);

  async function save(e) {
    e.preventDefault(); setError(''); setSaved(false);
    try { await api.put('/integrations/calendar/settings', form); setSaved(true); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not save.'); }
  }
  async function connect() {
    setError('');
    try {
      const r = await api.get('/integrations/calendar/connect');
      window.open(r.data.url, '_blank', 'noopener');
    } catch (err) { setError(err.response?.data?.error || 'Could not start connection.'); }
  }

  return (
    <div>
      <button onClick={onBack} style={{ marginBottom: 10 }}>← Back to Integrations</button>
      <h1>Calendar Sync (Google)</h1>
      <div className="subtitle">Every new Training Session (Learning Management) is pushed as a real Google Calendar event once connected. Needs an OAuth Client ID/Secret from the <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">Google Cloud Console</a> with the redirect URI set to <code>http://localhost:4000/api/integrations/calendar/callback</code>.</div>
      {error && <div className="banner error">{error}</div>}
      {saved && <div className="banner" style={{ background: '#E4F5EC', color: '#1E8E5A' }}>Saved.</div>}

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row" style={{ marginBottom: 10 }}>
          <span className={'status-tag ' + (settings?.connected ? 'present' : 'locked')}>{settings?.connected ? `Connected (${settings.connectedEmail})` : 'Not connected'}</span>
        </div>
        <form onSubmit={save}>
          <label className="field-label">Google OAuth Client ID</label>
          <input value={form.google_client_id} onChange={(e) => setForm({ ...form, google_client_id: e.target.value })} style={{ marginBottom: 10 }} />
          <label className="field-label">Google OAuth Client Secret {settings?.hasSecret && <span className="feature-meta">(already set — leave blank to keep it)</span>}</label>
          <input type="password" value={form.google_client_secret} onChange={(e) => setForm({ ...form, google_client_secret: e.target.value })} style={{ marginBottom: 10 }} />
          <div className="row">
            <button className="primary" type="submit">Save</button>
            <button type="button" onClick={connect}>Connect Google Account</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------- Payroll Bank-Transfer Export ----------
function PayrollExportScreen({ onBack }) {
  const [periods, setPeriods] = useState([]);
  const [period, setPeriod] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { api.get('/integrations/payroll-export/periods').then((r) => setPeriods(r.data.periods)).catch(() => {}); }, []);

  async function download() {
    setError('');
    if (!period) { setError('Select a completed payroll period first.'); return; }
    try {
      const res = await api.get(`/integrations/payroll-export/${encodeURIComponent(period)}`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url; a.download = `salary-transfer-${period.replace(/\s+/g, '-')}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError('Could not export — that period may have no payslips, or employees may be missing bank details.');
    }
  }

  return (
    <div>
      <button onClick={onBack} style={{ marginBottom: 10 }}>← Back to Integrations</button>
      <h1>Payroll Bank-Transfer Export</h1>
      <div className="subtitle">Generate a bank-ready salary disbursement CSV (account number, IFSC, amount) from a completed payroll run.</div>
      {error && <div className="banner error">{error}</div>}

      <div className="card">
        <label className="field-label">Completed payroll period</label>
        <select value={period} onChange={(e) => setPeriod(e.target.value)} style={{ marginBottom: 10 }}>
          <option value="">Select period…</option>
          {periods.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <div>
          <button className="primary" onClick={download}>Export CSV</button>
        </div>
      </div>
    </div>
  );
}
