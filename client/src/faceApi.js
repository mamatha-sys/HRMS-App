import * as faceapi from '@vladmandic/face-api';

const MODEL_URL = '/models';
let loadingPromise = null;

// SSD MobileNet v1 is noticeably more reliable at detecting real faces under normal webcam
// conditions than TinyFaceDetector (which trades accuracy for speed) — worth the larger model.
const DETECTOR_OPTIONS = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.3 });

export function loadFaceModels() {
  if (!loadingPromise) {
    loadingPromise = Promise.all([
      faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
    ]);
  }
  return loadingPromise;
}

// Cheap check used for the live "face detected" indicator — no landmarks/descriptor.
export async function detectFacePresence(videoEl) {
  if (!videoEl || videoEl.readyState < 2 || videoEl.videoWidth === 0) return false;
  try {
    const detection = await faceapi.detectSingleFace(videoEl, DETECTOR_OPTIONS);
    return !!detection;
  } catch (err) {
    console.error('face detection error', err);
    return false;
  }
}

export async function extractFaceDescriptor(videoEl) {
  const detection = await faceapi
    .detectSingleFace(videoEl, DETECTOR_OPTIONS)
    .withFaceLandmarks()
    .withFaceDescriptor();
  if (!detection) return null;
  return Array.from(detection.descriptor);
}
