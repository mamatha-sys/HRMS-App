import { getSetting, setSetting } from './integrationSettings.js';

// Built-in third-party job boards. "Company Careers Page" is deliberately NOT here — it's the
// company's own site, not a connectable third-party integration, so it's always available and
// has no connected/disconnected state.
const BUILTIN_LABELS = { naukri: 'Naukri', linkedin: 'LinkedIn', shine: 'Shine', indeed: 'Indeed' };

// A board is "connected" the same way Calendar/Webhooks are: real config is on file (here, an
// employer API key / account ID), not a bare on/off flag. Naukri/LinkedIn/Indeed ship with a
// demo credential so a working demo has somewhere to post to out of the box; Shine has none so
// "Shine (not connected)" shows until Super Admin supplies a real key.
const DEFAULT_CREDENTIAL = { naukri: 'demo-naukri-employer-id', linkedin: 'demo-linkedin-employer-id', indeed: 'demo-indeed-employer-id' };

const EXTRA_BOARDS_KEY = 'jobboard_extra_boards';

// Super Admin can add more boards beyond the 4 built-ins (e.g. a niche/regional portal) — stored
// as a JSON [{key, label}] list rather than a hardcoded array, so the catalog can grow.
function extraBoards() {
  const raw = getSetting(EXTRA_BOARDS_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

function allBoardDefs() {
  return [...Object.keys(BUILTIN_LABELS).map((key) => ({ key, label: BUILTIN_LABELS[key] })), ...extraBoards()];
}

export function jobBoardKeys() {
  return allBoardDefs().map((b) => b.key);
}

function credentialKey(boardKey) { return `jobboard_${boardKey}_credential`; }

export function getJobBoardCredential(boardKey) {
  const stored = getSetting(credentialKey(boardKey));
  if (stored !== null) return stored;
  return DEFAULT_CREDENTIAL[boardKey] || '';
}

export function isJobBoardConnected(boardKey) {
  if (!jobBoardKeys().includes(boardKey)) return false;
  return getJobBoardCredential(boardKey).trim() !== '';
}

export function listJobBoards() {
  // `link` surfaces the connected credential when it's a real URL (e.g. a LinkedIn company/job
  // page) so Recruitment's "Live on:" line can point at the actual place the job was posted,
  // instead of just naming the board.
  return allBoardDefs().map((b) => {
    const credential = getJobBoardCredential(b.key);
    return { key: b.key, label: b.label, connected: isJobBoardConnected(b.key), link: /^https?:\/\//i.test(credential) ? credential : null };
  });
}

export function connectJobBoard(boardKey, credential) {
  if (!jobBoardKeys().includes(boardKey)) throw new Error('Unknown job board');
  const trimmed = (credential || '').trim();
  if (!trimmed) throw new Error('An employer API key / account ID is required to connect.');
  setSetting(credentialKey(boardKey), trimmed);
}

export function disconnectJobBoard(boardKey) {
  if (!jobBoardKeys().includes(boardKey)) throw new Error('Unknown job board');
  setSetting(credentialKey(boardKey), '');
}

export function addJobBoard(label) {
  const trimmed = (label || '').trim();
  if (!trimmed) throw new Error('Board name is required');
  const key = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  if (!key) throw new Error('Board name is required');
  if (jobBoardKeys().includes(key)) throw new Error('That job board already exists');
  const boards = extraBoards();
  boards.push({ key, label: trimmed });
  setSetting(EXTRA_BOARDS_KEY, JSON.stringify(boards));
  // Starts disconnected — Super Admin still needs to supply that board's real API key/account ID.
  return { key, label: trimmed, connected: false };
}
