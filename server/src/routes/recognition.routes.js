import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();
router.use(requireAuth);

const AWARD_TYPES = ['Employee of the Month', 'Spot Award', 'Team Player', 'Innovation Award', 'Above & Beyond'];
const AWARD_POINTS = { 'Employee of the Month': 50, 'Spot Award': 15, 'Team Player': 10, 'Innovation Award': 20, 'Above & Beyond': 10 };
const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);

function withNames(rows) {
  return rows.map((r) => ({
    ...r,
    from_name: r.from_employee_id ? db.prepare('SELECT name FROM employees WHERE id = ?').get(r.from_employee_id)?.name : 'Super Admin',
    to_name: db.prepare('SELECT name FROM employees WHERE id = ?').get(r.to_employee_id)?.name
  }));
}

// Company-wide recognition feed — everyone can see everyone's recognitions (the point is
// visibility/celebration, unlike Disciplinary which is the opposite).
router.get('/feed', (req, res) => {
  res.json({
    feed: withNames(db.prepare('SELECT * FROM recognitions ORDER BY created_at DESC LIMIT 50').all()),
    awardTypes: AWARD_TYPES
  });
});

// Giving recognition is a Super Admin/HR Admin/Manager-only action — a plain employee (and
// Assistant Manager/STL/TL) can be recognized, and sees the leaderboard/feed like everyone
// else, but doesn't get to nominate others themselves.
const CAN_GIVE_ROLES = ['super_admin', 'hr_admin', 'manager'];

router.post('/', (req, res) => {
  if (!CAN_GIVE_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const me = myEmployee(req.user.sub);
  // Super Admin is a pure system-administrator account — it's allowed to give recognition even
  // with no employee record of its own (from_employee_id is nullable for exactly this case).
  // Every other give-capable role still needs a real linked employee to be attributed as "from".
  if (!me && req.user.role !== 'super_admin') return res.status(400).json({ error: 'No employee record linked to your account.' });
  const { to_employee_id, award_type, message } = req.body || {};
  if (!to_employee_id) return res.status(400).json({ error: 'Choose who you\'re recognizing' });
  if (me && Number(to_employee_id) === me.id) return res.status(400).json({ error: 'You cannot recognize yourself' });
  if (!AWARD_TYPES.includes(award_type)) return res.status(400).json({ error: 'A valid award type is required' });
  if (!message?.trim()) return res.status(400).json({ error: 'A message is required' });
  const info = db.prepare('INSERT INTO recognitions (from_employee_id, to_employee_id, award_type, message, points) VALUES (?, ?, ?, ?, ?)')
    .run(me ? me.id : null, to_employee_id, award_type, message.trim(), AWARD_POINTS[award_type] || 10);
  res.status(201).json({ recognition: withNames([db.prepare('SELECT * FROM recognitions WHERE id = ?').get(info.lastInsertRowid)])[0] });
});

// Aggregate points per employee, highest first.
router.get('/leaderboard', (req, res) => {
  const rows = db.prepare(`
    SELECT e.id, e.name, e.employee_code, e.department, COALESCE(SUM(r.points), 0) AS total_points, COUNT(r.id) AS award_count
    FROM employees e LEFT JOIN recognitions r ON r.to_employee_id = e.id
    WHERE e.status = 'Active'
    GROUP BY e.id
    HAVING total_points > 0
    ORDER BY total_points DESC
    LIMIT 20
  `).all();
  res.json({ leaderboard: rows });
});

// My own received recognitions.
router.get('/mine', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.json({ received: [] });
  res.json({ received: withNames(db.prepare('SELECT * FROM recognitions WHERE to_employee_id = ? ORDER BY created_at DESC').all(me.id)) });
});

export default router;
