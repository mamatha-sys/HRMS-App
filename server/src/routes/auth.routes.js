import { Router } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { sendEmail } from '../utils/channels.js';

const router = Router();

function signToken(user) {
  return jwt.sign(
    { sub: user.id, name: user.name, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

router.post('/register', (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email and password are required' });
  }
  const allowedRoles = ['super_admin', 'manager', 'employee'];
  const finalRole = allowedRoles.includes(role) ? role : 'employee';

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const passwordHash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(name, email, passwordHash, finalRole);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  const token = signToken(user);
  res.status(201).json({ token, user: publicUser(user) });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (!user.active) {
    return res.status(403).json({ error: 'This account has been deactivated. Contact your administrator.' });
  }

  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

// Forgot password — always responds the same way whether or not the email is registered, so
// the response itself can never be used to enumerate which emails have an account.
router.post('/forgot-password', async (req, res) => {
  const email = req.body?.email?.trim();
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (user) {
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    db.prepare('UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?').run(token, expires, user.id);
    const resetLink = `${process.env.CLIENT_URL || 'http://localhost:5173'}/reset-password?token=${token}`;
    try {
      await sendEmail(user.email, 'Reset your password',
        `Hi ${user.name},\n\nUse this link to reset your password (valid for 30 minutes):\n${resetLink}\n\nIf you didn't request this, you can ignore this email.`);
    } catch (err) {
      // No SMTP configured in this environment (or the send failed) — never let that surface to
      // the caller (would leak whether the email exists); log the link so it's still reachable.
      console.log(`[forgot-password] Could not email ${user.email} (${err.message}). Reset link: ${resetLink}`);
    }
  }
  res.json({ message: 'If that email is registered, a password reset link has been sent.' });
});

router.post('/reset-password', (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'Token and new password are required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const user = db.prepare('SELECT * FROM users WHERE reset_token = ?').get(token);
  if (!user || !user.reset_token_expires || new Date(user.reset_token_expires) < new Date()) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
  }

  db.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?')
    .run(bcrypt.hashSync(password, 10), user.id);
  res.json({ message: 'Password updated — you can now sign in with your new password.' });
});

router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: publicUser(user) });
});

export default router;
