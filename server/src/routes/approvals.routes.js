import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { evaluateDecision, approvalChainLabel } from '../utils/chain.js';
import { isScopedRole, filterToScopeOrOwnDepartment, isEmployeeInScopeOrOwnDepartment } from '../utils/scope.js';
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
  // For a Profile Edit request specifically, the approver deciding it also sees how many edit
  // requests this employee has raised in total (this one included) — useful context (e.g. a
  // pattern of repeated requests) that isn't visible from the reason/chain alone.
  const editRequestCountFor = (name) => db.prepare("SELECT COUNT(*) AS c FROM approvals WHERE type = 'Profile Edit' AND requester = ?").get(name).c;
  const enriched = rows.map((r) => {
    const emp = employeeByName(r.requester);
    return {
      ...r, department: emp?.department, team_id: emp?.team_id,
      edit_request_count: r.type === 'Profile Edit' ? editRequestCountFor(r.requester) : undefined
    };
  });
  // Own-department fallback (not the strict filterToScope): an STL/TL who has no explicit
  // supervisor_scopes row still sees their own department's requests, matching how Leave,
  // Attendance and the Dashboard already scope. Without this, a newly-appointed TL sees an empty
  // approvals queue and a submitted profile silently reaches nobody below HR.
  //
  // `?department=` is the Dashboard's filter bar, not a permission check — it narrows what an
  // already-authorised viewer is looking at so the Approvals widget follows the same department
  // selection as the KPIs above it, instead of staying company-wide while everything else narrows.
  const department = (req.query.department || '').trim();
  const visible = department ? enriched.filter((r) => r.department === department) : enriched;
  const scoped = filterToScopeOrOwnDepartment(visible, req.user.role, myEmployee(req.user.sub)?.id);
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

    if (isScopedRole(req.user.role)
      && !isEmployeeInScopeOrOwnDepartment(req.user.role, myEmployee(req.user.sub)?.id, employeeByName(approval.requester))) {
      return res.status(403).json({ error: 'This employee is outside your assigned department/team.' });
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
            `Your attendance regularization request (${approval.detail}) was ${finalStatus.toLowerCase()} by ${req.user.name || 'HR'}.`, { email: true });
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
      // A submitted profile decided from here must move the employee's own stage exactly as
      // Employee Management's Approve/Reject buttons do — approved locks the record, rejected
      // sends it back to the employee to correct and re-submit.
      if (approval.type === 'Profile Update') {
        const requesterEmp = employeeByName(approval.requester);
        if (requesterEmp) {
          db.prepare('UPDATE employees SET stage = ?, edit_requested = 0 WHERE id = ?')
            .run(finalStatus === 'Approved' ? 'locked' : 'assigned', requesterEmp.id);
          // The field-level change list has now been reviewed either way — close it so the next
          // round of edits starts from a clean slate.
          db.prepare("UPDATE employee_profile_changes SET reviewed_at = datetime('now') WHERE employee_id = ? AND reviewed_at IS NULL").run(requesterEmp.id);
          notifyEmployee(requesterEmp.id, `Profile update ${finalStatus}`,
            `Your submitted profile details were ${finalStatus.toLowerCase()} by ${req.user.name || 'HR'}.`);
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
