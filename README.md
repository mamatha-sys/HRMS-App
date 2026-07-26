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

  Each record shows a Stage badge (Draft / Assigned / Submitted / Locked). The **Documents** section takes any number of files each with an **editable label name**. Bank fields are masked for managers viewing others' records. Status is Active / On Probation / Exited. HR also assigns a **Shift** (currently one option: General, 9:00 AM – 6:00 PM).

- **Attendance** — scope banner, department/date filter bar + Export (CSV), KPI row (Present/Absent/Late Check-in/**Half-day Cut**/Missing Punch-in). Three tabs:
  - **Dashboard** — Biometric Reports (checked-in/out totals by method: Web/Mobile/Biometric/Face), Regularization Requests routed through the same **sequential approval chain** as Leave (visual stepper, Approve/Reject), Quick Actions (daily marking grid, Configure Policies).
  - **Biometric Attendance List** — every employee's last check-in method/time/GPS location plus this-month present, late & half-day-cut counts.
  - **Reports (Monthly)** — a month picker showing present/absent/leave/late/half-day-cut counts and attendance % per employee, with CSV export.

  Employee check-in optionally captures **GPS location** (browser geolocation, graceful fallback if denied/unsupported) alongside a selectable method (Web/Mobile/Biometric/Face); locations are shown as map links to both the employee and HR. 30-day history includes a Regularize button, and a **My Regularization Requests** card shows the employee's own past requests with the same visual chain stepper HR sees, so they can track approval progress instead of just fire-and-forgetting the request.

  **Company rule — late arrivals:** the General shift is 9:00 AM – 6:00 PM with a grace period until **9:15 AM**. Checking in after 9:15 marks the day Late. Each employee gets a configurable number of free late arrivals per month (default **2**, editable via **Configuration Policies** → "Free late arrivals per month"); every late day beyond that is flagged (`½-day cut` badge, visible on the daily grid, biometric list and monthly report) and automatically deducted as **half a day's pay** the next time payroll is run for that month.

- **Leave Management** — scope banner, filters + Export, KPI row (Pending/Approved MTD/Rejected MTD/On Leave Today/Cancellation Requests). Two tabs:
  - **Dashboard** — **Leave Approval Chain**: a real sequential multi-stage workflow (not just a label), shared with Attendance Regularization, derived live from the Organization Structure role order — e.g. TL → STL → Assistant Manager → Manager → HR Admin → Super Admin. Each pending request shows a **visual stepper** of its progress. A role can act once its authority is at least as senior as the request's current stage; acting fast-forwards the chain to the next role above the actor (skip-level approval), finalizing when it reaches the top. Super Admin always finalizes immediately. **A role can optionally have a maximum approvable leave duration** (e.g. Team Lead is seeded to 2 days) — set per role in **Organization Structure**; a request longer than that role's limit is rejected with a message to escalate to a more senior approver, who can then approve it directly (skip-level). **Leave Types & Policy** — Super Admin can **Add** a type as **Paid or Unpaid** (unpaid types have no quota and skip balance checks entirely, e.g. Sick Leave/Loss of Pay), **Edit** name/quota/paid-status, and **Pause/Resume** — a paused type is hidden everywhere (apply dropdown, employee KPIs, reports) and blocks new applications. **Employees on Leave — Department Wise**, plus a **Cancellation Requests** panel for employee-raised cancel requests on already-approved leave (approving restores the balance and logs it).
  - **Reports** — a **Leave Balances** table with one column per active leave type (not fixed to Casual/Sick/Earned — any type you add appears here too), showing **days used this year** for unpaid/unlimited types instead of a blank balance, and the full Leave Balance History (every credit/debit with reason and running balance), with CSV export.

  Employees see a **KPI card per active leave type** (unpaid types show "Unlimited" plus a **days-taken-this-year** count), a **balance history** view, apply for any active type (days auto-computed, blocked over balance for paid types, blocked entirely if paused), track requests with the same visual stepper, **request cancellation** of an approved leave, and **withdraw** their own still-pending cancellation request.

  Balances and requests are stored per-type (`employee_leave_balances`, `leaves.leave_type_id`) rather than fixed columns, so this works for any leave type you add — not just the original three.

- **Payroll** — scope banner, filters + Export, KPI row (Payroll Cycle/Employees Processed/F&F Requests). Two tabs:
  - **Dashboard** — a fully dynamic **Salary Structure** breakdown (Earnings → Gross; Deductions → Total Deductions; Net Pay) built from a configurable **salary component catalog** — HR can **+ Add salary component** (any new earning or deduction) which is instantly provisioned across every employee at ₹0, and pause/resume any component (paused ones drop out of every breakdown and net calculation). The per-employee structures table gains one column per active component. **Run Payroll** takes a calendar month (month picker); it buckets components into basic/HRA/allowances/deductions per payslip and automatically adds a **Late Cut** line — half a day's pay per late arrival beyond that employee's free monthly allowance (see Attendance) — subtracted from Net (idempotent per period).
  - **Reports** — payroll totals by period (including total Late Cuts) and by department (all-time), with CSV export.

  Employees see their own dynamic breakdown (including any late-arrival cut) and download payslips.

- **Recruitment** — scope banner, filters + Export, KPI row (Open Requisitions/Active Candidates/Offers Pending/Onboarding In Progress/Exiting Employees):
  - **Job Requisitions** — HR/Manager can **+ Add Requisition** (department, title, openings); every new requisition starts **Pending Approval** and must be **Approved** or **Rejected**; an approved requisition can then have its **Manage Posting** boards set (e.g. "LinkedIn, Naukri"), shown as "Live on: …".
  - **Candidate Pipeline** — **+ Add Candidate** against any requisition with an optional interview panel; each candidate **Move to &lt;next stage&gt;**s through the pipeline.
  - **Interview Rounds** — the pipeline itself is a dynamic, HR-configurable catalog (not a fixed list): **+ Add Round**, **Edit** a round's name, and **Pause/Resume** a round to skip it without losing history. Candidates always advance to the next non-paused round; the last round is marked **Final**.
  - **Onboarding — New Hires** — **+ Add New Hire** auto-seeds a named responsibilities checklist (offer letter signed, IT setup, orientation, documents, meet manager). Click a hire to expand the checklist — checking/unchecking a responsibility recomputes the overall onboarding %.
  - **Offboarding — Exiting Employees** — **+ Add Exit** against a real employee auto-seeds a clearance checklist (IT assets, knowledge transfer, finance clearance, HR exit interview). Click an exit to expand it — checking off every responsibility auto-marks the record **Cleared**.
  - **Department-wise Vacancies** — reuses the real employee headcount vs. open-position-target computation.
  - **Key Features** tile grid — each tile jumps straight to the section it configures (Job Requisitions, Candidate Pipeline, Interview Rounds, Onboarding, Offboarding, Vacancies).

  Non-HR roles (TL/STL/Employee) see the vacancies view read-only; the rest of the module is HR/Manager-run.

- **Performance Management** (Super Admin/HR/Manager) — Dashboard/Reports tabs, KPI row (Reviews In Progress/Avg Rating (Org)). The main **Performance Reviews** card is deliberately minimal: employee/team/goal+KPI (read-only), self-/manager-assessment status and rating, **Submit Manager Assessment**, **Mark Review Complete**, and three small links (360° Feedback / Competency / Plan) — everything else lives on its own dedicated screen:
  - **Goal Assignment & Tracking** (also reached via the KPI/KRA/OKR Management tile) — a global Employee/Goal/Due/Progress table; **+ Assign New Goal** creates one, and clicking a progress bar lets you update it inline.
  - **Performance Reviews & Appraisals — &lt;Name&gt;** — opened by "Submit Manager Assessment": Achievements this cycle, Areas for Development, and a 1–5 rating.
  - **360° & Continuous Feedback — &lt;Name&gt;** — a note thread labeled by relationship to the reviewee (Manager/Peer/Self/Other), postable by anyone.
  - **Competency & Skill Gap Assessment — &lt;Name&gt;** and **Promotion & Improvement Plans (PIP) — &lt;Name&gt;** — single-purpose screens for the competency notes and the Promotion/PIP flag, respectively.

  **Rule: a review cannot be marked complete until both self- and manager-assessment are submitted** — the **Mark Review Complete** button is disabled, and the server rejects the request, until both are `Submitted`. Employees get their own self-service view, scoped to just their own records: a **My Goals** table (goal/due/progress, view-only — progress is HR-updated), a small **My Reports** KPI row (goal count, completed reviews, their own average rating), **My Reviews** (self-assessment submission, achievements/development notes once written, and the same 360° feedback thread). **Reports** tab (HR-only): ratings by team, rating distribution, status split, Promotion/PIP counts.

- **Learning Management** (Super Admin/HR/Manager) — Dashboard/Certifications/Reports screens, KPI row (Active Courses/Total Enrolled). The main **Training Courses** list is deliberately minimal (title, Mandatory badge, completion stats, pass mark) with a single **View Course** button — all the per-course actions live in a dedicated **Course Detail** screen instead of cluttering the list: **Course Materials** (upload, remove, and Watch Video/View Document links — always view-only, no download/copy option for any role), a **Manage Assessment** link, and an **Enrolled Employees** list where HR can **Record Score** and **Issue Certificate** per employee (or **+ Enroll** a new one). **+ Add Course** opens a dedicated **Create Course** screen: Course Name, Mandatory/Compliance Training (Yes/No), **Has Assessment / Completion Criterion?** (Yes/No — **selecting "No" is rejected**, both client- and server-side, with the exact same message: "every course needs at least one assessment or completion criterion"), Assessment Pass Mark %, and PDF/video material upload with **+ Add Another File/Video**. **Manage Assessment** is its own screen per course: a real MCQ question bank (question + 4 options + correct answer), add/edit/delete questions. Employees get a **Take Assessment** button that fetches the question bank **shuffled per attempt** — the correct answer is never sent to the browser, and grading always happens server-side, then shows the employee their own score/pass-fail/certificate result immediately. **Rule: a certificate is only issued after the associated assessment is passed** — the quiz score is compared to the course's pass mark to decide pass/fail and certificate issuance automatically; HR can also record a score manually for offline/instructor-led assessments via the Course Detail screen. A dedicated **Certifications** screen lists every certified employee across every course. Materials are **always view-only for every role** — employees see them rendered inline (PDF in an embedded viewer with the browser's own PDF-viewer toolbar suppressed via `#toolbar=0`, video with the browser's download button hidden), with no download or copy option anywhere in the product. This is a UI-level deterrent against casual copying, not cryptographic DRM. Every **Key Feature** tile now opens its own dedicated screen instead of dumping into the dashboard: **Course & Program Management** (Course/Enrolled/Mandatory/Assessment/Materials table), **Course Enrollment** ("who has access to what" — every enrollment across every course with status Certified/Assessed/In Progress, plus **+ Enroll Employee**), **Assessments & Assignments** (every course's final assessment and pass mark in one list), **Training Delivery & Scheduling** (booked sessions, with a dedicated **Schedule Training Session** form — course, mode, date & time), **Skill Development & Competency Mapping** (pick an employee, see/add Skill × Current/5 × Required/5 × Gap rows), and **Progress, Attendance & Feedback** (pick an employee, a feedback thread with an **Add feedback** box). Employees get their own self-service **Learning Management** dashboard, matching the prototype: a **My Enrolled Courses** / **Certificates Earned** KPI row, a **Training Courses** card browsing every company course (aggregate completion stats, "View Course" if already enrolled or "View & Enroll" if not), and a **Quick Actions → Enroll in Course** self-enrollment flow. Opening a course goes to its own detail screen — enrolled courses show materials, **Take Assessment** (still the same shuffled, server-graded MCQ engine) and the employee's own score/certificate; not-yet-enrolled courses show an **Enroll in this Course** prompt instead. Everything here is scoped to just the signed-in employee's own enrollments/scores — no visibility into other employees' courses or scores. Every course in the system now has a real, hand-written question bank so its Take Assessment button actually works — no course sits with a pass mark and zero questions.

- **Asset Management** (Super Admin/HR/Manager) — Dashboard/Asset Requests/Reports screens, KPI row (Total Assets/Assigned/In Store, counting only active/non-disposed assets). **+ Add Asset** and **Assign** each open their own dedicated screen (not an inline row form) — Add Asset takes name/category/cost/warranty date; Assign shows the asset's details and an employee picker. Every asset gets an auto-generated tracking tag (`AST-0001`, …). **Edit** (name/category/cost/warranty) is a distinct action from **Assign**, so editing never silently changes who holds an asset. Also: **Return**, **Transfer** (reassign directly to a different employee in one step), **Send for Repair** / **Back In Store**, **Pause/Resume** (retires it from the active pool without deleting it), and **Dispose** (terminal, requires it to be returned first). **Log Audit** appends a timestamped check to the asset's **History**, alongside every other action ever taken on it. **Rule: an asset cannot be assigned to more than one active employee at a time** — enforced server-side. Assets added by a Manager/Assistant Manager start **Pending Approval** and need Super Admin/HR Admin sign-off before they can be assigned. Every **Key Feature** tile opens its own dedicated screen: **Asset Transfer & Return** (every asset with its last transfer, plus Transfer To…/Record Return/Report Damage), **Asset Maintenance & Repair** (assets currently Under Repair with their reported issue, **+ Log Maintenance Request** to send any other asset for repair with a note), **Barcode / QR Code Tracking** (every asset's tag next to a QR-style icon), **Asset Disposal & History** (Dispose — blocked while Assigned — plus each asset's full history log), and **Asset Audit** (**Run Full Audit** logs an "Audited" entry against every active asset at once and records a summary — "4/4 accounted for, 0 discrepancies" — with a running Audit History). **Asset Approval** now reviews two request shapes side by side: Return/Damage/Regularization against an asset an employee already holds, and a new **New Asset** request (category + urgency + reason, no asset yet) from the employee side. Employees get a self-service **Asset Management** dashboard: a **My Assets** KPI, an **Asset Inventory** card (their own assets, each with Request Return/Report Damage), a **My Asset Requests** history card, and **Quick Actions → Request Asset** — a brand-new self-service ask (I need a Laptop, urgency High, reason) that lands straight in HR's Asset Approval queue, for when they have nothing assigned yet or need a replacement/loaner.

  All four new modules' **Key Features** tile grids are functional — Recruitment/Performance jump to the relevant section on the same page; Learning/Asset Management tiles that need more room (Create Course, Manage Assessment, Certifications, Add Asset, Assign, Asset Requests) open their own dedicated screen with a way back to the dashboard.

- **Helpdesk** — employees raise IT/HR/Admin/Grievance/Facilities/Payroll tickets (category, priority Low/Medium/High/Critical, subject, description) and track status (Open/In Progress/Resolved/Closed) with a reply thread. HR gets a KPI row (Open/In Progress/Resolved) and a simplified ticket list; all 9 **Key Feature** tiles open their own dedicated screen: **Ticket Creation, Assignment & Categorization** (raise a ticket, assign/reassign any ticket to a staff member), **SLA Tracking & Status** (Critical 1h/High 4h/Medium 24h/Low 72h response targets, flags a breach), **Ticket Resolution, Closure & Reopening** (**rule: a ticket cannot be closed until the requester confirms resolution or the 3-day auto-close window elapses** — enforced server-side; either side can reopen a Resolved/Closed ticket that wasn't actually fixed), **Internal Notes, Attachments & Screenshots** (HR-only notes + file/screenshot attachments on the thread, never visible to the requester), **Knowledge Base** (HR-authored self-help articles employees can browse before raising a ticket), **Auto Routing & Email Notifications** (map a category to a default assignee — new tickets in that category auto-assign and fire a notification), **Ticket Escalation** (every SLA-breached, unresolved ticket, with **Approve Escalation** bumping its priority up a level), **CSAT / Customer Satisfaction Feedback** (the requester rates a Resolved/Closed ticket 1–5; HR sees the average and every individual rating), and **Helpdesk Dashboard, Reports & Analytics** (a by-category bar chart, Average CSAT, and a real CSV **Export** of every ticket).
- **Announcements** — HR posts a company-wide notice (title/body/category: General/Policy/Event/Holiday, optionally pinned to the top). **Send to** now offers **Everyone**, **By department**, or **Individual employee(s)** (multi-select) — a department- or individual-targeted post is only visible to the employees it names, never leaking into anyone else's feed (an HR-only **Sent to: …** line shows who a post reached). Posting an **Event**-category announcement with no narrower target (e.g. a company-wide team meeting) also fires a real entry into everyone's Notifications widget, not just the notice board. A **Notification Log** screen lists every real external send attempt.
- **Notifications** (Dashboard widget) — targeted, not just role-broadcast: leave approval/rejection, expense claim approval/rejection/reimbursement, and Helpdesk ticket resolution each send a real notification straight to the employee involved (`notifyEmployee()`), alongside role-wide broadcasts (like Event announcements, via `notifyAll()`). HR's **+ Send** form supports the same **Everyone / By role / By department / Individual employee(s)** targeting as Announcements. An employee's feed only ever shows notifications aimed at them personally, at their department, or at their role — never another employee's or another department's.
- **Real Email / SMS / WhatsApp delivery** — both Announcements and Notifications have an **Also deliver via** channel picker (Email/SMS/WhatsApp) alongside the always-on in-app entry. Email goes out over any SMTP account (Gmail app password, Office365, a transactional relay, …) via `nodemailer`; SMS and WhatsApp go out via Twilio. Configure `EMAIL_SMTP_*`/`EMAIL_FROM` and `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_SMS_FROM`/`TWILIO_WHATSAPP_FROM` in `server/.env` (see `server/.env.example`) to go live — with no credentials configured, a send is logged as **Failed** with a clear "not configured" reason instead of crashing, so the feature is safe to leave off until real accounts are ready. Every attempt (Sent or Failed, per recipient and channel) is recorded in the **Notification Log** (`channel_deliveries` table), reachable from Announcements.
- **Expense & Travel Claims** — employees submit a claim (category/amount/description/optional receipt upload) that goes through the exact same sequential approval chain already used by Leave and Attendance Regularization (`chain.js`, the visual `ChainStepper`). Once Approved, HR marks it **Reimbursed** as a separate terminal step. A Reports tab breaks totals down by category and pending vs. reimbursed amounts.
- **Employee Engagement Surveys** — HR builds a survey (title + a list of 1–5 rating questions), activates it, and employees respond once per survey (rating per question + an optional free-text comment). HR sees an aggregated **average rating per question** plus every comment — never an individual employee's raw answers.
- **Document Management** — a policy/handbook/form library. **Mandatory** documents require every active employee to explicitly acknowledge having read them; HR sees who has and hasn't acknowledged a given document. Employees just see their own acknowledgment status and an Acknowledge button.
- **Shift & Roster** — HR defines shift patterns (name + start/end time, e.g. Morning 09:00–18:00), assigns each active employee a shift per date via a roster view, and employees see their own upcoming roster. Employees can **Request Shift Swap** for a date (optionally naming who they'd like to swap with); HR's **Approve** actually swaps both employees' assigned shifts for that date when a target was named.
- **Rewards & Recognition** — any employee can nominate a colleague for an award (Employee of the Month/Spot Award/Team Player/Innovation Award/Above & Beyond), each worth a fixed points value, with a message. A company-wide feed shows every recognition; a leaderboard aggregates total points per employee.
- **Project & Resource Management** — HR tracks projects (Active/On Hold/Completed) and assigns employees to them with an allocation % and role. A **Resource Overview** sums each employee's allocation % across every Active project and flags anyone over 100% as double-booked. Employees see their own project assignments.
- **Timesheet** — employees log daily hours against a project they're assigned to (date, task description, hours), pending HR approval. HR approves/rejects entries and a Reports screen totals approved hours by project and by employee. A **My Tasks** section (matching the prototype's task table + "+ New Task" modal) lists Task/Sub Task Name/Status/Start/End Date/Updates, scoped by **department** rather than project, with a Dependent-Task toggle that links a task to another it depends on. A manager/HR ("higher authority") can assign a task straight to any employee via the modal's **Assign To** picker — it then shows up on that employee's own My Tasks list, with a real notification ("X assigned you a task"), and the assignee can update its status and post threaded updates.
- **Disciplinary Action Tracking** — HR-only case log against an employee (Warning/Suspension/Termination/Other) with a description, a timeline of HR notes, and Open/Resolved status with resolution notes. An employee can see only their own cases, read-only — never another employee's — the same privacy rule already used for the PIP flag in Performance Management. No demo case was seeded on purpose, since this is sensitive real HR data.

### Integrations (Super Admin only)

A dedicated module connecting the HRMS to real external systems, with a status dashboard + 7 **Key Feature** screens:
- **Email, SMS & WhatsApp** — a read-only status view of the channels already wired into Announcements/Notifications, plus the full recent-deliveries log.
- **Biometric Device Integration (eSSL)** — real fingerprint/face terminals (eSSL and other ADMS/iClock-protocol-compatible hardware) push attendance punches directly over HTTP to `/api/biometric-device/cdata` — no vendor SDK, no JWT (the device can't send one); the gate is device pre-registration by serial number. Register a device, map each employee's on-device enrollment ID, and punches flow through the *exact same* check-in/check-out/late-flag logic as a manual web check-in (`attendanceCore.js`, shared with `attendance.routes.js`). Every punch is logged (mapped or not) with a **Simulate a punch** test tool that proves the whole receive → map → attendance pipeline end-to-end without physical hardware in hand — verified against both the simulate endpoint and a raw `curl` POST to the real device endpoint.
- **Slack & Microsoft Teams Alerts** — paste an incoming webhook URL and new Helpdesk tickets + new Announcements mirror into that channel in real time. A delivery log shows every send attempt (Sent/Failed + the exact error, e.g. a bad URL) — verified against a real (fake) URL to confirm failures are caught and logged, never thrown.
- **Calendar Sync (Google)** — connect a Google account (OAuth Client ID/Secret from the Google Cloud Console) and every new Learning **Training Session** is pushed as a real Google Calendar event automatically. Best-effort: a session always saves even if the calendar push fails or isn't connected.
- **Payroll Bank-Transfer Export** — generates a bank-ready salary disbursement CSV (account number, IFSC, amount, narration) from any completed payroll run, using each employee's on-file bank details; flags how many employees in that run are missing bank details via an `X-Missing-Bank-Details` response header.
- **Custom Integrations (Add Your Own)** — Super Admin adds arbitrary integration entries beyond the 5 built-in ones: name, description, a link/webhook URL, and its own logo image (uploaded as a file, stored the same way as an employee photo). Never deleted, only Active/Paused, matching the Manage Modules convention.
- **Company Branding (Logo & Name)** — upload your own company logo and set a company name; both appear immediately (after a refresh) on the Login page and in the app header for every user and every role, replacing the default "HRMS" branding. The Login page's read is a public endpoint (`GET /api/branding`) since it renders before anyone has signed in.

None of the external integrations invent credentials — Twilio/SMTP/Slack/Teams/Google all require you to supply your own real account details (see `server/.env.example` and the Integrations screen itself); every one fails safely with a clear reason logged instead of crashing when left unconfigured.

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
- **Organization Structure** — the office hierarchy and **approval/escalation workflow** (Super Admin → HR Admin → Manager → Assistant Manager → STL → TL → Employee). Leave/attendance/alert/issue requests flow top-to-bottom through this chain. **Drag** a role to reorder the workflow; **Add Role**, **Edit**, and **Pause** are supported — roles are never deleted. Super Admin can't be paused. **Edit** also sets a role's **maximum approvable leave duration** (blank = unlimited) — e.g. Team Lead is seeded to 2 days, enforcing the company rule that longer requests must escalate.

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
