# MediChain

A hospital management platform for four kinds of users (patients, doctors,
administrators and insurance agents), built on a zero-trust security model
and a tamper-evident hash-chain ledger.

* **Patients** book appointments, read their medical records, decide which
  doctors may see them, track medications and home-monitoring vitals, pay
  bills and file insurance claims.
* **Doctors** manage their schedule, request consent, write and amend records,
  attach files, prescribe, watch live IoT vitals, and use audited
  "break-glass" access in an emergency.
* **Administrators** verify doctors and agents, manage users and IoT devices,
  configure the hospital, read the access audit and verify the whole ledger.
* **Insurance agents** work the claims queue through a strict state machine,
  record settlements and read financial reports.

Every create, change and access decision is written to a SHA-256 hash chain.
Any edit made directly in the database, bypassing the API, is detected by
"Verify ledger".

Full documentation, with code walk-throughs of every module:
[docs/documentation/medichain-documentation.pdf](docs/documentation/medichain-documentation.pdf).
The step-by-step demo script is in [docs/DEMO.md](docs/DEMO.md).

## Tech stack (as built; see PLAN.md §3)

| Layer | Choice |
|---|---|
| API | Node.js 18+, Express 4, one service: `backend/services/api` |
| Database | MongoDB (Mongoose 8); files in GridFS |
| Ledger | Hash chain inside MongoDB (`ledgerentries`), two chains: `records` and `access` |
| Sessions / OTP | Redis: hashed OTPs with TTL, refresh-token rotation, JWT blacklist, session cache |
| Auth | Password + emailed OTP → 15-minute JWT access token + HttpOnly rotating refresh cookie |
| Email | Nodemailer (Gmail SMTP) |
| Frontend | Vanilla HTML/CSS/JS served by the API on the same origin (no build step) |
| Tests | Jest + Supertest (backend, against real Mongo and Redis); Jest + jsdom + Testing Library (frontend) |

## Repository layout

```
backend/services/api/      the API (src/), tests/, scripts/ (seed and demo tools)
frontend/                  homepage, login, four role dashboards (css/, js/), tests/
docs/                      documentation (LaTeX + PDF), DEMO.md, zero-trust notes
Dockerfile, docker-compose.yml, .github/workflows/ci.yml
```

## Run it locally (macOS)

```bash
brew install mongodb-community redis
brew services start mongodb-community
brew services start redis
```

```bash
cp .env.example backend/services/api/.env
```

Edit `backend/services/api/.env`:

* `JWT_SECRET` and `JWT_REFRESH_SECRET`: two different values from `openssl rand -hex 64`.
* Email: for real OTP emails set `EMAIL_TRANSPORT=smtp`, `EMAIL_USER` to a
  Gmail address and `EMAIL_PASSWORD` to a Gmail **app password** (Google
  Account → Security → 2-Step Verification → App passwords). For offline
  development, `EMAIL_TRANSPORT=console` prints OTP codes to the server log
  instead (refused when `NODE_ENV=production`).
* `SEED_EMAIL_BASE`: your Gmail address. Demo accounts are created as
  plus-addresses of it (`you+patient@gmail.com`, `you+doctor@gmail.com`, ...),
  so every demo OTP lands in your one inbox.
* `SEED_DEMO_PASSWORD`: the password all demo accounts share.

```bash
cd backend/services/api
npm install
npm run seed -- --reset
npm run dev
```

Open http://localhost:8001. The server refuses to start if a required
variable is missing or Mongo or Redis is unreachable. With SMTP it also checks
the Gmail login at startup and logs `SMTP verification failed` if the app
password is wrong (logins will then fail with a clear error).

## Run it with Docker

```bash
cp .env.example backend/services/api/.env   # then fill it in as above
docker compose up --build -d
docker compose exec api node scripts/seed.js --reset
```

The compose file starts MongoDB, Redis and the API (which serves the
frontend) on port 8001. It runs with `NODE_ENV=production`, which requires
`EMAIL_TRANSPORT=smtp`; for a console-OTP trial run use
`NODE_ENV=development docker compose up --build -d`.

## Scripts (in `backend/services/api`)

| Command | What it does |
|---|---|
| `npm run dev` / `npm start` | Start the API with / without auto-reload |
| `npm test` / `npm run test:coverage` | Run the backend test suite (uses `medichain_test_*` databases and Redis DB 8–15, never your dev data) |
| `npm run seed -- --reset` | Wipe and fill the database with a demo hospital |
| `npm run demo:iot [-- --interval 2] [-- --spike]` | Stream readings from the seeded IoT devices; `--spike` sends abnormal values that raise alerts |
| `npm run demo:tamper [-- --ledger] [-- --restore]` | Edit a record (or a ledger entry) directly in MongoDB to show tamper detection, then undo it |
| `npm run ledger:verify` | Verify both chains and every protected document from the command line |

Frontend tests: `cd frontend && npm install && npm test`.

## API overview

All endpoints are under `/api`. Responses are `{ success, data | message }`.

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/register`, `/auth/login/request-otp`, `/auth/login/verify-otp`, `/auth/refresh-token`, `/auth/logout`, `/auth/change-password` |
| Public | `GET /settings/public`, `GET /public/stats` |
| Users | `GET/PATCH /users/me`, `GET /doctors`, `GET /doctors/:id/available-slots`, `GET /patients`, `GET /patients/search` |
| Appointments | `POST/GET /appointments`, `GET/PATCH/DELETE /appointments/:id` |
| Consent | `GET /consents`, `POST /consents/request`, `/consents/grant`, `/consents/:id/approve`, `/deny`, `/revoke` |
| Records | `POST/GET /records`, `GET/PATCH /records/:id`, `GET /records/:id/ledger-history`, `GET /records/:id/verify`, `POST /records/:id/files`, `GET /files/:fileId` |
| Prescriptions | `POST/GET /prescriptions`, `POST /prescriptions/:id/refill-request`, `PATCH /prescriptions/:id` |
| Vitals / IoT | `POST /devices/readings` (device key), `POST/GET /vitals`, `GET /vitals/monitor`, `GET /devices/mine` |
| Billing | `GET /bills`, `POST /bills/:id/pay` |
| Claims | `POST/GET /claims`, `GET /claims/settlements`, `GET /claims/reports`, `GET/PATCH /claims/:id` |
| Notifications | `GET /notifications`, `PATCH /notifications/:id/read`, `POST /notifications/read-all` |
| Admin | `GET/POST /admin/users`, `PATCH /admin/users/:id`, `GET /admin/doctors/pending-verification`, `PATCH /admin/doctors/:id/verify`, `GET /admin/stats`, `GET/PATCH /admin/settings`, `GET /admin/audit`, `GET/POST /admin/devices`, `PATCH /admin/devices/:id` |
| Ledger | `GET /ledger/stats`, `GET /ledger/entries`, `GET /ledger/verify` |

## Production checklist

* `NODE_ENV=production`, `EMAIL_TRANSPORT=smtp`, fresh JWT secrets, a real
  Gmail app password (or another SMTP provider).
* Serve over HTTPS (the refresh cookie is `Secure` in production).
* `ALLOWED_ORIGINS` set to the real frontend origin(s) only.
* MongoDB and Redis on private networks with authentication enabled.

## CARMA paper version (branch `paper/carma`)

This branch is the code described in the Objective 1 journal paper (CARMA: Context-Aware,
Risk-adaptive Multi-layer Authentication). Changes compared with Version 3, by problem number
of the improvement plan:

| # | Change | Where |
|---|---|---|
| 1 | The first-login endpoints (`/login/request-otp`, `/login/verify-otp`) refuse accounts that already signed in (`USE_DYNAMIC_LOGIN`) | `auth.controller.js` |
| 2 | Authenticator app (TOTP, RFC 6238) replaces the security question at high risk; set-up only in a fresh, non-emergency session; no high-risk sign-in without it (patients, agents) or only the emergency path (verified doctors, admins) | `totpService.js`, `auth.controller.js`, `login.html` |
| 3 | IP addresses and network prefixes stored only as HMAC-SHA256 (`IP_HASH_SECRET`) | `utils/hash.js`, `auditService.js`, `contextService.js` |
| 4-5 | Possession gate (password-only needs a trusted device) and failure gate (fewer than 2 failures) | `contextService.tierFor` |
| 6 | Role thresholds (`RISK_<ROLE>_UPPER/LOWER`) and `CONTEXT_PROFILE` = carma / v3 (baseline B2) / static (baseline B1) | `config.js`, `contextService.js` |
| 7 | Session age from the sign-in time (`authTime`), maximum session `MAX_SESSION_HOURS` | `tokenService.js`, `trustService.js` |
| 8 | Refresh tokens bound to network and browser (`REAUTH_REQUIRED`) | `auth.controller.js`, `js/api.js` |
| 9 | Break-glass and emergency sign-in only for approved doctors and admins | `trustService.js`, `auth.controller.js` |
| 10 | Ledger heads of the access and records chains anchored on-chain; verification and tamper demo (`--rewrite`, `--truncate`) | `anchorService.js`, `HealthRecordRegistry.sol`, `scripts/` |
| 11 | Time windows evaluated in the hospital time zone | `trustService.js` |
| 12 | `AUDIT_EVERY_REQUEST` switch (experiment only) | `middleware/auth.js` |
| 25 | 4-validator Hyperledger Besu QBFT network | `blockchain/besu-qbft/` |
| 26 | On-chain k-of-n register of staff roles; admins approve with their own wallet | `RoleRegistry.sol`, `roleService.js`, admin page "Role Registry" |

New settings are documented in `.env.example`. Tests: `npm test` in `backend/services/api`
(new: `tests/integration/carma.test.js`, `tests/unit/totpService.test.js`) and `npx hardhat test`
in `blockchain`. Experiments: see `experiments/README.md`.
