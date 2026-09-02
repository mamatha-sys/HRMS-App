// The single source of truth for every user-facing HRMS link that leaves the server — password
// resets, welcome/account emails, interview invitations.
//
// These links are read in someone's inbox, on their own device, long after the request that
// generated them. So they must point at the real, publicly reachable app — never at whatever host
// happens to be executing the code. A developer running on localhost still triggers mail to real
// people, and "http://localhost:5173/reset-password?..." is a dead link in their inbox.
//
// That is why this is deliberately NOT derived from the incoming request (Host header), the
// listening port, or the old CLIENT_URL variable (which was unset in practice, silently making
// every link fall back to localhost). It is one fixed production base, overridable only by an
// explicit APP_BASE_URL for a different environment (e.g. a staging domain).
const PRODUCTION_BASE = 'https://hrms.teamlinks.in';

function resolveBase() {
  const configured = (process.env.APP_BASE_URL || '').trim();
  if (!configured) return PRODUCTION_BASE;

  // A local address here would put dead links in real inboxes — the exact failure this module
  // exists to prevent — so an accidental local override is refused rather than honoured.
  if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)(:|\/|$)/i.test(configured)) {
    console.warn(`[appUrl] Ignoring APP_BASE_URL="${configured}" — email links must never point at a local address. Falling back to ${PRODUCTION_BASE}.`);
    return PRODUCTION_BASE;
  }
  return configured.replace(/\/+$/, ''); // no trailing slash, so appLink() joins cleanly
}

export const APP_BASE_URL = resolveBase();

// Build an absolute app link: appLink('/login'), appLink(`/reset-password?token=${t}`).
export function appLink(path = '') {
  const p = String(path || '');
  return p ? `${APP_BASE_URL}/${p.replace(/^\/+/, '')}` : APP_BASE_URL;
}
