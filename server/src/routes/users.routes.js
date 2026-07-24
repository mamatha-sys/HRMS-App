import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.middleware.js';

const router = Router();
router.use(requireAuth, requireRole('super_admin'));

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, active: !!u.active, faceEnrolled: !!u.face_descriptor };
}

function isValidRole(role) {
  return !!db.prepare('SELECT 1 FROM roles WHERE key = ?').get(role);
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY id').all();
  res.json({ users: rows.map(publicUser) });
});

router.post('/', (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: 'name, email, password and role are required' });
  }
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (!isValidRole(role)) return res.status(400).json({ error: 'Invalid role' });
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'A user with this email already exists' });
  }

  const info = db
    .prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(name.trim(), email.trim(), bcrypt.hashSync(password, 10), role);
  res.status(201).json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)) });
});

router.put('/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { role, active } = req.body || {};
  if (role && !isValidRole(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  if (Number(req.params.id) === req.user.sub && (active === false || (role && role !== 'super_admin'))) {
    return res.status(400).json({ error: 'You cannot demote or deactivate your own account' });
  }

  db.prepare('UPDATE users SET role = COALESCE(?, role), active = COALESCE(?, active) WHERE id = ?')
    .run(role || null, active === undefined ? null : (active ? 1 : 0), req.params.id);

  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)) });
});

router.put('/:id/reset-face', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.prepare('UPDATE users SET face_descriptor = NULL WHERE id = ?').run(req.params.id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)) });
});

export default router;
