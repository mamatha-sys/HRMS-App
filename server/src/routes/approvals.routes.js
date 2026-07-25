import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { evaluateDecision, approvalChainLabel } from '../utils/chain.js';

const router = Router();
router.use(requireAuth);

const roleNameOf = (id) => (id ? db.prepare('SELECT name FROM roles WHERE id = ?').get(id)?.name : null);
const withStage = (rows) => rows.map((r) => ({ ...r, current_stage_name: roleNameOf(r.current_stage_role_id) }));

router.get('/', (req, res) => {
  const status = req.query.status;
  const rows = status
    ? db.prepare('SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC').all(status)
    : db.prepare("SELECT * FROM approvals ORDER BY (status = 'Pending') DESC, created_at DESC").all();
  res.json({ approvals: withStage(rows), chainLabel: approvalChainLabel() });
});

// Sequential approval chain, same mechanics as Leave: a role may act once its authority is at
// least as senior as the request's current stage; acting fast-forwards to the role above the
// actor (skip-level approval), finalizing when none remain. Super Admin always finalizes.
function decide(finalStatus) {
  return (req, res) => {
    const approval = db.prepare('SELECT * FROM approvals WHERE id = ?').get(req.params.id);
    if (!approval) return res.status(404).json({ error: 'Approval not found' });
    if (approval.status !== 'Pending') return res.status(400).json({ error: 'This request has already been decided' });

    const result = evaluateDecision(req.user.role, approval.current_stage_role_id, finalStatus === 'Rejected');
    if (result.error) return res.status(403).json({ error: result.error });

    if (result.finalized) {
      db.prepare('UPDATE approvals SET status = ?, decided_by = ? WHERE id = ?').run(finalStatus, req.user.sub, approval.id);
    } else {
      db.prepare('UPDATE approvals SET current_stage_role_id = ? WHERE id = ?').run(result.stageRoleId, approval.id);
    }
    res.json({ approval: withStage([db.prepare('SELECT * FROM approvals WHERE id = ?').get(approval.id)])[0] });
  };
}

router.post('/:id/approve', decide('Approved'));
router.post('/:id/reject', decide('Rejected'));

export default router;
