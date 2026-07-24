import { useEffect, useState } from 'react';
import api from '../api.js';

export default function EventsWidget({ canCreate, badge }) {
  const [events, setEvents] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');

  function load() {
    api.get('/events').then((res) => setEvents(res.data.events)).catch(() => {});
  }
  useEffect(load, []);

  async function submit(e) {
    e.preventDefault();
    setError('');
    try {
      await api.post('/events', { title, event_date: eventDate, description });
      setTitle(''); setEventDate(''); setDescription(''); setShowForm(false);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not add event.');
    }
  }

  async function remove(id) {
    if (!window.confirm('Remove this event?')) return;
    await api.delete(`/events/${id}`);
    load();
  }

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div className="feature-name">{badge && <span className="widget-badge">{badge}</span>}Calendar &amp; Upcoming Events</div>
        {canCreate && <button onClick={() => setShowForm((v) => !v)}>{showForm ? 'Cancel' : '+ Add event'}</button>}
      </div>

      {error && <div className="banner error">{error}</div>}

      {showForm && (
        <form onSubmit={submit} className="row" style={{ flexWrap: 'wrap', marginBottom: 10 }}>
          <input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} required style={{ flex: '1 1 140px' }} />
          <input type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} required style={{ flex: '1 1 140px' }} />
          <input placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} style={{ flex: '2 1 200px' }} />
          <button className="primary" type="submit">Add</button>
        </form>
      )}

      {events.length === 0 && <div className="empty">No upcoming events.</div>}
      {events.map((ev) => (
        <div key={ev.id} className="rec-row">
          <span><strong>{ev.event_date}</strong> — {ev.title}{ev.description ? ` (${ev.description})` : ''}</span>
          {canCreate && <button onClick={() => remove(ev.id)}>Remove</button>}
        </div>
      ))}
    </div>
  );
}
