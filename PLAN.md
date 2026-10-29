# MediChain — Completion Plan

**Project:** MediChain — Hospital Dashboard with Blockchain-Based Decentralized Database
**Repo:** https://github.com/VSshashank/hospital-management-system (fork of `nikhil-k3312/hospital-management-system`)
**Source design doc:** MediChain Research Paper, v1.0, AY 2025–2026
**Team:** AS (Blockchain & Security) · NI (Backend & API) · SI (Full-Stack Integration) · SH (Frontend & UI/UX)
**Prepared:** August 5, 2026

## How to use this document

This is the spec. `PROMPT.md` is the execution driver — a set of copy-paste prompts for an AI coding agent (Claude Code or similar) that implements each phase below against the real repo. Work top to bottom. Check a box only when its Definition of Done is actually true, not when code merely exists.

**MediChain is "done" when:** every screen in all four dashboards is populated by a real API call to a real database, every backend route the frontend calls exists and is tested, nothing renders from a hardcoded array or a `setTimeout`-simulated response, and the ledger + file-storage layer actually makes records tamper-evident instead of just being described in a document.

---

## 1. Audit Summary

### Confirmed from the live repository
- Fork of `nikhil-k3312/hospital-management-system`; 3 commits on this fork (4 upstream) — very little history, consistent with early-stage implementation.
- Root contains `/backend`, `/frontend`, `/docs`, `/logs`, `/node_modules` (committed to git — it shouldn't be), `.env.example`, `.gitignore`, `package.json`, `package-lock.json`. **No root `README.md`.**
- Root `package.json` contains only `axios` as a dependency — it is not a real workspace root; the actual backend/frontend dependency trees live inside their own folders and could not be inspected remotely (see "Unknown" below).
- Root `.env.example` is the single most informative artifact in the repo. It configures:
  - Express on `PORT=8001`
  - `MONGODB_URI` (MongoDB Atlas connection string) — **no PostgreSQL variable anywhere**
  - `JWT_SECRET` + `JWT_REFRESH_SECRET`, `JWT_EXPIRY=15m` — an access/refresh token pair
  - Gmail-based OTP email (`EMAIL_SERVICE=gmail`, Nodemailer-style vars), `OTP_LENGTH=6`, `OTP_EXPIRY_MINUTES=10`
  - `REDIS_HOST` / `REDIS_PORT` — **not mentioned anywhere in the paper's tech stack table**
  - `MIN_TRUST_SCORE=50` / `HIGH_SENSITIVITY_TRUST_SCORE=70` — a "trust score" concept with **no explanation anywhere in the paper**
  - `ALLOWED_ORIGINS=http://localhost:3000` (CORS)
  - **No** Hyperledger Fabric connection profile, wallet, channel, or chaincode config
  - **No** IPFS API/gateway URL, **no** S3 credentials
- Repo language mix: HTML 56.3% / JavaScript 27.5% / CSS 16.2%. A JS share this low relative to HTML is more typical of a multi-page vanilla/EJS-style frontend than a React SPA, where JS normally dominates. **Needs local confirmation — do not assume either way.**
- GitHub's `robots.txt` blocks automated crawling of its folder-listing (`/tree/…`) pages, so the actual contents of `/backend` and `/frontend` — models, routes, controllers, components, their own `package.json` files — could not be inspected remotely. **Phase 0 exists specifically to close this gap with a real local audit.**

### Confirmed from the paper (the intended design)
- Four roles — Patient, Doctor, Admin, Insurance Agent — each with a distinct feature set (§1.3).
- Hybrid storage: PostgreSQL (users, appointments) + MongoDB (sessions/logs) + Hyperledger Fabric (immutable ledger) + IPFS/S3 (large files) (§3).
- REST API v1, JWT bearer auth, OTP-based login (§4).
- QA targets: >90% unit coverage (Jest/Mocha), Supertest integration tests, OWASP ZAP + smart-contract audits, <200ms API response / <2s page load (§6.3).
- Docker + GitHub Actions CI/CD across dev/staging/production (§8.2).

### Unknown — resolve in Phase 0, not by assumption
What models/routes/controllers actually exist in `/backend`; what's real vs. stubbed; whether the frontend is React or something simpler; which paper features (if any) are already working end-to-end; where dummy/mock data currently lives in the UI.

---

## 2. The Central Inconsistency

Say it plainly: the paper's headline feature — blockchain-based immutability via Hyperledger Fabric, with IPFS for large files — has **zero footprint** in the actual runtime configuration. The database story has also diverged (Mongo-only in practice vs. the documented Postgres+Mongo hybrid). These aren't cosmetic gaps; they're the two most architecturally significant pieces of the original design.

This is normal for a capstone at this stage — the paper is the aspirational design, the repo is wherever implementation actually got to — but the plan only works if it starts from what's real, not from what's documented. Sections 3–9 below are how this plan bridges that gap without pretending it isn't there.

---

## 3. Architecture Decisions to Lock First

Decide these before writing feature code — every phase after Phase 1 depends on them.

| # | Question | Paper says | Repo suggests | Recommendation | Why |
|---|---|---|---|---|---|
| D1 | Relational data | PostgreSQL for users/appointments | MongoDB only | **Standardize on MongoDB for everything.** Only add Postgres back if AS/NI have a specific relational need. | Repo already runs on Mongo. Adding a second database now is pure schedule risk with no user-facing benefit at this scale — document the deviation in the final report instead of chasing the original diagram. |
| D2 | Immutable ledger | Hyperledger Fabric, `PatientRecordContract` chaincode (§7.1) | Nothing configured | **Default: a lightweight cryptographic hash-chain ledger service inside the backend** (see §4 below). Keep real Fabric as a stretch goal only if AS has bandwidth after everything else works. | Fabric needs a multi-container network (CAs, peers, an orderer), channel setup, and chaincode lifecycle management — realistically its own multi-week project. A hash-chain satisfies the paper's actual requirement (immutable, tamper-evident, auditable) without the infra tax, and the chaincode skeleton in §7.1 maps almost directly onto a plain service class if Fabric gets added later. |
| D3 | Large file storage | IPFS, hash pinned on-chain | Nothing configured | **MongoDB GridFS (or encrypted local/S3-compatible disk storage) behind the API**, with the file's SHA-256 recorded in the ledger exactly where the paper puts the IPFS hash. | Same infra-cost logic as D2. The pattern — "hash lives in the immutable ledger, blob lives elsewhere" — is preserved either way. |
| D4 | Frontend architecture | React 18 + Redux Toolkit | Unclear (language mix suggests it may not be) | Confirm in Phase 0. If it isn't already React, this plan assumes **building/finishing it in React + Redux Toolkit** per the paper — four role-based dashboards sharing auth/session state genuinely benefit from it. If a non-React implementation is already substantial, extend it consistently rather than rewriting; note the deviation. **Outcome (Phase 9): kept vanilla HTML/CSS/JS.** The existing pages were substantial, so they were wired to the API instead of rewritten (decision confirmed by the project owner). Shared state lives in `frontend/js/api.js` (session, in-memory token, refresh) and `frontend/js/portal.js` (dashboard shell) instead of Redux; frontend tests use Jest + jsdom + `@testing-library/dom`. | Avoid a costly rewrite if real work already exists; avoid inconsistent tooling if it doesn't. |
| D5 | Redis | Not mentioned | Configured | **Formalize its role**: OTP code storage with TTL and login rate-limiting. | It's already in the env file — give it a documented job instead of leaving it unexplained. |
| D6 | `MIN_TRUST_SCORE` / `HIGH_SENSITIVITY_TRUST_SCORE` | Not mentioned | Configured | Phase 0 must determine whether this is (a) a real planned feature nobody wrote down, or (b) leftover config inherited from the upstream template. If (b), delete it. If (a), design it properly — e.g., a scoring heuristic gating access to high-sensitivity record types — and document it here. | Undocumented config that gates access to medical data is a real risk either way; it needs an owner and a decision, not silence. |

---

## 4. Concrete Artifacts From the Decisions Above

### 4.1 User schema (Mongoose, replacing the paper's Postgres `users` table)

```javascript
const userSchema = new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true }, // bcrypt or argon2id — never plain/reversible
  role: { type: String, required: true, enum: ['patient', 'doctor', 'admin', 'insurance_agent'] },
  ledgerAddress: { type: String }, // was blockchain_address — identity key inside the ledger service
  isVerified: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },
}, { timestamps: true }); // gives createdAt/updatedAt for free
```

### 4.2 Medical record schema (Mongoose, replacing the paper's Postgres `medical_records` table)

```javascript
const medicalRecordSchema = new Schema({
  patientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  doctorId: { type: Schema.Types.ObjectId, ref: 'User' },
  recordType: { type: String },
  ledgerEntryId: { type: String, required: true }, // was blockchain_transaction_id — FK into ledger_entries
  fileHash: { type: String }, // was ipfs_hash — SHA-256 of the stored file, if any
}, { timestamps: true });
```

### 4.3 Ledger entry — the hash-chain that replaces Hyperledger Fabric for now

```javascript
const ledgerEntrySchema = new Schema({
  recordId: { type: Schema.Types.ObjectId, required: true }, // the record/appointment/claim being logged
  action: { type: String, required: true }, // 'CREATE' | 'GRANT_ACCESS' | 'REVOKE_ACCESS' | 'UPDATE' | ...
  actorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  payloadHash: { type: String, required: true },       // SHA-256 of the record's content at this moment
  previousEntryHash: { type: String, required: true }, // hash of the prior entry — this IS the chain
  entryHash: { type: String, required: true },          // SHA-256(recordId+action+actorId+payloadHash+previousEntryHash+timestamp)
  timestamp: { type: Date, default: Date.now },
});
// Collection is insert-only at the application layer (no update/delete routes exposed).
// Tamper check: walk the chain, recompute each entryHash, compare to what's stored.
```

This directly implements the intent of the paper's `PatientRecordContract.createRecord` / `grantAccess` (§7.1) without a Fabric network. If Fabric is added later, this service becomes the chaincode's off-chain mirror instead of being thrown away.

---

## 5. Full API Surface

The paper's §4.3 lists four example endpoints, not the full surface the four roles' feature sets (§1.3) actually require. This is the complete map — build against this, not just the paper's examples.

| Area | Endpoint | Notes |
|---|---|---|
| Auth | `POST /auth/register` | Patient self-registration; doctor/admin/agent accounts created via admin invite |
| Auth | `POST /auth/login/request-otp` | Per paper §4.3.1 |
| Auth | `POST /auth/login/verify-otp` | Returns access + refresh JWT |
| Auth | `POST /auth/refresh-token` | Rotates access token using refresh token |
| Auth | `POST /auth/logout` | Invalidates refresh token |
| Users | `GET /users/me` | Per paper §4.3.1 |
| Users | `PATCH /users/me` | Profile updates |
| Appointments | `POST /appointments` | Per paper §4.3.2 |
| Appointments | `GET /doctors/:doctorId/available-slots` | Per paper §4.3.2 |
| Appointments | `GET /appointments/:id` | |
| Appointments | `PATCH /appointments/:id` | Reschedule / status change |
| Appointments | `DELETE /appointments/:id` | Cancel |
| Records | `GET /records/:id` | Consent-gated |
| Records | `POST /records` | Doctor creates record/prescription |
| Records | `POST /records/:id/grant-access` | Patient grants a doctor access, with expiry per §7.1 |
| Records | `POST /records/:id/revoke-access` | |
| Records | `GET /records/:id/ledger-history` | Audit trail from the ledger service |
| Files | `POST /records/:id/files` | Upload, hash, store per D3, link into ledger |
| Files | `GET /files/:fileId` | Auth + consent gated |
| Claims | `POST /claims` | Patient submits a claim |
| Claims | `GET /claims` | Own claims (patient) or queue (insurance agent) |
| Claims | `PATCH /claims/:id` | Agent approves/denies/settles |
| Claims | `GET /claims/settlements` | Settlement history |
| Claims | `GET /claims/reports` | Financial reports (agent/admin) |
| Admin | `GET /admin/users` | |
| Admin | `PATCH /admin/users/:id` | Activate/deactivate |
| Admin | `GET /admin/doctors/pending-verification` | |
| Admin | `PATCH /admin/doctors/:id/verify` | |
| Admin | `GET /admin/stats` | System statistics dashboard |
| Admin | `PATCH /admin/settings` | Hospital configuration |

**As built (differences from the table above):**

* All routes are under `/api` and served by one service, `backend/services/api`.
* Consent is **patient-level**, not per record: `GET /consents`, `POST /consents/request` (doctor asks), `POST /consents/grant` (patient grants directly, with expiry), `POST /consents/:id/approve|deny|revoke`. These replace `POST /records/:id/grant-access` and `/revoke-access`. Doctors and admins can also use audited break-glass access (`x-break-glass-reason` header).
* `POST /auth/register` self-registers patients, doctors and insurance agents (doctors and agents start `pending` until an admin verifies them). Admin and staff accounts are created by `POST /admin/users`.
* Added endpoints: `POST /auth/change-password`, `GET /settings/public`, `GET /public/stats`, `GET /doctors`, `GET /patients`, `GET /patients/search`, `GET /appointments`, `GET /records`, `PATCH /records/:id` (amend), `GET /records/:id/verify`, prescriptions (`POST/GET /prescriptions`, `POST /prescriptions/:id/refill-request`, `PATCH /prescriptions/:id`), IoT vitals (`POST /devices/readings`, `POST/GET /vitals`, `GET /vitals/monitor`, `GET /devices/mine`), billing (`GET /bills`, `POST /bills/:id/pay`), `GET /claims/:id`, notifications, `GET/POST/PATCH /admin/devices`, `GET /admin/settings`, `GET /admin/audit`, and the ledger browser (`GET /ledger/stats`, `/ledger/entries`, `/ledger/verify`).

The README lists the full surface; the documentation PDF describes each endpoint.

Error handling follows the paper's §4.4 codes (200/400/401/429/503) — add `403` (consent/role denial) and `404` explicitly, since a consent-based access model needs both.

---

## 6. Repository Hygiene (do this before feature work — cheap, high value)

- [x] Remove `node_modules/` and `logs/` from git tracking (`git rm -r --cached node_modules logs`); confirm both are listed in `.gitignore`.
- [x] Decide the fate of the root `package.json` (currently only `axios`) — delete it, or turn it into a real npm-workspaces root (`npm install` once, runs both backend and frontend).
- [x] Add a root `README.md`: what MediChain is, the tech stack as actually decided in §3 (not just copied from the paper), local setup steps, required env vars, how to run backend/frontend/tests.
- [x] Confirm `.env` is gitignored and only `.env.example` is committed. If a real `.env` was ever committed earlier in history, rotate every secret in it (JWT secrets, Gmail app password, DB credentials).
  - **Done, with an action for the original author:** `.env` is gitignored and only `.env.example` is tracked. History check: commit `91a158e` ("first commit") added `backend/services/auth/.env` with a real Gmail address, Gmail app password and JWT secret. That Gmail app password must be revoked in that Google account; the old JWT secret is no longer used anywhere.
  - The root `package.json` (only `axios`, unused) was deleted.

---

## 7. Phased Build Plan

Each phase lists its goal, key tasks, and Definition of Done. "No dummy data" is a Definition-of-Done line in every phase that touches the frontend — it is not optional polish at the end.

### Phase 0 — Audit & Baseline
**Goal:** Replace every "Unknown" in §1 with a fact, before changing any code.
**Tasks:** Inventory `/backend` and `/frontend` structure and dependencies; identify what's real vs. stubbed; grep for existing mock/dummy data patterns; confirm frontend framework; produce `AUDIT.md`.
**Done when:** `AUDIT.md` exists and every open question in §1 has an answer.
**Status: done.** See `AUDIT.md`.

### Phase 1 — Foundation & Hygiene
**Goal:** Clean base to build on.
**Tasks:** §6 checklist; env var validation at startup (fail fast if a required var is missing, e.g. via `envalid`); centralized error-handling middleware; `helmet` + `express-rate-limit` on the API.
**Done when:** Server refuses to start with a missing required env var instead of failing silently later; hygiene checklist fully checked.
**Status: done.** `validateConfig` refuses to start without required vars (and refuses console email in production); central error handler; helmet with a strict CSP; rate limits; startup fails if Mongo or Redis is unreachable.

### Phase 2 — Auth & User Management
**Goal:** Real OTP + JWT flow end to end.
**Tasks:** Implement the five auth endpoints from §5; password hashing (bcrypt/argon2id); OTP stored in Redis with TTL (D5); refresh-token rotation; RBAC middleware gating routes by `role`.
**Done when:** A new user can register, receive a real OTP email, verify it, and receive a working access+refresh token pair — no hardcoded OTP, no bypass in non-dev environments.
**Status: done.** Register, password + emailed OTP (hashed in Redis, TTL, attempt limits), 15-min JWT + rotating HttpOnly refresh cookie, logout with blacklist, change password, role + trust-score + approval checks in `requireRole`. Verified: tests, and the real OTP flow in the browser (console transport; live Gmail delivery needs the owner's app password).

### Phase 3 — Appointments
**Goal:** Real booking flow.
**Tasks:** Doctor slot/availability model; double-booking prevention (per paper §7.2's `AppointmentController` intent); the five appointment endpoints from §5.
**Done when:** Booking an already-taken slot is rejected by the backend, not just hidden in the UI.
**Status: done.** Slots from each doctor's availability; a partial unique index on (doctor, start) makes a double booking fail in the database (409), tested including a race.

### Phase 4 — Medical Records & Consent
**Goal:** Records with real access control.
**Tasks:** Record CRUD; grant/revoke-access endpoints with expiry (per §7.1); every record read/write emits a ledger entry (Phase 5 dependency — stub the call now, wire it in Phase 5).
**Done when:** A doctor without an active, unexpired grant gets a `403`, not just a hidden UI element.
**Status: done.** Patient-level consent with expiry, request/approve/deny/revoke, audited break-glass. A doctor without an active grant gets 403 (tested).

### Phase 5 — Ledger Layer
**Goal:** Make D2 real.
**Tasks:** Build the hash-chain service from §4.3; wire it into every record/appointment/claim mutation; `GET /records/:id/ledger-history`; a verification routine that walks the chain and flags tampering.
**Done when:** Manually editing a record in the database (bypassing the API) is detectable by the verification routine.
**Status: done.** Two SHA-256 hash chains (`records`, `access`), entity verification, `npm run ledger:verify`, admin "Verify ledger". `npm run demo:tamper` edits a record in MongoDB and verification flags it (tested and shown in the browser).

### Phase 6 — File Storage
**Goal:** Make D3 real.
**Tasks:** `multer` upload handling, size/type limits; GridFS (or chosen alternative) storage; SHA-256 hash written into the linked ledger entry; `GET /files/:fileId` gated by the same consent check as records.
**Done when:** An uploaded file's hash in the ledger matches a fresh hash of the stored file, and access is consent-gated.
**Status: done.** multer (type and size limits) into GridFS; SHA-256 stored on the record and in the ledger; downloads are consent-gated and re-hashed on verify (tested).

### Phase 7 — Insurance Claims
**Goal:** Build this module — nothing in the current repo evidence suggests it exists yet.
**Tasks:** The five claims endpoints from §5; claim status state machine (submitted → under review → approved/denied → settled); settlement history; basic financial report generation.
**Done when:** A patient can submit a claim and an insurance-agent account can see it, act on it, and the status change is reflected back to the patient — real round trip, not a static list.
**Status: done.** Claims from bills, state machine submitted → under_review → approved/denied → settled, settlements, reports; every change is a ledger entry and notifies the patient (tested, and run through the agent UI).

### Phase 8 — Admin Module
**Goal:** Build this module.
**Tasks:** User management, doctor credential verification, system stats aggregation, hospital settings — the six admin endpoints from §5.
**Done when:** Verifying a doctor in the admin UI actually flips `isVerified` in the database and changes what that doctor can do.
**Status: done.** Users (search, activate/deactivate with session revocation, create staff), doctor/agent verification, live stats, hospital settings, access audit, IoT device registry.

### Phase 9 — Frontend Integration, All Four Dashboards
**Goal:** Every screen backed by a real API call. This is the phase where "no dummy data" gets enforced hardest — see §8.
**Tasks:** Wire Patient, Doctor, Admin, and Insurance Agent dashboards to the real endpoints from §5; Redux Toolkit slices per role (extending the paper's `authSlice` pattern, §7.3); real loading/empty/error states; remove every hardcoded array, fixture file, or `setTimeout`-simulated call.
**Done when:** §8's checklist passes for all four dashboards.
**Status: done (vanilla JS, see D4).** All four dashboards and the homepage/login read only from the API; §8 checklist verified in the browser.

### Phase 10 — Testing, Security & Performance
**Goal:** Meet the paper's own QA bar (§6.3).
**Tasks:** Jest unit tests + Supertest integration tests on backend routes; React Testing Library component tests on frontend; an OWASP ZAP pass against a running staging instance; basic load check against the <200ms API / <2s page-load targets.
**Done when:** Coverage and the specific QA targets in §6.3 are met, not just "tests exist."
**Status: partly done.** 105 backend tests (Jest + Supertest against real Mongo/Redis, ~93% line coverage) and 20 frontend tests pass. **Not done:** the OWASP ZAP scan and the load test against the 200 ms / 2 s targets.

### Phase 11 — Deployment & CI/CD
**Goal:** Match the paper's §8.2 environments.
**Tasks:** `Dockerfile`s for backend and frontend, `docker-compose.yml` including Mongo + Redis; GitHub Actions pipeline (lint → test → build → deploy to staging); documented production checklist (secrets rotation, `NODE_ENV=production`, CORS locked to the real frontend origin).
**Done when:** A fresh clone of the repo can go from `docker-compose up` to a working local stack with one documented command sequence.
**Status: partly done.** `Dockerfile`, `docker-compose.yml` (Mongo + Redis + API) and `.github/workflows/ci.yml` (backend tests with Mongo/Redis services, frontend tests, Docker build). Verified locally: `docker compose up --build` starts a healthy stack, seeds and passes `ledger:verify`. **Not done:** deploy-to-staging (no staging environment exists); the CI workflow has not run on GitHub yet.

---

## 8. "No Dummy Data" — Acceptance Checklist

Run this against each of the four dashboards before calling Phase 9 done:

- [x] Stop the backend process. The dashboard shows a real network-error state — it does **not** keep rendering data from a previous load or a fixture.
- [x] Create a brand-new account with nothing in it yet. Every list (appointments, records, claims) shows a real empty state, not placeholder rows.
- [x] Search the entire `/frontend` source for `mockData`, `dummyData`, `fakeData`, `sampleData`, hardcoded object/array literals standing in for API responses, and `setTimeout`-wrapped fake fetches. Every hit is either deleted or was a legitimate one-time seed script (see below), not shipped UI code.
- [x] Every number shown on the Admin stats screen changes when the underlying data changes — it isn't a static figure.
- [x] A **seed script** (e.g. `backend/scripts/seed.js`) that inserts realistic demo data straight into the database for local development/demo purposes is fine and encouraged — the constraint is that the *application code* never fabricates data itself.

---

## 9. Improvements Beyond the Original Paper

| Improvement | Why | Phase |
|---|---|---|
| Redis-backed OTP + rate limiting | Formalizes D5 instead of leaving it unexplained | 2 |
| `helmet` + `express-rate-limit` | Paper never mentions basic API hardening | 1 |
| Startup env-var validation | Fail fast instead of mysterious runtime errors | 1 |
| Input validation (Joi/Zod) on every route | Paper's error handling section lists codes but not a validation strategy | 2–8 |
| Centralized error-handling middleware | Consistent error shape across all endpoints | 1 |
| Structured logging (Winston, rotated, **not** committed to git) | The current repo commits raw `/logs` — that's a hygiene bug, not a feature | 1 |
| OpenAPI/Swagger docs generated from the code | Nothing in the paper describes how the API is documented for the team itself | 8–9 (ongoing) |
| Refresh-token rotation + logout invalidation | Paper mentions JWT but not a refresh strategy — this repo's `.env` already implies one | 2 |
| Dependency vulnerability scanning in CI | Not in paper's §8.2 pipeline description | 11 |
| Accessibility pass (contrast, keyboard nav, form labels) on all four dashboards | Paper's UX section is silent on accessibility | 9 |

---

## 10. Updated Risk Register (extends paper §5.3)

| Risk | Level | Mitigation |
|---|---|---|
| Hyperledger Fabric complexity | Medium–High | Defaulted away via D2; Fabric is optional stretch scope, not a blocker |
| Paper/repo gap larger than the team assumed | High | This plan's Phase 0 forces a real audit before estimating remaining work |
| Single point of knowledge per domain (paper's team table assigns one owner each) | Medium | PR review across the team; README + this plan act as shared documentation |
| Secret hygiene (Gmail app password, JWT secrets, Mongo URI) | Medium | §6 hygiene checklist; rotate anything ever committed to `.env` |
| "Trust score" thresholds shipping unexplained (D6) | Medium | Must be resolved — designed or deleted — no later than Phase 1 |

---

## 11. Where PROMPT.md Fits

`PROMPT.md` turns each phase above into a ready-to-paste prompt for an AI coding agent working directly in this repo, in the same order, with the same Definition-of-Done bar. Run Phase 0 first no matter what — everything after it depends on facts it produces.
