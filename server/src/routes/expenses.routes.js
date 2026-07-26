import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { canModule, canModuleAdmin, canFeatureAction } from '../utils/rbac.js';
import { bottomRole, approvalChainLabel, evaluateDecision } from '../utils/chain.js';
import { notifyEmployee } from '../utils/notify.js';

const router = Router();
router.use(requireAuth);

// Dynamic RBAC via Manage Roles — module '15' (Expense & Travel Claims).
const isHR = (role) => canModuleAdmin(role, '15');
const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);
const roleNameOf = (id) => (id ? db.prepare('SELECT name FROM roles WHERE id = ?').get(id)?.name : null);

function withName(rows) {
  return rows.map((r) => {
    const emp = db.prepare('SELECT name, employee_code FROM employees WHERE id = ?').get(r.employee_id);
    return { ...r, employee_name: emp?.name, employee_code: emp?.employee_code, current_stage_name: roleNameOf(r.current_stage_role_id) };
  });
}

// Employee self-service: my own claims.
router.get('/my', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.json({ claims: [], chainLabel: approvalChainLabel() });
  const claims = withName(db.prepare('SELECT * FROM expense_claims WHERE employee_id = ? ORDER BY created_at DESC').all(me.id));
  res.json({ claims, chainLabel: approvalChainLabel() });
});

router.post('/', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
  const { category, amount, description, receipt_data_url } = req.body || {};
  if (!['Travel', 'Food', 'Accommodation', 'Other'].includes(category)) return res.status(400).json({ error: 'A valid category is required' });
  const amt = Math.max(0, parseInt(amount, 10) || 0);
  if (amt <= 0) return res.status(400).json({ error: 'Amount must be greater than 0' });
  const stage = bottomRole();
  const info = db.prepare('INSERT INTO expense_claims (employee_id, category, amount, description, receipt_data_url, current_stage_role_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(me.id, category, amt, description || null, receipt_data_url || null, stage?.id || null);
  res.status(201).json({ claim: withName([db.prepare('SELECT * FROM expense_claims WHERE id = ?').get(info.lastInsertRowid)])[0] });
});

// HR/approvers: the pending (and recently decided) queue.
router.get('/', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const claims = withName(db.prepare("SELECT * FROM expense_claims ORDER BY (status = 'Pending') DESC, created_at DESC").all());
  res.json({ claims, chainLabel: approvalChainLabel() });
});

// Sequential approval chain — see server/src/utils/chain.js (same mechanics as Leave and
// Attendance Regularization).
function decide(finalStatus) {
  return (req, res) => {
    const claim = db.prepare('SELECT * FROM expense_claims WHERE id = ?').get(req.params.id);
    if (!claim) return res.status(404).json({ error: 'Claim not found' });
    if (claim.status !== 'Pending') return res.status(400).json({ error: 'This claim has already been decided' });

    const result = evaluateDecision(req.user.role, claim.current_stage_role_id, finalStatus === 'Rejected');
    if (result.error) return res.status(403).json({ error: result.error });

    if (result.finalized) {
      db.prepare("UPDATE expense_claims SET status = ?, decided_at = datetime('now'), current_stage_role_id = NULL WHERE id = ?").run(finalStatus, claim.id);
      notifyEmployee(claim.employee_id, `Expense claim ${finalStatus.toLowerCase()}`, `Your expense claim of ₹${claim.amount} (${claim.category}) was ${finalStatus.toLowerCase()}.`);
    } else {
      db.prepare('UPDATE expense_claims SET current_stage_role_id = ? WHERE id = ?').run(result.stageRoleId, claim.id);
    }
    res.json({ claim: withName([db.prepare('SELECT * FROM expense_claims WHERE id = ?').get(claim.id)])[0] });
  };
}
router.put('/:id/approve', decide('Approved'));
router.put('/:id/reject', decide('Rejected'));

// Terminal step once finance has actually paid it out.
router.put('/:id/reimburse', (req, res) => {
  // Feature-level gate: marking a claim reimbursed is the 'Reimbursement Processing' feature.
  if (!canFeatureAction(req.user.role, '15', 'Reimbursement Processing', 'Manage')) return res.status(403).json({ error: 'Insufficient permissions' });
  const claim = db.prepare('SELECT * FROM expense_claims WHERE id = ?').get(req.params.id);
  if (!claim) return res.status(404).json({ error: 'Claim not found' });
  if (claim.status !== 'Approved') return res.status(400).json({ error: 'Only an approved claim can be marked reimbursed.' });
  db.prepare("UPDATE expense_claims SET status = 'Reimbursed', reimbursed_at = datetime('now') WHERE id = ?").run(claim.id);
  notifyEmployee(claim.employee_id, 'Expense claim reimbursed', `Your expense claim of ₹${claim.amount} (${claim.category}) has been reimbursed.`);
  res.json({ claim: withName([db.prepare('SELECT * FROM expense_claims WHERE id = ?').get(claim.id)])[0] });
});

router.get('/reports', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const claims = db.prepare('SELECT * FROM expense_claims').all();
  const byCategory = {};
  claims.forEach((c) => {
    byCategory[c.category] = byCategory[c.category] || { category: c.category, count: 0, totalAmount: 0 };
    byCategory[c.category].count++;
    byCategory[c.category].totalAmount += c.amount;
  });
  const totalReimbursed = claims.filter((c) => c.status === 'Reimbursed').reduce((t, c) => t + c.amount, 0);
  const totalPending = claims.filter((c) => c.status === 'Pending').reduce((t, c) => t + c.amount, 0);
  res.json({ byCategory: Object.values(byCategory), totalReimbursed, totalPending, totalClaims: claims.length });
});

export default router;
