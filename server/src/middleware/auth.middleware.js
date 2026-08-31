import jwt from 'jsonwebtoken';
import { verifyFileToken } from '../utils/fileAccessToken.js';

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing or invalid Authorization header' });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// For the photo/document routes only: a request carrying a short file-access token (minted only
// by the already HR-gated export routes — see utils/fileAccessToken.js) is authorized outright,
// no role/ownership re-check needed, since that token already proves the exporting user had
// permission. Anything else falls back to a normal session token (header or query), for the
// in-app photo/document viewers that still send one.
export function requireAuthOrFileToken(kind, indexParam) {
  return (req, res, next) => {
    const index = indexParam ? req.params[indexParam] : '';
    const queryToken = req.query.token || null;
    if (queryToken && verifyFileToken(queryToken, req.params.id, kind, index)) {
      req.fileTokenAuthorized = true;
      return next();
    }
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : queryToken;
    if (!token) return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET);
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}
