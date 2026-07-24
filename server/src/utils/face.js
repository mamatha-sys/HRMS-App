export const FACE_DESCRIPTOR_LENGTH = 128;
export const FACE_MATCH_THRESHOLD = 0.6;

export function isValidDescriptor(d) {
  return Array.isArray(d) && d.length === FACE_DESCRIPTOR_LENGTH && d.every((n) => typeof n === 'number' && Number.isFinite(n));
}

export function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}
