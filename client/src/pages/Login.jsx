import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { loadFaceModels, extractFaceDescriptor, detectFacePresence } from '../faceApi.js';
import api from '../api.js';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const detectLoopRef = useRef(null);

  const [email, setEmail] = useState('admin@hrms.com');
  const [password, setPassword] = useState('Admin@123');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [cameraStatus, setCameraStatus] = useState('loading'); // loading | ready | error
  const [facePresent, setFacePresent] = useState(false);
  const [videoInfo, setVideoInfo] = useState('');
  const [faceMismatch, setFaceMismatch] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [branding, setBranding] = useState(null);

  useEffect(() => { api.get('/branding').then((r) => setBranding(r.data)).catch(() => {}); }, []);

  useEffect(() => {
    let cancelled = false;

    async function setup() {
      try {
        await loadFaceModels();
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setCameraStatus('ready');
        setVideoInfo(`${videoRef.current.videoWidth}×${videoRef.current.videoHeight}`);

        detectLoopRef.current = setInterval(async () => {
          if (cancelled || !videoRef.current) return;
          const present = await detectFacePresence(videoRef.current);
          if (!cancelled) setFacePresent(present);
        }, 500);
      } catch (err) {
        setCameraStatus('error');
        setError('Camera/model setup failed: ' + (err.message || 'permission denied or unsupported browser.'));
      }
    }
    setup();

    return () => {
      cancelled = true;
      if (detectLoopRef.current) clearInterval(detectLoopRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setInfo('');
    setFaceMismatch(false);

    if (cameraStatus !== 'ready') {
      setError('Camera is not ready yet. Please allow camera access and wait for it to load.');
      return;
    }

    setSubmitting(true);
    try {
      const descriptor = await extractFaceDescriptor(videoRef.current);
      if (!descriptor) {
        setError('No face detected. Move closer, face the camera directly, and make sure the room is well lit.');
        setSubmitting(false);
        return;
      }

      const data = await login(email, password, descriptor);
      if (data.faceJustEnrolled) {
        setInfo('Face enrolled — this face is now required for future logins to this account.');
      }
      navigate(location.state?.from || '/dashboard', { replace: true });
    } catch (err) {
      const message = err.response?.data?.error || 'Login failed';
      setError(message);
      if (message.toLowerCase().includes('does not match the enrolled face')) {
        setFaceMismatch(true);
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResetFace() {
    setResetting(true);
    setError('');
    try {
      await api.post('/auth/reset-face', { email, password });
      setFaceMismatch(false);
      setInfo('Face enrollment cleared. Click "Capture face & Sign in" again to enroll your current face.');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not reset face enrollment.');
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          {branding?.company_logo && <img src={branding.company_logo} alt="" className="brand-logo" />}
          {branding?.company_name || 'HRMS'}
        </div>
        <div className="login-subtitle">Sign in with email, password &amp; face verification</div>

        {error && <div className="banner error">{error}</div>}
        {faceMismatch && (
          <div className="banner error" style={{ marginTop: -10 }}>
            If this is really your account, your enrolled face may be from a bad earlier capture.{' '}
            <button type="button" onClick={handleResetFace} disabled={resetting} style={{ textDecoration: 'underline', border: 'none', background: 'none', color: '#B3401E', padding: 0, fontWeight: 700 }}>
              {resetting ? 'Resetting...' : 'Reset my face enrollment'}
            </button>
          </div>
        )}
        {info && <div className="banner" style={{ background: '#E8EEF9', border: '1px solid #2E5CB8', color: '#2E5CB8' }}>{info}</div>}

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
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />

          <label className="field-label">Face verification</label>
          <div className="camera-box">
            <video ref={videoRef} muted playsInline className="camera-video" />
            {cameraStatus === 'loading' && <div className="camera-overlay">Loading camera &amp; face models...</div>}
            {cameraStatus === 'error' && <div className="camera-overlay">Camera unavailable</div>}
            {cameraStatus === 'ready' && (
              <div className={'face-indicator ' + (facePresent ? 'ok' : 'warn')}>
                {facePresent ? '✓ Face detected' : 'No face detected'}
              </div>
            )}
          </div>
          <div className="note" style={{ marginBottom: 10 }}>
            First login enrolls your face for this account. Later logins are blocked if the captured face doesn't match.
            {videoInfo && ` (camera resolution: ${videoInfo})`}
          </div>

          <button className="primary login-submit" type="submit" disabled={submitting || cameraStatus !== 'ready'}>
            {submitting ? 'Verifying face...' : 'Capture face & Sign in'}
          </button>
        </form>

        <div className="note login-hint">
          Demo accounts — Super Admin: admin@hrms.com / Admin@123 · Manager: manager@hrms.com / Manager@123 · Employee: employee@hrms.com / Employee@123
        </div>
      </div>
    </div>
  );
}
