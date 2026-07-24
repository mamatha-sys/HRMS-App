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

## Modules

- **Dashboard** — role-scoped KPIs, a department-distribution donut chart, and live Alerts & Notifications / Calendar & Upcoming Events / Pending Tasks & Reminders widgets.
- **Employee Management** — full employee records (personal, emergency contact, employment, bank/identity documents, education) with an expandable detail view. Bank/Aadhaar/PAN fields are masked for managers viewing other employees' records, per the configurable rules in Manage Permissions. Department/branch are selected from real master data, not free text.
- **Recruitment** — department-wise vacancies computed live from current headcount vs. open positions, with progress bars.
- **Reports** — headcount summary by department/status and a CSV export of the employee list.
- **Organization Structure** *(Super Admin)* — manage departments (with hierarchy) and branches.
- **Manage Permissions** *(Super Admin)* — per-role (Manager/Employee), per-field access control (Hidden/View/Edit) for sensitive employee fields — changes apply immediately.
- **Role & User Management** *(Super Admin)* — change a user's role or deactivate their account.
- **Manage Modules & Features** *(Super Admin)* — add a custom module and features on the fly; each appears immediately in the sidebar for every user as a generic record-list screen (status cycles Open → In Progress → Closed on click). This mirrors the metadata-driven approach from `HRMS_Prototype.html`, now backed by a real database instead of in-memory JS state.

## Role model

Three fixed roles: `super_admin`, `manager`, `employee`. Super Admin always has full access. Managers see all employees (masked per Manage Permissions) and can manage most modules; Employees see only their own employee record and their own tasks/notifications.

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
