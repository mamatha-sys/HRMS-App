import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api.js';

const ANSWER_SECONDS = 90;
const SpeechRecognitionApi = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
const supportsRecording = typeof window !== 'undefined' && !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

// Public, unauthenticated page — a candidate opens this from their invite email, no login. Asks
// each interview question out loud (browser text-to-speech), records a short video answer on
// their camera, and live-transcribes it (browser speech-to-text) for the AI to score afterward.
// Nothing here is HRMS-authenticated; the token in the URL is the only thing that scopes access.
export default function CandidateInterview() {
  const { token } = useParams();
  const [phase, setPhase] = useState('loading'); // loading | error | landing | ready | recording | submitting | done
  const [error, setError] = useState('');
  const [interview, setInterview] = useState(null); // { candidateName, positionTitle, currentIndex, totalQuestions, question }
  const [timeLeft, setTimeLeft] = useState(ANSWER_SECONDS);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const recognitionRef = useRef(null);
  const transcriptRef = useRef('');
  const timerRef = useRef(null);

  useEffect(() => {
    api.get(`/interview/${token}`)
      .then((r) => {
        if (r.data.status === 'completed') { setPhase('done'); return; }
        setInterview(r.data);
        setPhase('landing');
      })
      .catch((err) => { setError(err.response?.data?.error || 'This interview link could not be loaded.'); setPhase('error'); });
    return () => stopEverything();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  function stopEverything() {
    clearInterval(timerRef.current);
    recognitionRef.current?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
  }

  function speak(text) {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }

  async function startInterview() {
    if (!supportsRecording) { setError('Your browser doesn\'t support camera recording — please open this link in Chrome, Edge, or Firefox on a desktop or Android device.'); setPhase('error'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 }, audio: true });
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.muted = true; videoRef.current.play().catch(() => {}); }
      setPhase('ready');
      speak(interview.question);
    } catch {
      setError('Camera/microphone access is required for this interview — please allow access and reload the page.');
      setPhase('error');
    }
  }

  function startRecording() {
    window.speechSynthesis?.cancel();
    chunksRef.current = [];
    transcriptRef.current = '';
    const recorder = new MediaRecorder(streamRef.current, { mimeType: MediaRecorder.isTypeSupported('video/webm') ? 'video/webm' : undefined });
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    recorder.onstop = submitAnswer;
    recorderRef.current = recorder;
    recorder.start();

    if (SpeechRecognitionApi) {
      const recognition = new SpeechRecognitionApi();
      recognition.lang = 'en-US';
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) transcriptRef.current += (transcriptRef.current ? ' ' : '') + e.results[i][0].transcript;
        }
      };
      recognition.onerror = () => {};
      recognition.start();
      recognitionRef.current = recognition;
    }

    setTimeLeft(ANSWER_SECONDS);
    timerRef.current = setInterval(() => {
      setTimeLeft((t) => {
        if (t <= 1) { stopRecording(); return 0; }
        return t - 1;
      });
    }, 1000);
    setPhase('recording');
  }

  function stopRecording() {
    clearInterval(timerRef.current);
    recognitionRef.current?.stop();
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
  }

  async function submitAnswer() {
    setPhase('submitting');
    const blob = new Blob(chunksRef.current, { type: 'video/webm' });
    const videoDataUrl = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });

    try {
      const r = await api.post(`/interview/${token}/answer`, { transcript: transcriptRef.current, video_data_url: videoDataUrl });
      if (r.data.done) {
        stopEverything();
        setPhase('done');
      } else {
        setInterview((iv) => ({ ...iv, currentIndex: r.data.currentIndex, totalQuestions: r.data.totalQuestions, question: r.data.nextQuestion }));
        setPhase('ready');
        speak(r.data.nextQuestion);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Could not submit that answer — please try again.');
      setPhase('error');
    }
  }

  if (phase === 'loading') return <Centered>Loading your interview…</Centered>;
  if (phase === 'error') return <Centered><div className="banner error">{error}</div></Centered>;
  if (phase === 'done') return (
    <Centered>
      <h1>Thank you!</h1>
      <p>Your interview has been submitted. Our team will review your responses and get back to you soon.</p>
    </Centered>
  );

  if (phase === 'landing') return (
    <Centered>
      <h1>Hi {interview.candidateName?.split(' ')[0]}, welcome to your interview</h1>
      <p>You're interviewing for <strong>{interview.positionTitle || 'the open position'}</strong>. You'll be asked {interview.totalQuestions} questions on camera, one at a time — each answer is up to {ANSWER_SECONDS} seconds.</p>
      <p className="note">Make sure your camera and microphone are available, then click Start when ready.</p>
      <button className="primary" onClick={startInterview}>Start Interview</button>
    </Centered>
  );

  // ready | recording | submitting
  return (
    <Centered wide>
      <div className="note" style={{ marginBottom: 6 }}>Question {interview.currentIndex + 1} of {interview.totalQuestions}</div>
      <h2 style={{ marginTop: 0 }}>{interview.question}</h2>
      <video ref={videoRef} style={{ width: 320, height: 240, background: '#000', borderRadius: 8, marginBottom: 12 }} playsInline />
      <div>
        {phase === 'ready' && <button className="primary" onClick={startRecording}>Start Recording My Answer</button>}
        {phase === 'recording' && (
          <>
            <div className="note" style={{ marginBottom: 8 }}>🔴 Recording — {timeLeft}s left</div>
            <button onClick={stopRecording}>I'm done answering</button>
          </>
        )}
        {phase === 'submitting' && <div className="note">Submitting your answer…</div>}
      </div>
    </Centered>
  );
}

function Centered({ children, wide }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F7F8FA', padding: 20 }}>
      <div className="card" style={{ maxWidth: wide ? 480 : 440, width: '100%', textAlign: 'center' }}>{children}</div>
    </div>
  );
}
