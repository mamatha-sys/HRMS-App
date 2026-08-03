import db from '../db.js';

// Cross-module onboarding automation: other route files (Employees, Assets) call this whenever
// a real action completes something an onboarding checklist item represents (a manager gets
// assigned, documents get uploaded, an asset gets handed over) — the matching task auto-checks
// itself for any of this employee's still-in-progress new-hire record(s), instead of requiring
// HR to separately go tick it in Recruitment. HR can still toggle any task by hand as a fallback
// (see PUT /recruitment/new-hires/:id/tasks/:taskId) — this only ever turns a task ON, never off.
export function autoCompleteOnboardingTask(employeeId, taskName) {
  if (!employeeId) return;
  const hires = db.prepare('SELECT id FROM new_hires WHERE employee_id = ? AND completed_at IS NULL').all(employeeId);
  hires.forEach((h) => {
    const task = db.prepare('SELECT id FROM onboarding_tasks WHERE new_hire_id = ? AND task_name = ? AND completed = 0').get(h.id, taskName);
    if (!task) return;
    db.prepare('UPDATE onboarding_tasks SET completed = 1 WHERE id = ?').run(task.id);
    recomputeOnboardingPct(h.id);
  });
}

// Recomputes onboarding_pct from the checklist, and stamps completed_at the moment it first
// reaches 100% (cleared again if a task gets unchecked afterward) — completed_at is what drives
// the 2-day auto-archive of a finished record in GET /overview.
export function recomputeOnboardingPct(newHireId) {
  const tasks = db.prepare('SELECT completed FROM onboarding_tasks WHERE new_hire_id = ?').all(newHireId);
  const pct = tasks.length ? Math.round((tasks.filter((t) => t.completed).length / tasks.length) * 100) : 0;
  db.prepare("UPDATE new_hires SET onboarding_pct = ?, completed_at = CASE WHEN ? = 100 THEN COALESCE(completed_at, datetime('now')) ELSE NULL END WHERE id = ?").run(pct, pct, newHireId);
  return pct;
}
