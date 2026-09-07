import { Router } from 'express';
import { createHash } from 'node:crypto';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { canModule, canModuleAdmin, canFeatureAction } from '../utils/rbac.js';
import { bottomRole, approvalChainLabel, evaluateDecision } from '../utils/chain.js';
import { notifyEmployee } from '../utils/notify.js';
import { isScopedRole, getSupervisorScope, isEmployeeInScope, filterToScope } from '../utils/scope.js';
import { verifyExpenseReceipt } from '../utils/documentVerify.js';

const router = Router();
router.use(requireAuth);

// Dynamic RBAC via Manage Roles — module '15' (Expense & Travel Claims). A Senior Team
// Lead/Team Lead/Assistant Manager also passes: the read routes below fetch-then-filter via
// filterToScope, so admitting them here only ever narrows to their assigned departments/teams.
const isHR = (role) => canModuleAdmin(role, '15') || isScopedRole(role);
const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);
const roleNameOf = (id) => (id ? db.prepare('SELECT name FROM roles WHERE id = ?').get(id)?.name : null);

// Duplicate Receipt Detection: hashes a receipt's actual decoded bytes (not the filename or any
// claim metadata), so the exact same receipt photo/PDF reused for a second claim is caught even
// if the employee renamed the file, changed the description, or a different employee entirely
// uploaded it.
function hashReceipt(dataUrl) {
  if (!dataUrl) return null;
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  return createHash('sha256').update(Buffer.from(match[2], 'base64')).digest('hex');
}

// The receipts a claim carries, as an array, whichever way they got there: the current
// receipts_json column (a JSON array — see db.js), or a pre-existing single-receipt claim's
// legacy receipt_data_url/receipt_hash columns, synthesized into a one-item array so old claims
// still display correctly without a data migration.
function receiptsOf(row) {
  if (row.receipts_json) {
    try {
      const parsed = JSON.parse(row.receipts_json);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* fall through to legacy shape below */ }
  }
  if (row.receipt_data_url) {
    return [{
      name: 'Receipt', dataUrl: row.receipt_data_url, hash: row.receipt_hash || null,
      aiChecked: false, amountMatch: null, placeMatch: null, note: ''
    }];
  }
  return [];
}

// How many days a trip covers — never stored, always derived from from_date/to_date, so it can
// never drift from the two dates it comes from. Inclusive of both ends (3rd to 5th = 3 days).
function daysOf(row) {
  if (!row.from_date || !row.to_date) return null;
  const ms = new Date(`${row.to_date}T00:00:00Z`) - new Date(`${row.from_date}T00:00:00Z`);
  return Math.max(1, Math.round(ms / 86400000) + 1);
}

// Any receipt on this claim whose hash matches a receipt hash belonging to a DIFFERENT claim —
// across every employee, every status (including already-Rejected/Reimbursed ones), since a
// receipt reused after rejection or reused post-reimbursement is exactly the pattern worth
// surfacing to HR, not something to quietly ignore once decided.
function duplicateReceiptNamesFor(claimId) {
  return db.prepare(`
    SELECT DISTINCT h.hash FROM expense_receipt_hashes h
    WHERE h.claim_id = ? AND EXISTS (
      SELECT 1 FROM expense_receipt_hashes h2 WHERE h2.hash = h.hash AND h2.claim_id != ?
    )
  `).all(claimId, claimId).map((r) => r.hash);
}

function present(row) {
  const emp = db.prepare('SELECT name, employee_code, department, team_id FROM employees WHERE id = ?').get(row.employee_id);
  const receipts = receiptsOf(row);
  const duplicateHashes = new Set(duplicateReceiptNamesFor(row.id));
  return {
    ...row,
    employee_name: emp?.name, employee_code: emp?.employee_code, department: emp?.department, team_id: emp?.team_id,
    current_stage_name: roleNameOf(row.current_stage_role_id),
    receipts: receipts.map((r) => ({ ...r, isDuplicate: r.hash ? duplicateHashes.has(r.hash) : false })),
    days: daysOf(row),
    isDuplicateReceipt: duplicateHashes.size > 0
  };
}
function presentAll(rows) { return rows.map(present); }

// Every relevant typed field the current employee typed in, run through OCR against one uploaded
// receipt — self-service before submitting, or HR/finance re-checking one already on file. Runs
// against whatever dataUrl is handed in; nothing is read from or written to the database here.
router.post('/verify-receipt', async (req, res) => {
  const { amount, place, dataUrl } = req.body || {};
  if (!dataUrl) return res.status(400).json({ error: 'No receipt to verify' });
  try {
    const result = await verifyExpenseReceipt({ amount, place }, dataUrl);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not verify this receipt.' });
  }
});

// Employee self-service: my own claims.
router.get('/my', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.json({ claims: [], chainLabel: approvalChainLabel() });
  const claims = presentAll(db.prepare('SELECT * FROM expense_claims WHERE employee_id = ? ORDER BY created_at DESC').all(me.id));
  res.json({ claims, chainLabel: approvalChainLabel() });
});

router.post('/', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
  const { category, amount, description, place, from_date, to_date, receipts } = req.body || {};
  if (!['Travel', 'Food', 'Accommodation', 'Other'].includes(category)) return res.status(400).json({ error: 'A valid category is required' });
  const amt = Math.max(0, parseInt(amount, 10) || 0);
  if (amt <= 0) return res.status(400).json({ error: 'Amount must be greater than 0' });

  // A Travel claim has to say how many days and where — that's the whole point of the trip
  // record. Food/Accommodation/Other may carry the same dates/place (a multi-day offsite has
  // meals and a hotel too), but are not required to.
  if (category === 'Travel') {
    if (!place?.trim()) return res.status(400).json({ error: 'Place is required for a Travel claim' });
    if (!from_date || !to_date) return res.status(400).json({ error: 'From/To dates are required for a Travel claim' });
  }
  if (from_date && to_date && to_date < from_date) return res.status(400).json({ error: 'To date cannot be before From date' });

  const receiptList = Array.isArray(receipts) ? receipts.filter((r) => r?.dataUrl) : [];
  const hashedReceipts = receiptList.map((r) => ({
    name: r.name || 'Receipt', dataUrl: r.dataUrl, hash: hashReceipt(r.dataUrl),
    aiChecked: !!r.aiChecked, amountMatch: r.amountMatch ?? null, placeMatch: r.placeMatch ?? null, note: r.note || ''
  }));

  // Duplicate Receipt Detection: check BEFORE inserting so we can name the original claim in the
  // alert. Never blocks submission — a genuine resubmission (e.g. after rejection for an unrelated
  // reason) is legitimate — it just makes the reuse visible to HR/finance instead of silent.
  const priorMatches = [];
  hashedReceipts.forEach((r) => {
    if (!r.hash) return;
    const prior = db.prepare(`
      SELECT ec.* FROM expense_receipt_hashes h JOIN expense_claims ec ON ec.id = h.claim_id
      WHERE h.hash = ? ORDER BY ec.created_at LIMIT 1
    `).get(r.hash);
    if (prior) priorMatches.push({ receiptName: r.name, claim: present(prior) });
  });

  const stage = bottomRole();
  const submit = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO expense_claims (employee_id, category, amount, description, place, from_date, to_date, receipts_json, current_stage_role_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(me.id, category, amt, description || null, place?.trim() || null, from_date || null, to_date || null, JSON.stringify(hashedReceipts), stage?.id || null);
    const insertHash = db.prepare('INSERT OR IGNORE INTO expense_receipt_hashes (claim_id, hash) VALUES (?, ?)');
    hashedReceipts.forEach((r) => { if (r.hash) insertHash.run(info.lastInsertRowid, r.hash); });
    return info.lastInsertRowid;
  });
  const claimId = submit();

  let duplicateWarning = null;
  if (priorMatches.length) {
    const m = priorMatches[0];
    duplicateWarning = `"${m.receiptName}" matches a receipt already used on claim #${m.claim.id}, ₹${m.claim.amount} (${m.claim.category}) submitted by ${m.claim.employee_name} on ${m.claim.created_at.slice(0, 10)}. HR has been notified.`;
    priorMatches.forEach((pm) => {
      db.prepare('INSERT INTO notifications (title, message, target_role) VALUES (?, ?, ?)').run(
        'Possible Duplicate Receipt',
        `${me.name}'s new ₹${amt} (${category}) claim reuses a receipt ("${pm.receiptName}") already used on claim #${pm.claim.id} (₹${pm.claim.amount}, ${pm.claim.category}) submitted by ${pm.claim.employee_name} on ${pm.claim.created_at.slice(0, 10)}.`,
        'staff'
      );
    });
  }

  res.status(201).json({ claim: present(db.prepare('SELECT * FROM expense_claims WHERE id = ?').get(claimId)), duplicateWarning });
});

// HR/approvers: the pending (and recently decided) queue. Employee ID / Name / Department
// filtering happens client-side on this list, same as the Payroll preview and the Performance
// progress table — this endpoint just returns everything the viewer's own scope allows.
router.get('/', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const claims = filterToScope(presentAll(db.prepare("SELECT * FROM expense_claims ORDER BY (status = 'Pending') DESC, created_at DESC").all()), req.user.role, myEmployee(req.user.sub)?.id);
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
    res.json({ claim: present(db.prepare('SELECT * FROM expense_claims WHERE id = ?').get(claim.id)) });
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
  res.json({ claim: present(db.prepare('SELECT * FROM expense_claims WHERE id = ?').get(claim.id)) });
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
