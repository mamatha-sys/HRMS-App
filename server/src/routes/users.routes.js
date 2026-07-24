import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.middleware.js';

const router = Router();
router.use(requireAuth, requireRole('super_admin'));

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, active: !!u.active, faceEnrolled: !!u.face_descriptor };
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY id').all();
  res.json({ users: rows.map(publicUser) });
});

router.put('/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { role, active } = req.body || {};
  if (role && !['super_admin', 'manager', 'employee'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  if (Number(req.params.id) === req.user.sub && (active === false || (role && role !== 'super_admin'))) {
    return res.status(400).json({ error: 'You cannot demote or deactivate your own account' });
  }

  db.prepare('UPDATE users SET role = COALESCE(?, role), active = COALESCE(?, active) WHERE id = ?')
    .run(role || null, active === undefined ? null : (active ? 1 : 0), req.params.id);

  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)) });
});

export default router;
