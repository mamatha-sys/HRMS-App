import db from '../db.js';

// The approval chain, bottom (least authority) → top, from the live role workflow.
// Paused roles are skipped and 'employee' is excluded. Shared by Leave and Attendance
// Regularization so reordering/pausing roles in Organization Structure changes how both
// actually flow, not just what's displayed.
export function chainRoles() {
  return db.prepare("SELECT * FROM roles WHERE key != 'employee' AND paused = 0 ORDER BY sort_order DESC").all();
}

export function bottomRole() {
  return chainRoles()[0] || db.prepare("SELECT * FROM roles WHERE key = 'super_admin'").get();
}

export function roleAbove(sortOrder) {
  return db.prepare("SELECT * FROM roles WHERE key != 'employee' AND paused = 0 AND sort_order < ? ORDER BY sort_order DESC LIMIT 1").get(sortOrder);
}

export function approvalChainLabel() {
  return chainRoles().map((r) => r.name).join(' → ');
}

// Shared sequential-stage decision: returns { finalized, stageRoleId, error }.
// - error set (and nothing else meaningful) if the actor isn't authorized to act yet.
// - finalized=true means this decision reached the top of the chain (or was Super Admin / a reject).
// - otherwise stageRoleId is the new current stage to persist (still Pending).
export function evaluateDecision(actorRoleKey, currentStageRoleId, isReject) {
  const actorRole = db.prepare('SELECT * FROM roles WHERE key = ?').get(actorRoleKey);
  if (!actorRole || actorRole.key === 'employee') return { error: 'Insufficient permissions' };

  if (actorRoleKey !== 'super_admin') {
    let stage = currentStageRoleId ? db.prepare('SELECT * FROM roles WHERE id = ?').get(currentStageRoleId) : null;
    if (!stage) stage = bottomRole();
    if (actorRole.sort_order > stage.sort_order) {
      return { error: `Waiting on ${stage.name} to act first.` };
    }
  }

  if (isReject) return { finalized: true };

  const above = actorRoleKey === 'super_admin' ? null : roleAbove(actorRole.sort_order);
  if (!above) return { finalized: true };
  return { finalized: false, stageRoleId: above.id };
}
