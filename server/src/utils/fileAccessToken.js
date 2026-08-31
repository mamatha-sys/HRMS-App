import crypto from 'node:crypto';

// A full login JWT is 200+ characters — embedded as a hyperlink's ?token= query param, Excel's
// Windows hyperlink handler silently fails to open the link: the "Opening <url>..." trust dialog
// shows, clicking OK does nothing at all, no browser opens, no error. This is a short, purpose-
// built, stateless token instead — scoped to exactly one employee's one photo/document until it
// expires — so an export's hyperlinks are a fraction of the length and reliably clickable.
// Minted only from inside the already HR-gated export routes (reports.routes.js), so possessing
// a valid one already proves the exporting user had permission to see this file — no need to
// re-derive role/ownership at click time the way the header-based session token requires.
const TTL_MS = 24 * 60 * 60 * 1000;

function sign(payload) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET).update(payload).digest('base64url');
}

export function makeFileToken(employeeId, kind, index = '') {
  const expires = Date.now() + TTL_MS;
  const payload = `${employeeId}.${kind}.${index}.${expires}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyFileToken(token, employeeId, kind, index = '') {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 5) return false;
  const [empId, k, idx, expires, sig] = parts;
  if (sign(`${empId}.${k}.${idx}.${expires}`) !== sig) return false;
  if (Date.now() > Number(expires)) return false;
  return String(empId) === String(employeeId) && k === kind && idx === String(index);
}
