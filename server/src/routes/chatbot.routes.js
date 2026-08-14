import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { chatWithAssistant } from '../utils/aiAssist.js';
import { getSetting } from '../utils/integrationSettings.js';

const router = Router();
router.use(requireAuth);
const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);

const ROLE_LABELS = { super_admin: 'Super Admin', manager: 'Manager', hr_admin: 'HR Admin', assistant_manager: 'Assistant Manager', stl: 'Senior Team Lead', tl: 'Team Lead', employee: 'Employee' };

const MODULE_LIST = [
  'Employee Management', 'Attendance', 'Leave Management', 'Payroll', 'Recruitment',
  'Performance Management', 'Learning Management', 'Asset Management', 'Helpdesk', 'Announcements',
  'Expense & Travel Claims', 'Engagement Surveys', 'Document Management', 'Shift & Roster',
  'Rewards & Recognition', 'Project & Resource Management', 'Timesheet', 'Disciplinary Action Tracking'
];

// Read-only grounding facts about the requesting user — deliberately server-derived from req.user
// only (never trusts anything the client sends about "who I am"), so the assistant can answer
// personal questions like "how much leave do I have left" without the model ever inventing numbers.
function buildSystemPrompt(req) {
  const employee = myEmployee(req.user.sub);
  const companyName = getSetting('company_name') || 'this company';
  const today = new Date().toISOString().slice(0, 10);

  let facts = `Today's date: ${today}\nUser: ${req.user.name} (${ROLE_LABELS[req.user.role] || req.user.role})`;

  if (employee) {
    facts += `\nDepartment: ${employee.department || 'unassigned'}\nDesignation: ${employee.designation || 'unassigned'}`;

    const balances = db.prepare(`
      SELECT lt.name, elb.balance
      FROM leave_types lt LEFT JOIN employee_leave_balances elb ON elb.leave_type_id = lt.id AND elb.employee_id = ?
      WHERE lt.active = 1 ORDER BY lt.id
    `).all(employee.id);
    if (balances.length) {
      facts += `\nLeave balances: ${balances.map((b) => `${b.name}: ${b.balance ?? 0} days`).join(', ')}`;
    }

    const pendingLeaves = db.prepare("SELECT COUNT(*) AS n FROM leaves WHERE employee_id = ? AND status = 'Pending'").get(employee.id);
    facts += `\nOwn pending leave requests: ${pendingLeaves.n}`;
  } else {
    facts += `\n(This user account isn't linked to an employee record, so no leave/attendance data is available for them.)`;
  }

  // Configuration Policies is a short settings key/value store (notice period, work week, etc.) —
  // grouped by its own category labels. Announcements tagged "Policy" carry the actual narrative
  // policy text (e.g. WFH rules) that admins have posted — together these are the only real
  // "policy" data this app has, so the assistant is only ever grounded on what's genuinely there.
  const policyRows = db.prepare('SELECT category, name, value FROM policies ORDER BY category, id').all();
  if (policyRows.length) {
    const byCategory = { business: [], rule: [], setting: [] };
    policyRows.forEach((p) => { (byCategory[p.category] || (byCategory[p.category] = [])).push(`${p.name}: ${p.value ?? '—'}`); });
    const sections = Object.entries(byCategory).filter(([, items]) => items.length);
    facts += `\n\nCompany policies & settings:\n${sections.map(([cat, items]) => `- ${cat}: ${items.join('; ')}`).join('\n')}`;
  }

  const policyAnnouncements = db.prepare("SELECT title, body FROM announcements WHERE category = 'Policy' ORDER BY pinned DESC, created_at DESC LIMIT 15").all();
  if (policyAnnouncements.length) {
    facts += `\n\nPosted policy announcements:\n${policyAnnouncements.map((a) => `- "${a.title}": ${a.body}`).join('\n')}`;
  }

  return `You are the AI Assistant embedded in ${companyName}'s internal HRMS. You are talking directly with the user described below — answer them personally using the facts given, don't ask them to re-identify themselves.

===== FACTS (this is the ONLY information you know about this company/user) =====
${facts}
===== END OF FACTS =====

This HRMS has these modules: ${MODULE_LIST.join(', ')}.

CRITICAL RULE — read this twice before answering: everything between "===== FACTS =====" and "===== END OF FACTS =====" above is 100% of what you are allowed to state as true about this specific company or user. You have general knowledge of how HR/companies typically work, but typical/common values (e.g. "notice period is usually 2 weeks", "standard leave is 12 days") are NOT this company's actual values unless they appear word-for-word in the facts above. If a question asks about something not in the facts (a policy, number, or rule that isn't listed), you MUST say you don't have that on record and suggest checking the relevant module or asking HR — do NOT fill the gap with a plausible-sounding typical value. Getting this wrong (stating an invented number as if it were real) is the single worst mistake you can make here.

Other guidelines:
- For "how do I do X" questions, point to the relevant module by name — that's not a factual claim about the company, so general knowledge of the app's modules is fine to use.
- You cannot take actions — you cannot submit, approve, or edit anything. If asked to do something, explain that they need to use the relevant module themselves.
- Keep answers short and conversational: 2-4 sentences unless the question genuinely needs a short list.`;
}

router.post('/ask', async (req, res) => {
  const message = req.body?.message?.toString().trim();
  if (!message) return res.status(400).json({ error: 'Message is required' });

  // Client-supplied history is just prior turns for conversational continuity — never trusted for
  // identity/facts (those are rebuilt server-side above). Capped to the last few turns to keep
  // requests small; a long back-and-forth doesn't need the full transcript replayed every time.
  const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];
  const trimmedHistory = rawHistory
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-10)
    .map((m) => ({ role: m.role, content: m.content.trim() }));

  try {
    const reply = await chatWithAssistant(buildSystemPrompt(req), [...trimmedHistory, { role: 'user', content: message }]);
    res.json({ reply });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
