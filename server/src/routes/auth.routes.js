import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { isValidDescriptor, euclideanDistance, FACE_MATCH_THRESHOLD } from '../utils/face.js';

const router = Router();

function signToken(user) {
  return jwt.sign(
    { sub: user.id, name: user.name, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role, faceEnrolled: !!user.face_descriptor };
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
  const { email, password, faceDescriptor } = req.body || {};
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

  if (!isValidDescriptor(faceDescriptor)) {
    return res.status(400).json({ error: 'Face capture is required to sign in.' });
  }

  if (!user.face_descriptor) {
    // First successful login enrolls this face as the reference for future logins.
    db.prepare('UPDATE users SET face_descriptor = ? WHERE id = ?').run(JSON.stringify(faceDescriptor), user.id);
    const token = signToken(user);
    return res.json({ token, user: { ...publicUser(user), faceEnrolled: true }, faceJustEnrolled: true });
  }

  const stored = JSON.parse(user.face_descriptor);
  const distance = euclideanDistance(stored, faceDescriptor);
  if (distance > FACE_MATCH_THRESHOLD) {
    return res.status(401).json({ error: 'Face verification failed — this does not match the enrolled face for this account.' });
  }

  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: publicUser(user) });
});

export default router;
