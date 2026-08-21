import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import api from '../api.js';

const SpeechRecognitionApi = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
const speechSynthesisApi = typeof window !== 'undefined' ? window.speechSynthesis : null;

// Preset prompts shown as tappable chips before the first message — cuts the "blank textbox"
// friction and points people at what the assistant is actually grounded to answer (see
// buildSystemPrompt server-side: leave balances, pending requests, policies, how-to).
const QUICK_ACTIONS = [
  { label: '🌴 My leave balance', message: "What's my leave balance?" },
  { label: '📋 My pending requests', message: 'What requests of mine are still pending?' },
  { label: '📜 Company policies', message: 'What company policies should I know about?' },
  { label: '❓ How do I apply for leave', message: 'How do I apply for leave?' }
];

const ACTION_LABELS = {
  submit_leave: 'Submit leave request',
  approve_request: 'Approve request',
  reject_request: 'Reject request',
  request_profile_edit: 'Request profile edit',
  post_announcement: 'Post announcement'
};

function describeAction(action, params) {
  switch (action) {
    case 'submit_leave':
      return [
        ['Type', params.leave_type_name || (params.leave_type_id ? `Leave type #${params.leave_type_id}` : '—')],
        ['From', params.from_date || '—'],
        ['To', params.to_date || '—'],
        ...(params.reason ? [['Reason', params.reason]] : [])
      ];
    case 'approve_request':
    case 'reject_request':
      return [['Request', params.label || `${params.kind || '?'} #${params.id || '?'}`]];
    case 'request_profile_edit':
      return [['Reason', params.reason || '—']];
    case 'post_announcement':
      return [['Title', params.title || '—'], ['Category', params.category || 'General'], ['Body', params.body || '—']];
    default:
      return [];
  }
}

// Floating chat widget available on every authenticated page (mounted once in AppLayout).
// Two distinct modes share this one panel/shell (open state, mic, TTS, copy, quick actions):
//  - Assistant: read-only Q&A, exactly as before — it can never change anything (see
//    buildSystemPrompt in chatbot.routes.js, which explicitly refuses to take actions).
//  - Agent: can PROPOSE real actions (submit leave, approve/reject, request a profile edit, post
//    an announcement), but every proposal is a plan-then-confirm two-step — nothing executes
//    until the user explicitly clicks Confirm on the card (see agent.routes.js).
// Conversation lives only in this component's state — nothing is persisted server-side, so a page
// reload starts fresh in both modes.
export default function ChatAssistant() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('assistant');
  const [messages, setMessages] = useState([]);
  const [agentMessages, setAgentMessages] = useState([]);
  const [agentCtx, setAgentCtx] = useState(null);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [executingIdx, setExecutingIdx] = useState(null);
  const [error, setError] = useState('');
  const [listening, setListening] = useState(false);
  const [speakingIdx, setSpeakingIdx] = useState(null);
  const [copiedIdx, setCopiedIdx] = useState(null);
  const [aiDown, setAiDown] = useState(false);
  const listRef = useRef(null);
  const recognitionRef = useRef(null);

  const activeMessages = mode === 'assistant' ? messages : agentMessages;

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, agentMessages, mode, open, loading]);

  // Lets other parts of the app (e.g. the Dashboard's Quick Actions "Ask AI Assistant" button)
  // open the panel without needing to lift this component's state up through the route tree.
  useEffect(() => {
    const openHandler = () => setOpen(true);
    window.addEventListener('hrms:open-assistant', openHandler);
    return () => window.removeEventListener('hrms:open-assistant', openHandler);
  }, []);

  useEffect(() => () => recognitionRef.current?.stop(), []);
  useEffect(() => () => speechSynthesisApi?.cancel(), []);

  // Checked fresh every time the panel opens (rather than trusting a stale value) so a message
  // that's about to fail says why up front, instead of the user only finding out after typing.
  useEffect(() => {
    if (open) api.get('/agent/status').then((r) => setAiDown(!r.data.available)).catch(() => setAiDown(true));
  }, [open]);

  // Fetch once per session (not per message) what this user is currently allowed to do, purely to
  // decide which quick-action chips to show (e.g. hide "Post an announcement" from non-HR users,
  // hide "Review pending approvals" when nothing is actually pending for them). The real
  // permission enforcement always happens server-side on /agent/plan and /agent/execute — this is
  // display-only.
  useEffect(() => {
    if (mode === 'agent' && open && !agentCtx) {
      api.get('/agent/context').then((r) => setAgentCtx(r.data)).catch(() => setAgentCtx({ hasEmployee: true, canAnnounce: false, actionableCount: 0 }));
    }
  }, [mode, open, agentCtx]);

  function clearChat() {
    speechSynthesisApi?.cancel();
    if (mode === 'assistant') setMessages([]); else setAgentMessages([]);
    setError('');
    setSpeakingIdx(null);
  }

  function copyMessage(idx, text) {
    const markCopied = () => {
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx((v) => (v === idx ? null : v)), 1500);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(markCopied, () => fallbackCopy(text, markCopied));
    } else {
      fallbackCopy(text, markCopied);
    }
  }

  // Some embedded/automation browser contexts deny the async Clipboard API outright — this
  // legacy textarea+execCommand path still works there since it's a synchronous, in-page copy.
  function fallbackCopy(text, onDone) {
    const el = document.createElement('textarea');
    el.value = text;
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    try { document.execCommand('copy'); onDone(); } catch { /* copy not supported here */ }
    document.body.removeChild(el);
  }

  // Read a reply aloud via the browser's native TTS — the mirror of the mic's speech-to-text input,
  // so the assistant can be used fully hands-free. Feature-detected, same as the mic button.
  function toggleSpeak(idx, text) {
    if (!speechSynthesisApi) return;
    if (speakingIdx === idx) {
      speechSynthesisApi.cancel();
      setSpeakingIdx(null);
      return;
    }
    speechSynthesisApi.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = () => setSpeakingIdx((v) => (v === idx ? null : v));
    utterance.onerror = () => setSpeakingIdx((v) => (v === idx ? null : v));
    setSpeakingIdx(idx);
    speechSynthesisApi.speak(utterance);
  }

  async function send(overrideText) {
    const text = (overrideText ?? input).trim();
    if (!text || loading) return;
    if (mode === 'agent') return sendAgent(text);
    setError('');
    const history = messages.slice(-10).map((m) => ({ role: m.role, content: m.content }));
    setMessages((m) => [...m, { role: 'user', kind: 'text', content: text }]);
    setInput('');
    setLoading(true);
    try {
      const r = await api.post('/chatbot/ask', { message: text, history });
      setMessages((m) => [...m, { role: 'assistant', kind: 'text', content: r.data.reply }]);
    } catch (err) {
      setError(err.response?.data?.error || 'The assistant could not reply — please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function sendAgent(text) {
    setError('');
    // Every turn must alternate user/assistant or the model loses track of what it already
    // proposed and repeats a stale action — so proposal turns are represented too (as their
    // summary + outcome), not dropped, even though they're rendered as cards rather than bubbles.
    const history = agentMessages
      .slice(-6)
      .map((m) => ({
        role: m.role,
        content: m.kind === 'proposal'
          ? `[Proposed ${m.action}: ${m.summary}] ${m.status === 'done' ? `Confirmed — ${m.resultMessage}` : m.status === 'failed' ? `Confirmed but failed — ${m.resultMessage}` : m.status === 'cancelled' ? 'User cancelled this, did not happen.' : 'Awaiting user confirmation.'}`
          : m.content
      }));
    setAgentMessages((m) => [...m, { role: 'user', kind: 'text', content: text }]);
    setInput('');
    setLoading(true);
    try {
      const r = await api.post('/agent/plan', { message: text, history });
      const { action, params, summary } = r.data;
      if (action === 'clarify' || !action) {
        setAgentMessages((m) => [...m, { role: 'assistant', kind: 'text', content: summary || "I'm not sure what you'd like me to do — could you rephrase?" }]);
      } else {
        setAgentMessages((m) => [...m, { role: 'assistant', kind: 'proposal', action, params, summary, status: 'pending' }]);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'The agent could not respond — please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function confirmProposal(idx) {
    const msg = agentMessages[idx];
    if (!msg || msg.kind !== 'proposal' || msg.status !== 'pending') return;
    setExecutingIdx(idx);
    try {
      const r = await api.post('/agent/execute', { action: msg.action, params: msg.params });
      setAgentMessages((arr) => arr.map((m, i) => (i === idx ? { ...m, status: 'done', resultMessage: r.data.message } : m)));
    } catch (err) {
      setAgentMessages((arr) => arr.map((m, i) => (i === idx ? { ...m, status: 'failed', resultMessage: err.response?.data?.error || 'Could not complete this action.' } : m)));
    } finally {
      setExecutingIdx(null);
    }
  }

  function cancelProposal(idx) {
    setAgentMessages((arr) => arr.map((m, i) => (i === idx ? { ...m, status: 'cancelled' } : m)));
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

  const agentQuickActions = [
    { label: '🌴 Apply for leave', message: 'I want to apply for leave' },
    ...(agentCtx?.actionableCount ? [{ label: '✅ Review what I can approve', message: 'What do I have pending to approve or reject?' }] : []),
    { label: '✏️ Request a profile edit', message: 'I want to request a change to my profile' },
    ...(agentCtx?.canAnnounce ? [{ label: '📣 Post an announcement', message: 'I want to post a company announcement' }] : [])
  ];

  return (
    <>
      <button type="button" className="chat-fab" onClick={() => setOpen((v) => !v)} aria-label={open ? 'Close assistant' : 'Open assistant'}>
        {open ? '✕' : '💬'}
      </button>

      {open && (
        <div className="chat-panel">
          <div className="chat-panel-header">
            <div>
              <div className="chat-panel-title">{mode === 'assistant' ? 'HRMS Assistant' : 'HRMS Agent'}</div>
              <div className="chat-panel-subtitle">
                {mode === 'assistant' ? 'Ask about your leave, or how to use the app' : 'I can submit, approve, or post things for you — nothing happens until you confirm'}
              </div>
            </div>
            {activeMessages.length > 0 && (
              <button type="button" className="chat-panel-close" onClick={clearChat} title="Clear chat" aria-label="Clear chat">🗑</button>
            )}
            <button type="button" className="chat-panel-close" onClick={() => setOpen(false)} aria-label="Close">✕</button>
          </div>

          {aiDown && (
            <div className="chat-ai-down-banner">⚠️ Local AI isn't reachable right now — replies will likely fail. Someone needs to start Ollama on the server.</div>
          )}

          <div className="chat-mode-tabs">
            <button type="button" className={mode === 'assistant' ? 'active' : ''} onClick={() => setMode('assistant')}>💬 Assistant</button>
            <button type="button" className={mode === 'agent' ? 'active' : ''} onClick={() => setMode('agent')}>⚡ Agent</button>
          </div>

          <div className="chat-messages" ref={listRef}>
            {activeMessages.length === 0 && mode === 'assistant' && (
              <>
                <div className="chat-bubble assistant">
                  Hi {user.name?.split(' ')[0] || ''}! I can answer questions about your leave balance, pending requests, or how to find things in the app. What do you need?
                </div>
                <div className="chat-quick-actions">
                  {QUICK_ACTIONS.map((qa) => (
                    <button key={qa.label} type="button" className="chat-quick-action" onClick={() => send(qa.message)} disabled={loading}>
                      {qa.label}
                    </button>
                  ))}
                </div>
              </>
            )}
            {activeMessages.length === 0 && mode === 'agent' && (
              <>
                <div className="chat-bubble assistant">
                  Hi {user.name?.split(' ')[0] || ''}! I'm the Agent — I can actually submit or approve things for you, like applying for leave or deciding a pending request. I'll always show you exactly what I'm about to do and wait for your confirmation first.
                </div>
                <div className="chat-quick-actions">
                  {agentQuickActions.map((qa) => (
                    <button key={qa.label} type="button" className="chat-quick-action" onClick={() => send(qa.message)} disabled={loading}>
                      {qa.label}
                    </button>
                  ))}
                </div>
              </>
            )}
            {activeMessages.map((m, i) => (
              <div key={i} className={'chat-bubble-wrap ' + m.role}>
                {m.kind === 'proposal' ? (
                  <div className={'chat-proposal' + (m.status !== 'pending' ? ' ' + m.status : '')}>
                    <div className="chat-proposal-title">{ACTION_LABELS[m.action] || m.action}</div>
                    <div className="chat-proposal-summary">{m.summary}</div>
                    <table className="chat-proposal-details"><tbody>
                      {describeAction(m.action, m.params).map(([k, v]) => (
                        <tr key={k}><td>{k}</td><td>{v}</td></tr>
                      ))}
                    </tbody></table>
                    {m.status === 'pending' && (
                      <div className="chat-proposal-actions">
                        <button type="button" className="chat-proposal-confirm" onClick={() => confirmProposal(i)} disabled={executingIdx === i}>
                          {executingIdx === i ? 'Working…' : 'Confirm'}
                        </button>
                        <button type="button" className="chat-proposal-cancel" onClick={() => cancelProposal(i)} disabled={executingIdx === i}>Cancel</button>
                      </div>
                    )}
                    {m.status === 'done' && <div className="chat-proposal-result ok">✓ {m.resultMessage}</div>}
                    {m.status === 'failed' && <div className="chat-proposal-result error">✕ {m.resultMessage}</div>}
                    {m.status === 'cancelled' && <div className="chat-proposal-result">Cancelled — nothing was done.</div>}
                  </div>
                ) : (
                  <>
                    <div className={'chat-bubble ' + m.role}>{m.content}</div>
                    {m.role === 'assistant' && (
                      <div className="chat-bubble-actions">
                        <button type="button" onClick={() => copyMessage(i, m.content)} title="Copy" aria-label="Copy reply">
                          {copiedIdx === i ? '✓' : '📋'}
                        </button>
                        {speechSynthesisApi && (
                          <button type="button" onClick={() => toggleSpeak(i, m.content)} title={speakingIdx === i ? 'Stop reading' : 'Read aloud'} aria-label={speakingIdx === i ? 'Stop reading' : 'Read aloud'}>
                            {speakingIdx === i ? '⏹' : '🔊'}
                          </button>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
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
              placeholder={listening ? 'Listening…' : mode === 'agent' ? 'Tell the agent what to do…' : 'Type a message…'}
              rows={1}
            />
            <button type="button" onClick={() => send()} disabled={loading || !input.trim()}>Send</button>
          </div>
        </div>
      )}
    </>
  );
}
