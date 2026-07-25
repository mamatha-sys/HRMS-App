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
  `);
  const lt = db.prepare('PRAGMA table_info(leave_types)').all().map((c) => c.name);
  if (!lt.includes('active')) db.exec('ALTER TABLE leave_types ADD COLUMN active INTEGER NOT NULL DEFAULT 1');

  const lv = db.prepare('PRAGMA table_info(leaves)').all().map((c) => c.name);
  if (!lv.includes('current_stage_role_id')) db.exec('ALTER TABLE leaves ADD COLUMN current_stage_role_id INTEGER REFERENCES roles(id)');
  if (!lv.includes('cancel_requested')) db.exec('ALTER TABLE leaves ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0');
  if (!lv.includes('cancelled')) db.exec('ALTER TABLE leaves ADD COLUMN cancelled INTEGER NOT NULL DEFAULT 0');

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
      type TEXT NOT NULL CHECK (type IN ('earning','deduction')),
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS employee_salary_lines (
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      component_id INTEGER NOT NULL REFERENCES salary_components(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (employee_id, component_id)
    );
  `);
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
}

migrate();
seedModuleData();

export default db;
