import { Router } from 'express';
import { createHash } from 'node:crypto';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { canModule, canModuleAdmin, canFeatureAction } from '../utils/rbac.js';
import { bottomRole, approvalChainLabel, evaluateDecision } from '../utils/chain.js';
import { notifyEmployee } from '../utils/notify.js';
import { isScopedRole, getSupervisorScope, isEmployeeInScope, filterToScope } from '../utils/scope.js';

const router = Router();
router.use(requireAuth);

// Dynamic RBAC via Manage Roles — module '15' (Expense & Travel Claims). A Senior Team
// Lead/Team Lead/Assistant Manager also passes: the read routes below fetch-then-filter via
// filterToScope, so admitting them here only ever narrows to their assigned departments/teams.
const isHR = (role) => canModuleAdmin(role, '15') || isScopedRole(role);
const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);
const roleNameOf = (id) => (id ? db.prepare('SELECT name FROM roles WHERE id = ?').get(id)?.name : null);

function withName(rows) {
  return rows.map((r) => {
    const emp = db.prepare('SELECT name, employee_code, department, team_id FROM employees WHERE id = ?').get(r.employee_id);
    return { ...r, employee_name: emp?.name, employee_code: emp?.employee_code, department: emp?.department, team_id: emp?.team_id, current_stage_name: roleNameOf(r.current_stage_role_id) };
  });
}

// Duplicate Receipt Detection: hashes the receipt's actual decoded bytes (not the filename or
// any claim metadata), so the exact same receipt photo/PDF reused for a second claim is caught
// even if the employee renamed the file, changed the description, or a different employee
// entirely uploaded it. Returns null for claims with no receipt — nothing to hash.
function hashReceipt(dataUrl) {
  if (!dataUrl) return null;
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  return createHash('sha256').update(Buffer.from(match[2], 'base64')).digest('hex');
}

// Flags a claim as a possible duplicate whenever its receipt_hash matches ANY other claim's —
// across every employee, every status (including already-Rejected/Reimbursed ones), since a
// receipt reused after rejection or reused post-reimbursement is exactly the pattern worth
// surfacing to HR, not something to quietly ignore once decided.
function withDuplicateFlag(rows) {
  return rows.map((r) => {
    if (!r.receipt_hash) return { ...r, isDuplicateReceipt: false };
    const match = db.prepare('SELECT COUNT(*) AS n FROM expense_claims WHERE receipt_hash = ? AND id != ?').get(r.receipt_hash, r.id);
    return { ...r, isDuplicateReceipt: match.n > 0 };
  });
}

// Employee self-service: my own claims.
router.get('/my', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.json({ claims: [], chainLabel: approvalChainLabel() });
  const claims = withDuplicateFlag(withName(db.prepare('SELECT * FROM expense_claims WHERE employee_id = ? ORDER BY created_at DESC').all(me.id)));
  res.json({ claims, chainLabel: approvalChainLabel() });
});

router.post('/', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
  const { category, amount, description, receipt_data_url } = req.body || {};
  if (!['Travel', 'Food', 'Accommodation', 'Other'].includes(category)) return res.status(400).json({ error: 'A valid category is required' });
  const amt = Math.max(0, parseInt(amount, 10) || 0);
  if (amt <= 0) return res.status(400).json({ error: 'Amount must be greater than 0' });

  // Duplicate Receipt Detection: check BEFORE inserting so we can name the original claim in the
  // alert. Never blocks submission — a genuine resubmission (e.g. after rejection for an unrelated
  // reason) is legitimate — it just makes the reuse visible to HR/finance instead of silent.
  const receiptHash = hashReceipt(receipt_data_url);
  const priorMatch = receiptHash
    ? withName([db.prepare('SELECT * FROM expense_claims WHERE receipt_hash = ? ORDER BY created_at LIMIT 1').get(receiptHash)].filter(Boolean))[0]
    : null;

  const stage = bottomRole();
  const info = db.prepare('INSERT INTO expense_claims (employee_id, category, amount, description, receipt_data_url, receipt_hash, current_stage_role_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(me.id, category, amt, description || null, receipt_data_url || null, receiptHash, stage?.id || null);

  let duplicateWarning = null;
  if (priorMatch) {
    duplicateWarning = `This receipt matches an existing claim — #${priorMatch.id}, ₹${priorMatch.amount} (${priorMatch.category}) submitted by ${priorMatch.employee_name} on ${priorMatch.created_at.slice(0, 10)}. HR has been notified.`;
    db.prepare('INSERT INTO notifications (title, message, target_role) VALUES (?, ?, ?)').run(
      'Possible Duplicate Receipt',
      `${me.name}'s new ₹${amt} (${category}) claim uses the same receipt as claim #${priorMatch.id} (₹${priorMatch.amount}, ${priorMatch.category}) submitted by ${priorMatch.employee_name} on ${priorMatch.created_at.slice(0, 10)}.`,
      'staff'
    );
  }

  res.status(201).json({ claim: withDuplicateFlag(withName([db.prepare('SELECT * FROM expense_claims WHERE id = ?').get(info.lastInsertRowid)]))[0], duplicateWarning });
});

// HR/approvers: the pending (and recently decided) queue.
router.get('/', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const claims = filterToScope(withDuplicateFlag(withName(db.prepare("SELECT * FROM expense_claims ORDER BY (status = 'Pending') DESC, created_at DESC").all())), req.user.role, myEmployee(req.user.sub)?.id);
  res.json({ claims, chainLabel: approvalChainLabel() });
});

// Sequential approval chain — see server/src/utils/chain.js (same mechanics as Leave and
// Attendance Regularization).
function decide(finalStatus) {
  return (req, res) => {
    const claim = db.prepare('SELECT * FROM expense_claims WHERE id = ?').get(req.params.id);
    if (!claim) return res.status(404).json({ error: 'Claim not found' });
    if (claim.status !== 'Pending') return res.status(400).json({ error: 'This claim has already been decided' });

    // A Senior Team Lead/Team Lead/Assistant Manager may only act on claims from employees
    // within their assigned departments/teams — even though the chain says it's their turn —
    // unlike every other HR-tier role in the chain, whose reach stays company-wide.
    if (isScopedRole(req.user.role)) {
      const scope = getSupervisorScope(myEmployee(req.user.sub)?.id);
      const claimant = db.prepare('SELECT department, team_id FROM employees WHERE id = ?').get(claim.employee_id);
      if (!isEmployeeInScope(scope, claimant)) return res.status(403).json({ error: 'This employee is outside your assigned department/team.' });
    }

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
  const enriched = db.prepare('SELECT * FROM expense_claims').all().map((c) => {
    const emp = db.prepare('SELECT department, team_id FROM employees WHERE id = ?').get(c.employee_id);
    return { ...c, department: emp?.department, team_id: emp?.team_id };
  });
  const claims = filterToScope(enriched, req.user.role, myEmployee(req.user.sub)?.id);
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
