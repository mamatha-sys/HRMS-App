import db from '../db.js';

// Mirrors server/src/utils/onboarding.js for the offboarding side: other route files (Assets)
// call this whenever a real action completes something an offboarding checklist item
// represents — auto-checks the matching task for this employee's still-in-progress exit
// record(s), instead of requiring HR to separately go tick it in Recruitment. HR can still
// toggle any task by hand as a fallback — this only ever turns a task ON, never off.
export function autoCompleteOffboardingTask(employeeId, taskName) {
  if (!employeeId) return;
  const exits = db.prepare("SELECT id FROM exits WHERE employee_id = ? AND status = 'Serving Notice'").all(employeeId);
  exits.forEach((x) => {
    const task = db.prepare('SELECT id FROM offboarding_tasks WHERE exit_id = ? AND task_name = ? AND completed = 0').get(x.id, taskName);
    if (!task) return;
    db.prepare('UPDATE offboarding_tasks SET completed = 1 WHERE id = ?').run(task.id);
    recomputeOffboardingClearance(x.id);
  });
}

// Recomputes clearance_current/status from the checklist — auto-marks 'Cleared' once every task
// is done, same rule PUT /exits/:id/tasks/:taskId already applies for a manual toggle.
export function recomputeOffboardingClearance(exitId) {
  const tasks = db.prepare('SELECT completed FROM offboarding_tasks WHERE exit_id = ?').all(exitId);
  const total = tasks.length;
  const completed = tasks.filter((t) => t.completed).length;
  const status = total > 0 && completed >= total ? 'Cleared' : 'Serving Notice';
  db.prepare('UPDATE exits SET clearance_current = ?, clearance_total = ?, status = ? WHERE id = ?').run(completed, total, status, exitId);
  return { completed, total, status };
}
