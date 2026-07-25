# HRMS-App

A full-stack HR Management System — React (Vite) frontend, Node/Express backend, SQLite database. Built as a working implementation of the `HRMS_Prototype.html` / `HRMS_Multi_Module.html` designs in this repo.

## Stack

- **Backend**: Node.js, Express, better-sqlite3, JWT auth, bcrypt
- **Frontend**: React 18, Vite, React Router, axios
- **Face verification**: [@vladmandic/face-api](https://github.com/vladmandic/face-api) (TensorFlow.js in the browser)

## Setup

```bash
cd server && npm install && cp .env.example .env && npm run dev
```

```bash
cd client && npm install && npm run dev
```

Open http://localhost:5173. The backend runs on http://localhost:4000 and Vite proxies `/api` to it.

The SQLite database (`server/data/hrms.db`) is created and seeded automatically on first run — it's gitignored, so each clone starts fresh.

## Demo accounts

| Role | Email | Password |
|---|---|---|
| Super Admin | admin@hrms.com | Admin@123 |
| Manager | manager@hrms.com | Manager@123 |
| Employee | employee@hrms.com | Employee@123 |

## Login & face verification

Login requires email + password **and** a webcam face capture:

- **First successful login** for an account auto-enrolls the captured face as that account's reference (no separate enrollment step).
- **Every login after that** is rejected if the captured face doesn't match the enrolled one (Euclidean distance over a 128-point face descriptor, threshold 0.6 — the standard face-api.js recommendation).
- Deactivated accounts (see Role & User Management) are blocked before the face check even runs.

**This is a demo-grade feature, not hardened biometric security** — there's no liveness detection, so a photo or video of the enrolled user's face could potentially pass. The face descriptor comparison happens server-side (the client only extracts and sends the numeric descriptor), which prevents casual client-side bypass, but this should not be treated as production-grade auth without additional anti-spoofing work.

## Modules (sidebar)

- **Dashboard** — role-scoped. KPI cards (Total Employees, Active / Inactive, New Hires (90d), Open Positions, Present Today, Absent Today, Pending Approvals, Payroll Status), Employee/Organization Growth line chart, New Hires bar chart, Department Strength bar chart, and numbered widgets: Pending Approvals (with Approve/Reject), Tasks, Alerts & Notifications, Calendar & Events, Quick Actions, Department-wise Vacancies, and a Role & User summary. A department/branch/status filter bar re-computes the KPIs and charts. Which widgets appear is controlled by **Configurations**.
- **Employee Management** — its own KPI cards (Total Employees, Active, On Probation, Exited), quick-action links (Bulk Import, Add Departments, Add Branch, Configuration Policies), and a **5-stage onboarding workflow** per record:
  1. **HR creates a draft** — Employee ID + Name + Department + Designation.
  2. **HR assigns** the draft to an employee-role user so they can fill it in.
  3. **Employee fills** their own details (photo, address — street/city/state/country/pincode, emergency contact, bank, education, documents) and **Submits**. Employees can't change their department/designation/status.
  4. **HR reviews** and **Approves** (the profile **locks**) or **Rejects** (back to the employee).
  5. Once locked, nobody can edit until the **employee raises an edit request** and **HR approves** it, which unlocks the profile for re-filling → back to step 3/4.

  Each record shows a Stage badge (Draft / Assigned / Submitted / Locked). The **Documents** section takes any number of files each with an **editable label name**. Bank fields are masked for managers viewing others' records. Status is Active / On Probation / Exited.

- **Attendance** — scope banner, department/date filter bar + Export (CSV), KPI row (Present/Absent/Late Check-in/Missing Punch-in). Three tabs:
  - **Dashboard** — Biometric Reports (checked-in/out totals by method: Web/Mobile/Biometric/Face), Regularization Requests (Approve/Reject via the shared approvals queue), Quick Actions (daily marking grid, Configure Policies).
  - **Biometric Attendance List** — every employee's last check-in method/time/GPS location plus this-month present & late counts.
  - **Reports (Monthly)** — a month picker showing present/absent/leave/late counts and attendance % per employee, with CSV export.

  Employee check-in optionally captures **GPS location** (browser geolocation, graceful fallback if denied/unsupported) alongside a selectable method (Web/Mobile/Biometric/Face); locations are shown as map links to both the employee and HR. 30-day history includes a Regularize button.

- **Leave Management** — scope banner, filters + Export, KPI row (Pending/Approved MTD/Rejected MTD/On Leave Today/Cancellation Requests). Two tabs:
  - **Dashboard** — **Leave Approval Chain**: a real sequential multi-stage workflow (not just a label) derived live from the Organization Structure role order — e.g. TL → STL → Assistant Manager → Manager → HR Admin → Super Admin. Each pending request shows a **visual stepper** of its progress. A role can act once its authority is at least as senior as the request's current stage; acting fast-forwards the chain to the next role above the actor (skip-level approval), finalizing when it reaches the top. Super Admin always finalizes immediately. **Leave Types & Policy** now has **Edit** and **Pause/Resume** per type (paused types can't be applied for). **Employees on Leave — Department Wise**, plus a **Cancellation Requests** panel for employee-raised cancel requests on already-approved leave (approving restores the balance and logs it).
  - **Reports** — Leave Balances table (all employees) and full Leave Balance History (every credit/debit with reason and running balance), with CSV export.

  Employees see their balance, a **balance history** view, apply for leave (days auto-computed, blocked over balance or if the type is paused), track requests with the same visual stepper, and can **request cancellation** of an approved leave.

- **Payroll** — scope banner, filters + Export, KPI row (Payroll Cycle/Employees Processed/F&F Requests). Two tabs:
  - **Dashboard** — a fully dynamic **Salary Structure** breakdown (Earnings → Gross; Deductions → Total Deductions; Net Pay) built from a configurable **salary component catalog** — HR can **+ Add salary component** (any new earning or deduction) which is instantly provisioned across every employee at ₹0, and pause/resume any component (paused ones drop out of every breakdown and net calculation). The per-employee structures table gains one column per active component. Running payroll buckets components into basic/HRA/allowances/deductions per payslip (idempotent per period).
  - **Reports** — payroll totals by period and by department (all-time), with CSV export.

  Employees see their own dynamic breakdown and download payslips.

Role access is strictly layered: **Super Admin has full, unrestricted access everywhere** (every module, every admin screen, read-only-safe on its own role); **HR Admin** and **Manager/Assistant Manager** get the operational HR screens (Attendance/Leave/Payroll/Employee Management) but are blocked from Super-Admin-only configuration (Manage Roles, Configurations, adding Leave Types) — verified via direct API checks.

### Admin (Super Admin only)

- **Configurations** — customize the Dashboard: toggle which cards/charts/widgets are shown. Persisted server-side; applies to everyone's dashboard.
- **Manage Roles** — a full **Role Catalog → Edit Access → Configure** flow:
  - **Role Catalog** — 7 roles (Super Admin, HR Admin, Manager, Assistant Manager, Senior Team Lead, Team Lead, Employee) each with a data-scope description; **+ Create Role** adds new ones.
  - **Edit Access** — per role, a data-scope banner plus the module list (Dashboard Management, Employee Management, Organization, Recruitment, Onboarding, Attendance, Leave, Payroll, PMS, LMS, Asset Management).
  - **Configure** — a feature × action permission matrix: each feature (grouped by category) has checkboxes for the 12 actions (View, Create, Edit, Delete, Approve, Reject, Assign, Import, Export, Download, Print, Manage). Toggles persist immediately. Super Admin's matrix is read-only (always full access).

Admin screens (in the sidebar for Super Admin, plus reachable from dashboard Quick Actions):
- **Configurations** — toggle which dashboard widgets are visible.
- **Configuration Policies** — Business Policies, Custom Rules, and Configuration Settings, each add/edit/remove.
- **Manage Roles** — the role catalog → edit access → feature × action permission matrix.
- **Organization Structure** — the office hierarchy and **approval/escalation workflow** (Super Admin → HR Admin → Manager → Assistant Manager → STL → TL → Employee). Leave/attendance/alert/issue requests flow top-to-bottom through this chain. **Drag** a role to reorder the workflow; **Add Role**, **Edit**, and **Pause** are supported — roles are never deleted. Super Admin can't be paused.

Other screens (reachable from Quick Actions):
- **Bulk Import** — paste or upload a CSV of employees; choose a department scope (all, or force one department) and a default joining month/year; rows are inserted with per-row overrides, duplicates skipped, errors reported.
- **Add Departments / Add Branch** (Organization) — departments and branches with created-date history and Edit / Pause (paused entries stay on record).
- **Manage Modules & Features** — lists built-in/previous modules, and lets you add custom modules with **Edit / Pause** and an **+ Add features** button per module.
- **Role & User Management** — list users, change roles, deactivate/reactivate, reset a user's enrolled face, and **+ Add user**.
- Recruitment, Reports.

## Role model & enforcement

Roles are a real database table (7 seeded roles, extensible via **+ Create Role**). Login accepts any role key. **Enforced today:** Super Admin = full access; the Employee Management field masking; approve/reject gated to decider roles; module/admin route guards. The granular feature×action matrix in **Manage Roles** is fully persisted, editable configuration — the two live modules (Dashboard, Employee Management) are wired to it where meaningful, while the catalog modules that don't yet have their own screens (Payroll, LMS, etc.) store their grants as configuration for when those modules are built.

## Attendance & payroll data

The new dashboard KPIs are backed by real tables: `attendance` (today's Present/Absent per employee, seeded on first run) and `payroll_runs` (current payroll status). These are demo-seeded — there's no attendance-capture or payroll-processing UI yet.

## Project structure

```
server/
  src/
    db.js              # schema + seed data
    routes/            # one file per resource
    middleware/         # JWT auth + role guard
client/
  src/
    pages/             # one file per screen
    components/         # Sidebar, Topbar, widgets, DonutChart, FaceCapture helpers
    faceApi.js          # face-api.js model loading + descriptor extraction
```
