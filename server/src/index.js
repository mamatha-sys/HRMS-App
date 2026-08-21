import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import authRoutes from './routes/auth.routes.js';
import employeeRoutes from './routes/employees.routes.js';
import dashboardRoutes from './routes/dashboard.routes.js';
import orgRoutes from './routes/org.routes.js';
import permissionsRoutes from './routes/permissions.routes.js';
import usersRoutes from './routes/users.routes.js';
import notificationsRoutes from './routes/notifications.routes.js';
import eventsRoutes from './routes/events.routes.js';
import tasksRoutes from './routes/tasks.routes.js';
import positionsRoutes from './routes/positions.routes.js';
import reportsRoutes from './routes/reports.routes.js';
import modulesRoutes from './routes/modules.routes.js';
import rolesRoutes from './routes/roles.routes.js';
import approvalsRoutes from './routes/approvals.routes.js';
import configRoutes from './routes/config.routes.js';
import policiesRoutes from './routes/policies.routes.js';
import attendanceRoutes from './routes/attendance.routes.js';
import leavesRoutes from './routes/leaves.routes.js';
import payrollRoutes from './routes/payroll.routes.js';
import recruitmentRoutes from './routes/recruitment.routes.js';
import performanceRoutes from './routes/performance.routes.js';
import learningRoutes from './routes/learning.routes.js';
import assetsRoutes from './routes/assets.routes.js';
import helpdeskRoutes from './routes/helpdesk.routes.js';
import announcementsRoutes from './routes/announcements.routes.js';
import expensesRoutes from './routes/expenses.routes.js';
import surveysRoutes from './routes/surveys.routes.js';
import documentsRoutes from './routes/documents.routes.js';
import integrationsRoutes from './routes/integrations.routes.js';
import biometricDeviceRoutes from './routes/biometricDevice.routes.js';
import brandingRoutes from './routes/branding.routes.js';
import shiftRosterRoutes from './routes/shiftRoster.routes.js';
import recognitionRoutes from './routes/recognition.routes.js';
import projectsRoutes from './routes/projects.routes.js';
import timesheetRoutes from './routes/timesheet.routes.js';
import disciplinaryRoutes from './routes/disciplinary.routes.js';
import myAccessRoutes from './routes/myAccess.routes.js';
import chatbotRoutes from './routes/chatbot.routes.js';
import agentRoutes from './routes/agent.routes.js';
import interviewRoutes from './routes/interview.routes.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '150mb' })); // base64 photo/document/course-material uploads

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/org', orgRoutes);
app.use('/api/permissions', permissionsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/positions', positionsRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/modules', modulesRoutes);
app.use('/api/roles', rolesRoutes);
app.use('/api/approvals', approvalsRoutes);
app.use('/api/config', configRoutes);
app.use('/api/policies', policiesRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/leaves', leavesRoutes);
app.use('/api/payroll', payrollRoutes);
app.use('/api/recruitment', recruitmentRoutes);
app.use('/api/performance', performanceRoutes);
app.use('/api/learning', learningRoutes);
app.use('/api/assets', assetsRoutes);
app.use('/api/helpdesk', helpdeskRoutes);
app.use('/api/announcements', announcementsRoutes);
app.use('/api/expenses', expensesRoutes);
app.use('/api/surveys', surveysRoutes);
app.use('/api/documents', documentsRoutes);
app.use('/api/integrations', integrationsRoutes);
// Real biometric hardware calls this directly (no JWT) — see biometricDevice.routes.js.
app.use('/api/biometric-device', biometricDeviceRoutes);
app.use('/api/branding', brandingRoutes);
app.use('/api/shift-roster', shiftRosterRoutes);
app.use('/api/recognition', recognitionRoutes);
app.use('/api/projects', projectsRoutes);
app.use('/api/timesheet', timesheetRoutes);
app.use('/api/disciplinary', disciplinaryRoutes);
app.use('/api/my-access', myAccessRoutes);
app.use('/api/chatbot', chatbotRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/interview', interviewRoutes);

// Production: this same process also serves the built React app (client/dist) — one Node
// process per domain is what Hostinger's Node.js Selector (and most shared-hosting Node
// setups) expects, rather than a separate static host. Dev mode still runs the two separately
// (Vite dev server on 5173, proxying /api to this server on 4000), so this only matters when
// client/dist actually exists (i.e. `npm run build` was run).
const clientDist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(clientDist, 'index.html')));

app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'That upload is too large for the server to accept (limit 150 MB per request).' });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`HRMS API listening on http://localhost:${PORT}`));
