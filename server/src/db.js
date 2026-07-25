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

  // Half_day_flag marks a late check-in beyond the month's free-late allowance (company rule:
  // 2 free late arrivals/month, configurable via the "Free late arrivals per month" policy).
  const attCols = db.prepare('PRAGMA table_info(attendance)').all().map((c) => c.name);
  if (!attCols.includes('half_day_flag')) db.exec('ALTER TABLE attendance ADD COLUMN half_day_flag INTEGER NOT NULL DEFAULT 0');

  const payCols = db.prepare('PRAGMA table_info(payslips)').all().map((c) => c.name);
  if (!payCols.includes('late_deduction')) db.exec('ALTER TABLE payslips ADD COLUMN late_deduction INTEGER NOT NULL DEFAULT 0');

  if (!db.prepare("SELECT 1 FROM policies WHERE name = 'Free late arrivals per month'").get()) {
    db.prepare("INSERT INTO policies (category, name, value) VALUES ('rule', 'Free late arrivals per month', '2')").run();
  }

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

    CREATE TABLE IF NOT EXISTS employee_leave_balances (
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      leave_type_id INTEGER NOT NULL REFERENCES leave_types(id) ON DELETE CASCADE,
      balance INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (employee_id, leave_type_id)
    );
  `);

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
  migrateCandidatesTable();

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

  db.exec(`
    CREATE TABLE IF NOT EXISTS course_materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      file_type TEXT NOT NULL CHECK (file_type IN ('pdf','video','other')),
      data_url TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // --- Asset Management Key Features: pause/resume (retire without deleting), warranty,
  // a barcode-style tracking tag, a full action history log, a Disposed status, and a
  // Pending-Approval gate for assets added by non-final-authority roles.
  migrateAssetsTable();

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
  `);

  migrateLeavesTable();
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
    const insCand = db.prepare('INSERT INTO candidates (name, position_id, panel, feedback_status, stage) VALUES (?, ?, ?, ?, ?)');
    insCand.run('A. Verma', posByTitle('Senior Backend Engineer'), 'Usha, Vasavi', 'No feedback yet', 'Technical Interview');
    insCand.run('J. Thomas', posByTitle('Senior Backend Engineer'), null, 'No feedback yet', 'Resume Screening');
    insCand.run('M. Khan', posByTitle('Automation QA Engineer'), 'Ragini', 'Feedback submitted', 'Offer');
    insCand.run('S. Rao', posByTitle('Sales Executive'), 'Bhavana', 'Feedback submitted', 'HR Interview');
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

  // Backfill the onboarding/offboarding checklist for any new_hire/exit row that doesn't
  // have one yet (first run after this migration, or a row created before it).
  const insOnTask = db.prepare('INSERT INTO onboarding_tasks (new_hire_id, task_name, sort_order) VALUES (?, ?, ?)');
  db.prepare('SELECT id FROM new_hires').all().forEach((h) => {
    if (db.prepare('SELECT COUNT(*) c FROM onboarding_tasks WHERE new_hire_id = ?').get(h.id).c > 0) return;
    ONBOARDING_TASK_DEFAULTS.forEach((t, i) => insOnTask.run(h.id, t, i));
  });
  const insOffTask = db.prepare('INSERT INTO offboarding_tasks (exit_id, task_name, sort_order) VALUES (?, ?, ?)');
  db.prepare('SELECT id FROM exits').all().forEach((x) => {
    if (db.prepare('SELECT COUNT(*) c FROM offboarding_tasks WHERE exit_id = ?').get(x.id).c > 0) return;
    OFFBOARDING_TASK_DEFAULTS.forEach((t, i) => insOffTask.run(x.id, t, i));
  });
}

export const ONBOARDING_TASK_DEFAULTS = [
  'Offer letter signed', 'IT & workstation setup', 'Orientation session completed', 'Documents submitted', 'Meet reporting manager'
];
export const OFFBOARDING_TASK_DEFAULTS = [
  'Return IT assets', 'Knowledge transfer completed', 'Finance clearance (dues/loans)', 'HR exit interview'
];

migrate();
seedModuleData();

export default db;
