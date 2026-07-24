import * as faceapi from '@vladmandic/face-api';

const MODEL_URL = '/models';
let loadingPromise = null;

// Larger inputSize and a lower scoreThreshold than the library default make detection
// noticeably more forgiving under weak/uneven webcam lighting, at the cost of a few more ms per frame.
const DETECTOR_OPTIONS = new faceapi.TinyFaceDetectorOptions({ inputSize: 512, scoreThreshold: 0.3 });

export function loadFaceModels() {
  if (!loadingPromise) {
    loadingPromise = Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
    ]);
  }
  return loadingPromise;
}

// Cheap check used for the live "face detected" indicator — no landmarks/descriptor.
export async function detectFacePresence(videoEl) {
  if (!videoEl || videoEl.readyState < 2) return false;
  const detection = await faceapi.detectSingleFace(videoEl, DETECTOR_OPTIONS);
  return !!detection;
}

export async function extractFaceDescriptor(videoEl) {
  const detection = await faceapi
    .detectSingleFace(videoEl, DETECTOR_OPTIONS)
    .withFaceLandmarks()
    .withFaceDescriptor();
  if (!detection) return null;
  return Array.from(detection.descriptor);
}
