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

- **Dashboard** — role-scoped. KPI cards (Total Employees, Present Today, Absent Today, Payroll Status), Employee/Organization Growth line chart, New Hires bar chart, Department Strength bar chart, and numbered widgets: Pending Approvals (with Approve/Reject), Tasks, Alerts & Notifications, Calendar & Events, Quick Actions, Department-wise Vacancies, and a Role & User summary. A department/branch/status filter bar re-computes the KPIs and charts. Which widgets appear is controlled by **Configurations**.
- **Employee Management** — full employee records (personal, emergency contact, employment, bank/identity documents, education) with an expandable detail view. Bank/Aadhaar/PAN fields are masked for managers viewing other employees' records. Department/branch are selected from real master data.

### Admin (Super Admin only)

- **Configurations** — customize the Dashboard: toggle which cards/charts/widgets are shown. Persisted server-side; applies to everyone's dashboard.
- **Manage Roles** — a full **Role Catalog → Edit Access → Configure** flow:
  - **Role Catalog** — 7 roles (Super Admin, HR Admin, Manager, Assistant Manager, Senior Team Lead, Team Lead, Employee) each with a data-scope description; **+ Create Role** adds new ones.
  - **Edit Access** — per role, a data-scope banner plus the module list (Dashboard Management, Employee Management, Organization, Recruitment, Onboarding, Attendance, Leave, Payroll, PMS, LMS, Asset Management).
  - **Configure** — a feature × action permission matrix: each feature (grouped by category) has checkboxes for the 12 actions (View, Create, Edit, Delete, Approve, Reject, Assign, Import, Export, Download, Print, Manage). Toggles persist immediately. Super Admin's matrix is read-only (always full access).

Other screens (Recruitment, Reports, Organization Structure, Role & User Management, Manage Modules) remain available at their routes but were removed from the sidebar to keep it focused on Dashboard + Employee Management as requested.

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
