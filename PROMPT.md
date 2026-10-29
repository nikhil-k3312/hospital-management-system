# MediChain — Execution Prompts

Companion to `PLAN.md`. Use with an AI coding agent that has direct file/terminal access to the repo (Claude Code or similar) — not a chat-only assistant, since these tasks need to read and edit real files.

## How to use this

1. Put both `PLAN.md` and this file at the repo root.
2. Paste the **Persistent Project Context** block below into your agent's project instructions (e.g. `CLAUDE.md`) once, so it holds for every phase.
3. Paste each phase prompt **in order**, one at a time. Don't skip ahead — later phases assume earlier ones are actually done, not just started.
4. After each phase, check its Definition of Done in `PLAN.md` yourself before moving on. Don't take the agent's word that something works — run it.
5. Have the agent update the checkboxes for the completed phase in `PLAN.md` as its last step each time, so the plan stays a live document instead of going stale.

---

## Persistent Project Context

```
You are working in the MediChain repo — a hospital dashboard system originally
documented as a blockchain-based decentralized database project. PLAN.md at the
repo root is the source of truth for scope and architecture decisions. Read it
in full before starting any phase, especially section 3 (locked architecture
decisions) and section 5 (full API surface).

Absolute rules, no exceptions:
- Never write mock, hardcoded, or placeholder data into shipped frontend or
  backend code. Every screen's data comes from a real API call to a real
  database. Loading, empty, and error states must be real — never simulated
  with setTimeout or a static fixture standing in for a network call.
- A seed script that inserts realistic demo data directly into the database
  (for local dev/demo purposes) is fine. Fabricating data inside application
  code that should be calling the database is not — these are different things.
- Don't build a frontend call to an endpoint that doesn't exist on the backend,
  and don't build a backend endpoint nothing calls, without flagging it. Every
  feature should be wired end-to-end before you call it done.
- Follow the existing repo folder structure (backend/, frontend/, docs/).
  Don't restructure wholesale without asking first.
- All config and secrets come from process.env, never hardcoded. If you add a
  new required variable, add it to .env.example (never commit a real .env).
- Write or update tests (Jest/Supertest on the backend, React Testing Library
  on the frontend) for any new logic before marking a phase complete.
- If a phase requires a major new dependency or infrastructure piece that
  isn't already named in PLAN.md section 3, stop and ask before adding it.
- When a phase is done, update its checkboxes in PLAN.md as your last step.

Work one phase at a time, in the order given. State clearly what you verified
(tests run, endpoints hit manually, etc.) at the end of each phase — don't just
assert completion.
```

---

## Phase 0 — Audit & Baseline

```
Read PLAN.md section 1 in full. Your job this phase is read-only investigation
— do not change any code yet.

1. Inventory backend/ and frontend/: list every top-level subfolder, every
   package.json and its dependencies, every route/controller/model file on
   the backend and every page/component on the frontend.
2. For each of the four roles (Patient, Doctor, Admin, Insurance Agent),
   determine what already works end-to-end (real DB round trip), what's
   partially built, and what doesn't exist yet.
3. Confirm whether the frontend is React or something else, and whether it
   uses Redux Toolkit, and report the actual finding either way.
4. Grep the frontend for mock/dummy data: search for mockData, dummyData,
   fakeData, sampleData, hardcoded arrays used in place of API responses,
   and setTimeout-wrapped fake fetches. List every hit with file and line.
5. Compare what you find against PLAN.md section 1's "Confirmed from repo"
   list and flag any discrepancies.

Write your findings to AUDIT.md at the repo root, organized to mirror
PLAN.md section 1's structure. Do not proceed to Phase 1 in this same
session until I've reviewed AUDIT.md.
```

---

## Phase 1 — Foundation & Hygiene

```
Implement PLAN.md section 6 (repository hygiene) and Phase 1's tasks from
section 7:

1. Remove node_modules/ and logs/ from git tracking; confirm .gitignore
   covers both plus .env.
2. Resolve the root package.json per PLAN.md D-decisions: either remove it
   or convert it into a proper npm-workspaces root for backend+frontend.
3. Add startup env-var validation (e.g. with envalid) so the backend refuses
   to start with a clear error if a required variable is missing, instead of
   failing confusingly later.
4. Add centralized Express error-handling middleware with a consistent JSON
   error shape, matching the status codes in PLAN.md section 5.
5. Add helmet and express-rate-limit to the API.
6. Write a root README.md: what MediChain is, the tech stack as decided in
   PLAN.md section 3 (not the paper's original), setup steps, required env
   vars, and how to run backend, frontend, and tests.

When done, confirm: server refuses to boot with a missing required env var
(show the error), and the hygiene checklist in PLAN.md section 6 is fully
checkable. Update PLAN.md's checkboxes for section 6 and Phase 1.
```

---

## Phase 2 — Auth & User Management

```
Implement PLAN.md Phase 2. Build the real OTP + JWT flow — no shortcuts, no
bypass outside of a clearly-isolated test environment:

1. Endpoints: POST /auth/register, POST /auth/login/request-otp,
   POST /auth/login/verify-otp, POST /auth/refresh-token, POST /auth/logout,
   GET /users/me, PATCH /users/me — per PLAN.md section 5.
2. Use the user schema from PLAN.md section 4.1. Hash passwords with bcrypt
   or argon2id — never store or log a plaintext password.
3. Store OTP codes in Redis with the TTL from OTP_EXPIRY_MINUTES. Send the
   real email via the configured Gmail/Nodemailer setup — do not fake or
   log the OTP to the console as a shortcut, even temporarily.
4. Implement refresh-token rotation and logout invalidation.
5. Add RBAC middleware that gates routes by role (patient/doctor/admin/
   insurance_agent) and returns 401/403 correctly per PLAN.md section 5.
6. Write Supertest integration tests covering: register, request-otp,
   verify-otp with correct and incorrect codes, protected-route access with
   and without a valid token, and role-gated access.

Verify by actually registering a test account and completing the OTP flow
against a real (or a documented test) inbox before marking this done.
Update PLAN.md's checkboxes for Phase 2.
```

---

## Phase 3 — Appointments

```
Implement PLAN.md Phase 3:

1. Doctor availability/slot model and GET /doctors/:doctorId/available-slots.
2. POST /appointments, GET /appointments/:id, PATCH /appointments/:id,
   DELETE /appointments/:id per PLAN.md section 5.
3. Enforce no-double-booking at the backend — a request for an already-taken
   slot must be rejected with a clear error, not merely hidden in the UI.
4. Supertest coverage for the double-booking rejection specifically, plus
   the normal booking/reschedule/cancel paths.

Verify by attempting to double-book the same slot from two requests and
confirming the second is rejected server-side. Update PLAN.md's checkboxes
for Phase 3.
```

---

## Phase 4 — Medical Records & Consent

```
Implement PLAN.md Phase 4:

1. Use the medical record schema from PLAN.md section 4.2.
2. Endpoints: GET /records/:id, POST /records, POST /records/:id/grant-access,
   POST /records/:id/revoke-access, per PLAN.md section 5.
3. Access control: a doctor may read a record only with an active, unexpired
   grant from the patient. No grant, or an expired one, returns 403.
4. Every record create/update/grant/revoke should call a ledgerService
   function to log the action — Phase 5 will implement that service for
   real; for now, stub it with a clear TODO and a function signature that
   matches what Phase 5 expects, so nothing has to be rewired later.
5. Supertest coverage including the 403 case for missing/expired consent.

Verify the 403 case explicitly, not just the happy path. Update PLAN.md's
checkboxes for Phase 4.
```

---

## Phase 5 — Ledger Layer

```
Implement PLAN.md section 4.3 and Phase 5. This replaces Hyperledger Fabric
with a hash-chain ledger service per PLAN.md decision D2 — do not attempt a
real Fabric network unless PLAN.md has been explicitly updated to reverse D2.

1. Build the ledgerEntrySchema from PLAN.md section 4.3 as its own
   insert-only Mongo collection — no update or delete route may ever touch it.
2. Implement the ledgerService.appendEntry(...) function that Phase 4 stubbed:
   compute payloadHash, chain to the previous entry's entryHash, compute this
   entry's entryHash, and persist.
3. Wire it into every record/appointment/claim mutation across the codebase
   so nothing bypasses it.
4. Implement GET /records/:id/ledger-history.
5. Implement a verification routine that walks the chain for a given record
   and recomputes each entryHash, returning whether it's intact.
6. Write a test that: creates a record, edits the underlying document
   directly in the database (bypassing the API, simulating tampering), and
   confirms the verification routine flags it.

That tampering test is the actual proof this phase works — don't skip it.
Update PLAN.md's checkboxes for Phase 5.
```

---

## Phase 6 — File Storage

```
Implement PLAN.md Phase 6 per decision D3 (GridFS or the agreed alternative
— not IPFS unless PLAN.md has been explicitly updated):

1. multer-based upload handling with size and MIME-type limits.
2. Store files via the chosen mechanism from PLAN.md D3.
3. Compute a SHA-256 hash of the uploaded file and write it into the linked
   ledger entry via ledgerService from Phase 5.
4. POST /records/:id/files and GET /files/:fileId, the latter gated by the
   same consent check as record reads from Phase 4.
5. Test that a fresh hash of the retrieved file matches what's stored in the
   ledger, and that an unauthorized user gets 403 on GET /files/:fileId.

Update PLAN.md's checkboxes for Phase 6.
```

---

## Phase 7 — Insurance Claims

```
This module likely doesn't exist yet (nothing in the repo audit suggested it
does) — confirm against AUDIT.md, then build it per PLAN.md Phase 7:

1. Claim schema/model with a status state machine: submitted → under_review
   → approved/denied → settled.
2. Endpoints: POST /claims, GET /claims, PATCH /claims/:id,
   GET /claims/settlements, GET /claims/reports per PLAN.md section 5.
3. Role gating: patients can submit and view their own; insurance agents can
   view the queue and change status; admins can view everything.
4. Test the full state transition path and that a patient cannot change
   their own claim's status.

Verify a claim submitted by a patient test account is visible to and
actionable by an insurance-agent test account, and the status change is
visible back to the patient. Update PLAN.md's checkboxes for Phase 7.
```

---

## Phase 8 — Admin Module

```
Implement PLAN.md Phase 8:

1. Endpoints: GET /admin/users, PATCH /admin/users/:id,
   GET /admin/doctors/pending-verification, PATCH /admin/doctors/:id/verify,
   GET /admin/stats, PATCH /admin/settings per PLAN.md section 5.
2. GET /admin/stats must aggregate real counts from the database (users by
   role, appointments this week, pending claims, etc.) — not static numbers.
3. Verifying a doctor must actually flip isVerified on that user document and
   change what routes that doctor can access.

Verify by checking a pending doctor account is blocked from doctor-only
routes before verification and allowed after. Update PLAN.md's checkboxes
for Phase 8.
```

---

## Phase 9 — Frontend Integration, All Four Dashboards

```
This is where PLAN.md section 8 (the "no dummy data" checklist) gets
enforced hardest. Read it again before starting.

1. Wire the Patient, Doctor, Admin, and Insurance Agent dashboards to the
   real endpoints built in Phases 2–8. If the frontend isn't already React
   (confirm from AUDIT.md), build these in React + Redux Toolkit per
   PLAN.md decision D4, extending the authSlice pattern already implied by
   the repo's env config (access/refresh tokens).
2. Delete every hardcoded array, fixture file, or setTimeout-simulated
   fetch found in AUDIT.md's grep results. If any UI still needs sample
   content for local development, move it into a database seed script
   instead — never into component code.
3. Build real loading, empty, and error states for every list/detail view —
   not just a happy-path render.
4. Run PLAN.md section 8's full checklist against all four dashboards:
   backend killed → real error state; brand-new account → real empty
   states; grep for mock-data terms → zero hits in shipped code; admin
   stats numbers actually move when data changes.
5. React Testing Library component tests for the critical flows: login,
   book an appointment, view a record, submit/act on a claim.

Report the section 8 checklist results explicitly, dashboard by dashboard,
not just "done." Update PLAN.md's checkboxes for Phase 9.
```

---

## Phase 10 — Testing, Security & Performance

```
Bring the project up to PLAN.md section 7 Phase 10 / the paper's own QA bar:

1. Get backend unit + integration test coverage as close to the paper's
   >90% target as practical; report the actual number.
2. Run an OWASP ZAP scan against a running staging instance and fix any
   high/critical findings.
3. Check API response times and page load against the <200ms / <2s targets
   under a basic load test; report actual numbers, not estimates.
4. Run `npm audit` (or equivalent) on both backend and frontend dependency
   trees and resolve high-severity issues.

Report real numbers for coverage, ZAP findings, and load-test results —
this phase is only done when those numbers exist and meet the bar, not
when the tools have merely been run once.
```

---

## Phase 11 — Deployment & CI/CD

```
Implement PLAN.md Phase 11:

1. Dockerfiles for backend and frontend; docker-compose.yml including
   MongoDB and Redis alongside the app services.
2. GitHub Actions pipeline: lint → test → build → deploy to staging on
   merge to main.
3. A documented production checklist: secret rotation, NODE_ENV=production,
   CORS locked to the real deployed frontend origin (not localhost:3000).
4. Confirm a completely fresh clone of the repo can go from
   `docker-compose up` to a working local stack using only the steps in
   the README from Phase 1 — no undocumented manual steps.

Do a literal fresh-clone test if possible and report what broke, if
anything. Update PLAN.md's checkboxes for Phase 11 — and section 0's
top-level Definition of Done in PLAN.md should now be true for all four
dashboards.
```
