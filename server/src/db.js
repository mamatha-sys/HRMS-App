import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'hrms.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    face_descriptor TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    scope_description TEXT,
    is_system INTEGER NOT NULL DEFAULT 0,
    paused INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS perm_modules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS perm_features (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    module_id INTEGER NOT NULL REFERENCES perm_modules(id) ON DELETE CASCADE,
    category TEXT,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS role_permissions (
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    feature_id INTEGER NOT NULL REFERENCES perm_features(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    PRIMARY KEY (role_id, feature_id, action)
  );

  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('Present','Absent','Leave')),
    UNIQUE(employee_id, date)
  );

  CREATE TABLE IF NOT EXISTS payroll_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Processing' CHECK (status IN ('Processing','Completed','Pending')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    requester TEXT NOT NULL,
    detail TEXT,
    status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Rejected')),
    decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS dashboard_config (
    widget_key TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    visible INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS departments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    parent_department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Paused')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS branches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    location TEXT,
    status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Paused')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL CHECK (category IN ('business','rule','setting')),
    name TEXT NOT NULL,
    value TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS field_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL CHECK (role IN ('manager','employee')),
    field_name TEXT NOT NULL,
    access TEXT NOT NULL CHECK (access IN ('view','edit','hidden')),
    UNIQUE(role, field_name)
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    target_role TEXT NOT NULL DEFAULT 'all' CHECK (target_role IN ('all','super_admin','manager','employee')),
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notification_reads (
    notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    read_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (notification_id, user_id)
  );
  `);
  // Employee self-service must only ever see their own notifications, not the whole
  // role-broadcast pool — add a nullable per-employee target alongside the existing
  // role-broadcast target_role, so a notification can be aimed at one specific person
  // (e.g. "Your leave request was approved") as well as/instead of a whole role.
  const notificationCols = db.prepare('PRAGMA table_info(notifications)').all().map((c) => c.name);
  if (!notificationCols.includes('employee_id')) db.exec('ALTER TABLE notifications ADD COLUMN employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE');
  // Department-wide targeting (alongside the existing whole-role and single-employee targets)
  // and a record of which external channels (Email/SMS/WhatsApp, beyond the always-on in-app
  // entry) were requested for this notification.
  if (!notificationCols.includes('target_department')) db.exec('ALTER TABLE notifications ADD COLUMN target_department TEXT');
  if (!notificationCols.includes('channels')) db.exec("ALTER TABLE notifications ADD COLUMN channels TEXT NOT NULL DEFAULT 'in_app'");
  // Optional urgency tag (Low/Medium/High/Critical) — set on Helpdesk-ticket-related
  // notifications so the main Dashboard's Alerts & Notifications widget can show the same
  // green/yellow/orange/red badge the Helpdesk module itself uses. NULL for every other kind
  // of notification (leave/expense/announcement, etc.), which render with no badge as before.
  if (!notificationCols.includes('priority')) db.exec('ALTER TABLE notifications ADD COLUMN priority TEXT');
  // Links a Helpdesk-ticket-related notification back to its ticket, so the notification feed
  // can drop it once that ticket is Resolved/Closed — matching the Helpdesk dashboard's own
  // "resolved tickets drop off the list" behavior instead of leaving a stale urgent-looking
  // alert around after the thing it was about is already handled.
  if (!notificationCols.includes('ticket_id')) db.exec('ALTER TABLE notifications ADD COLUMN ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL');
  migrateNotificationsTargetRole();

  // --- Multi-channel delivery log: every Email/SMS/WhatsApp send attempt for a Notification
  // or Announcement, one row per (recipient, channel) — this is the "Notification Log" the
  // prototype shows (e.g. "Email -> Ragini: message"), and lets HR see what actually went out
  // (or why it failed, e.g. no provider configured) rather than assuming silent success. ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL CHECK (source IN ('notification','announcement')),
      source_id INTEGER NOT NULL,
      employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK (channel IN ('email','sms','whatsapp')),
      target TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('Sent','Failed')),
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec(`

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    event_date TEXT NOT NULL,
    target_role TEXT NOT NULL DEFAULT 'all' CHECK (target_role IN ('all','super_admin','manager','employee')),
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    due_date TEXT,
    assigned_to INTEGER REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Done')),
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    target_headcount INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','Closed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS custom_modules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Paused')),
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS custom_features (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    module_id INTEGER NOT NULL REFERENCES custom_modules(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS custom_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feature_id INTEGER NOT NULL REFERENCES custom_features(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Open',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Leave Management module
  CREATE TABLE IF NOT EXISTS leaves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('Casual','Sick','Earned')),
    from_date TEXT NOT NULL,
    to_date TEXT NOT NULL,
    days INTEGER NOT NULL,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Rejected')),
    decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS leave_balances (
    employee_id INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
    casual INTEGER NOT NULL DEFAULT 12,
    sick INTEGER NOT NULL DEFAULT 8,
    earned INTEGER NOT NULL DEFAULT 15
  );

  -- Payroll Management module
  CREATE TABLE IF NOT EXISTS salary_structures (
    employee_id INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
    basic INTEGER NOT NULL DEFAULT 0,
    hra INTEGER NOT NULL DEFAULT 0,
    allowances INTEGER NOT NULL DEFAULT 0,
    deductions INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS payslips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    period TEXT NOT NULL,
    basic INTEGER NOT NULL,
    hra INTEGER NOT NULL,
    allowances INTEGER NOT NULL,
    deductions INTEGER NOT NULL,
    net INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(employee_id, period)
  );

  CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    phone TEXT,
    photo TEXT,
    date_of_birth TEXT,
    emergency_contact_name TEXT,
    emergency_contact_relation TEXT,
    emergency_contact_number TEXT,
    address_street TEXT,
    address_city TEXT,
    address_state TEXT,
    address_country TEXT,
    address_pincode TEXT,
    department TEXT NOT NULL,
    branch TEXT,
    designation TEXT NOT NULL,
    date_of_joining TEXT,
    reporting_manager TEXT,
    status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','On Probation','Exited')),
    bank_name TEXT,
    bank_account_number TEXT,
    ifsc_code TEXT,
    aadhaar_number TEXT,
    pan_number TEXT,
    education TEXT,
    experience TEXT,
    skills TEXT,
    documents TEXT,
    stage TEXT NOT NULL DEFAULT 'locked' CHECK (stage IN ('draft','assigned','submitted','locked')),
    edit_requested INTEGER NOT NULL DEFAULT 0,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

function seed() {
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount > 0) return;

  const insertUser = db.prepare(
    'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)'
  );
  const hash = (pwd) => bcrypt.hashSync(pwd, 10);

  const adminId = insertUser.run('Super Admin', 'admin@hrms.com', hash('Admin@123'), 'super_admin').lastInsertRowid;
  const managerId = insertUser.run('Priya Manager', 'manager@hrms.com', hash('Manager@123'), 'manager').lastInsertRowid;
  const employeeId = insertUser.run('Arjun Employee', 'employee@hrms.com', hash('Employee@123'), 'employee').lastInsertRowid;
  // A spare employee-role login with no employee record yet — used to demo Stage 2 (HR assigns a draft to an employee).
  insertUser.run('New Joiner', 'newjoiner@hrms.com', hash('Joiner@123'), 'employee');

  const insertEmployee = db.prepare(`
    INSERT INTO employees (
      employee_code, name, email, phone, photo, date_of_birth,
      emergency_contact_name, emergency_contact_relation, emergency_contact_number,
      department, branch, designation, date_of_joining, reporting_manager, status,
      bank_name, bank_account_number, ifsc_code, aadhaar_number, pan_number,
      education, experience, skills, user_id
    ) VALUES (
      @employee_code, @name, @email, @phone, @photo, @date_of_birth,
      @emergency_contact_name, @emergency_contact_relation, @emergency_contact_number,
      @department, @branch, @designation, @date_of_joining, @reporting_manager, @status,
      @bank_name, @bank_account_number, @ifsc_code, @aadhaar_number, @pan_number,
      @education, @experience, @skills, @user_id
    )
  `);

  const base = {
    phone: null, photo: null, date_of_birth: null,
    emergency_contact_name: null, emergency_contact_relation: null, emergency_contact_number: null,
    branch: null, reporting_manager: null,
    bank_name: null, bank_account_number: null, ifsc_code: null, aadhaar_number: null, pan_number: null,
    education: null, experience: null, skills: null, user_id: null
  };

  const rows = [
    { ...base, employee_code: 'EMP-001', name: 'Priya Manager', email: 'manager@hrms.com', phone: '9000000001',
      date_of_birth: '1988-04-12', emergency_contact_name: 'Rohan Manager', emergency_contact_relation: 'Spouse', emergency_contact_number: '9000011001',
      department: 'Engineering', branch: 'Hyderabad', designation: 'Engineering Manager', date_of_joining: '2021-03-14', reporting_manager: 'Super Admin', status: 'Active',
      bank_name: 'HDFC Bank', bank_account_number: '50100123456789', ifsc_code: 'HDFC0001234', aadhaar_number: '2345-6789-0123', pan_number: 'ABCPM1234D',
      education: 'M.Tech, Computer Science', experience: '10 years in software engineering', skills: 'Leadership, System Design, Node.js',
      user_id: managerId },
    { ...base, employee_code: 'EMP-002', name: 'Arjun Employee', email: 'employee@hrms.com', phone: '9000000002',
      date_of_birth: '1996-11-02', emergency_contact_name: 'Lakshmi Employee', emergency_contact_relation: 'Mother', emergency_contact_number: '9000011002',
      department: 'Engineering', branch: 'Hyderabad', designation: 'Software Engineer', date_of_joining: '2022-06-01', reporting_manager: 'Priya Manager', status: 'Active',
      bank_name: 'ICICI Bank', bank_account_number: '00201987654321', ifsc_code: 'ICIC0000021', aadhaar_number: '3456-7890-1234', pan_number: 'BCDPA5678E',
      education: 'B.Tech, Computer Science', experience: '3 years in software development', skills: 'React, Node.js, SQL',
      user_id: employeeId },
    { ...base, employee_code: 'EMP-003', name: 'D. Fernandes', email: 'd.fernandes@hrms.com', phone: '9000000003',
      department: 'QA', branch: 'Bengaluru', designation: 'QA Engineer', date_of_joining: '2022-01-10', reporting_manager: 'K. Menon', status: 'Active' },
    { ...base, employee_code: 'EMP-004', name: 'R. Iyer', email: 'r.iyer@hrms.com', phone: '9000000004',
      department: 'Sales', branch: 'Chennai', designation: 'Sales Executive', date_of_joining: '2020-11-20', reporting_manager: 'P. Nair', status: 'Exited' },
    { ...base, employee_code: 'EMP-005', name: 'P. Nair', email: 'p.nair@hrms.com', phone: '9000000005',
      department: 'Sales', branch: 'Chennai', designation: 'Sales Manager', date_of_joining: '2019-08-05', reporting_manager: 'Super Admin', status: 'Active' },
    { ...base, employee_code: 'EMP-006', name: 'K. Menon', email: 'k.menon@hrms.com', phone: '9000000006',
      department: 'QA', branch: 'Bengaluru', designation: 'QA Lead', date_of_joining: '2021-09-17', reporting_manager: 'Super Admin', status: 'Active' }
  ];
  rows.forEach((r) => insertEmployee.run(r));

  // Varied onboarding stages so every stage is visible in the demo:
  // EMP-002 (Arjun, the employee login) is 'assigned' → log in as employee@hrms.com to fill & submit.
  // EMP-003 is 'submitted' → HR sees it under review. EMP-005 is 'draft' → HR can assign it.
  const setStage = db.prepare('UPDATE employees SET stage = ? WHERE employee_code = ?');
  setStage.run('assigned', 'EMP-002');
  setStage.run('submitted', 'EMP-003');
  setStage.run('draft', 'EMP-005');
  // Give the seeded records a sample address.
  db.prepare("UPDATE employees SET address_street='12 MG Road', address_city='Hyderabad', address_state='Telangana', address_country='India', address_pincode='500081' WHERE employee_code IN ('EMP-001','EMP-002')").run();

  const insertDept = db.prepare('INSERT INTO departments (name, parent_department_id) VALUES (?, ?)');
  const engId = insertDept.run('Engineering', null).lastInsertRowid;
  insertDept.run('QA', engId);
  insertDept.run('Sales', null);
  insertDept.run('Human Resources', null);

  const insertBranch = db.prepare('INSERT INTO branches (name, location) VALUES (?, ?)');
  insertBranch.run('Hyderabad', 'Telangana, India');
  insertBranch.run('Bengaluru', 'Karnataka, India');
  insertBranch.run('Chennai', 'Tamil Nadu, India');

  const insertFieldPerm = db.prepare('INSERT INTO field_permissions (role, field_name, access) VALUES (?, ?, ?)');
  const sensitiveFields = ['bank_name', 'bank_account_number', 'ifsc_code', 'aadhaar_number', 'pan_number'];
  sensitiveFields.forEach((f) => insertFieldPerm.run('manager', f, 'hidden'));
  sensitiveFields.forEach((f) => insertFieldPerm.run('employee', f, 'view'));

  // --- Roles catalog (matches the documented role model) ---
  const insertRole = db.prepare('INSERT INTO roles (key, name, scope_description, is_system, sort_order) VALUES (?, ?, ?, ?, ?)');
  const roleRows = [
    { key: 'super_admin', name: 'Super Admin', scope: 'Company-wide (all branches, all departments)', system: 1 },
    { key: 'hr_admin', name: 'HR Admin', scope: 'Company-wide (all branches, all departments)', system: 0 },
    { key: 'manager', name: 'Manager', scope: 'All departments, company-wide', system: 0 },
    { key: 'assistant_manager', name: 'Assistant Manager', scope: 'All departments, company-wide (supporting role)', system: 0 },
    { key: 'stl', name: 'Senior Team Lead (STL)', scope: 'Team-A & Team-B (Educational), plus Medical & Manufacturing', system: 0 },
    { key: 'tl', name: 'Team Lead (TL)', scope: 'Single team (direct reports only)', system: 0 },
    { key: 'employee', name: 'Employee (Self-Service)', scope: 'Own record only', system: 0 }
  ];
  const roleIds = {};
  roleRows.forEach((r, i) => { roleIds[r.key] = insertRole.run(r.key, r.name, r.scope, r.system, i).lastInsertRowid; });

  // --- Module & feature catalog (drives the permission matrix) ---
  const MODULE_CATALOG = [
    { code: '01', name: 'Dashboard Management', groups: [
      { category: 'Core Records & Day-to-Day Operations', items: ['Total Employees (Attendance, Leaves)', 'Total Branches', 'Total Departments', 'Alerts Notifications', 'Total Expenses', 'Total Deposits', 'Total Salaries Paid', 'AI Requests', 'Asset Allocation', 'Quick Actions', 'Upcoming Events', 'Calendar'] },
      { category: 'Approval & Policy Configuration', items: ['Pending Approvals'] }
    ]},
    { code: '02', name: 'Employee Management', groups: [
      { category: 'Core Records & Day-to-Day Operations', items: ['Employee Directory', 'Add Employee', 'Employee Profile', 'Personal Information', 'Contact Details', 'Employment Details', 'Documents', 'Education & Experience'] },
      { category: 'Restricted Fields', items: ['Bank Details', 'Identity Documents (Aadhaar / PAN)'] }
    ]},
    { code: '03', name: 'Organization Structure', groups: [
      { category: 'Core Records & Day-to-Day Operations', items: ['Departments', 'Branches', 'Org Chart', 'Reporting Hierarchy'] }
    ]},
    { code: '05', name: 'Recruitment Management', groups: [
      { category: 'Core Records & Day-to-Day Operations', items: ['Open Positions', 'Department Vacancies', 'Candidates', 'Interviews'] }
    ]},
    { code: '06', name: 'Onboarding Management', groups: [
      { category: 'Core Records & Day-to-Day Operations', items: ['Onboarding Checklist', 'Document Collection', 'Induction'] }
    ]},
    { code: '07', name: 'Attendance & Time Tracking', groups: [
      { category: 'Core Records & Day-to-Day Operations', items: ['Daily Attendance', 'Check-in / Check-out', 'Regularization', 'Timesheets'] }
    ]},
    { code: '08', name: 'Leave Management', groups: [
      { category: 'Core Records & Day-to-Day Operations', items: ['Leave Application', 'Leave Balance', 'Leave Approval', 'Leave Policy'] }
    ]},
    { code: '09', name: 'Payroll Management', groups: [
      { category: 'Core Records & Day-to-Day Operations', items: ['Payslips', 'Salary Structure', 'Payroll Run', 'Deductions'] }
    ]},
    { code: '10', name: 'Performance Management (PMS)', groups: [
      { category: 'Core Records & Day-to-Day Operations', items: ['Goals', 'Appraisals', 'Reviews'] }
    ]},
    { code: '11', name: 'Learning Management System (LMS)', groups: [
      { category: 'Core Records & Day-to-Day Operations', items: ['Courses', 'Enrollments', 'Certifications'] }
    ]},
    { code: '12', name: 'Asset Management', groups: [
      { category: 'Core Records & Day-to-Day Operations', items: ['Asset Register', 'Asset Allocation', 'Maintenance'] }
    ]}
  ];

  const insertModule = db.prepare('INSERT INTO perm_modules (code, name, sort_order) VALUES (?, ?, ?)');
  const insertFeature = db.prepare('INSERT INTO perm_features (module_id, category, name, sort_order) VALUES (?, ?, ?, ?)');
  const insertGrant = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, feature_id, action) VALUES (?, ?, ?)');
  const ACTIONS = ['View', 'Create', 'Edit', 'Delete', 'Approve', 'Reject', 'Assign', 'Import', 'Export', 'Download', 'Print', 'Manage'];

  MODULE_CATALOG.forEach((m, mi) => {
    const moduleId = insertModule.run(m.code, m.name, mi).lastInsertRowid;
    let fi = 0;
    m.groups.forEach((g) => {
      g.items.forEach((item) => {
        const featureId = insertFeature.run(moduleId, g.category, item, fi++).lastInsertRowid;
        // Default grants: super_admin & hr_admin get every action; all other roles get baseline View.
        roleRows.forEach((r) => {
          if (r.key === 'super_admin' || r.key === 'hr_admin') {
            ACTIONS.forEach((a) => insertGrant.run(roleIds[r.key], featureId, a));
          } else {
            insertGrant.run(roleIds[r.key], featureId, 'View');
          }
        });
      });
    });
  });

  // --- Attendance for today (drives Present/Absent KPIs) ---
  const insertAttendance = db.prepare("INSERT INTO attendance (employee_id, date, status) VALUES (?, date('now'), ?)");
  db.prepare('SELECT id, status FROM employees').all().forEach((e, i) => {
    const present = e.status === 'Active' && i % 6 !== 2; // one active employee marked absent for realism
    insertAttendance.run(e.id, present ? 'Present' : 'Absent');
  });

  // --- Payroll run status ---
  db.prepare('INSERT INTO payroll_runs (period, status) VALUES (?, ?)').run('Current month', 'Processing');

  // --- Pending approvals ---
  const insertApproval = db.prepare('INSERT INTO approvals (type, requester, detail, status) VALUES (?, ?, ?, ?)');
  insertApproval.run('Leave', 'Arjun Employee', 'Casual leave — 2 days', 'Pending');
  insertApproval.run('Expense', 'P. Nair', 'Travel reimbursement — ₹4,500', 'Pending');
  insertApproval.run('Requisition', 'K. Menon', 'New QA headcount — 1 position', 'Pending');

  // --- Dashboard widget visibility config ---
  const insertConfig = db.prepare('INSERT INTO dashboard_config (widget_key, label, visible, sort_order) VALUES (?, ?, ?, ?)');
  const widgets = [
    ['kpis', 'KPI cards (Employees, Present, Absent, Payroll)'],
    ['growth_chart', 'Employee / Organization Growth chart'],
    ['hiring_chart', 'New Hires by Year chart'],
    ['department_chart', 'Department Strength & Distribution chart'],
    ['approvals', 'Pending Approvals'],
    ['tasks', 'Pending Tasks & Reminders'],
    ['notifications', 'Alerts & Notifications'],
    ['quick_actions', 'Quick Actions'],
    ['vacancies', 'Department-wise Vacancies'],
    ['calendar', 'Calendar & Upcoming Events'],
    ['role_user', 'Role & User Management summary']
  ];
  widgets.forEach((w, i) => insertConfig.run(w[0], w[1], 1, i));

  // --- Two recent hires so the "New Hires" KPI (last 90 days) is meaningful ---
  const recentHires = [
    { ...base, employee_code: 'EMP-007', name: 'S. Reddy', email: 's.reddy@hrms.com', phone: '9000000007',
      department: 'Engineering', branch: 'Hyderabad', designation: 'Frontend Engineer', reporting_manager: 'Priya Manager', status: 'Active' },
    { ...base, employee_code: 'EMP-008', name: 'M. Khan', email: 'm.khan@hrms.com', phone: '9000000008',
      department: 'QA', branch: 'Bengaluru', designation: 'QA Analyst', reporting_manager: 'K. Menon', status: 'On Probation' }
  ];
  const insertRecentHire = db.prepare(`
    INSERT INTO employees (
      employee_code, name, email, phone, department, branch, designation, date_of_joining, reporting_manager, status
    ) VALUES (@employee_code, @name, @email, @phone, @department, @branch, @designation, @date_of_joining, @reporting_manager, @status)
  `);
  const hire1 = insertRecentHire.run({ ...recentHires[0], date_of_joining: db.prepare("SELECT date('now','-12 days') AS d").get().d }).lastInsertRowid;
  const hire2 = insertRecentHire.run({ ...recentHires[1], date_of_joining: db.prepare("SELECT date('now','-40 days') AS d").get().d }).lastInsertRowid;
  insertAttendance.run(hire1, 'Present');
  insertAttendance.run(hire2, 'Present');

  // --- Open positions (Open Positions KPI + Department-wise Vacancies) ---
  const deptId = (name) => db.prepare('SELECT id FROM departments WHERE name = ?').get(name)?.id;
  const insertPosition = db.prepare('INSERT INTO positions (department_id, title, target_headcount, status) VALUES (?, ?, ?, ?)');
  insertPosition.run(deptId('Engineering'), 'Senior Backend Engineer', 2, 'Open');
  insertPosition.run(deptId('QA'), 'Automation QA Engineer', 1, 'Open');
  insertPosition.run(deptId('Sales'), 'Sales Executive', 3, 'Open');
  insertPosition.run(deptId('Human Resources'), 'HR Business Partner', 1, 'Open');

  // --- Notifications, events, tasks so the dashboard widgets are populated ---
  const insertNotification = db.prepare('INSERT INTO notifications (title, message, target_role, created_by) VALUES (?, ?, ?, ?)');
  insertNotification.run('Low attendance', 'Attendance dipped below 90% in Engineering this week.', 'all', adminId);
  insertNotification.run('Payroll cut-off', 'Submit expense claims before the 25th for this cycle.', 'all', adminId);

  const insertEvent = db.prepare('INSERT INTO events (title, description, event_date, target_role, created_by) VALUES (?, ?, ?, ?, ?)');
  insertEvent.run('Public Holiday', 'Independence Day — office closed', db.prepare("SELECT date('now','+21 days') AS d").get().d, 'all', adminId);
  insertEvent.run('Board Meeting', 'Quarterly review', db.prepare("SELECT date('now','+5 days') AS d").get().d, 'all', adminId);

  const insertTask = db.prepare('INSERT INTO tasks (title, due_date, assigned_to, status, created_by) VALUES (?, ?, ?, ?, ?)');
  insertTask.run('Review Q3 budget', db.prepare("SELECT date('now') AS d").get().d, adminId, 'Pending', adminId);
  insertTask.run('Approve pending leave requests', db.prepare("SELECT date('now','+2 days') AS d").get().d, managerId, 'Pending', adminId);
  insertTask.run('Submit timesheet', db.prepare("SELECT date('now','+6 days') AS d").get().d, employeeId, 'Pending', adminId);

  // --- Configuration policies (business policies, custom rules, settings) ---
  const insertPolicy = db.prepare('INSERT INTO policies (category, name, value) VALUES (?, ?, ?)');
  insertPolicy.run('business', 'Probation period', '6 months');
  insertPolicy.run('business', 'Notice period', '30 days');
  insertPolicy.run('business', 'Work week', 'Monday–Friday, 9:00–18:00');
  insertPolicy.run('business', 'Casual leave / year', '12 days');
  insertPolicy.run('rule', 'Auto-approve leave under 1 day', 'Enabled');
  insertPolicy.run('rule', 'Flag attendance below 90%', 'Enabled');
  insertPolicy.run('setting', 'Default branch for new hires', 'Hyderabad');
  insertPolicy.run('setting', 'Payroll cut-off day', '25th of month');

  void adminId;
}

seed();

// Non-destructive migrations for tables that already exist in older databases
// (ALTER ... ADD COLUMN is a no-op-safe way to evolve without wiping user data).
function migrate() {
  const att = db.prepare('PRAGMA table_info(attendance)').all().map((c) => c.name);
  if (!att.includes('check_in_time')) db.exec('ALTER TABLE attendance ADD COLUMN check_in_time TEXT');
  if (!att.includes('check_out_time')) db.exec('ALTER TABLE attendance ADD COLUMN check_out_time TEXT');
  if (!att.includes('method')) db.exec("ALTER TABLE attendance ADD COLUMN method TEXT NOT NULL DEFAULT 'Web Check-in'");
  if (!att.includes('latitude')) db.exec('ALTER TABLE attendance ADD COLUMN latitude REAL');
  if (!att.includes('longitude')) db.exec('ALTER TABLE attendance ADD COLUMN longitude REAL');

  // Detailed salary components (earnings + statutory deductions) — added with sensible defaults
  // so existing rows get a realistic structure without a reset.
  const sal = db.prepare('PRAGMA table_info(salary_structures)').all().map((c) => c.name);
  if (!sal.includes('conveyance')) db.exec('ALTER TABLE salary_structures ADD COLUMN conveyance INTEGER NOT NULL DEFAULT 1600');
  if (!sal.includes('special_allowance')) db.exec('ALTER TABLE salary_structures ADD COLUMN special_allowance INTEGER NOT NULL DEFAULT 8000');
  if (!sal.includes('pf')) db.exec('ALTER TABLE salary_structures ADD COLUMN pf INTEGER NOT NULL DEFAULT 4080');
  if (!sal.includes('pt')) db.exec('ALTER TABLE salary_structures ADD COLUMN pt INTEGER NOT NULL DEFAULT 200');
  if (!sal.includes('tds')) db.exec('ALTER TABLE salary_structures ADD COLUMN tds INTEGER NOT NULL DEFAULT 850');

  db.exec(`
    CREATE TABLE IF NOT EXISTS leave_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      annual_quota INTEGER NOT NULL DEFAULT 0,
      unpaid INTEGER NOT NULL DEFAULT 0
    );

    -- Approving a 4+ day leave requires picking at least one reason from this Super-Admin-managed
    -- checkbox catalog (e.g. "Medical Emergency", "Family Function") — same catalog+active-toggle
    -- shape as leave_types/salary_components/employee_custom_fields.
    CREATE TABLE IF NOT EXISTS leave_approval_reasons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
  `);
  const lt = db.prepare('PRAGMA table_info(leave_types)').all().map((c) => c.name);
  if (!lt.includes('active')) db.exec('ALTER TABLE leave_types ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
  // Sick Leave: monthly accrual (1 day/month) with uncapped carry-forward, instead of the flat
  // annual_quota granted upfront like every other type. monthly_accrual = 0/NULL means "use the
  // existing flat annual_quota model" — only Sick Leave opts into this, per Super Admin policy;
  // Casual Leave and everything else keep their current flat-grant, no-carry-forward behavior
  // completely unchanged. See applyMonthlyAccrual() in leaves.routes.js for the actual crediting.
  if (!lt.includes('carry_forward')) db.exec('ALTER TABLE leave_types ADD COLUMN carry_forward INTEGER NOT NULL DEFAULT 0');
  if (!lt.includes('monthly_accrual')) db.exec('ALTER TABLE leave_types ADD COLUMN monthly_accrual INTEGER');
  db.prepare("UPDATE leave_types SET carry_forward = 1, monthly_accrual = 1 WHERE code = 'SL'").run();

  if (db.prepare('SELECT COUNT(*) AS c FROM leave_approval_reasons').get().c === 0) {
    const insReason = db.prepare('INSERT INTO leave_approval_reasons (label, sort_order) VALUES (?, ?)');
    ['Medical Emergency', 'Family Function / Event', 'Personal Reasons', 'Approved per Company Policy', 'Other']
      .forEach((label, i) => insReason.run(label, i));
  }

  const apr = db.prepare('PRAGMA table_info(approvals)').all().map((c) => c.name);
  if (!apr.includes('current_stage_role_id')) {
    db.exec('ALTER TABLE approvals ADD COLUMN current_stage_role_id INTEGER REFERENCES roles(id)');
    const bottom = db.prepare("SELECT id FROM roles WHERE key != 'employee' AND paused = 0 ORDER BY sort_order DESC LIMIT 1").get();
    if (bottom) db.prepare("UPDATE approvals SET current_stage_role_id = ? WHERE status = 'Pending' AND current_stage_role_id IS NULL").run(bottom.id);
  }

  // Company rule: Team Lead can only approve leave requests up to 2 days — anything longer
  // must be escalated to a more senior role. Editable per-role in Organization Structure.
  const roleCols = db.prepare('PRAGMA table_info(roles)').all().map((c) => c.name);
  if (!roleCols.includes('max_leave_approval_days')) {
    db.exec('ALTER TABLE roles ADD COLUMN max_leave_approval_days INTEGER');
    db.prepare("UPDATE roles SET max_leave_approval_days = 2 WHERE key = 'tl'").run();
  }

  const empCols = db.prepare('PRAGMA table_info(employees)').all().map((c) => c.name);
  if (!empCols.includes('shift')) db.exec("ALTER TABLE employees ADD COLUMN shift TEXT NOT NULL DEFAULT 'General (9:00 AM – 6:00 PM)'");

  // email is UNIQUE — a stored empty string (rather than NULL) collides with every other blank
  // email and blocks creating any further employee with no email. Normalize any that slipped in
  // before the create/edit routes started treating '' as "not provided".
  db.prepare("UPDATE employees SET email = NULL WHERE email = ''").run();

  // Half_day_flag marks a late check-in beyond the month's free-late allowance (company rule:
  // 2 free late arrivals/month, configurable via the "Free late arrivals per month" policy).
  const attCols = db.prepare('PRAGMA table_info(attendance)').all().map((c) => c.name);
  if (!attCols.includes('half_day_flag')) db.exec('ALTER TABLE attendance ADD COLUMN half_day_flag INTEGER NOT NULL DEFAULT 0');
  // Tracks whether the employee has already been alerted about THIS row being a missed
  // check-out or missing check-in, so the sweep in attendanceCore.js only ever notifies once
  // per gap instead of re-notifying every time they open Attendance or check in again.
  if (!attCols.includes('alert_sent')) db.exec('ALTER TABLE attendance ADD COLUMN alert_sent INTEGER NOT NULL DEFAULT 0');

  const payCols = db.prepare('PRAGMA table_info(payslips)').all().map((c) => c.name);
  if (!payCols.includes('late_deduction')) db.exec('ALTER TABLE payslips ADD COLUMN late_deduction INTEGER NOT NULL DEFAULT 0');

  if (!db.prepare("SELECT 1 FROM policies WHERE name = 'Free late arrivals per month'").get()) {
    db.prepare("INSERT INTO policies (category, name, value) VALUES ('rule', 'Free late arrivals per month', '2')").run();
  }

  const lv = db.prepare('PRAGMA table_info(leaves)').all().map((c) => c.name);
  if (!lv.includes('current_stage_role_id')) db.exec('ALTER TABLE leaves ADD COLUMN current_stage_role_id INTEGER REFERENCES roles(id)');
  if (!lv.includes('cancel_requested')) db.exec('ALTER TABLE leaves ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0');
  if (!lv.includes('cancelled')) db.exec('ALTER TABLE leaves ADD COLUMN cancelled INTEGER NOT NULL DEFAULT 0');
  // JSON array of leave_approval_reasons.id — only populated when a 4+ day request is approved
  // (see leaves.routes.js decide()); shorter requests never need one.
  if (!lv.includes('approval_reason_ids')) db.exec('ALTER TABLE leaves ADD COLUMN approval_reason_ids TEXT');

  db.exec(`
    CREATE TABLE IF NOT EXISTS leave_cancellations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      leave_id INTEGER NOT NULL REFERENCES leaves(id) ON DELETE CASCADE,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Rejected')),
      decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS leave_balance_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      leave_type TEXT NOT NULL,
      change INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      reason TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS salary_components (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('earning','deduction','employer_cost')),
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS employee_salary_lines (
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      component_id INTEGER NOT NULL REFERENCES salary_components(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (employee_id, component_id)
    );

    CREATE TABLE IF NOT EXISTS employee_leave_balances (
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      leave_type_id INTEGER NOT NULL REFERENCES leave_types(id) ON DELETE CASCADE,
      balance INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (employee_id, leave_type_id)
    );

    -- Employee Management custom fields: Super Admin can add a new field to the Employee form at
    -- any time (label + type); once added it shows up on every employee's record for HR/the
    -- employee to fill in, same "catalog + per-record value" pattern as Payroll's salary components.
    CREATE TABLE IF NOT EXISTS employee_custom_fields (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      field_type TEXT NOT NULL DEFAULT 'text' CHECK (field_type IN ('text','number','date')),
      section TEXT NOT NULL DEFAULT 'personal' CHECK (section IN ('personal','address','emergency','employment','bank','education')),
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS employee_custom_field_values (
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      field_id INTEGER NOT NULL REFERENCES employee_custom_fields(id) ON DELETE CASCADE,
      value TEXT,
      PRIMARY KEY (employee_id, field_id)
    );

    -- Built-in field labels/visibility: unlike employee_custom_fields (a brand-new field Super
    -- Admin defines from scratch), this only ever stores OVERRIDES on top of the fixed set of
    -- built-in fields (Name, Employee ID, Address, etc.) hardcoded into the form — a row here
    -- means "rename to this label" and/or "hide from the form"; no row means use the default.
    -- Data/columns are never dropped — hiding is a form-rendering concern only, per Super Admin
    -- policy (a handful of load-bearing fields — see PROTECTED_FIELD_KEYS in employees.routes.js
    -- — can never be hidden, only renamed, since Payroll/Attendance/RBAC/Reports depend on them).
    CREATE TABLE IF NOT EXISTS employee_field_config (
      field_key TEXT PRIMARY KEY,
      label TEXT,
      hidden INTEGER NOT NULL DEFAULT 0
    );

    -- A dated history of department/designation/team changes, separate from a plain field edit —
    -- editing department/designation directly via PUT /employees/:id silently overwrites the old
    -- value with no record of when or from what; a Transfer captures the before/after and the
    -- effective date so it's visible on the employee's profile later.
    CREATE TABLE IF NOT EXISTS employee_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      from_department TEXT, to_department TEXT,
      from_designation TEXT, to_designation TEXT,
      from_team_id INTEGER, to_team_id INTEGER,
      transfer_date TEXT NOT NULL,
      reason TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Tracks where each employee's monthly-accrual leave types (currently just Sick Leave) last
  // credited up to — applyMonthlyAccrual() in leaves.routes.js reads this, credits whatever whole
  // months have elapsed since, and advances it, so re-checking a balance never double-credits.
  // Existing rows default to NOW at migration time — accrual starts fresh from today on top of
  // whatever balance an employee already has, rather than retroactively recomputing years of
  // history from their join date.
  const elbCols = db.prepare('PRAGMA table_info(employee_leave_balances)').all().map((c) => c.name);
  if (!elbCols.includes('last_accrued_at')) {
    db.exec("ALTER TABLE employee_leave_balances ADD COLUMN last_accrued_at TEXT");
    db.prepare("UPDATE employee_leave_balances SET last_accrued_at = datetime('now') WHERE last_accrued_at IS NULL").run();
  }

  // Tags each leave_balance_history row with the calendar month ('YYYY-MM') it belongs to, so the
  // client can group the ledger into a month-by-month balance table (accrued/used/closing per
  // month) instead of just a flat chronological log. Backfilled from created_at for existing rows.
  const lbhCols = db.prepare('PRAGMA table_info(leave_balance_history)').all().map((c) => c.name);
  if (!lbhCols.includes('period_month')) {
    db.exec('ALTER TABLE leave_balance_history ADD COLUMN period_month TEXT');
    db.prepare("UPDATE leave_balance_history SET period_month = strftime('%Y-%m', created_at) WHERE period_month IS NULL").run();
  }

  // Recruitment: `positions` becomes "Job Requisitions" — every requisition now needs HR/manager
  // approval before it's live, and can be posted to job boards once approved.
  const posCols = db.prepare('PRAGMA table_info(positions)').all().map((c) => c.name);
  if (!posCols.includes('requested_by')) db.exec('ALTER TABLE positions ADD COLUMN requested_by TEXT');
  if (!posCols.includes('approval_status')) db.exec("ALTER TABLE positions ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'Approved' CHECK (approval_status IN ('Pending Approval','Approved','Rejected'))");
  if (!posCols.includes('posted_boards')) db.exec('ALTER TABLE positions ADD COLUMN posted_boards TEXT');

  db.exec(`
    CREATE TABLE IF NOT EXISTS candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      position_id INTEGER REFERENCES positions(id) ON DELETE SET NULL,
      panel TEXT,
      feedback_status TEXT NOT NULL DEFAULT 'No feedback yet' CHECK (feedback_status IN ('No feedback yet','Feedback submitted')),
      stage TEXT NOT NULL DEFAULT 'Resume Screening' CHECK (stage IN ('Resume Screening','Technical Interview','HR Interview','Offer','Hired')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS new_hires (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      designation TEXT,
      department TEXT,
      start_date TEXT,
      onboarding_pct INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS exits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      department TEXT,
      last_working_day TEXT,
      clearance_current INTEGER NOT NULL DEFAULT 0,
      clearance_total INTEGER NOT NULL DEFAULT 4,
      status TEXT NOT NULL DEFAULT 'Serving Notice' CHECK (status IN ('Serving Notice','Cleared')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS performance_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_name TEXT NOT NULL,
      team TEXT,
      goal_text TEXT NOT NULL,
      kpi_text TEXT,
      self_assessment_status TEXT NOT NULL DEFAULT 'Pending' CHECK (self_assessment_status IN ('Pending','Submitted')),
      manager_assessment_status TEXT NOT NULL DEFAULT 'Pending' CHECK (manager_assessment_status IN ('Pending','Submitted')),
      rating INTEGER,
      status TEXT NOT NULL DEFAULT 'In Progress' CHECK (status IN ('In Progress','Completed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS courses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      mandatory INTEGER NOT NULL DEFAULT 0,
      pass_mark INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS course_enrollments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      completed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(course_id, employee_id)
    );

    CREATE TABLE IF NOT EXISTS assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT,
      assigned_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'In Store' CHECK (status IN ('Assigned','In Store','Under Repair')),
      cost INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // --- Recruitment: dynamic Interview Rounds catalog (add/edit/pause, like leave_types /
  // salary_components) replaces the fixed 5-stage CHECK on candidates.stage. Seeded here
  // (inside migrate(), not seedModuleData()) so migrateCandidatesTable() below can map old
  // stage strings to the new rows in the same upgrade pass.
  db.exec(`
    CREATE TABLE IF NOT EXISTS interview_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      paused INTEGER NOT NULL DEFAULT 0,
      is_final INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  if (db.prepare('SELECT COUNT(*) AS c FROM interview_rounds').get().c === 0) {
    const insRound = db.prepare('INSERT INTO interview_rounds (name, sort_order, is_final) VALUES (?, ?, ?)');
    insRound.run('Resume Screening', 0, 0);
    insRound.run('Technical Interview', 1, 0);
    insRound.run('HR Interview', 2, 0);
    insRound.run('Offer', 3, 0);
    insRound.run('Hired', 4, 1);
  }

  // Candidate source catalog — same add/pause shape as interview_rounds, so "where did this
  // candidate come from" is a first-class, filterable field instead of overloaded text in
  // `candidates.panel`. 'Referral' is looked up by name in POST /refer to auto-tag referred
  // candidates, so it must always exist — never delete it, only pause other entries if unused.
  db.exec(`
    CREATE TABLE IF NOT EXISTS candidate_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      paused INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  if (db.prepare('SELECT COUNT(*) AS c FROM candidate_sources').get().c === 0) {
    const insSource = db.prepare('INSERT INTO candidate_sources (label, sort_order) VALUES (?, ?)');
    ['Referral', 'Naukri', 'LinkedIn', 'Company Careers Page', 'Indeed', 'Campus Hiring', 'Walk-in', 'Other']
      .forEach((label, i) => insSource.run(label, i));
  }

  migrateCandidatesTable();

  // Candidate contact + profile fields — none of these existed before (the only prior "contact"
  // was free-text stuffed into `panel` by the self-referral form). Needed for candidate-facing
  // Email/WhatsApp messaging and a fuller ATS-style profile.
  const candCols = db.prepare('PRAGMA table_info(candidates)').all().map((c) => c.name);
  [
    ['email', 'TEXT'], ['phone', 'TEXT'], ['experience_years', 'TEXT'],
    ['current_ctc', 'TEXT'], ['expected_ctc', 'TEXT'], ['notice_period', 'TEXT'],
    ['resume_data_url', 'TEXT'], ['resume_name', 'TEXT'],
    ['linkedin_url', 'TEXT'], ['location', 'TEXT']
  ].forEach(([col, type]) => { if (!candCols.includes(col)) db.exec(`ALTER TABLE candidates ADD COLUMN ${col} ${type}`); });

  // Job requisitions: replacement-hire tracking (who's leaving, target date to backfill them)
  // and a Job Description + the date it was finalized — none of this existed before, requisitions
  // were just department + title + headcount.
  const posCols2 = db.prepare('PRAGMA table_info(positions)').all().map((c) => c.name);
  if (!posCols2.includes('is_replacement')) db.exec('ALTER TABLE positions ADD COLUMN is_replacement INTEGER NOT NULL DEFAULT 0');
  if (!posCols2.includes('replacement_for')) db.exec('ALTER TABLE positions ADD COLUMN replacement_for TEXT');
  if (!posCols2.includes('replacement_target_date')) db.exec('ALTER TABLE positions ADD COLUMN replacement_target_date TEXT');
  if (!posCols2.includes('job_description')) db.exec('ALTER TABLE positions ADD COLUMN job_description TEXT');
  if (!posCols2.includes('jd_date')) db.exec('ALTER TABLE positions ADD COLUMN jd_date TEXT');

  // --- Onboarding / offboarding checklists: named responsibilities per new hire / exit,
  // each independently checkable, driving the overall onboarding_pct / clearance counts.
  db.exec(`
    CREATE TABLE IF NOT EXISTS onboarding_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      new_hire_id INTEGER NOT NULL REFERENCES new_hires(id) ON DELETE CASCADE,
      task_name TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS offboarding_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exit_id INTEGER NOT NULL REFERENCES exits(id) ON DELETE CASCADE,
      task_name TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
  `);

  // --- Performance Management Key Features: link reviews to a real employee for
  // self-service, plus 360 feedback / competency notes / promotion-or-PIP flag.
  const perCols = db.prepare('PRAGMA table_info(performance_reviews)').all().map((c) => c.name);
  if (!perCols.includes('employee_id')) db.exec('ALTER TABLE performance_reviews ADD COLUMN employee_id INTEGER REFERENCES employees(id)');
  if (!perCols.includes('competency_notes')) db.exec('ALTER TABLE performance_reviews ADD COLUMN competency_notes TEXT');
  if (!perCols.includes('plan_type')) db.exec("ALTER TABLE performance_reviews ADD COLUMN plan_type TEXT NOT NULL DEFAULT 'None' CHECK (plan_type IN ('None','Promotion','PIP'))");
  // Goal Assignment & Tracking (due date + progress) and the richer Performance Reviews &
  // Appraisals form (achievements / development areas), each now their own dedicated screen.
  if (!perCols.includes('due_date')) db.exec('ALTER TABLE performance_reviews ADD COLUMN due_date TEXT');
  if (!perCols.includes('progress_pct')) db.exec('ALTER TABLE performance_reviews ADD COLUMN progress_pct INTEGER NOT NULL DEFAULT 0');
  if (!perCols.includes('achievements_text')) db.exec('ALTER TABLE performance_reviews ADD COLUMN achievements_text TEXT');
  if (!perCols.includes('development_areas')) db.exec('ALTER TABLE performance_reviews ADD COLUMN development_areas TEXT');
  // Buckets each goal/target into the calendar month it belongs to ('YYYY-MM') — company policy
  // is N targets per employee per month, N configurable per department (see
  // department_target_policies below; enforced in performance.routes.js at creation time) — this
  // is what makes "this month's targets" a queryable group instead of an undifferentiated pile of
  // goals. Backfilled from created_at for existing rows.
  if (!perCols.includes('month')) {
    db.exec('ALTER TABLE performance_reviews ADD COLUMN month TEXT');
    db.prepare("UPDATE performance_reviews SET month = strftime('%Y-%m', created_at) WHERE month IS NULL").run();
  }
  // Measurable targets: a target_value/achieved_value/unit triple (e.g. "20 deals", achieved 15)
  // lets progress_pct be computed from real numbers instead of HR eyeballing a percentage.
  // Nullable — a qualitative goal ("Improve code quality") just leaves these unset and keeps the
  // old manual progress_pct entry.
  if (!perCols.includes('target_value')) db.exec('ALTER TABLE performance_reviews ADD COLUMN target_value REAL');
  if (!perCols.includes('achieved_value')) db.exec('ALTER TABLE performance_reviews ADD COLUMN achieved_value REAL');
  if (!perCols.includes('unit')) db.exec('ALTER TABLE performance_reviews ADD COLUMN unit TEXT');
  // Last time a "your self-assessment/manager-assessment is still pending" reminder went out for
  // this review — throttles the lazy reminder sweep (see sendPendingAssessmentReminders() in
  // performance.routes.js) to at most once every few days per review, same "no scheduler, check
  // lazily on read" idiom as Helpdesk's 24h auto-escalation.
  if (!perCols.includes('last_reminded_at')) db.exec('ALTER TABLE performance_reviews ADD COLUMN last_reminded_at TEXT');

  // How many monthly targets a department's employees get — Super Admin can set this per
  // department (Sales might run 6 monthly targets, a back-office team might run 2); a department
  // with no row here just uses the default. Missing row = default, same "no row = default" idiom
  // as freeLateAllowance()/notice period elsewhere.
  db.exec(`
    CREATE TABLE IF NOT EXISTS department_target_policies (
      department_id INTEGER PRIMARY KEY REFERENCES departments(id) ON DELETE CASCADE,
      targets_per_month INTEGER NOT NULL DEFAULT 4,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS performance_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id INTEGER NOT NULL REFERENCES performance_reviews(id) ON DELETE CASCADE,
      author_name TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const feedbackCols = db.prepare('PRAGMA table_info(performance_feedback)').all().map((c) => c.name);
  if (!feedbackCols.includes('author_type')) db.exec("ALTER TABLE performance_feedback ADD COLUMN author_type TEXT NOT NULL DEFAULT 'Other' CHECK (author_type IN ('Manager','Peer','Self','Other'))");

  // --- Learning Management Key Features: uploaded course materials (PDF/video, stored as
  // base64 like employee documents), a Super-Admin-only download/copy toggle per course, and
  // a per-enrollment score so "certificate issued" can enforce the assessment-passed rule.
  const courseCols = db.prepare('PRAGMA table_info(courses)').all().map((c) => c.name);
  if (!courseCols.includes('allow_download')) db.exec('ALTER TABLE courses ADD COLUMN allow_download INTEGER NOT NULL DEFAULT 0');

  const enrCols = db.prepare('PRAGMA table_info(course_enrollments)').all().map((c) => c.name);
  if (!enrCols.includes('score')) db.exec('ALTER TABLE course_enrollments ADD COLUMN score INTEGER');
  if (!enrCols.includes('certificate_issued')) db.exec('ALTER TABLE course_enrollments ADD COLUMN certificate_issued INTEGER NOT NULL DEFAULT 0');
  if (!enrCols.includes('certified_at')) db.exec('ALTER TABLE course_enrollments ADD COLUMN certified_at TEXT');

  db.exec(`
    CREATE TABLE IF NOT EXISTS course_materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      file_type TEXT NOT NULL CHECK (file_type IN ('pdf','video','other')),
      data_url TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Materials are view-only by default (no download/copy path). An employee can ask Super
    -- Admin/HR Admin to lift that for one specific file/video; approval is per material, per
    -- employee — same Pending/Approved/Rejected request pattern as asset_requests.
    CREATE TABLE IF NOT EXISTS material_download_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      material_id INTEGER NOT NULL REFERENCES course_materials(id) ON DELETE CASCADE,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Rejected')),
      decided_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      decided_at TEXT
    );
  `);

  // --- Asset Management Key Features: pause/resume (retire without deleting), warranty,
  // a barcode-style tracking tag, a full action history log, a Disposed status, and a
  // Pending-Approval gate for assets added by non-final-authority roles.
  migrateAssetsTable();
  // Manufacturer/vendor serial number — distinct from the internal asset_tag (which this app
  // generates itself, e.g. "AST-0001"); serial_number is whatever's printed on the physical unit.
  const assetCols = db.prepare('PRAGMA table_info(assets)').all().map((c) => c.name);
  if (!assetCols.includes('serial_number')) db.exec('ALTER TABLE assets ADD COLUMN serial_number TEXT');

  db.exec(`
    CREATE TABLE IF NOT EXISTS asset_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS asset_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('Return','Damage','Regularization')),
      detail TEXT,
      status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Rejected')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      decided_at TEXT
    );
  `);
  migrateAssetRequestsTable();

  // --- Asset Audit: a full-sweep audit run (checks every active, non-disposed asset at
  // once and records a summary), matching the "Asset Audit" Key Feature's "4/4 accounted
  // for, 0 discrepancies" prototype, alongside the existing per-asset manual audit log.
  db.exec(`
    CREATE TABLE IF NOT EXISTS asset_audits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      total INTEGER NOT NULL,
      accounted_for INTEGER NOT NULL,
      discrepancies INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // --- Learning "Assessments & Assignments": a real MCQ question bank per course, so
  // employees get a scored quiz (shuffled per attempt) instead of a manually-entered score.
  db.exec(`
    CREATE TABLE IF NOT EXISTS course_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      question_text TEXT NOT NULL,
      option_a TEXT NOT NULL,
      option_b TEXT NOT NULL,
      option_c TEXT NOT NULL,
      option_d TEXT NOT NULL,
      correct_option TEXT NOT NULL CHECK (correct_option IN ('A','B','C','D')),
      sort_order INTEGER NOT NULL DEFAULT 0
    );
  `);

  // --- Learning "Skill Development & Competency Mapping" and "Progress, Attendance &
  // Feedback" Key Features, plus "Training Delivery & Scheduling" session booking.
  db.exec(`
    CREATE TABLE IF NOT EXISTS employee_skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      skill_name TEXT NOT NULL,
      current_level INTEGER NOT NULL,
      required_level INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS learning_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      author_name TEXT NOT NULL,
      author_type TEXT NOT NULL DEFAULT 'Other' CHECK (author_type IN ('Manager','Peer','Self','Other')),
      note TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS training_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      mode TEXT NOT NULL,
      scheduled_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS course_access_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Rejected')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      decided_at TEXT
    );
  `);

  // --- Helpdesk / Grievance Ticketing: employees raise IT/HR/Admin/Grievance tickets,
  // HR/assigned staff track status and reply on a comment thread. ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      category TEXT NOT NULL CHECK (category IN ('IT','HR','Admin','Grievance','Other')),
      priority TEXT NOT NULL DEFAULT 'Medium' CHECK (priority IN ('Low','Medium','High')),
      subject TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','In Progress','Resolved','Closed')),
      assigned_to_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS ticket_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      author_name TEXT NOT NULL,
      comment TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS kb_articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'General',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ticket_routing (
      category TEXT PRIMARY KEY,
      assigned_to_employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE
    );
  `);
  migrateTicketsTable();
  // Tracks when a ticket was last auto-escalated (see runAutoEscalations in helpdesk.routes.js)
  // so the 24-hour unresolved-ticket check knows where its next 24-hour window starts, distinct
  // from created_at (which stays fixed) and from manual escalation (which doesn't touch this).
  const ticketCols = db.prepare('PRAGMA table_info(tickets)').all().map((c) => c.name);
  if (!ticketCols.includes('last_escalated_at')) db.exec('ALTER TABLE tickets ADD COLUMN last_escalated_at TEXT');
  // Proof/document attached at raise time (e.g. a screenshot or receipt) — distinct from
  // ticket_comments' own attachment columns, which are for files added later in the thread.
  if (!ticketCols.includes('attachment_data_url')) db.exec('ALTER TABLE tickets ADD COLUMN attachment_data_url TEXT');
  if (!ticketCols.includes('attachment_name')) db.exec('ALTER TABLE tickets ADD COLUMN attachment_name TEXT');
  const ticketCommentCols = db.prepare('PRAGMA table_info(ticket_comments)').all().map((c) => c.name);
  if (!ticketCommentCols.includes('internal')) db.exec('ALTER TABLE ticket_comments ADD COLUMN internal INTEGER NOT NULL DEFAULT 0');
  if (!ticketCommentCols.includes('attachment_data_url')) db.exec('ALTER TABLE ticket_comments ADD COLUMN attachment_data_url TEXT');
  if (!ticketCommentCols.includes('attachment_name')) db.exec('ALTER TABLE ticket_comments ADD COLUMN attachment_name TEXT');

  // --- Announcements / Company Notice Board: HR broadcasts posts every employee sees on
  // their dashboard, distinct from the personal notifications table. ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'General' CHECK (category IN ('General','Policy','Event','Holiday')),
      posted_by TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Department-wide targeting (nullable — a plain NULL keeps today's "everyone sees it"
  // behavior for every existing row) and a record of which external channels were requested,
  // alongside individual-employee targeting via the announcement_recipients join table (an
  // announcement can be aimed at several specific people at once, unlike notifications which
  // fan out one row per employee).
  const announcementCols = db.prepare('PRAGMA table_info(announcements)').all().map((c) => c.name);
  if (!announcementCols.includes('target_department')) db.exec('ALTER TABLE announcements ADD COLUMN target_department TEXT');
  if (!announcementCols.includes('channels')) db.exec("ALTER TABLE announcements ADD COLUMN channels TEXT NOT NULL DEFAULT 'in_app'");
  db.exec(`
    CREATE TABLE IF NOT EXISTS announcement_recipients (
      announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      PRIMARY KEY (announcement_id, employee_id)
    );
  `);

  // --- Expense & Travel Claims: reuses the same sequential approval-chain pattern already
  // shared by Leave and Attendance Regularization (current_stage_role_id + chain.js). ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS expense_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      category TEXT NOT NULL CHECK (category IN ('Travel','Food','Accommodation','Other')),
      amount INTEGER NOT NULL,
      description TEXT,
      receipt_data_url TEXT,
      status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Rejected','Reimbursed')),
      current_stage_role_id INTEGER REFERENCES roles(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      decided_at TEXT,
      reimbursed_at TEXT
    );
  `);

  // --- Employee Engagement Surveys: HR builds a rating-scale survey, employees respond once,
  // HR sees aggregated per-question averages. ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS surveys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft','Active','Closed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS survey_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
      question_text TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS survey_responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      comment TEXT,
      submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(survey_id, employee_id)
    );

    CREATE TABLE IF NOT EXISTS survey_answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      response_id INTEGER NOT NULL REFERENCES survey_responses(id) ON DELETE CASCADE,
      question_id INTEGER NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5)
    );
  `);

  // --- Document Management: a policy/handbook library; mandatory documents require every
  // active employee to explicitly acknowledge having read them. ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS company_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Policy' CHECK (category IN ('Policy','Handbook','Form','Other')),
      file_data_url TEXT NOT NULL,
      mandatory INTEGER NOT NULL DEFAULT 0,
      published INTEGER NOT NULL DEFAULT 1,
      uploaded_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS document_acknowledgments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES company_documents(id) ON DELETE CASCADE,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      acknowledged_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(document_id, employee_id)
    );
  `);

  migrateLeavesTable();
  // Optional attachment (e.g. a medical certificate for Sick Leave) — same base64-data-URL-as-
  // TEXT-column pattern already used for expense_claims.receipt_data_url.
  const leaveCols = db.prepare('PRAGMA table_info(leaves)').all().map((c) => c.name);
  if (!leaveCols.includes('document_data_url')) db.exec('ALTER TABLE leaves ADD COLUMN document_data_url TEXT');
  if (!leaveCols.includes('document_name')) db.exec('ALTER TABLE leaves ADD COLUMN document_name TEXT');

  // --- Integrations: generic key/value config store (Slack/Teams webhook URLs, Google
  // Calendar OAuth client id/secret + refresh token) so Super Admin can manage credentials
  // from the app itself instead of editing server/.env and restarting. Not encrypted at
  // rest — consistent with this demo app's existing plaintext bank/Aadhaar storage, not
  // production-grade secret management. ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS integration_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target TEXT NOT NULL CHECK (target IN ('slack','teams')),
      event TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('Sent','Failed')),
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Biometric Device Integration (eSSL and compatible ADMS/iClock-protocol terminals): a
    -- device pushes raw punches over HTTP with no vendor SDK required. Each device is
    -- pre-registered by serial number so the unauthenticated device-facing endpoint only
    -- accepts punches from known hardware.
    CREATE TABLE IF NOT EXISTS biometric_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      vendor TEXT NOT NULL DEFAULT 'eSSL',
      serial_number TEXT NOT NULL UNIQUE,
      location TEXT,
      status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Paused')),
      last_seen_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Maps the numeric enrollment ID punched into the device to a real employee.
    CREATE TABLE IF NOT EXISTS employee_biometric_ids (
      employee_id INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
      device_user_id TEXT NOT NULL UNIQUE,
      mapped_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Every raw punch received, mapped or not — lets HR see unmapped punches and map them
    -- retroactively (the punch is then processed into the attendance table).
    CREATE TABLE IF NOT EXISTS biometric_punches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_serial TEXT NOT NULL,
      device_user_id TEXT NOT NULL,
      employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      punch_time TEXT NOT NULL,
      punch_type TEXT NOT NULL DEFAULT 'unknown' CHECK (punch_type IN ('check-in','check-out','unknown')),
      processed INTEGER NOT NULL DEFAULT 0,
      raw_line TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Self-service: Super Admin adds their own integration entries beyond the 5 built-in
    -- ones (any third-party tool, with its own logo/icon for recognizability) — never
    -- deleted, only paused, matching the custom_modules convention.
    CREATE TABLE IF NOT EXISTS custom_integrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      logo TEXT,
      url TEXT,
      status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Paused')),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Google Calendar sync target: which Training Session event (if any) a session has already
  // been pushed as, so re-saving a session never creates a duplicate calendar entry.
  const trainingSessionCols = db.prepare('PRAGMA table_info(training_sessions)').all().map((c) => c.name);
  if (!trainingSessionCols.includes('calendar_event_id')) db.exec('ALTER TABLE training_sessions ADD COLUMN calendar_event_id TEXT');

  // --- Shift & Roster: shift patterns, per-day assignments, and swap requests. ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Paused')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS roster_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(employee_id, date)
    );

    CREATE TABLE IF NOT EXISTS shift_swap_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requester_employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      target_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Rejected')),
      decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // --- Rewards & Recognition: peer/manager nominations with a points value per award type. ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS recognitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      to_employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      award_type TEXT NOT NULL CHECK (award_type IN ('Employee of the Month','Spot Award','Team Player','Innovation Award','Above & Beyond')),
      message TEXT NOT NULL,
      points INTEGER NOT NULL DEFAULT 10,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // --- Project & Resource Management: projects + per-employee allocation %, so over/under
  // allocation can be flagged across active projects. ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','On Hold','Completed')),
      start_date TEXT,
      end_date TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS project_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      allocation_pct INTEGER NOT NULL DEFAULT 100 CHECK (allocation_pct > 0 AND allocation_pct <= 100),
      role_on_project TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id, employee_id)
    );
  `);

  // --- Timesheet: daily hours logged against a project, HR-approved. ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS timesheet_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      task_description TEXT,
      hours REAL NOT NULL CHECK (hours > 0 AND hours <= 24),
      status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Rejected')),
      decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // --- Timesheet > My Tasks: real project task management. A task is normally on its
  // creator's own list, but a manager/HR ("higher authority") can assign it straight to a
  // specific employee via assigned_to_employee_id, so it shows up on that employee's own
  // My Tasks list instead. ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      assigned_to_employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      task_name TEXT NOT NULL,
      description TEXT,
      sub_task_name TEXT,
      status TEXT NOT NULL DEFAULT 'Not Started' CHECK (status IN ('Not Started','In Progress','Completed','On Hold')),
      start_date TEXT NOT NULL,
      end_date TEXT,
      is_dependent INTEGER NOT NULL DEFAULT 0,
      depends_on_task_id INTEGER REFERENCES project_tasks(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS project_task_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
      author_name TEXT NOT NULL,
      comment TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // My Tasks is now scoped by department rather than project — project_id is left in place
  // (never destructively dropped) but unused by the create-task form going forward.
  const projectTaskCols = db.prepare('PRAGMA table_info(project_tasks)').all().map((c) => c.name);
  if (!projectTaskCols.includes('department')) db.exec('ALTER TABLE project_tasks ADD COLUMN department TEXT');

  // --- Disciplinary Action Tracking: HR-only case log against an employee, with a timeline
  // of notes. An employee may see only their own cases (never another's), matching the
  // PIP-flag privacy pattern already used in Performance Management. ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS disciplinary_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      category TEXT NOT NULL CHECK (category IN ('Warning','Suspension','Termination','Other')),
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','Resolved')),
      raised_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      resolution_notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS disciplinary_case_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER NOT NULL REFERENCES disciplinary_cases(id) ON DELETE CASCADE,
      author_name TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  migratePermissionCatalog();
  migrateTeamsAndScopes();
  migratePayrollFormula();
}

// Package formula: Gross = Basic + HRA + Bonus + Special Allowance; Deductions = PF + PT + Bonus
// (Bonus is part of the package — counted in Gross — but withheld from this month's payout, so
// it's shown again as its own line in Deductions; net effect on take-home is zero, purely for
// payslip transparency). Also retires Conveyance/TDS and a stray test component ("eds") that
// aren't part of that formula — safe because every employee's amount on all three is still 0.
function migratePayrollFormula() {
  const compCols = db.prepare('PRAGMA table_info(salary_components)').all().map((c) => c.name);
  if (!compCols.includes('withheld')) db.exec('ALTER TABLE salary_components ADD COLUMN withheld INTEGER NOT NULL DEFAULT 0');

  if (!db.prepare("SELECT 1 FROM salary_components WHERE key = 'bonus'").get()) {
    const bonusId = db.prepare("INSERT INTO salary_components (key, label, type, withheld, sort_order) VALUES ('bonus', 'Bonus', 'earning', 1, 2)").run().lastInsertRowid;
    const ins = db.prepare('INSERT INTO employee_salary_lines (employee_id, component_id, amount) VALUES (?, ?, 0)');
    db.prepare('SELECT id FROM employees').all().forEach((e) => ins.run(e.id, bonusId));
  }

  db.prepare("UPDATE salary_components SET active = 0 WHERE key IN ('conveyance','tds','eds') AND active = 1").run();

  // CTC also includes employer-side costs (Employer PF, Gratuity) that sit outside Gross/
  // Deductions/Net entirely — they're what the company pays on top, not part of the employee's
  // own earnings or deductions. The original 'type' CHECK only allowed earning/deduction, so
  // this needs a table rebuild (SQLite can't ALTER a CHECK constraint in place).
  const typeCheckSql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'salary_components'").get().sql;
  if (!typeCheckSql.includes('employer_cost')) {
    db.exec(`
      CREATE TABLE salary_components_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('earning','deduction','employer_cost')),
        active INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        withheld INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO salary_components_new SELECT * FROM salary_components;
      DROP TABLE salary_components;
      ALTER TABLE salary_components_new RENAME TO salary_components;
    `);
  }

  if (!db.prepare("SELECT 1 FROM salary_components WHERE key = 'employer_pf'").get()) {
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM salary_components').get().m;
    const insC = db.prepare('INSERT INTO salary_components (key, label, type, sort_order) VALUES (?, ?, ?, ?)');
    const employerPfId = insC.run('employer_pf', 'Employer PF', 'employer_cost', maxOrder + 1).lastInsertRowid;
    const gratuityId = insC.run('gratuity', 'Gratuity', 'employer_cost', maxOrder + 2).lastInsertRowid;
    const ins = db.prepare('INSERT INTO employee_salary_lines (employee_id, component_id, amount) VALUES (?, ?, 0)');
    db.prepare('SELECT id FROM employees').all().forEach((e) => { ins.run(e.id, employerPfId); ins.run(e.id, gratuityId); });
  }
}

// Sub-department "teams" (e.g. Education's Team-A/Team-B), an optional team_id on each
// employee, and a supervisor_scopes table recording which specific departments (STL) or
// teams (TL) a given employee — not role, since two different people can hold the same
// 'stl'/'tl' role with different scopes — is allowed to see/act on. Deliberately not
// auto-seeded with any Team-A/Team-B rows: departments here are the user's own live data,
// so Super Admin creates teams and assigns scopes explicitly via the UI.
function migrateTeamsAndScopes() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Paused')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(department_id, name)
    );

    CREATE TABLE IF NOT EXISTS supervisor_scopes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      department_id INTEGER REFERENCES departments(id) ON DELETE CASCADE,
      team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK ((department_id IS NOT NULL) != (team_id IS NOT NULL))
    );
  `);

  const empCols = db.prepare('PRAGMA table_info(employees)').all().map((c) => c.name);
  if (!empCols.includes('team_id')) db.exec('ALTER TABLE employees ADD COLUMN team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL');

  // Fresher vs Experienced — lets the Employee form show only the relevant fields/document
  // names for each (e.g. no "Experience Letter" document option for a Fresher).
  if (!empCols.includes('employment_type')) db.exec('ALTER TABLE employees ADD COLUMN employment_type TEXT');

  // Pay Type — separate from Fresher/Experienced above: which payroll formula applies.
  // 'Stipend' interns get a fixed ₹10,000/month with no components at all; 'Package' employees
  // use the normal Basic/HRA/etc. salary-components breakdown. Defaults to 'Package' so every
  // existing employee keeps today's behavior.
  if (!empCols.includes('pay_type')) db.exec("ALTER TABLE employees ADD COLUMN pay_type TEXT NOT NULL DEFAULT 'Package' CHECK (pay_type IN ('Package','Stipend'))");

  // CTC-driven salary structure: HR enters one CTC figure and the server splits it into
  // Basic/HRA/Bonus/Special Allowance/PF/PT/Employer PF/Gratuity per the configured percentages
  // (see payroll.routes.js splitCtc()) — replaces manually typing each component amount.
  // Storing the CTC itself (not just the derived component amounts) lets the structure be
  // re-displayed and re-split later without asking HR to re-enter it.
  if (!empCols.includes('ctc')) db.exec('ALTER TABLE employees ADD COLUMN ctc INTEGER');

  // Custom fields now belong to a real form section (Personal/Address/Emergency/Employment/
  // Bank/Education) instead of always landing in one lumped "Additional information" block.
  const customFieldCols = db.prepare('PRAGMA table_info(employee_custom_fields)').all().map((c) => c.name);
  if (!customFieldCols.includes('section')) db.exec("ALTER TABLE employee_custom_fields ADD COLUMN section TEXT NOT NULL DEFAULT 'personal' CHECK (section IN ('personal','address','emergency','employment','bank','education'))");

  // Forgot-password: a one-time token + expiry stored on the account, cleared once used or
  // once a new token is issued (issuing a fresh one implicitly invalidates any older link).
  const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!userCols.includes('reset_token')) db.exec('ALTER TABLE users ADD COLUMN reset_token TEXT');
  if (!userCols.includes('reset_token_expires')) db.exec('ALTER TABLE users ADD COLUMN reset_token_expires TEXT');

  // Finer-grained address (building/door/floor/landmark alongside the existing street/city/
  // state/country/pincode) + phone OTP verification (India: 10-digit mobile, +91 assumed).
  if (!empCols.includes('address_building_no')) db.exec('ALTER TABLE employees ADD COLUMN address_building_no TEXT');
  if (!empCols.includes('address_door_no')) db.exec('ALTER TABLE employees ADD COLUMN address_door_no TEXT');
  if (!empCols.includes('address_floor_no')) db.exec('ALTER TABLE employees ADD COLUMN address_floor_no TEXT');
  if (!empCols.includes('address_landmark')) db.exec('ALTER TABLE employees ADD COLUMN address_landmark TEXT');
  if (!empCols.includes('phone_verified')) db.exec('ALTER TABLE employees ADD COLUMN phone_verified INTEGER NOT NULL DEFAULT 0');
  if (!empCols.includes('phone_otp_code')) db.exec('ALTER TABLE employees ADD COLUMN phone_otp_code TEXT');
  if (!empCols.includes('phone_otp_expires')) db.exec('ALTER TABLE employees ADD COLUMN phone_otp_expires TEXT');

  // Statutory identifiers shown on a real payslip alongside the existing PAN number.
  if (!empCols.includes('uan_number')) db.exec('ALTER TABLE employees ADD COLUMN uan_number TEXT');
  if (!empCols.includes('pf_number')) db.exec('ALTER TABLE employees ADD COLUMN pf_number TEXT');
  if (!empCols.includes('esi_number')) db.exec('ALTER TABLE employees ADD COLUMN esi_number TEXT');

  // Address redesign: Address Type (Current/Permanent) + Line 1/Line 2 + District replace the
  // old door/building/floor/street/landmark breakdown (city/state/country/pincode are reused
  // as-is, just relabeled in the UI). Existing data is folded into the new fields once so
  // nothing already filled in is lost — door/building/floor -> Line 1, street/landmark -> Line 2.
  if (!empCols.includes('address_type')) db.exec('ALTER TABLE employees ADD COLUMN address_type TEXT');
  if (!empCols.includes('address_line1')) {
    db.exec('ALTER TABLE employees ADD COLUMN address_line1 TEXT');
    db.exec('ALTER TABLE employees ADD COLUMN address_line2 TEXT');
    db.prepare('SELECT id, address_door_no, address_building_no, address_floor_no, address_street, address_landmark FROM employees').all().forEach((e) => {
      const line1 = [e.address_door_no, e.address_building_no, e.address_floor_no && `Floor ${e.address_floor_no}`].filter(Boolean).join(', ');
      const line2 = [e.address_street, e.address_landmark && `Near ${e.address_landmark}`].filter(Boolean).join(', ');
      if (line1 || line2) {
        db.prepare('UPDATE employees SET address_line1 = ?, address_line2 = ? WHERE id = ?').run(line1 || null, line2 || null, e.id);
      }
    });
  }
  if (!empCols.includes('address_district')) db.exec('ALTER TABLE employees ADD COLUMN address_district TEXT');

  // A proper payslip needs: the calendar month (for computing that period's Days Worked/LOP from
  // attendance), an explicit Loss-of-Pay day count + the pay it cost them, and a frozen snapshot
  // of the itemized earning/deduction lines at the moment payroll ran — salary_components can
  // change later, but an already-issued payslip must keep showing what was actually paid then.
  const payCols2 = db.prepare('PRAGMA table_info(payslips)').all().map((c) => c.name);
  if (!payCols2.includes('month')) db.exec('ALTER TABLE payslips ADD COLUMN month TEXT');
  if (!payCols2.includes('days_worked')) db.exec('ALTER TABLE payslips ADD COLUMN days_worked INTEGER');
  if (!payCols2.includes('lop_days')) db.exec('ALTER TABLE payslips ADD COLUMN lop_days INTEGER NOT NULL DEFAULT 0');
  if (!payCols2.includes('lop_deduction')) db.exec('ALTER TABLE payslips ADD COLUMN lop_deduction INTEGER NOT NULL DEFAULT 0');
  if (!payCols2.includes('lines_json')) db.exec('ALTER TABLE payslips ADD COLUMN lines_json TEXT');

  // Super Admin can give recognition without being linked to an employee record (a true
  // system-administrator login often isn't tied to one) — from_employee_id has to become
  // nullable for that, which SQLite only allows via a table rebuild.
  const recogCol = db.prepare('PRAGMA table_info(recognitions)').all().find((c) => c.name === 'from_employee_id');
  if (recogCol && recogCol.notnull) {
    db.exec(`
      CREATE TABLE recognitions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE,
        to_employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        award_type TEXT NOT NULL CHECK (award_type IN ('Employee of the Month','Spot Award','Team Player','Innovation Award','Above & Beyond')),
        message TEXT NOT NULL,
        points INTEGER NOT NULL DEFAULT 10,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO recognitions_new SELECT * FROM recognitions;
      DROP TABLE recognitions;
      ALTER TABLE recognitions_new RENAME TO recognitions;
    `);
  }

  // Employee self-service Recruitment: refer a candidate (tracked on the same candidates row
  // used by the HR pipeline) and submit a resignation (creates the same exits row HR's own
  // "Add Exit" flow creates, just self-initiated — with a reason, which HR-created exits never
  // needed since HR already knows why).
  const candCols = db.prepare('PRAGMA table_info(candidates)').all().map((c) => c.name);
  if (!candCols.includes('referred_by_employee_id')) db.exec('ALTER TABLE candidates ADD COLUMN referred_by_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL');
  if (!candCols.includes('source_id')) db.exec('ALTER TABLE candidates ADD COLUMN source_id INTEGER REFERENCES candidate_sources(id)');
  const exitCols = db.prepare('PRAGMA table_info(exits)').all().map((c) => c.name);
  if (!exitCols.includes('reason')) db.exec('ALTER TABLE exits ADD COLUMN reason TEXT');

  // New Hires now link to a real employee record (nullable, for backward compat with any row
  // created before this migration) — required going forward so onboarding can be driven by real
  // cross-module signals (Documents/Employees/Assets — see server/src/utils/onboarding.js)
  // instead of HR manually ticking every checklist item. `completed_at` drives the 2-day
  // auto-archive of a finished onboarding record (see /overview's newHires filter).
  const newHireCols = db.prepare('PRAGMA table_info(new_hires)').all().map((c) => c.name);
  if (!newHireCols.includes('employee_id')) db.exec('ALTER TABLE new_hires ADD COLUMN employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL');
  if (!newHireCols.includes('completed_at')) db.exec('ALTER TABLE new_hires ADD COLUMN completed_at TEXT');

  // Documents used to be visible to every employee unconditionally. Default existing/new rows to
  // published=1 so nothing already-visible silently disappears — HR now has the option to hide
  // specific ones instead of everything being forced into one state.
  const docCols = db.prepare('PRAGMA table_info(company_documents)').all().map((c) => c.name);
  if (!docCols.includes('published')) db.exec('ALTER TABLE company_documents ADD COLUMN published INTEGER NOT NULL DEFAULT 1');
}

// The original permission-matrix catalog (perm_modules/perm_features) only covered the first
// 11 modules built in this app. Every module added since (Helpdesk through Disciplinary) was
// missing from Manage Roles entirely. This adds them, idempotently (guarded per-module-name so
// re-running is always safe), with default grants chosen to exactly preserve today's real
// behavior: super_admin/hr_admin/manager/assistant_manager (the roles every one of these
// modules' HR_ROLES arrays already includes) get full access; stl/tl/employee get baseline
// View — nothing changes for anyone until Super Admin actively edits the matrix. Only
// HR/admin-facing features are catalogued here (never an employee's own self-service actions
// like applying for leave or logging their own hours) — matching how the original 11 modules
// were scoped, and so the matrix can never be used to accidentally lock an employee out of
// their own self-service screens.
function migratePermissionCatalog() {
  const NEW_MODULES = [
    { name: 'Helpdesk', items: [
      'Ticket Creation, Assignment & Categorization', 'SLA Tracking & Status', 'Ticket Resolution, Closure & Reopening',
      'Internal Notes, Attachments & Screenshots', 'Knowledge Base', 'Auto Routing & Email Notifications',
      'Ticket Escalation', 'CSAT / Customer Satisfaction Feedback', 'Helpdesk Dashboard, Reports & Analytics'
    ]},
    { name: 'Announcements', items: [
      'Post Announcement', 'Department / Individual Targeting', 'Multi-Channel Delivery (Email/SMS/WhatsApp)', 'Notification Log'
    ]},
    { name: 'Expense & Travel Claims', items: [
      'Expense Claim Approval Chain', 'Reimbursement Processing', 'Expense Reports'
    ]},
    { name: 'Employee Engagement Surveys', items: [
      'Build & Manage Survey', 'Activate / Deactivate Survey', 'Survey Results & Analytics'
    ]},
    { name: 'Document Management', items: [
      'Upload & Manage Company Documents', 'Mandatory Acknowledgment Tracking', 'Document Library', 'Publish / Hide from Employees'
    ]},
    { name: 'Shift & Roster', items: [
      'Shift Pattern Management', 'Roster Assignment', 'Shift Swap Approval'
    ]},
    { name: 'Rewards & Recognition', items: [
      'Recognition Feed & Leaderboard', 'Recognition Analytics'
    ]},
    { name: 'Project & Resource Management', items: [
      'Project Catalog & Assignment', 'Resource Allocation Overview'
    ]},
    { name: 'Timesheet', items: [
      'Timesheet Approval', 'Timesheet Reports', 'Task Assignment (My Tasks)'
    ]},
    { name: 'Disciplinary Action Tracking', items: [
      'Case Log & Timeline', 'Case Resolution'
    ]}
  ];
  const FULL_ACCESS_ROLES = ['super_admin', 'hr_admin', 'manager'];
  const ACTIONS = ['View', 'Create', 'Edit', 'Delete', 'Approve', 'Reject', 'Assign', 'Import', 'Export', 'Download', 'Print', 'Manage'];

  const roles = db.prepare('SELECT id, key FROM roles').all();
  if (!roles.length) return; // fresh DB — seed() will run and cover the original 11; this
                              // migration only needs to backfill an already-seeded live DB.

  const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM perm_modules').get().m;
  const insertModule = db.prepare('INSERT INTO perm_modules (code, name, sort_order) VALUES (?, ?, ?)');
  const insertFeature = db.prepare('INSERT INTO perm_features (module_id, category, name, sort_order) VALUES (?, ?, ?, ?)');
  const insertGrant = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, feature_id, action) VALUES (?, ?, ?)');

  NEW_MODULES.forEach((m, i) => {
    if (db.prepare('SELECT 1 FROM perm_modules WHERE name = ?').get(m.name)) return; // already added
    const code = String(13 + i).padStart(2, '0');
    const moduleId = insertModule.run(code, m.name, maxSort + 1 + i).lastInsertRowid;
    m.items.forEach((item, fi) => {
      const featureId = insertFeature.run(moduleId, 'Core Records & Day-to-Day Operations', item, fi).lastInsertRowid;
      roles.forEach((r) => {
        if (FULL_ACCESS_ROLES.includes(r.key)) ACTIONS.forEach((a) => insertGrant.run(r.id, featureId, a));
        else insertGrant.run(r.id, featureId, 'View');
      });
    });
  });

  migrateManagerFullAccess();
  migrateDocumentPublishFeature();
}

// Document Management gained a distinct "Publish / Hide from Employees" permission after go-live
// (documents were visible to every employee unconditionally) — added as its own feature, not
// folded into the existing 'Upload & Manage Company Documents' grant, so Super Admin can grant or
// revoke just the publish/hide capability independently via Manage Roles. Runs after the
// NEW_MODULES loop above, which — since Document Management already exists on a live DB — would
// otherwise skip adding this new item entirely (its "already added" check is module-level, not
// per-feature).
function migrateDocumentPublishFeature() {
  const mod = db.prepare("SELECT id FROM perm_modules WHERE code = '17'").get();
  if (!mod) return; // Document Management not seeded yet — the NEW_MODULES loop above will cover it
  if (db.prepare('SELECT 1 FROM perm_features WHERE module_id = ? AND name = ?').get(mod.id, 'Publish / Hide from Employees')) return;

  const ACTIONS = ['View', 'Create', 'Edit', 'Delete', 'Approve', 'Reject', 'Assign', 'Import', 'Export', 'Download', 'Print', 'Manage'];
  const FULL_ACCESS_ROLES = ['super_admin', 'hr_admin', 'manager'];
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM perm_features WHERE module_id = ?').get(mod.id).m;
  const featureId = db.prepare('INSERT INTO perm_features (module_id, category, name, sort_order) VALUES (?, ?, ?, ?)')
    .run(mod.id, 'Core Records & Day-to-Day Operations', 'Publish / Hide from Employees', maxSort + 1).lastInsertRowid;
  const roles = db.prepare('SELECT id, key FROM roles').all();
  const insertGrant = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, feature_id, action) VALUES (?, ?, ?)');
  roles.forEach((r) => {
    if (FULL_ACCESS_ROLES.includes(r.key)) ACTIONS.forEach((a) => insertGrant.run(r.id, featureId, a));
    else insertGrant.run(r.id, featureId, 'View');
  });
}

// The original 11-module seed() only ever gave 'super_admin'/'hr_admin' the full action set,
// with every other role (including manager) getting 'View' only. But every route file's real
// isHR() gate has always treated manager as full HR access alongside super_admin/hr_admin — so
// its permission-matrix rows never matched its actual live behavior. Backfill it to full access
// on every feature (idempotent INSERT OR IGNORE) so turning on feature-level enforcement doesn't
// newly lock out access this role already has.
// NOTE: assistant_manager was deliberately removed from this backfill — per Super Admin policy,
// Assistant Manager/STL/TL are limited to View + workflow-approval actions only across every
// module (05-18, Payroll excepted), unless Super Admin explicitly grants more in Manage Roles.
// Re-adding it here would silently undo that on every server restart.
function migrateManagerFullAccess() {
  const ACTIONS = ['View', 'Create', 'Edit', 'Delete', 'Approve', 'Reject', 'Assign', 'Import', 'Export', 'Download', 'Print', 'Manage'];
  const roleIds = db.prepare("SELECT id FROM roles WHERE key IN ('manager')").all().map((r) => r.id);
  if (!roleIds.length) return;
  const featureIds = db.prepare('SELECT id FROM perm_features').all().map((f) => f.id);
  const insertGrant = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, feature_id, action) VALUES (?, ?, ?)');
  roleIds.forEach((roleId) => {
    featureIds.forEach((featureId) => {
      ACTIONS.forEach((a) => insertGrant.run(roleId, featureId, a));
    });
  });
}

// One-time rebuild: candidates.stage was a fixed 5-value CHECK column. Replace it with a
// round_id FK into the new interview_rounds catalog so HR can add custom rounds, preserving
// every existing row's id and mapping its old stage string to the matching round.
function migrateCandidatesTable() {
  const cols = db.prepare('PRAGMA table_info(candidates)').all().map((c) => c.name);
  if (cols.includes('round_id')) return;

  db.pragma('foreign_keys = OFF');
  const rebuild = db.transaction(() => {
    db.exec(`
      CREATE TABLE candidates_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        position_id INTEGER REFERENCES positions(id) ON DELETE SET NULL,
        panel TEXT,
        feedback_status TEXT NOT NULL DEFAULT 'No feedback yet' CHECK (feedback_status IN ('No feedback yet','Feedback submitted')),
        round_id INTEGER REFERENCES interview_rounds(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const insert = db.prepare(`
      INSERT INTO candidates_new (id, name, position_id, panel, feedback_status, round_id, created_at)
      VALUES (@id, @name, @position_id, @panel, @feedback_status, @round_id, @created_at)
    `);
    db.prepare('SELECT * FROM candidates').all().forEach((r) => {
      const round = db.prepare('SELECT id FROM interview_rounds WHERE name = ?').get(r.stage);
      insert.run({ ...r, round_id: round ? round.id : null });
    });
    db.exec('DROP TABLE candidates');
    db.exec('ALTER TABLE candidates_new RENAME TO candidates');
  });
  rebuild();
  db.pragma('foreign_keys = ON');
}

// One-time rebuild: widen assets.status to include 'Disposed' (SQLite can't ALTER a CHECK)
// and add the pause/warranty/tag/approval columns needed for the Asset Management key
// features, preserving every existing row's id and data.
function migrateAssetsTable() {
  const cols = db.prepare('PRAGMA table_info(assets)').all().map((c) => c.name);
  if (cols.includes('asset_tag')) return;

  db.pragma('foreign_keys = OFF');
  const rebuild = db.transaction(() => {
    db.exec(`
      CREATE TABLE assets_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT,
        assigned_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'In Store' CHECK (status IN ('Assigned','In Store','Under Repair','Disposed')),
        cost INTEGER,
        active INTEGER NOT NULL DEFAULT 1,
        warranty_expiry TEXT,
        asset_tag TEXT,
        approval_status TEXT NOT NULL DEFAULT 'Approved' CHECK (approval_status IN ('Pending Approval','Approved','Rejected')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const insert = db.prepare(`
      INSERT INTO assets_new (id, name, category, assigned_employee_id, status, cost, created_at)
      VALUES (@id, @name, @category, @assigned_employee_id, @status, @cost, @created_at)
    `);
    db.prepare('SELECT * FROM assets').all().forEach((r) => insert.run(r));
    db.exec('DROP TABLE assets');
    db.exec('ALTER TABLE assets_new RENAME TO assets');
    db.prepare('SELECT id FROM assets ORDER BY id').all().forEach((r) => {
      db.prepare('UPDATE assets SET asset_tag = ? WHERE id = ?').run('AST-' + String(r.id).padStart(4, '0'), r.id);
    });
  });
  rebuild();
  db.pragma('foreign_keys = ON');
}

// One-time rebuild: asset_requests originally required an asset_id (every request had to be
// against an asset the employee already held). The "Request Asset" Quick Action needs a
// request type with no asset yet — a brand-new asset ask (category + urgency) reviewed via
// Asset Approval — so asset_id becomes nullable and category/urgency columns are added.
function migrateAssetRequestsTable() {
  const cols = db.prepare('PRAGMA table_info(asset_requests)').all().map((c) => c.name);
  if (cols.includes('urgency')) return;

  db.pragma('foreign_keys = OFF');
  const rebuild = db.transaction(() => {
    db.exec(`
      CREATE TABLE asset_requests_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id INTEGER REFERENCES assets(id) ON DELETE CASCADE,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('Return','Damage','Regularization','New Asset')),
        category TEXT,
        urgency TEXT NOT NULL DEFAULT 'Medium' CHECK (urgency IN ('Low','Medium','High')),
        detail TEXT,
        status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Rejected')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        decided_at TEXT
      );
    `);
    const insert = db.prepare(`
      INSERT INTO asset_requests_new (id, asset_id, employee_id, type, detail, status, created_at, decided_at)
      VALUES (@id, @asset_id, @employee_id, @type, @detail, @status, @created_at, @decided_at)
    `);
    db.prepare('SELECT * FROM asset_requests').all().forEach((r) => insert.run(r));
    db.exec('DROP TABLE asset_requests');
    db.exec('ALTER TABLE asset_requests_new RENAME TO asset_requests');
  });
  rebuild();
  db.pragma('foreign_keys = ON');
}

// One-time rebuild: Helpdesk's Key Features (SLA Tracking, Ticket Resolution/Closure/
// Reopening, Ticket Escalation, CSAT) need a wider category/priority CHECK (Facilities,
// Payroll, Critical) plus sla_deadline/requester_confirmed/escalated/csat_rating columns.
function migrateTicketsTable() {
  const cols = db.prepare('PRAGMA table_info(tickets)').all().map((c) => c.name);
  if (cols.includes('sla_deadline')) return;

  db.pragma('foreign_keys = OFF');
  const rebuild = db.transaction(() => {
    db.exec(`
      CREATE TABLE tickets_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        category TEXT NOT NULL CHECK (category IN ('IT','HR','Admin','Grievance','Facilities','Payroll','Other')),
        priority TEXT NOT NULL DEFAULT 'Medium' CHECK (priority IN ('Low','Medium','High','Critical')),
        subject TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','In Progress','Resolved','Closed')),
        assigned_to_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        sla_deadline TEXT,
        requester_confirmed INTEGER NOT NULL DEFAULT 0,
        escalated INTEGER NOT NULL DEFAULT 0,
        csat_rating INTEGER CHECK (csat_rating IS NULL OR csat_rating BETWEEN 1 AND 5),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT
      );
    `);
    const insert = db.prepare(`
      INSERT INTO tickets_new (id, employee_id, category, priority, subject, description, status, assigned_to_employee_id, created_at, resolved_at)
      VALUES (@id, @employee_id, @category, @priority, @subject, @description, @status, @assigned_to_employee_id, @created_at, @resolved_at)
    `);
    db.prepare('SELECT * FROM tickets').all().forEach((r) => insert.run(r));
    db.exec('DROP TABLE tickets');
    db.exec('ALTER TABLE tickets_new RENAME TO tickets');
  });
  rebuild();
  db.pragma('foreign_keys = ON');
}

// One-time rebuild: the original notifications.target_role CHECK only allowed
// ('all','super_admin','manager','employee') — too narrow once Helpdesk needed a 'staff'
// broadcast (every role except plain employee, for operational alerts a regular employee
// shouldn't see about someone else's ticket). Preserves every existing column/row by rebuilding
// against whatever the live table's current column set already is (it's grown several ALTER-
// added columns over time — employee_id, target_department, channels, priority, ticket_id).
function migrateNotificationsTargetRole() {
  const info = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='notifications'").get();
  if (!info || info.sql.includes("'staff'")) return;

  const colNames = db.prepare('PRAGMA table_info(notifications)').all().map((c) => c.name);
  db.pragma('foreign_keys = OFF');
  const rebuild = db.transaction(() => {
    db.exec(`
      CREATE TABLE notifications_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        target_role TEXT NOT NULL DEFAULT 'all' CHECK (target_role IN ('all','staff','super_admin','manager','hr_admin','assistant_manager','stl','tl','employee')),
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE,
        target_department TEXT,
        channels TEXT NOT NULL DEFAULT 'in_app',
        priority TEXT,
        ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL
      );
    `);
    const cols = colNames.join(', ');
    db.exec(`INSERT INTO notifications_new (${cols}) SELECT ${cols} FROM notifications`);
    db.exec('DROP TABLE notifications');
    db.exec('ALTER TABLE notifications_new RENAME TO notifications');
  });
  rebuild();
  db.pragma('foreign_keys = ON');
}

// One-time rebuild: the original `leaves` table restricted `type` to a fixed CHECK
// (Casual/Sick/Earned), which blocks applying for any other leave type. Rebuild it with a
// leave_type_id FK and no such restriction, preserving every existing row's id (so
// leave_cancellations.leave_id keeps pointing at the right record) and mapping old type
// strings to their matching leave_types row where possible.
function migrateLeavesTable() {
  const cols = db.prepare('PRAGMA table_info(leaves)').all().map((c) => c.name);
  if (cols.includes('leave_type_id')) return;

  db.pragma('foreign_keys = OFF');
  const rebuild = db.transaction(() => {
    db.exec(`
      CREATE TABLE leaves_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        leave_type_id INTEGER REFERENCES leave_types(id),
        type TEXT NOT NULL,
        from_date TEXT NOT NULL,
        to_date TEXT NOT NULL,
        days INTEGER NOT NULL,
        reason TEXT,
        status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Rejected')),
        decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        current_stage_role_id INTEGER REFERENCES roles(id),
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        cancelled INTEGER NOT NULL DEFAULT 0
      );
    `);
    const codeOfOldType = { Casual: 'CL', Sick: 'SL', Earned: 'EL' };
    const insert = db.prepare(`
      INSERT INTO leaves_new (id, employee_id, leave_type_id, type, from_date, to_date, days, reason, status, decided_by, created_at, current_stage_role_id, cancel_requested, cancelled)
      VALUES (@id, @employee_id, @leave_type_id, @type, @from_date, @to_date, @days, @reason, @status, @decided_by, @created_at, @current_stage_role_id, @cancel_requested, @cancelled)
    `);
    db.prepare('SELECT * FROM leaves').all().forEach((r) => {
      const code = codeOfOldType[r.type];
      const lt = code ? db.prepare('SELECT id FROM leave_types WHERE code = ?').get(code) : null;
      insert.run({ ...r, leave_type_id: lt ? lt.id : null });
    });
    db.exec('DROP TABLE leaves');
    db.exec('ALTER TABLE leaves_new RENAME TO leaves');
  });
  rebuild();
  db.pragma('foreign_keys = ON');
}

// Idempotent seed for the Leave/Payroll modules — fills defaults for existing employees
// only when the tables are empty, so it runs safely on a database that already has data.
function seedModuleData() {
  const employees = db.prepare('SELECT id FROM employees').all();
  if (db.prepare('SELECT COUNT(*) AS c FROM leave_balances').get().c === 0) {
    const ins = db.prepare('INSERT INTO leave_balances (employee_id, casual, sick, earned) VALUES (?, 12, 8, 15)');
    employees.forEach((e) => ins.run(e.id));
  }
  if (db.prepare('SELECT COUNT(*) AS c FROM salary_structures').get().c === 0) {
    const ins = db.prepare('INSERT INTO salary_structures (employee_id, basic, hra, allowances, deductions) VALUES (?, 40000, 16000, 8000, 4000)');
    employees.forEach((e) => ins.run(e.id));
  }
  if (db.prepare('SELECT COUNT(*) AS c FROM leave_types').get().c === 0) {
    const ins = db.prepare('INSERT INTO leave_types (name, code, annual_quota, unpaid) VALUES (?, ?, ?, ?)');
    ins.run('Casual Leave', 'CL', 12, 0);
    ins.run('Sick Leave', 'SL', 10, 0);
    ins.run('Earned Leave', 'EL', 18, 0);
    ins.run('Maternity', 'ML', 182, 0);
    ins.run('Paternity', 'PL', 15, 0);
    ins.run('Loss of Pay', 'LWP', 0, 1);
  }

  // Per-type balances, migrated from the old fixed casual/sick/earned columns so every
  // existing employee keeps their real (possibly already-decremented) balance.
  if (db.prepare('SELECT COUNT(*) AS c FROM employee_leave_balances').get().c === 0) {
    const types = db.prepare('SELECT * FROM leave_types').all();
    const oldBalances = db.prepare('SELECT * FROM leave_balances').all();
    const oldMap = {}; oldBalances.forEach((b) => { oldMap[b.employee_id] = b; });
    const codeCol = { CL: 'casual', SL: 'sick', EL: 'earned' };
    const ins = db.prepare('INSERT INTO employee_leave_balances (employee_id, leave_type_id, balance) VALUES (?, ?, ?)');
    employees.forEach((e) => {
      types.forEach((t) => {
        const col = codeCol[t.code];
        const bal = (col && oldMap[e.id]) ? oldMap[e.id][col] : t.annual_quota;
        ins.run(e.id, t.id, bal);
      });
    });
  }

  // Salary components catalog + per-employee lines, migrated from the old fixed
  // salary_structures columns so every existing employee keeps their current pay.
  if (db.prepare('SELECT COUNT(*) AS c FROM salary_components').get().c === 0) {
    const insC = db.prepare('INSERT INTO salary_components (key, label, type, sort_order) VALUES (?, ?, ?, ?)');
    insC.run('basic', 'Basic', 'earning', 0);
    insC.run('hra', 'HRA', 'earning', 1);
    insC.run('conveyance', 'Conveyance Allowance', 'earning', 2);
    insC.run('special_allowance', 'Special Allowance', 'earning', 3);
    insC.run('pf', 'PF (Provident Fund)', 'deduction', 4);
    insC.run('pt', 'PT (Professional Tax)', 'deduction', 5);
    insC.run('tds', 'TDS (Income Tax)', 'deduction', 6);
  }
  if (db.prepare('SELECT COUNT(*) AS c FROM employee_salary_lines').get().c === 0) {
    const components = db.prepare('SELECT id, key FROM salary_components').all();
    const insLine = db.prepare('INSERT INTO employee_salary_lines (employee_id, component_id, amount) VALUES (?, ?, ?)');
    db.prepare('SELECT * FROM salary_structures').all().forEach((s) => {
      components.forEach((c) => insLine.run(s.employee_id, c.id, s[c.key] || 0));
    });
  }

  // Any Pending leave without a chain stage yet (older rows, or first run after this migration)
  // starts at the bottom-most active, non-employee role.
  const bottomRole = db.prepare("SELECT id FROM roles WHERE key != 'employee' AND paused = 0 ORDER BY sort_order DESC LIMIT 1").get();
  if (bottomRole) {
    db.prepare("UPDATE leaves SET current_stage_role_id = ? WHERE status = 'Pending' AND current_stage_role_id IS NULL").run(bottomRole.id);
  }

  // --- Recruitment / Performance / Learning / Asset demo data (candidates, reviews, courses
  // etc. are prospective/fictional records, not tied to real employees, except where an
  // employee_id FK legitimately references one — e.g. assigning a real asset to a real employee
  // doesn't modify that employee's own record). ---
  const deptId = (name) => db.prepare('SELECT id FROM departments WHERE name = ?').get(name)?.id;
  if (db.prepare('SELECT COUNT(*) AS c FROM candidates').get().c === 0) {
    const posByTitle = (title) => db.prepare('SELECT id FROM positions WHERE title = ?').get(title)?.id;
    // `stage` was replaced by `round_id` (FK into interview_rounds) when the pipeline became
    // dynamic/HR-configurable — this seed still wrote the old column name and would crash on any
    // fresh DB (or one where candidates had all been cleared) until interview_rounds is resolved
    // by name instead.
    const roundByName = (name) => db.prepare('SELECT id FROM interview_rounds WHERE name = ?').get(name)?.id;
    const insCand = db.prepare('INSERT INTO candidates (name, position_id, panel, feedback_status, round_id) VALUES (?, ?, ?, ?, ?)');
    insCand.run('A. Verma', posByTitle('Senior Backend Engineer'), 'Usha, Vasavi', 'No feedback yet', roundByName('Technical Interview'));
    insCand.run('J. Thomas', posByTitle('Senior Backend Engineer'), null, 'No feedback yet', roundByName('Resume Screening'));
    insCand.run('M. Khan', posByTitle('Automation QA Engineer'), 'Ragini', 'Feedback submitted', roundByName('Offer'));
    insCand.run('S. Rao', posByTitle('Sales Executive'), 'Bhavana', 'Feedback submitted', roundByName('HR Interview'));
  }

  if (db.prepare('SELECT COUNT(*) AS c FROM new_hires').get().c === 0) {
    const insHire = db.prepare('INSERT INTO new_hires (name, designation, department, start_date, onboarding_pct) VALUES (?, ?, ?, ?, ?)');
    insHire.run('N. Kavya', 'Trainer', 'Educational', db.prepare("SELECT date('now','+3 days') AS d").get().d, 14);
    insHire.run('Supriya', 'Recruiter', 'Medical', db.prepare("SELECT date('now','+33 days') AS d").get().d, 0);
  }

  if (db.prepare('SELECT COUNT(*) AS c FROM exits').get().c === 0) {
    const r_iyer = db.prepare("SELECT id, name, department FROM employees WHERE employee_code = 'EMP-004'").get();
    if (r_iyer) {
      db.prepare('INSERT INTO exits (employee_id, name, department, last_working_day, clearance_current, clearance_total, status) VALUES (?, ?, ?, ?, 0, 4, ?)')
        .run(r_iyer.id, r_iyer.name, r_iyer.department, db.prepare("SELECT date('now','+21 days') AS d").get().d, 'Serving Notice');
    }
  }

  if (db.prepare('SELECT COUNT(*) AS c FROM performance_reviews').get().c === 0) {
    const insRev = db.prepare('INSERT INTO performance_reviews (employee_name, team, goal_text, kpi_text, self_assessment_status, manager_assessment_status, rating, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    insRev.run('Ragini', null, 'Ship v2 of the reporting module', 'On-time delivery', 'Submitted', 'Pending', null, 'In Progress');
    insRev.run('Usha', 'Team-A', 'Reduce support ticket backlog by 30%', 'Backlog reduction %', 'Submitted', 'Submitted', 4, 'Completed');
    insRev.run('Vasavi', null, 'Complete QA automation certification', 'Certification completion', 'Pending', 'Pending', null, 'In Progress');
  }
  // Backfill Goal Assignment & Tracking demo data (due date / progress) independent of the
  // block above, so it still lands even on a DB where performance_reviews already existed.
  if (!db.prepare("SELECT 1 FROM performance_reviews WHERE due_date IS NOT NULL").get()) {
    const setGoal = db.prepare('UPDATE performance_reviews SET due_date = ?, progress_pct = ? WHERE employee_name = ?');
    setGoal.run('2026-09-30', 45, 'Ragini');
    setGoal.run('2026-08-15', 90, 'Usha');
    setGoal.run('2026-09-30', 15, 'Vasavi');
  }
  if (db.prepare('SELECT COUNT(*) AS c FROM performance_feedback').get().c === 0) {
    const ragini = db.prepare("SELECT id FROM performance_reviews WHERE employee_name = 'Ragini'").get();
    if (ragini) {
      const insFb = db.prepare('INSERT INTO performance_feedback (review_id, author_name, author_type, note, created_at) VALUES (?, ?, ?, ?, ?)');
      insFb.run(ragini.id, 'Keerthana', 'Manager', 'Strong technical delivery this quarter, great ownership on the reporting module.', '2026-07-02 10:00:00');
      insFb.run(ragini.id, 'Usha', 'Peer', 'Very responsive in cross-team requests, always helpful.', '2026-06-28 10:00:00');
      insFb.run(ragini.id, 'Ragini', 'Self', 'Feel confident about delivery pace, want more exposure to architecture decisions.', '2026-06-25 10:00:00');
    }
  }

  if (db.prepare('SELECT COUNT(*) AS c FROM courses').get().c === 0) {
    const insCourse = db.prepare('INSERT INTO courses (title, mandatory, pass_mark) VALUES (?, ?, ?)');
    const c1 = insCourse.run('Workplace Safety & Compliance', 1, 70).lastInsertRowid;
    const c2 = insCourse.run('Advanced Excel for Reporting', 0, 70).lastInsertRowid;
    const c3 = insCourse.run('Leadership Fundamentals', 0, null).lastInsertRowid;
    if (db.prepare('SELECT COUNT(*) AS c FROM course_enrollments').get().c === 0) {
      const insEnr = db.prepare('INSERT INTO course_enrollments (course_id, employee_id, completed) VALUES (?, ?, ?)');
      const emps = db.prepare('SELECT id FROM employees ORDER BY id').all();
      // Rough completion ratios matching the prototype (74% / 50% / 100%), capped to how many real employees exist.
      const enroll = (courseId, n, completedN) => emps.slice(0, n).forEach((e, i) => insEnr.run(courseId, e.id, i < completedN ? 1 : 0));
      enroll(c1, Math.min(emps.length, 9), Math.min(emps.length, 7));
      enroll(c2, Math.min(emps.length, 6), Math.min(emps.length, 3));
      enroll(c3, Math.min(emps.length, 4), Math.min(emps.length, 4));
    }
  }
  // Independent of the courses-seed block above (which only runs once, ever) so this still
  // backfills a demo question bank even on a DB where courses already existed.
  if (db.prepare('SELECT COUNT(*) AS c FROM course_questions').get().c === 0) {
    const safetyCourse = db.prepare("SELECT id FROM courses WHERE title = 'Workplace Safety & Compliance'").get();
    if (safetyCourse) {
      const insQ = db.prepare('INSERT INTO course_questions (course_id, question_text, option_a, option_b, option_c, option_d, correct_option, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      insQ.run(safetyCourse.id, 'What should you do first in case of a fire alarm?', 'Finish your current task', 'Evacuate via the nearest marked exit', 'Call a colleague', 'Take the elevator', 'B', 0);
      insQ.run(safetyCourse.id, 'Where is the nearest fire extinguisher usually located?', 'In the parking lot', 'Near exits and hallways', 'In the CEO\'s office', 'It is not required', 'B', 1);
      insQ.run(safetyCourse.id, 'Who should workplace safety incidents be reported to?', 'No one, handle it yourself', 'HR/Safety Officer', 'The nearest customer', 'Social media', 'B', 2);
      insQ.run(safetyCourse.id, 'How often should workstation ergonomics be reviewed?', 'Never', 'Only when injured', 'Periodically / when discomfort starts', 'Once at joining only', 'C', 3);
    }
  }
  // Scoped to this specific course's own question count (not the global course_questions
  // count above) — otherwise, once the Workplace Safety seed above ever ran once, this would
  // silently never backfill Advanced Excel's bank on a live DB. This course has a pass_mark
  // but had zero questions, so employees could never actually take/pass/get certified for it.
  if (db.prepare('SELECT COUNT(*) AS c FROM course_questions WHERE course_id = (SELECT id FROM courses WHERE title = ?)').get('Advanced Excel for Reporting').c === 0) {
    const excelCourse = db.prepare("SELECT id FROM courses WHERE title = 'Advanced Excel for Reporting'").get();
    if (excelCourse) {
      const insQ = db.prepare('INSERT INTO course_questions (course_id, question_text, option_a, option_b, option_c, option_d, correct_option, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      insQ.run(excelCourse.id, 'Which Excel feature summarizes large datasets into a compact table with grouping and aggregation?', 'Conditional Formatting', 'Pivot Table', 'Data Validation', 'Sparklines', 'B', 0);
      insQ.run(excelCourse.id, 'Which function looks up a value in a table and returns a value from a specified column in the same row?', 'SUM', 'IF', 'VLOOKUP', 'CONCAT', 'C', 1);
      insQ.run(excelCourse.id, 'How do you lock a specific cell reference so it does not change when a formula is copied across cells?', 'Use $ signs (absolute reference)', 'Press Ctrl+L', 'Rename the cell', 'Add a comment', 'A', 2);
      insQ.run(excelCourse.id, 'Which chart type is best suited for showing a trend over time?', 'Pie Chart', 'Line Chart', 'Scatter Plot', 'Doughnut Chart', 'B', 3);
    }
  }
  // Same fix as Advanced Excel above, for the two other courses that had a pass_mark but no
  // question bank ("data" and "copmputer" — created later via the Create Course screen).
  if (db.prepare('SELECT COUNT(*) AS c FROM course_questions WHERE course_id = (SELECT id FROM courses WHERE title = ?)').get('data').c === 0) {
    const dataCourse = db.prepare("SELECT id FROM courses WHERE title = 'data'").get();
    if (dataCourse) {
      const insQ = db.prepare('INSERT INTO course_questions (course_id, question_text, option_a, option_b, option_c, option_d, correct_option, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      insQ.run(dataCourse.id, 'What is the primary purpose of data validation in a spreadsheet or database?', 'To format cells', 'To restrict the type of data a user can enter', 'To sort data', 'To delete duplicate data', 'B', 0);
      insQ.run(dataCourse.id, 'Which of the following best describes structured data?', 'Data with no defined format', 'Data organized in a fixed field format, like a table', 'Free-text documents', 'Images and videos', 'B', 1);
      insQ.run(dataCourse.id, 'What does "GIGO" stand for in data processing?', 'Get In, Get Out', 'Garbage In, Garbage Out', 'Group In, Group Out', 'Generate Input, Generate Output', 'B', 2);
      insQ.run(dataCourse.id, 'Which practice best helps protect data privacy when handling employee records?', 'Sharing data openly with everyone', 'Restricting access on a need-to-know basis', 'Storing data in plain text', 'Ignoring access logs', 'B', 3);
    }
  }
  if (db.prepare('SELECT COUNT(*) AS c FROM course_questions WHERE course_id = (SELECT id FROM courses WHERE title = ?)').get('copmputer').c === 0) {
    const compCourse = db.prepare("SELECT id FROM courses WHERE title = 'copmputer'").get();
    if (compCourse) {
      const insQ = db.prepare('INSERT INTO course_questions (course_id, question_text, option_a, option_b, option_c, option_d, correct_option, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      insQ.run(compCourse.id, 'What does "CPU" stand for?', 'Central Processing Unit', 'Computer Personal Unit', 'Central Program Utility', 'Control Processing Unit', 'A', 0);
      insQ.run(compCourse.id, 'Which of these is an example of an operating system?', 'Microsoft Word', 'Windows', 'Google Chrome', 'Adobe Photoshop', 'B', 1);
      insQ.run(compCourse.id, 'What is the main function of RAM in a computer?', 'Permanent storage', 'Temporary/working memory', 'Power supply', 'Display output', 'B', 2);
      insQ.run(compCourse.id, 'Which keyboard shortcut is commonly used to save a file?', 'Ctrl+P', 'Ctrl+S', 'Ctrl+C', 'Ctrl+Z', 'B', 3);
    }
  }

  // "Leadership Fundamentals" was seeded long before the "every course needs an assessment"
  // rule existed (pass_mark null, zero questions). Give it a real bank + pass mark so its
  // Take Assessment button actually works like every other course.
  if (db.prepare('SELECT COUNT(*) AS c FROM course_questions WHERE course_id = (SELECT id FROM courses WHERE title = ?)').get('Leadership Fundamentals').c === 0) {
    const leadership = db.prepare("SELECT id FROM courses WHERE title = 'Leadership Fundamentals'").get();
    if (leadership) {
      db.prepare('UPDATE courses SET pass_mark = 70 WHERE id = ?').run(leadership.id);
      const insQ = db.prepare('INSERT INTO course_questions (course_id, question_text, option_a, option_b, option_c, option_d, correct_option, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      insQ.run(leadership.id, 'Which leadership style involves setting a high standard and expecting the team to keep pace with the leader?', 'Democratic', 'Pacesetting', 'Laissez-faire', 'Coaching', 'B', 0);
      insQ.run(leadership.id, 'What is the primary goal of giving constructive feedback?', 'To criticize the person', "To help someone improve specific behavior or performance", 'To assign blame', 'To avoid conflict entirely', 'B', 1);
      insQ.run(leadership.id, 'Which of these best describes emotional intelligence in leadership?', 'Suppressing all emotion at work', "Recognizing and managing your own and others' emotions effectively", 'Only focusing on your own goals', 'Ignoring team morale', 'B', 2);
      insQ.run(leadership.id, 'What is a key benefit of delegating tasks effectively?', 'It reduces trust in the team', "It frees the leader's time and develops team members' skills", 'It always slows down projects', "It removes the leader's accountability", 'B', 3);
    }
  }

  // The real user created "prompt engineer" live via Create Course and added one question of
  // their own. Backfill 3 more so it has a proper bank, guarded by a specific question's text
  // (not a bare count) since the user may keep adding their own alongside these.
  {
    const promptCourse = db.prepare("SELECT id FROM courses WHERE title = 'prompt engineer'").get();
    const marker = 'Which of these is a best practice when writing a prompt for an LLM?';
    if (promptCourse && !db.prepare('SELECT 1 FROM course_questions WHERE course_id = ? AND question_text = ?').get(promptCourse.id, marker)) {
      const insQ = db.prepare('INSERT INTO course_questions (course_id, question_text, option_a, option_b, option_c, option_d, correct_option, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      insQ.run(promptCourse.id, marker, 'Being as vague as possible', 'Giving clear context, instructions and examples', 'Never specifying a format', 'Avoiding any constraints', 'B', 1);
      insQ.run(promptCourse.id, 'What is "few-shot prompting"?', 'Asking a very short question', 'Providing a few examples of the desired input/output in the prompt', 'Limiting the model to a few words', 'Using multiple different models', 'B', 2);
      insQ.run(promptCourse.id, 'Why is it useful to ask an LLM to "think step by step"?', 'It makes the response shorter', 'It encourages more structured, accurate reasoning before the final answer', 'It has no effect', 'It reduces token usage', 'B', 3);
    }
  }

  // Another real course the user created live via Create Course, with a pass_mark but no
  // questions yet — same gap as every prior course, fixed the same way.
  if (db.prepare('SELECT COUNT(*) AS c FROM course_questions WHERE course_id = (SELECT id FROM courses WHERE title = ?)').get('Python Full stack').c === 0) {
    const pyCourse = db.prepare("SELECT id FROM courses WHERE title = 'Python Full stack'").get();
    if (pyCourse) {
      const insQ = db.prepare('INSERT INTO course_questions (course_id, question_text, option_a, option_b, option_c, option_d, correct_option, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      insQ.run(pyCourse.id, 'Which keyword is used to define a function in Python?', 'func', 'def', 'function', 'lambda', 'B', 0);
      insQ.run(pyCourse.id, 'Which of these is a commonly used Python web framework for building full-stack applications?', 'Django', 'jQuery', 'Bootstrap', 'Photoshop', 'A', 1);
      insQ.run(pyCourse.id, 'In a typical full-stack app, what is the main role of the frontend?', 'Storing data permanently in the database', 'Rendering the user interface and handling user interaction', 'Managing server infrastructure', 'Compiling the database schema', 'B', 2);
      insQ.run(pyCourse.id, 'Which HTTP method is typically used to retrieve data from a REST API without changing anything on the server?', 'POST', 'DELETE', 'GET', 'PUT', 'C', 3);
    }
  }

  // Independent of the courses-seed block (which only runs once, ever) so this backfills
  // demo Skill Development & Competency Mapping / Progress-Attendance-Feedback data even on
  // a DB where courses already existed. Matches the "Skill Development & Competency Mapping —
  // Ragini" and "Progress, Attendance & Feedback — Ragini" prototype screens.
  if (db.prepare('SELECT COUNT(*) AS c FROM employee_skills').get().c === 0) {
    const ragini = db.prepare("SELECT id FROM employees WHERE name = 'Ragini'").get();
    if (ragini) {
      const insSkill = db.prepare('INSERT INTO employee_skills (employee_id, skill_name, current_level, required_level) VALUES (?, ?, ?, ?)');
      insSkill.run(ragini.id, 'System Design', 3, 4);
      insSkill.run(ragini.id, 'Cloud Architecture', 2, 4);
      insSkill.run(ragini.id, 'Mentoring', 3, 3);
    }
  }
  if (db.prepare('SELECT COUNT(*) AS c FROM learning_feedback').get().c === 0) {
    const ragini = db.prepare("SELECT id FROM employees WHERE name = 'Ragini'").get();
    if (ragini) {
      const insLf = db.prepare('INSERT INTO learning_feedback (employee_id, author_name, author_type, note, created_at) VALUES (?, ?, ?, ?, ?)');
      insLf.run(ragini.id, 'Keerthana', 'Manager', 'Strong technical delivery this quarter, great ownership on the reporting module.', '2026-07-02 10:00:00');
      insLf.run(ragini.id, 'Usha', 'Peer', 'Very responsive in cross-team requests, always helpful.', '2026-06-28 10:00:00');
      insLf.run(ragini.id, 'Ragini', 'Self', 'Feel confident about delivery pace, want more exposure to architecture decisions.', '2026-06-25 10:00:00');
    }
  }

  if (db.prepare('SELECT COUNT(*) AS c FROM assets').get().c === 0) {
    const emp1 = db.prepare("SELECT id FROM employees WHERE employee_code = 'EMP-001'").get()?.id || null;
    const emp3 = db.prepare("SELECT id FROM employees WHERE employee_code = 'EMP-003'").get()?.id || null;
    const insAsset = db.prepare('INSERT INTO assets (name, category, assigned_employee_id, status, cost) VALUES (?, ?, ?, ?, ?)');
    insAsset.run('Dell Latitude 5440', 'Laptop', emp1, emp1 ? 'Assigned' : 'In Store', 78000);
    insAsset.run('iPhone 14', 'Mobile', emp3, emp3 ? 'Assigned' : 'In Store', 65000);
    insAsset.run('HP LaserJet Pro', 'Printer', null, 'In Store', 22000);
    insAsset.run('Dell Latitude 5440', 'Laptop', null, 'Under Repair', 78000);
  }

  // Backfill the onboarding checklist for any new_hire row that doesn't have one yet (first run
  // after this migration, or a row created before it) ...
  const insOnTask = db.prepare('INSERT INTO onboarding_tasks (new_hire_id, task_name, sort_order) VALUES (?, ?, ?)');
  db.prepare('SELECT id FROM new_hires').all().forEach((h) => {
    if (db.prepare('SELECT COUNT(*) c FROM onboarding_tasks WHERE new_hire_id = ?').get(h.id).c > 0) return;
    ONBOARDING_TASK_DEFAULTS.forEach((t, i) => insOnTask.run(h.id, t, i));
  });

  // ... and re-sync every EXISTING checklist whenever ONBOARDING_TASK_DEFAULTS itself changes
  // (a renamed step, a newly added one like 'Assets assigned', or just a reordering) — otherwise
  // a new_hire row created before this migration is permanently stuck on the old names/order.
  // Renames preserve whatever was already checked under the old name.
  const ONBOARDING_TASK_RENAMES = { 'Meet reporting manager': 'Reporting manager assigned' };
  const defaultsSet = new Set(ONBOARDING_TASK_DEFAULTS);
  db.prepare('SELECT id, employee_id FROM new_hires').all().forEach((h) => {
    const existing = db.prepare('SELECT * FROM onboarding_tasks WHERE new_hire_id = ? ORDER BY sort_order').all(h.id);
    const inSync = existing.length === ONBOARDING_TASK_DEFAULTS.length
      && ONBOARDING_TASK_DEFAULTS.every((name, i) => existing[i]?.task_name === name);
    if (inSync) return;

    Object.entries(ONBOARDING_TASK_RENAMES).forEach(([oldName, newName]) => {
      db.prepare('UPDATE onboarding_tasks SET task_name = ? WHERE new_hire_id = ? AND task_name = ?').run(newName, h.id, oldName);
    });
    const haveNames = new Set(db.prepare('SELECT task_name FROM onboarding_tasks WHERE new_hire_id = ?').all(h.id).map((t) => t.task_name));
    ONBOARDING_TASK_DEFAULTS.forEach((name, i) => { if (!haveNames.has(name)) insOnTask.run(h.id, name, i); });
    const stale = [...haveNames].filter((n) => !defaultsSet.has(n));
    if (stale.length) {
      const placeholders = stale.map(() => '?').join(',');
      db.prepare(`DELETE FROM onboarding_tasks WHERE new_hire_id = ? AND task_name IN (${placeholders})`).run(h.id, ...stale);
    }
    const updSort = db.prepare('UPDATE onboarding_tasks SET sort_order = ? WHERE new_hire_id = ? AND task_name = ?');
    ONBOARDING_TASK_DEFAULTS.forEach((name, i) => updSort.run(i, h.id, name));

    // A newly-added task (e.g. 'Assets assigned') may already be true for a linked employee.
    if (h.employee_id && db.prepare('SELECT id FROM assets WHERE assigned_employee_id = ?').get(h.employee_id)) {
      db.prepare("UPDATE onboarding_tasks SET completed = 1 WHERE new_hire_id = ? AND task_name = 'Assets assigned' AND completed = 0").run(h.id);
    }

    const tasksNow = db.prepare('SELECT completed FROM onboarding_tasks WHERE new_hire_id = ?').all(h.id);
    const pct = tasksNow.length ? Math.round((tasksNow.filter((t) => t.completed).length / tasksNow.length) * 100) : 0;
    db.prepare("UPDATE new_hires SET onboarding_pct = ?, completed_at = CASE WHEN ? = 100 THEN COALESCE(completed_at, datetime('now')) ELSE NULL END WHERE id = ?").run(pct, pct, h.id);
  });
  const insOffTask = db.prepare('INSERT INTO offboarding_tasks (exit_id, task_name, sort_order) VALUES (?, ?, ?)');
  db.prepare('SELECT id FROM exits').all().forEach((x) => {
    if (db.prepare('SELECT COUNT(*) c FROM offboarding_tasks WHERE exit_id = ?').get(x.id).c > 0) return;
    OFFBOARDING_TASK_DEFAULTS.forEach((t, i) => insOffTask.run(x.id, t, i));
  });
  // Re-sync every EXISTING exit's checklist order whenever OFFBOARDING_TASK_DEFAULTS itself gets
  // reordered — same fix as onboarding's sync above, just simpler since no task was renamed or
  // added here, only reordered.
  const offboardingUpdSort = db.prepare('UPDATE offboarding_tasks SET sort_order = ? WHERE exit_id = ? AND task_name = ?');
  db.prepare('SELECT id FROM exits').all().forEach((x) => {
    const existing = db.prepare('SELECT * FROM offboarding_tasks WHERE exit_id = ? ORDER BY sort_order').all(x.id);
    const inSync = existing.length === OFFBOARDING_TASK_DEFAULTS.length
      && OFFBOARDING_TASK_DEFAULTS.every((name, i) => existing[i]?.task_name === name);
    if (inSync) return;
    OFFBOARDING_TASK_DEFAULTS.forEach((name, i) => offboardingUpdSort.run(i, x.id, name));
  });

  // --- Helpdesk / Grievance Ticketing demo data. ---
  if (db.prepare('SELECT COUNT(*) AS c FROM tickets').get().c === 0) {
    const arjun = db.prepare("SELECT id FROM employees WHERE employee_code = 'EMP-002'").get();
    const fernandes = db.prepare("SELECT id FROM employees WHERE employee_code = 'EMP-003'").get();
    if (arjun) {
      const t1 = db.prepare("INSERT INTO tickets (employee_id, category, priority, subject, description, status, resolved_at) VALUES (?, 'IT', 'High', 'Laptop battery draining fast', 'Battery drops from 100% to 20% within an hour of unplugging.', 'Resolved', datetime('now'))").run(arjun.id).lastInsertRowid;
      db.prepare('INSERT INTO ticket_comments (ticket_id, author_name, comment) VALUES (?, ?, ?)').run(t1, 'IT Support', 'Replaced the battery — please confirm it is holding charge normally now.');
      db.prepare('INSERT INTO ticket_comments (ticket_id, author_name, comment) VALUES (?, ?, ?)').run(t1, 'Arjun Employee', 'Confirmed, working fine now. Thank you!');
    }
    if (fernandes) {
      db.prepare("INSERT INTO tickets (employee_id, category, priority, subject, description, status) VALUES (?, 'HR', 'Medium', 'Query about shift allowance', 'Could someone clarify how the night-shift allowance is calculated on the payslip?', 'Open')").run(fernandes.id);
    }
  }
  // Independent of the tickets-seed block above so this still backfills the newer
  // Facilities/Payroll categories and Critical priority even on a DB that already had the
  // original 2 tickets seeded.
  if (!db.prepare("SELECT 1 FROM tickets WHERE subject = 'AC not working on 3rd floor'").get()) {
    const pnair = db.prepare("SELECT id FROM employees WHERE employee_code = 'EMP-005'").get();
    if (pnair) db.prepare("INSERT INTO tickets (employee_id, category, priority, subject, description, status) VALUES (?, 'Facilities', 'Low', 'AC not working on 3rd floor', 'The air conditioning on the 3rd floor has not been cooling since yesterday.', 'Open')").run(pnair.id);
  }
  if (!db.prepare("SELECT 1 FROM tickets WHERE subject = 'Salary not credited this month'").get()) {
    const kmenon = db.prepare("SELECT id FROM employees WHERE employee_code = 'EMP-006'").get();
    if (kmenon) db.prepare("INSERT INTO tickets (employee_id, category, priority, subject, description, status, resolved_at, requester_confirmed) VALUES (?, 'Payroll', 'Critical', 'Salary not credited this month', 'My salary for this month has not been credited yet — please check urgently.', 'Resolved', datetime('now'), 1)").run(kmenon.id);
  }
  // Backfill sla_deadline for any ticket that doesn't have one yet (pre-existing rows, or
  // rows seeded before this column existed) — High: 4h, Medium: 24h, Low: 72h, Critical: 1h.
  {
    const SLA_HOURS = { Critical: 1, High: 4, Medium: 24, Low: 72 };
    db.prepare('SELECT id, priority, created_at FROM tickets WHERE sla_deadline IS NULL').all().forEach((t) => {
      db.prepare("UPDATE tickets SET sla_deadline = datetime(?, '+' || ? || ' hours') WHERE id = ?").run(t.created_at, SLA_HOURS[t.priority] || 24, t.id);
    });
  }

  // --- Knowledge Base demo articles. ---
  if (db.prepare('SELECT COUNT(*) AS c FROM kb_articles').get().c === 0) {
    const insKb = db.prepare('INSERT INTO kb_articles (title, body, category, created_by) VALUES (?, ?, ?, ?)');
    insKb.run('How to reset your laptop password', 'Go to Settings > Accounts > Sign-in options > Reset password, and follow the prompts. If you are locked out entirely, raise an IT ticket.', 'IT', 'IT Support');
    insKb.run('Understanding your payslip components', 'Your payslip breaks pay into Basic, HRA, allowances and deductions. See the Payroll module for a full component-wise breakdown of your latest payslip.', 'Payroll', 'HR Admin');
    insKb.run('How to raise a regularization request', 'Go to Attendance > Regularize, pick the date and reason, and submit — it follows the same approval chain as leave requests.', 'HR', 'HR Admin');
  }

  // --- Auto Routing & Email Notifications: a starter rule so new IT tickets auto-assign. ---
  if (db.prepare('SELECT COUNT(*) AS c FROM ticket_routing').get().c === 0) {
    const fernandes = db.prepare("SELECT id FROM employees WHERE employee_code = 'EMP-003'").get();
    if (fernandes) db.prepare('INSERT INTO ticket_routing (category, assigned_to_employee_id) VALUES (?, ?)').run('IT', fernandes.id);
  }

  // --- Announcements / Company Notice Board demo data. ---
  if (db.prepare('SELECT COUNT(*) AS c FROM announcements').get().c === 0) {
    const insAnn = db.prepare('INSERT INTO announcements (title, body, category, posted_by, pinned, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    insAnn.run('Revised Work-From-Home Policy', 'Effective next month, WFH requests must be submitted at least 2 working days in advance via your reporting manager.', 'Policy', 'HR Admin', 1, '2026-07-20 09:00:00');
    insAnn.run('Team Outing — August 15th', 'Join us for the annual team outing! Details and RSVP link will follow shortly.', 'Event', 'HR Admin', 0, '2026-07-22 11:00:00');
    insAnn.run('Office Closed — Independence Day', 'The office will remain closed on August 15th for the public holiday.', 'Holiday', 'Super Admin', 0, '2026-07-24 10:00:00');
  }

  // --- Expense & Travel Claims demo data. ---
  if (db.prepare('SELECT COUNT(*) AS c FROM expense_claims').get().c === 0) {
    const arjun = db.prepare("SELECT id FROM employees WHERE employee_code = 'EMP-002'").get();
    const priya = db.prepare("SELECT id FROM employees WHERE employee_code = 'EMP-001'").get();
    const bottomRoleId = db.prepare("SELECT id FROM roles WHERE key != 'employee' AND paused = 0 ORDER BY sort_order DESC LIMIT 1").get()?.id || null;
    if (arjun) {
      db.prepare("INSERT INTO expense_claims (employee_id, category, amount, description, status, current_stage_role_id) VALUES (?, 'Travel', 850, 'Cab fare for client site visit', 'Pending', ?)").run(arjun.id, bottomRoleId);
    }
    if (priya) {
      db.prepare("INSERT INTO expense_claims (employee_id, category, amount, description, status, decided_at, reimbursed_at) VALUES (?, 'Accommodation', 4200, 'Hotel stay — Bangalore offsite', 'Reimbursed', datetime('now'), datetime('now'))").run(priya.id);
    }
  }

  // --- Employee Engagement Surveys demo data: one active survey with a couple of responses. ---
  if (db.prepare('SELECT COUNT(*) AS c FROM surveys').get().c === 0) {
    const surveyId = db.prepare("INSERT INTO surveys (title, description, status) VALUES ('Quarterly Pulse Check', 'A quick check-in on how the team is feeling this quarter.', 'Active')").run().lastInsertRowid;
    const q1 = db.prepare('INSERT INTO survey_questions (survey_id, question_text, sort_order) VALUES (?, ?, 0)').run(surveyId, 'I feel valued for the work I do').lastInsertRowid;
    const q2 = db.prepare('INSERT INTO survey_questions (survey_id, question_text, sort_order) VALUES (?, ?, 1)').run(surveyId, 'My manager gives me useful feedback').lastInsertRowid;
    const q3 = db.prepare('INSERT INTO survey_questions (survey_id, question_text, sort_order) VALUES (?, ?, 2)').run(surveyId, 'I have a healthy work-life balance').lastInsertRowid;
    const fernandes = db.prepare("SELECT id FROM employees WHERE employee_code = 'EMP-003'").get();
    if (fernandes) {
      const respId = db.prepare('INSERT INTO survey_responses (survey_id, employee_id, comment) VALUES (?, ?, ?)').run(surveyId, fernandes.id, 'Overall a good quarter, would like more recognition for cross-team work.').lastInsertRowid;
      const insAns = db.prepare('INSERT INTO survey_answers (response_id, question_id, rating) VALUES (?, ?, ?)');
      insAns.run(respId, q1, 4); insAns.run(respId, q2, 4); insAns.run(respId, q3, 3);
    }
  }

  // --- Document Management demo data: one mandatory policy with a partial acknowledgment. ---
  if (db.prepare('SELECT COUNT(*) AS c FROM company_documents').get().c === 0) {
    const docId = db.prepare("INSERT INTO company_documents (title, category, file_data_url, mandatory, uploaded_by) VALUES ('Employee Code of Conduct', 'Policy', 'data:text/plain;base64,RW1wbG95ZWUgQ29kZSBvZiBDb25kdWN0IC0gcGxhY2Vob2xkZXIgZG9jdW1lbnQu', 1, 'HR Admin')").run().lastInsertRowid;
    const arjun = db.prepare("SELECT id FROM employees WHERE employee_code = 'EMP-002'").get();
    if (arjun) db.prepare('INSERT INTO document_acknowledgments (document_id, employee_id) VALUES (?, ?)').run(docId, arjun.id);
  }

  // --- Shift & Roster demo data: 3 standard shifts + a week of assignments for real employees. ---
  if (db.prepare('SELECT COUNT(*) AS c FROM shifts').get().c === 0) {
    const insShift = db.prepare('INSERT INTO shifts (name, start_time, end_time) VALUES (?, ?, ?)');
    const morning = insShift.run('Morning', '09:00', '18:00').lastInsertRowid;
    insShift.run('Evening', '14:00', '23:00');
    insShift.run('Night', '22:00', '07:00');
    const arjun = db.prepare("SELECT id FROM employees WHERE employee_code = 'EMP-002'").get();
    const priya = db.prepare("SELECT id FROM employees WHERE employee_code = 'EMP-001'").get();
    const insRoster = db.prepare('INSERT INTO roster_assignments (employee_id, shift_id, date) VALUES (?, ?, ?)');
    if (arjun) insRoster.run(arjun.id, morning, '2026-07-27');
    if (priya) insRoster.run(priya.id, morning, '2026-07-27');
  }

  // --- Rewards & Recognition demo data. ---
  if (db.prepare('SELECT COUNT(*) AS c FROM recognitions').get().c === 0) {
    const arjun = db.prepare("SELECT id FROM employees WHERE employee_code = 'EMP-002'").get();
    const priya = db.prepare("SELECT id FROM employees WHERE employee_code = 'EMP-001'").get();
    if (arjun && priya) {
      db.prepare('INSERT INTO recognitions (from_employee_id, to_employee_id, award_type, message, points, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(priya.id, arjun.id, 'Spot Award', 'Jumped in over the weekend to fix the client-facing reporting bug before Monday.', 15, '2026-07-20 09:00:00');
    }
  }

  // --- Project & Resource Management demo data. ---
  if (db.prepare('SELECT COUNT(*) AS c FROM projects').get().c === 0) {
    const projId = db.prepare("INSERT INTO projects (name, description, start_date) VALUES ('Client Reporting Revamp', 'Rebuild the client-facing analytics dashboard.', '2026-07-01')").run().lastInsertRowid;
    const arjun = db.prepare("SELECT id FROM employees WHERE employee_code = 'EMP-002'").get();
    if (arjun) db.prepare('INSERT INTO project_assignments (project_id, employee_id, allocation_pct, role_on_project) VALUES (?, ?, ?, ?)').run(projId, arjun.id, 60, 'Developer');
  }

  // --- Timesheet demo data (needs the project seeded just above). ---
  if (db.prepare('SELECT COUNT(*) AS c FROM timesheet_entries').get().c === 0) {
    const arjun = db.prepare("SELECT id FROM employees WHERE employee_code = 'EMP-002'").get();
    const proj = db.prepare('SELECT id FROM projects LIMIT 1').get();
    if (arjun && proj) {
      db.prepare("INSERT INTO timesheet_entries (employee_id, project_id, date, task_description, hours, status) VALUES (?, ?, '2026-07-24', 'Built the new chart export endpoint', 6, 'Approved')").run(arjun.id, proj.id);
      db.prepare("INSERT INTO timesheet_entries (employee_id, project_id, date, task_description, hours, status) VALUES (?, ?, '2026-07-25', 'Code review + bug fixes', 5, 'Pending')").run(arjun.id, proj.id);
    }
  }

  // --- Disciplinary Action Tracking: no demo case seeded on purpose — this is sensitive,
  // real HR data and should only ever contain genuine cases HR raises themselves. ---
}

// Company-specified onboarding sequence. 'Documents submitted', 'Reporting manager assigned',
// and 'Assets assigned' auto-check themselves from real actions in Documents/Employees/Assets
// (see server/src/utils/onboarding.js) — HR can still tick any of them manually as a fallback.
export const ONBOARDING_TASK_DEFAULTS = [
  'Orientation session completed', 'Documents submitted', 'Offer letter signed', 'Reporting manager assigned', 'IT & workstation setup', 'Assets assigned'
];
// Company-specified offboarding sequence. 'Return IT assets' auto-checks itself when the asset
// actually gets returned in Asset Management (see server/src/utils/offboarding.js) — HR can
// still tick it manually as a fallback. The other three have no existing system of record in
// this app to hook into (no knowledge-transfer log, no finance-clearance tracker, no exit-
// interview scheduler), so they stay manual checkboxes for now.
export const OFFBOARDING_TASK_DEFAULTS = [
  'Knowledge transfer completed', 'Finance clearance (dues/loans)', 'HR exit interview', 'Return IT assets'
];

migrate();
seedModuleData();

export default db;
