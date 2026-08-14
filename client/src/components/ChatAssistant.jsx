import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import api from '../api.js';

const SpeechRecognitionApi = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

// Floating chat widget available on every authenticated page (mounted once in AppLayout).
// Conversation lives only in this component's state — nothing is persisted server-side yet, so a
// page reload starts a fresh conversation. The assistant's grounding facts (leave balance, etc.)
// are rebuilt server-side per request from the caller's own JWT, never from anything sent here.
export default function ChatAssistant() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [listening, setListening] = useState(false);
  const listRef = useRef(null);
  const recognitionRef = useRef(null);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, open, loading]);

  // Lets other parts of the app (e.g. the Dashboard's Quick Actions "Ask AI Assistant" button)
  // open the panel without needing to lift this component's state up through the route tree.
  useEffect(() => {
    const openHandler = () => setOpen(true);
    window.addEventListener('hrms:open-assistant', openHandler);
    return () => window.removeEventListener('hrms:open-assistant', openHandler);
  }, []);

  useEffect(() => () => recognitionRef.current?.stop(), []);

  async function send(overrideText) {
    const text = (overrideText ?? input).trim();
    if (!text || loading) return;
    setError('');
    const history = messages.slice(-10).map((m) => ({ role: m.role, content: m.content }));
    setMessages((m) => [...m, { role: 'user', content: text }]);
    setInput('');
    setLoading(true);
    try {
      const r = await api.post('/chatbot/ask', { message: text, history });
      setMessages((m) => [...m, { role: 'assistant', content: r.data.reply }]);
    } catch (err) {
      setError(err.response?.data?.error || 'The assistant could not reply — please try again.');
    } finally {
      setLoading(false);
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  // Voice input: browser-native speech-to-text (Chrome/Edge). Feature-detected — the mic button
  // simply doesn't render on browsers without it (e.g. Firefox), rather than showing a broken control.
  function toggleListening() {
    if (!SpeechRecognitionApi) return;
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const recognition = new SpeechRecognitionApi();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (e) => {
      const transcript = e.results[0][0].transcript;
      setInput((prev) => (prev ? `${prev} ${transcript}` : transcript));
    };
    recognition.onerror = () => setError('Could not hear that — check your microphone permission and try again.');
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    setError('');
    setListening(true);
    recognition.start();
  }

  if (!user) return null;

  return (
    <>
      <button type="button" className="chat-fab" onClick={() => setOpen((v) => !v)} aria-label={open ? 'Close assistant' : 'Open assistant'}>
        {open ? '✕' : '💬'}
      </button>

      {open && (
        <div className="chat-panel">
          <div className="chat-panel-header">
            <div>
              <div className="chat-panel-title">HRMS Assistant</div>
              <div className="chat-panel-subtitle">Ask about your leave, or how to use the app</div>
            </div>
            <button type="button" className="chat-panel-close" onClick={() => setOpen(false)} aria-label="Close">✕</button>
          </div>

          <div className="chat-messages" ref={listRef}>
            {messages.length === 0 && (
              <div className="chat-bubble assistant">
                Hi {user.name?.split(' ')[0] || ''}! I can answer questions about your leave balance, pending requests, or how to find things in the app. What do you need?
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={'chat-bubble ' + m.role}>{m.content}</div>
            ))}
            {loading && <div className="chat-bubble assistant chat-thinking">Thinking…</div>}
          </div>

          {error && <div className="chat-error">{error}</div>}

          <div className="chat-input-row">
            {SpeechRecognitionApi && (
              <button
                type="button"
                className={'chat-mic-btn' + (listening ? ' listening' : '')}
                onClick={toggleListening}
                title={listening ? 'Stop listening' : 'Speak your message'}
                aria-label={listening ? 'Stop listening' : 'Speak your message'}
              >
                🎤
              </button>
            )}
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={listening ? 'Listening…' : 'Type a message…'}
              rows={1}
            />
            <button type="button" onClick={() => send()} disabled={loading || !input.trim()}>Send</button>
          </div>
        </div>
      )}
    </>
  );
}
