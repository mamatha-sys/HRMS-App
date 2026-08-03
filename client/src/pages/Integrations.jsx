import { useEffect, useState } from 'react';
import api from '../api.js';

const KEY_FEATURES = [
  { key: 'channels', label: 'Email, SMS & WhatsApp' },
  { key: 'biometric', label: 'Biometric Device Integration (eSSL)' },
  { key: 'webhooks', label: 'Slack & Microsoft Teams Alerts' },
  { key: 'calendar', label: 'Calendar Sync (Google)' },
  { key: 'payroll-export', label: 'Payroll Bank-Transfer Export' },
  { key: 'custom', label: 'Custom Integrations (Add Your Own)' },
  { key: 'branding', label: 'Company Branding (Logo & Name)' },
  { key: 'job-boards', label: 'Job Board Postings (Naukri, LinkedIn, Shine, Indeed)' }
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
  if (screen === 'custom') return <CustomIntegrationsScreen onBack={() => { load(); setScreen('dashboard'); }} />;
  if (screen === 'branding') return <BrandingScreen onBack={() => { load(); setScreen('dashboard'); }} />;
  if (screen === 'job-boards') return <JobBoardsScreen onBack={() => { load(); setScreen('dashboard'); }} />;

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
            <StatusPill label={`Custom Integrations (${s.customIntegrations})`} ok={s.customIntegrations > 0} />
            <StatusPill label={`Job Boards Connected (${s.jobBoardsConnected})`} ok={s.jobBoardsConnected > 0} />
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

const MAX_LOGO_BYTES = 1 * 1024 * 1024;
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ---------- Custom Integrations (add your own, beyond the 5 built-in ones) ----------
function CustomIntegrationsScreen({ onBack }) {
  const [integrations, setIntegrations] = useState([]);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', url: '', logo: '' });
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ name: '', description: '', url: '' });

  function load() { api.get('/integrations/custom').then((r) => setIntegrations(r.data.integrations)).catch(() => setError('Could not load custom integrations.')); }
  useEffect(load, []);

  async function handleLogo(e, setter, current) {
    const file = e.target.files?.[0]; if (!file) return;
    if (file.size > MAX_LOGO_BYTES) { setError('Logo is too large (max 1 MB).'); return; }
    const dataUrl = await readFileAsDataUrl(file);
    setter({ ...current, logo: dataUrl });
  }

  async function add(e) {
    e.preventDefault(); setError('');
    if (!form.name.trim()) { setError('Name is required.'); return; }
    try {
      await api.post('/integrations/custom', form);
      setForm({ name: '', description: '', url: '', logo: '' });
      setShowForm(false);
      load();
    } catch (err) { setError(err.response?.data?.error || 'Could not add integration.'); }
  }

  function startEdit(i) {
    setEditingId(i.id);
    setEditForm({ name: i.name, description: i.description || '', url: i.url || '' });
  }
  async function saveEdit(id) {
    setError('');
    try { await api.put(`/integrations/custom/${id}`, editForm); setEditingId(null); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not save.'); }
  }
  async function toggleStatus(i) {
    setError('');
    try { await api.put(`/integrations/custom/${i.id}`, { status: i.status === 'Active' ? 'Paused' : 'Active' }); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not update.'); }
  }

  return (
    <div>
      <button onClick={onBack} style={{ marginBottom: 10 }}>← Back to Integrations</button>
      <h1>Custom Integrations</h1>
      <div className="subtitle">Add your own integration entries for any third-party tool not built in — give each one its own logo so it's easy to recognize.</div>
      {error && <div className="banner error">{error}</div>}

      <div className="card" style={{ marginBottom: 14 }}>
        {integrations.length === 0 && <div className="empty">No custom integrations added yet.</div>}
        {integrations.map((i) => (
          <div key={i.id} className="rec-row" style={{ opacity: i.status === 'Paused' ? 0.6 : 1, alignItems: 'flex-start' }}>
            {editingId === i.id ? (
              <>
                <span style={{ flex: 1 }}>
                  <input autoFocus value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} style={{ marginBottom: 6 }} />
                  <input placeholder="Description" value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} style={{ marginBottom: 6 }} />
                  <input placeholder="Link / webhook URL" value={editForm.url} onChange={(e) => setEditForm({ ...editForm, url: e.target.value })} />
                </span>
                <span className="row" style={{ gap: 6 }}>
                  <button className="primary" onClick={() => saveEdit(i.id)}>Save</button>
                  <button onClick={() => setEditingId(null)}>Cancel</button>
                </span>
              </>
            ) : (
              <>
                <span className="row" style={{ gap: 10, alignItems: 'center' }}>
                  {i.logo ? <img src={i.logo} alt="" style={{ width: 32, height: 32, objectFit: 'contain', borderRadius: 6 }} /> : <span className="dot" />}
                  <span>
                    <strong>{i.name}</strong>
                    {i.description && <div className="feature-meta">{i.description}</div>}
                    {i.url && <div className="feature-meta"><a href={i.url} target="_blank" rel="noreferrer">{i.url}</a></div>}
                  </span>
                </span>
                <span className="row" style={{ gap: 6 }}>
                  <span className={'status-tag ' + (i.status === 'Active' ? 'present' : 'locked')}>{i.status}</span>
                  <button onClick={() => startEdit(i)}>Edit</button>
                  <button onClick={() => toggleStatus(i)}>{i.status === 'Active' ? 'Pause' : 'Resume'}</button>
                </span>
              </>
            )}
          </div>
        ))}

        {showForm ? (
          <form onSubmit={add} style={{ marginTop: 10, borderTop: '1px solid #EEF0F3', paddingTop: 10 }}>
            <label className="field-label">Name *</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required style={{ marginBottom: 10 }} />
            <label className="field-label">Description</label>
            <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} style={{ marginBottom: 10 }} />
            <label className="field-label">Link / webhook URL</label>
            <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} style={{ marginBottom: 10 }} />
            <label className="field-label">Logo</label>
            <div className="row" style={{ alignItems: 'center', gap: 10, marginBottom: 10 }}>
              {form.logo && <img src={form.logo} alt="" style={{ width: 40, height: 40, objectFit: 'contain', borderRadius: 6 }} />}
              <input type="file" accept="image/*" onChange={(e) => handleLogo(e, setForm, form)} />
            </div>
            <div className="row">
              <button className="primary" type="submit">+ Add Integration</button>
              <button type="button" onClick={() => setShowForm(false)}>Cancel</button>
            </div>
          </form>
        ) : (
          <button className="primary" style={{ marginTop: 10 }} onClick={() => setShowForm(true)}>+ Add Custom Integration</button>
        )}
      </div>
    </div>
  );
}

// ---------- Company Branding (logo + name) ----------
function BrandingScreen({ onBack }) {
  const [form, setForm] = useState({ company_name: '', company_logo: '', company_address: '' });
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => { api.get('/branding').then((r) => setForm({ company_name: r.data.company_name || '', company_logo: r.data.company_logo || '', company_address: r.data.company_address || '' })).catch(() => {}); }, []);

  async function handleLogo(e) {
    const file = e.target.files?.[0]; if (!file) return;
    if (file.size > MAX_LOGO_BYTES) { setError('Logo is too large (max 1 MB).'); return; }
    const dataUrl = await readFileAsDataUrl(file);
    setForm((f) => ({ ...f, company_logo: dataUrl }));
  }

  async function save(e) {
    e.preventDefault(); setError(''); setSaved(false);
    try { await api.put('/branding', form); setSaved(true); }
    catch (err) { setError(err.response?.data?.error || 'Could not save.'); }
  }
  async function removeLogo() {
    setForm((f) => ({ ...f, company_logo: '' }));
  }

  return (
    <div>
      <button onClick={onBack} style={{ marginBottom: 10 }}>← Back to Integrations</button>
      <h1>Company Branding</h1>
      <div className="subtitle">Your own company logo, name &amp; address — shown on the Login page, the app header, and on payslips.</div>
      {error && <div className="banner error">{error}</div>}
      {saved && <div className="banner" style={{ background: '#E4F5EC', color: '#1E8E5A' }}>Saved.</div>}

      <div className="card">
        <form onSubmit={save}>
          <label className="field-label">Company name</label>
          <input placeholder="HRMS" value={form.company_name} onChange={(e) => setForm({ ...form, company_name: e.target.value })} style={{ marginBottom: 10 }} />
          <label className="field-label">Company address <span className="note">(shown on payslips)</span></label>
          <textarea rows={3} placeholder="#512, 5th Floor, Building Name, Area, City, State, Country - Pincode" value={form.company_address}
            onChange={(e) => setForm({ ...form, company_address: e.target.value })} style={{ marginBottom: 10, width: '100%' }} />
          <label className="field-label">Logo</label>
          <div className="row" style={{ alignItems: 'center', gap: 10, marginBottom: 10 }}>
            {form.company_logo && <img src={form.company_logo} alt="" style={{ width: 48, height: 48, objectFit: 'contain', borderRadius: 6, background: '#fff', border: '1px solid #EEF0F3' }} />}
            <input type="file" accept="image/*" onChange={handleLogo} />
            {form.company_logo && <button type="button" onClick={removeLogo}>Remove logo</button>}
          </div>
          <button className="primary" type="submit">Save</button>
        </form>
      </div>
    </div>
  );
}

// ---------- Job Board Postings — which boards Recruitment's Manage Posting can post to ----------
function JobBoardsScreen({ onBack }) {
  const [boards, setBoards] = useState([]);
  const [error, setError] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [newBoardLabel, setNewBoardLabel] = useState('');
  const [editingKey, setEditingKey] = useState(null);
  const [credentialInputs, setCredentialInputs] = useState({});

  function load() { api.get('/integrations/job-boards').then((r) => setBoards(r.data.boards)).catch(() => setError('Could not load job boards.')); }
  useEffect(load, []);

  async function connect(board) {
    setError('');
    try {
      await api.put(`/integrations/job-boards/${board.key}`, { credential: credentialInputs[board.key] || '' });
      setEditingKey(null);
      setCredentialInputs((c) => ({ ...c, [board.key]: '' }));
      load();
    } catch (err) { setError(err.response?.data?.error || 'Could not connect.'); }
  }

  async function disconnect(board) {
    setError('');
    try { await api.put(`/integrations/job-boards/${board.key}`, { credential: '' }); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not disconnect.'); }
  }

  async function submitAddBoard(e) {
    e.preventDefault(); setError('');
    try { await api.post('/integrations/job-boards', { label: newBoardLabel }); setNewBoardLabel(''); setShowAdd(false); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not add job board.'); }
  }

  return (
    <div>
      <button onClick={onBack} style={{ marginBottom: 10 }}>← Back to Integrations</button>
      <h1>Job Board Postings</h1>
      <div className="subtitle">
        This does not publish jobs on the board's own website — that needs a paid partner API relationship with each portal, which isn't available here.
        Connecting just marks a board as ready to reference on approved requisitions; if you paste that board's real job-posting URL (after posting it there yourself),
        Recruitment's "Live on" line will link straight to it, for tracking only. The Company Careers Page is always available and isn't listed here.
      </div>
      {error && <div className="banner error">{error}</div>}

      <div className="card">
        {boards.map((b) => (
          <div key={b.key} className="rec-row" style={{ alignItems: 'flex-start' }}>
            <span style={{ flex: 1 }}>
              <div style={{ marginBottom: editingKey === b.key ? 6 : 0 }}>{b.label}</div>
              {editingKey === b.key && (
                <input
                  autoFocus
                  placeholder="Job posting URL on this board (or an account ID/key for reference)"
                  value={credentialInputs[b.key] || ''}
                  onChange={(e) => setCredentialInputs((c) => ({ ...c, [b.key]: e.target.value }))}
                  style={{ width: '100%' }}
                />
              )}
            </span>
            <span className="row" style={{ gap: 6, flexShrink: 0 }}>
              <span className={'status-tag ' + (b.connected ? 'present' : 'locked')}>{b.connected ? 'Connected' : 'Not connected'}</span>
              {editingKey === b.key ? (
                <>
                  <button className="primary" onClick={() => connect(b)}>Save</button>
                  <button onClick={() => setEditingKey(null)}>Cancel</button>
                </>
              ) : b.connected ? (
                <button onClick={() => disconnect(b)}>Disconnect</button>
              ) : (
                <button onClick={() => setEditingKey(b.key)}>Connect</button>
              )}
            </span>
          </div>
        ))}

        {showAdd ? (
          <form onSubmit={submitAddBoard} className="row" style={{ marginTop: 12 }}>
            <input placeholder="New job board name (e.g. Monster)" value={newBoardLabel} onChange={(e) => setNewBoardLabel(e.target.value)} required style={{ flex: '1 1 200px' }} />
            <button className="primary" type="submit">Add</button>
            <button type="button" onClick={() => { setShowAdd(false); setNewBoardLabel(''); }}>Cancel</button>
          </form>
        ) : (
          <button style={{ marginTop: 12 }} onClick={() => setShowAdd(true)}>+ Add Job Board</button>
        )}
      </div>
    </div>
  );
}
