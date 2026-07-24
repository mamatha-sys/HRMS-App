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
    role TEXT NOT NULL CHECK (role IN ('super_admin','manager','employee')),
    face_descriptor TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS departments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    parent_department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS branches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    location TEXT
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

  CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    phone TEXT,
    photo TEXT,
    date_of_birth TEXT,
    emergency_contact_name TEXT,
    emergency_contact_relation TEXT,
    emergency_contact_number TEXT,
    department TEXT NOT NULL,
    branch TEXT,
    designation TEXT NOT NULL,
    date_of_joining TEXT NOT NULL,
    reporting_manager TEXT,
    status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Inactive')),
    bank_name TEXT,
    bank_account_number TEXT,
    ifsc_code TEXT,
    aadhaar_number TEXT,
    pan_number TEXT,
    education TEXT,
    experience TEXT,
    skills TEXT,
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
      department: 'Sales', branch: 'Chennai', designation: 'Sales Executive', date_of_joining: '2020-11-20', reporting_manager: 'P. Nair', status: 'Inactive' },
    { ...base, employee_code: 'EMP-005', name: 'P. Nair', email: 'p.nair@hrms.com', phone: '9000000005',
      department: 'Sales', branch: 'Chennai', designation: 'Sales Manager', date_of_joining: '2019-08-05', reporting_manager: 'Super Admin', status: 'Active' },
    { ...base, employee_code: 'EMP-006', name: 'K. Menon', email: 'k.menon@hrms.com', phone: '9000000006',
      department: 'QA', branch: 'Bengaluru', designation: 'QA Lead', date_of_joining: '2021-09-17', reporting_manager: 'Super Admin', status: 'Active' }
  ];
  rows.forEach((r) => insertEmployee.run(r));

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

  void adminId;
}

seed();

export default db;
