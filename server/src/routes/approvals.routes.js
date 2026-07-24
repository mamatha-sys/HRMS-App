import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.middleware.js';

const router = Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const status = req.query.status;
  const rows = status
    ? db.prepare('SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC').all(status)
    : db.prepare("SELECT * FROM approvals ORDER BY (status = 'Pending') DESC, created_at DESC").all();
  res.json({ approvals: rows });
});

function decide(status) {
  return (req, res) => {
    const approval = db.prepare('SELECT * FROM approvals WHERE id = ?').get(req.params.id);
    if (!approval) return res.status(404).json({ error: 'Approval not found' });
    db.prepare('UPDATE approvals SET status = ?, decided_by = ? WHERE id = ?').run(status, req.user.sub, req.params.id);
    res.json({ approval: db.prepare('SELECT * FROM approvals WHERE id = ?').get(req.params.id) });
  };
}

router.post('/:id/approve', requireRole('super_admin', 'manager', 'hr_admin', 'assistant_manager'), decide('Approved'));
router.post('/:id/reject', requireRole('super_admin', 'manager', 'hr_admin', 'assistant_manager'), decide('Rejected'));

export default router;
