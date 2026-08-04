import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { evaluateDecision, approvalChainLabel } from '../utils/chain.js';
import { isScopedRole, getSupervisorScope, isEmployeeInScope, filterToScope } from '../utils/scope.js';
import { notifyEmployee } from '../utils/notify.js';

const router = Router();
router.use(requireAuth);

const roleNameOf = (id) => (id ? db.prepare('SELECT name FROM roles WHERE id = ?').get(id)?.name : null);
// A department can be split into teams (e.g. Education's Team-A/Team-B) — surface which team
// the requester belongs to so an STL overseeing both teams can tell them apart at a glance.
const teamNameOf = (id) => (id ? db.prepare('SELECT name FROM teams WHERE id = ?').get(id)?.name : null);
const withStage = (rows) => rows.map((r) => ({ ...r, team_name: teamNameOf(r.team_id), current_stage_name: roleNameOf(r.current_stage_role_id) }));
// The approvals table records the requester by name (no employee_id column), matching the
// convention already used in attendance.routes.js's own regularization queries.
const employeeByName = (name) => db.prepare('SELECT id, department, team_id FROM employees WHERE name = ?').get(name);
const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);

router.get('/', (req, res) => {
  const status = req.query.status;
  const rows = status
    ? db.prepare('SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC').all(status)
    : db.prepare("SELECT * FROM approvals ORDER BY (status = 'Pending') DESC, created_at DESC").all();
  // Only pull department/team_id from the matched employee — spreading the whole employee row
  // clobbered the approval's own `id` with the employee's id whenever they happened to collide
  // (both are auto-incrementing ints from 1, so this was a real, silent bug: the client would
  // call /approvals/:id/approve|reject with the wrong id — sometimes another row entirely,
  // sometimes a 404 "Approval not found").
  const enriched = rows.map((r) => {
    const emp = employeeByName(r.requester);
    return { ...r, department: emp?.department, team_id: emp?.team_id };
  });
  const scoped = filterToScope(enriched, req.user.role, myEmployee(req.user.sub)?.id);
  res.json({ approvals: withStage(scoped), chainLabel: approvalChainLabel() });
});

// Sequential approval chain, same mechanics as Leave: a role may act once its authority is at
// least as senior as the request's current stage; acting fast-forwards to the role above the
// actor (skip-level approval), finalizing when none remain. Super Admin always finalizes.
function decide(finalStatus) {
  return (req, res) => {
    const approval = db.prepare('SELECT * FROM approvals WHERE id = ?').get(req.params.id);
    if (!approval) return res.status(404).json({ error: 'Approval not found' });
    if (approval.status !== 'Pending') return res.status(400).json({ error: 'This request has already been decided' });

    if (isScopedRole(req.user.role)) {
      const scope = getSupervisorScope(myEmployee(req.user.sub)?.id);
      if (!isEmployeeInScope(scope, employeeByName(approval.requester))) {
        return res.status(403).json({ error: 'This employee is outside your assigned department/team.' });
      }
    }

    const result = evaluateDecision(req.user.role, approval.current_stage_role_id, finalStatus === 'Rejected');
    if (result.error) return res.status(403).json({ error: result.error });

    if (result.finalized) {
      db.prepare('UPDATE approvals SET status = ?, decided_by = ? WHERE id = ?').run(finalStatus, req.user.sub, approval.id);
      // Leave/Expense already notify their requester from their own dedicated routes — this
      // generic table's Regularization rows are the one type that never did. Scoped to just
      // Regularization here so Leave/Expense don't end up notified twice.
      if (approval.type === 'Regularization') {
        const requesterEmp = employeeByName(approval.requester);
        if (requesterEmp) {
          notifyEmployee(requesterEmp.id, `Regularization ${finalStatus}`,
            `Your attendance regularization request (${approval.detail}) was ${finalStatus.toLowerCase()} by ${req.user.name || 'HR'}.`);
        }
      }
      // A hierarchy-approved profile edit request unlocks the employee's record back to
      // 'assigned' (same effect the old direct HR "Approve edit" used to have) — a rejection
      // leaves them locked, so they'd need to raise a fresh request if they still want the edit.
      if (approval.type === 'Profile Edit') {
        const requesterEmp = employeeByName(approval.requester);
        if (requesterEmp) {
          if (finalStatus === 'Approved') db.prepare("UPDATE employees SET stage = 'assigned' WHERE id = ?").run(requesterEmp.id);
          notifyEmployee(requesterEmp.id, `Profile edit request ${finalStatus}`,
            `Your profile edit request ("${approval.detail}") was ${finalStatus.toLowerCase()} by ${req.user.name || 'HR'}.`);
        }
      }
    } else {
      db.prepare('UPDATE approvals SET current_stage_role_id = ? WHERE id = ?').run(result.stageRoleId, approval.id);
    }
    res.json({ approval: withStage([db.prepare('SELECT * FROM approvals WHERE id = ?').get(approval.id)])[0] });
  };
}

router.post('/:id/approve', decide('Approved'));
router.post('/:id/reject', decide('Rejected'));

export default router;
