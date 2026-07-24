import 'dotenv/config';
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

const app = express();
app.use(cors());
app.use(express.json());

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

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`HRMS API listening on http://localhost:${PORT}`));
