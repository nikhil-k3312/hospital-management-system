# MediChain — Phase 0 Audit

**Date:** August 5, 2026
**Scope:** Read-only investigation. No application code was modified.
**Commit audited:** `f875a0d` (upstream `nikhil-k3312/hospital-management-system`, `main`)
**Method:** Local clone, full file read of `backend/`, targeted read of `frontend/`, grep sweeps, dependency diff, one isolated runtime repro.

> Organized to mirror `PLAN.md` §1. Section 4 answers every "Unknown" in `PLAN.md` §1; section 6 lists where the plan's assumptions were wrong.

---

## 0. Headline

Three findings drive everything else:

1. **The frontend never talks to the backend.** There is not one `fetch`, `axios`, `XMLHttpRequest`, or `/api/` reference in the entire `frontend/` tree. Login is simulated client-side and accepts essentially any credentials. Every dashboard renders from hardcoded literals.
2. **The backend is one auth service and nothing else.** No appointments, records, claims, admin, ledger, or file module exists. 6 of the 30 endpoints in `PLAN.md` §5 are implemented.
3. **The auth service that does exist is good** — genuinely better than `PLAN.md` assumes. Real bcrypt, real Redis-backed hashed OTP, real Nodemailer, JWT access/refresh with revocation, Joi validation, helmet, rate limiting, and a documented zero-trust/ABAC layer. Several `PLAN.md` Phase 1 and Phase 2 tasks are already done.

The gap is not "backend needs polish." It is that **~80% of the API surface and 100% of the frontend-to-backend wiring does not exist yet.**

---

## 1. Repository Inventory

### 1.1 Top level

| Path | Contents | Notes |
|---|---|---|
| `backend/` | `package.json` (winston only), `logs/`, `node_modules/`, `services/auth/`, `shared/utils/logger.js` | Only one service |
| `frontend/` | 5 HTML, 2 JS, 2 CSS | No `package.json`, no build tooling |
| `docs/` | `zero-trust-improvement-ideas.md` | **Not known to `PLAN.md`** — documents the trust score |
| `logs/` | `combined.log`, `error.log` | Committed to git |
| `node_modules/` | 4,439 files | Committed to git |
| `zerotrust.html` | 51 KB, 955 lines | **Not in `PLAN.md`'s inventory.** Standalone demo |
| root | `.env.example`, `.gitignore`, `package.json`, `package-lock.json` | No `README.md` |

### 1.2 Backend — `backend/services/auth/`

Structure is `src/{config,controllers,middleware,models,routes,services}` — conventional and clean.

| File | LOC | What it does | Real? |
|---|---|---|---|
| `src/app.js` | 187 | Express bootstrap, helmet, CORS, rate limiters, health check, 404 + error handler, graceful shutdown | Real |
| `src/controllers/authController.js` | 509 | register, requestOTP, verifyOTP, getCurrentUser, logout, refreshToken, changePassword | Real (see bug 5.1) |
| `src/middleware/authMiddleware.js` | 278 | JWT verify, Redis session cache, trust scoring, `requireRole` | Real (`requireRole` unused) |
| `src/middleware/validation.js` | 153 | Joi schemas for register/login/OTP/change-password | Real |
| `src/models/User.js` | 112 | Mongoose user, bcrypt pre-save hook, `toJSON` scrubbing | Real |
| `src/services/tokenService.js` | 148 | JWT issue/verify, jti hashing, Redis blacklist + refresh revocation | Real |
| `src/services/otpService.js` | 140 | `crypto.randomInt` OTP, SHA-256 hashed, Redis TTL, attempt counters | Real |
| `src/services/emailService.js` | 346 | Nodemailer transport, OTP + welcome emails | Real |
| `src/services/trustService.js` | 131 | Trust scoring + ABAC policy evaluation | Real (partly unused) |
| `src/services/auditService.js` | 76 | Hash-chained JSONL access-decision log | Real (file-based) |
| `src/services/redis.js` | 33 | Shared Redis client | Real (see bug 5.5) |
| `src/config/config.js` | 52 | env → config, required-var check | Real |
| `src/test.js` | 11 | Prints config values | **Not a test** |
| `test-api.js` / `test-complete.js` / `test-mongodb.js` / `test-redis.js` | 1,057 | Interactive axios + readline scripts | **Not automated tests** |

**Dependencies** (`backend/services/auth/package.json`): express, mongoose, jsonwebtoken, bcryptjs, nodemailer, redis, dotenv, cookie-parser, cors, helmet, express-rate-limit, joi, winston; dev: nodemon.
**No Jest, Mocha, Supertest, or any assertion library anywhere in the repo.**

### 1.3 Frontend — `frontend/`

| File | LOC | Role | Data source |
|---|---|---|---|
| `homepage.html` + `homepagescript.js` + `homepagestyle.css` | 1,761 | Marketing landing page | Static content |
| `login.html` + `loginscript.js` + `loginstyle.css` | 1,524 | Login / OTP / biometric | **Fully simulated** |
| `index (2).html` | 2,265 | **Admin Dashboard** | Hardcoded HTML literals |
| `index (3).html` | 961 | **Doctor Dashboard** | Hardcoded `AppData` |
| `index (4).html` | 1,967 | **Patient Portal** | Hardcoded `AppData` |

Filenames `index (2)`, `index (3)`, `index (4)` are browser-download artifacts and should be renamed.

**There is no Insurance Agent dashboard.** Three of the four required dashboards have a UI; the fourth does not exist in any form.

---

## 2. Endpoint Coverage vs. `PLAN.md` §5

**6 of 30 implemented (20%).** All existing routes are prefixed `/api/auth`.

| `PLAN.md` §5 | Actual | Status |
|---|---|---|
| `POST /auth/register` | `POST /api/auth/register` | ✅ |
| `POST /auth/login/request-otp` | `POST /api/auth/login` | ✅ *renamed* |
| `POST /auth/login/verify-otp` | `POST /api/auth/verify-otp` | ✅ *renamed* |
| `POST /auth/refresh-token` | `POST /api/auth/refresh` | ⚠️ *renamed; no rotation (5.2)* |
| `POST /auth/logout` | `POST /api/auth/logout` | ⚠️ *broken (5.1)* |
| `GET /users/me` | `GET /api/auth/me` | ✅ *renamed* |
| `PATCH /users/me` | — | ❌ |
| All 5 Appointments | — | ❌ |
| All 5 Records | — | ❌ |
| All 2 Files | — | ❌ |
| All 5 Claims | — | ❌ |
| All 6 Admin | — | ❌ |
| — | `POST /api/auth/change-password` | ➕ *extra, not in plan* |

Naming is consistent within itself but diverges from `PLAN.md` §5 throughout. **Decision needed before Phase 2** (see section 7).

---

## 3. Per-Role End-to-End Status

The honest answer for all four roles is the same: **nothing works end-to-end, because no screen is connected to the API.**

| Role | UI exists | Backend exists | End-to-end | Detail |
|---|---|---|---|---|
| **Patient** | Yes — `index (4).html` | Auth only | ❌ None | Vitals, appointments, records, billing all from `AppData` (lines 1043–1374) |
| **Doctor** | Yes — `index (3).html` | Auth only | ❌ None | Patients, schedule from `AppData` (lines 485–511) |
| **Admin** | Yes — `index (2).html` | Auth only | ❌ None | Every stat is an HTML literal; 25 static `<tr>` rows |
| **Insurance Agent** | **No** | Auth only | ❌ None | Role exists in the User enum and login test config only |

The auth backend does support all four roles at the model level (`enum: ['patient','doctor','admin','insurance']`), so role-based login is buildable immediately — it is simply never called.

---

## 4. Resolving `PLAN.md` §1's "Unknown" List

| Question | Answer |
|---|---|
| What models/routes/controllers exist? | One `User` model, one auth router (7 routes), one controller, 7 services, 2 middleware. Nothing else. |
| What's real vs. stubbed? | Auth is real and reasonably complete. Everything else is absent — not stubbed, absent. |
| **Is the frontend React?** | **No.** Vanilla multi-page HTML + inline `<script>` + two external JS files. No React, no JSX, no `import`/module scripts, no bundler, no `package.json`, no build step. |
| **Does it use Redux Toolkit?** | **No.** State is plain objects (`AppState`, `AppData`, `App.state`). |
| Which paper features work end-to-end? | Server-side: OTP login. Through the UI: none. |
| Where does dummy data live? | See section 5.6 — full inventory. |
| **D6 — trust score: real feature or leftover?** | **(a) A real, deliberate, documented feature.** `docs/zero-trust-improvement-ideas.md` specifies it; `trustService.js` implements it. **Do not delete it.** |

### 4.1 On D6 in particular

`PLAN.md` §3 suspected `MIN_TRUST_SCORE` might be "leftover config inherited from the upstream template" and flagged it as a Medium risk needing resolution by Phase 1. It is not leftover. `docs/zero-trust-improvement-ideas.md` documents an eight-point zero-trust design, of which five points are marked implemented, and `trustService.js` delivers:

- `calculateTrustScore()` — scores each request from verified state, recent failed attempts, missing user-agent, and session age; bounded 0–100.
- `evaluatePolicy()` — RBAC role check, then ABAC checks on trust threshold, verified state, and time-of-day window.
- **Emergency break-glass** — a `x-break-glass-reason` header lets doctor/admin bypass policy, and the bypass is audited.
- `auditService` — append-only JSONL, each entry hash-chained to the previous.

This is a genuine contribution beyond the paper, and it partly pre-empts Phase 5: **a working hash-chain audit log already exists**, just file-based rather than in Mongo. The docs file explicitly anticipates "later blockchain anchoring." Phase 5 should extend this design, not invent a parallel one.

Two caveats: `HIGH_SENSITIVITY_TRUST_SCORE` is only ever *reported* in a response body, never *enforced* (`trustService.js:52`); and `requireRole` is never applied to a route, so the ABAC layer is currently dead code.

---

## 5. Defects and Risks Found

### 5.1 `this` is undefined in five route handlers — logout is broken *(High)*

`authRoutes.js` passes class methods as bare references (`authController.logout`), losing `this`. Class bodies are strict-mode, so `this` is `undefined`, not the instance.

Reproduced in isolation:

```
TypeError: Cannot read properties of undefined (reading 'getBearerToken')
```

- `logout` — **fails on the happy path** (`authController.js:338`). Logout is non-functional.
- `requestOTP` — fails on wrong password (`:142`) and in the catch block (`:176`).
- `verifyOTP` — fails on wrong OTP (`:221`, `:283`).
- `refreshToken`, `changePassword` — fail in their catch blocks (`:427`, `:478`).

Net effect: the account-lockout mechanism never actually locks an account, because the failure path throws before it can increment. Fix is one line at the router (`.bind()`) or arrow-function class properties.

### 5.2 Refresh-token rotation is not implemented *(High — Phase 2 requirement)*

`refreshToken` (`authController.js:392`) issues a new access token but leaves the refresh token unchanged: no new refresh token, no revocation of the old jti, no `refreshTokens` array update. `PLAN.md` Phase 2 and §9 both require rotation. The building blocks (`revokeRefreshToken`, `hashJTI`, the 5-token cap) all exist and are unused here.

### 5.3 Repo as-cloned does not boot *(High)*

`node_modules` is committed **and stale**: `cookie-parser` is declared in `package.json` but absent from the committed tree. A fresh clone dies at `src/app.js:6` with `MODULE_NOT_FOUND`. This is exactly the failure mode that committing `node_modules` produces.

### 5.4 `secure: true` cookie blocks local dev *(Medium)*

`res.cookie('refreshToken', …, { secure: true })` (`authController.js:266`) is unconditional. Browsers drop `Secure` cookies over plain `http://localhost`, so the refresh flow cannot work in local development. Should be `secure: config.nodeEnv === 'production'`.

### 5.5 Redis connection failure is swallowed *(Medium)*

`redis.js:22` catches connection errors and only logs. The service starts "successfully" with no Redis, then every authenticated request returns 503. Fails late and confusingly — `PLAN.md` Phase 1's fail-fast goal should cover this too.

### 5.6 Mock / simulated data inventory *(the Phase 9 worklist)*

**Zero real network calls exist in `frontend/`.** Confirmed by grep for `fetch(`, `axios`, `XMLHttpRequest`, `localhost:8001`, `/api/` — no hits.

Note that `PLAN.md` §8's suggested grep terms (`mockData`, `dummyData`, `fakeData`, `sampleData`) find **nothing** here — the fake data does not use those names. Searching for those terms alone would produce a false all-clear.

| File | Lines | What |
|---|---|---|
| `loginscript.js` | 9–37 | `TEST_CONFIG.USERS` — four hardcoded accounts with plaintext passwords (`Patient123!`, `Doctor123!`, `Admin123!`, `Insurance123!`) |
| `loginscript.js` | 282–294 | `_authenticateUser` — **accepts any user ID with any 8+ character password**; comment admits "this would make an API call" |
| `loginscript.js` | 296–303 | `_simulateAPICall` — `setTimeout` + `Math.random() < 0.02` fake failures |
| `loginscript.js` | 315–330 | OTP generated **client-side** and **displayed on screen** |
| `loginscript.js` | 431–437 | `_simulateAuthDelay` — fake biometric/passkey auth, `Math.random() < 0.1` failure |
| `loginscript.js` | 420 | Hardcoded local PIN `1234` |
| `index (4).html` | 1043–1374 | `AppData` — 331 lines: patient identity, vitals, appointments, records, billing |
| `index (3).html` | 485–511 | `AppData` — doctor identity, 4 patients with names/DOB/conditions, schedule |
| `index (2).html` | markup | Admin stats as literals: `42`, `587`, `68`, `1,254`, `45,786`, `100%`, `95%` |
| `index (2).html` | 2203, 2235 | Chart.js datasets hardcoded `[42, 58]`, `[67, 33]` |
| `index (2).html` | ~25 rows | Static `<tr>` user/audit table rows |

The dashboards contain **realistic fake patient data** (names, DOBs, diagnoses). It is fabricated, not real PHI, but it should not survive into a demo.

### 5.7 Hygiene *(matches `PLAN.md` §6, with one correction)*

- 4,439 `node_modules` files tracked; `logs/*.log` and `backend/logs/*.log` tracked.
- `.gitignore` **already lists** `node_modules/`, `logs/`, `.env` correctly — the files were committed before it existed, so `git rm -r --cached` is all that's needed.
- **No real `.env` has ever been committed** — only `.env.example`. Checked across tracked files.
- The committed logs contain only two lines of harmless test output — no secrets, no PII.

**This meaningfully reduces `PLAN.md` §6's last item and §10's "Secret hygiene" risk: there is no evidence any secret was ever committed, so no rotation is required.** Worth confirming against the private fork's full history before closing it out.

---

## 6. Discrepancies vs. `PLAN.md` §1's "Confirmed from repo"

| `PLAN.md` §1 says | Actual | Impact |
|---|---|---|
| Root contains `/backend`, `/frontend`, `/docs`, `/logs`, `/node_modules`, … | Correct, **plus an unlisted `zerotrust.html`** (955 lines) at root | Minor — but it is an undocumented artifact needing an owner |
| "3 commits on this fork (4 upstream)" | Correct. Upstream = fork + `zerotrust.html`; the fork's work is already merged upstream via PR #1 | The two repos have **not** diverged; either is a safe base |
| Root `package.json` "is not a real workspace root" | Correct — but its lone `axios` is **actually used**, by the four `test-*.js` scripts via Node's upward module resolution | Deleting it outright breaks those scripts |
| "JS share low → likely not React. **Needs local confirmation**" | **Inference confirmed.** Vanilla multi-page HTML, no framework, no build step | D4 resolved — no rewrite risk to weigh, there is nothing to preserve |
| `MIN_TRUST_SCORE` has "no explanation anywhere" | **Wrong.** Fully documented in `docs/zero-trust-improvement-ideas.md` and implemented in `trustService.js` | D6 resolved as "(a) real feature." Risk register entry can be closed |
| "No Hyperledger / IPFS / S3 config" | Correct — and no such code either. Only vestige is an Ethereum-address regex on `walletAddress` (`validation.js:31`) | D2/D3 stand as written |
| §10 risk: "rotate anything ever committed to `.env`" | No `.env` was ever committed | Risk closable after a fork-history check |
| Phase 1 plans to *add* helmet, rate limiting, error middleware, env validation | **All four already exist** (`app.js:19`, `:35`, `:116`, `config.js:46`) | Phase 1 is smaller than planned — it becomes *verify and extend*, not *build* |
| Phase 7 assumes claims "likely doesn't exist" | Confirmed — no trace | As planned |

---

## 7. Decisions Needed Before Phase 1

These are genuine forks in the road that the plan does not yet answer. Flagging rather than assuming:

1. **Endpoint naming.** Existing routes are `/api/auth/login`, `/api/auth/verify-otp`, `/api/auth/refresh`, `/api/auth/me`. `PLAN.md` §5 specifies `/auth/login/request-otp`, `/auth/login/verify-otp`, `/auth/refresh-token`, `/users/me` — and no `/api` prefix. Since no client calls these yet, renaming is **free right now** and will never be cheaper. Recommend conforming to `PLAN.md` §5 with an `/api` prefix, and updating §5 to record the prefix.

2. **Role enum.** Code uses `'insurance'`; `PLAN.md` §4.1 specifies `'insurance_agent'`. Trivial now, migration later. Recommend aligning code to the plan.

3. **User schema drift.** Code has `walletAddress` (plan: `ledgerAddress`) plus `fullName`, `lastLogin`, `failedLoginAttempts`, `accountLockedUntil`, `refreshTokens` — all load-bearing for lockout and token revocation. Recommend keeping the extra fields, renaming `walletAddress` → `ledgerAddress`, and updating `PLAN.md` §4.1 to match reality. The Ethereum-address regex should be dropped with D2.

4. **Service layout.** Backend is `backend/services/<name>/` (microservice-shaped) with per-service `package.json`. Phases 3–8 add six modules. Continuing the pattern means six more services to boot and deploy; a single `backend/services/api/` with internal modules is far simpler for a capstone. **This needs a decision before Phase 3** — `PLAN.md` §3 does not cover it. Recommend one service with internal modules.

5. **Insurance Agent dashboard.** Does not exist. Phase 9 as written says "wire the four dashboards"; for this role it is build-from-scratch. Should be scoped explicitly.

6. **`zerotrust.html`.** A 955-line standalone demo at the repo root, undocumented and unreferenced. Keep as a demo (move to `docs/`), fold into the real UI, or delete?

7. **Frontend rebuild scope.** D4 assumed a possible tradeoff between rewriting and extending. There is no substantial non-React implementation to preserve *functionally* — but there are ~5,000 lines of genuinely polished HTML/CSS. Recommend rebuilding in React per D4 while **porting the existing markup and styling**, so the visual work is not thrown away.

---

## 8. Recommended Adjustments to the Plan

- **Phase 1 shrinks.** helmet, rate limiting, error middleware, and env validation already exist. Phase 1 becomes: verify/extend those (add `EMAIL_USER`/`EMAIL_FROM` to the required list, move the check in `config.js` above the export, fail fast on Redis), untrack `node_modules`/`logs`, write the README, and fix defects 5.1–5.5.
- **Phase 2 shrinks but does not vanish.** OTP + JWT is largely built. Real work: rotation (5.2), the `this` bug (5.1), applying `requireRole` to routes, `PATCH /users/me`, endpoint renaming, and the entire Jest/Supertest suite — which does not exist at all.
- **Phase 5 should extend `auditService`, not replace it.** A hash-chained append-only log already exists and is already documented as a blockchain-anchoring precursor. Moving it to a Mongo collection and generalizing it to records/appointments/claims is a smaller, better-grounded task than building fresh.
- **Phase 9 is much larger than planned.** It is not "wire up dashboards" — it is a full React rebuild of three dashboards plus a from-scratch fourth, plus every API client. This is the critical-path phase and should be estimated accordingly.
- **Add a test-infrastructure task early.** No test framework is installed. Phases 2–8 each require Supertest coverage, so Jest + Supertest setup should land in Phase 1, not be improvised per phase.

---

## 9. What Was Verified, and How

| Claim | Verification |
|---|---|
| Frontend makes zero API calls | `grep -rnE "fetch\(|axios|XMLHttpRequest|localhost:8001|/api/" frontend/` → no matches |
| Frontend is not React/Redux | `grep -rlE "from 'react'|ReactDOM|<script type=\"module\""` → no matches; no `package.json`, no bundler |
| `this` binding bug | Reproduced in an isolated Node script — `TypeError` as documented in 5.1 |
| Repo won't boot | Ran `node src/app.js` → `MODULE_NOT_FOUND: cookie-parser`; confirmed by diffing declared deps against committed `node_modules` |
| No `.env` ever committed | `git ls-files | grep -i "\.env"` → only `.env.example` |
| `requireRole` unused | `grep -rn "requireRole" src/` → only definition, export, and its own doc comment |
| `HIGH_SENSITIVITY_TRUST_SCORE` unenforced | `grep -rn "highSensitivity"` → config read + response field only |
| No test framework | No Jest/Mocha/Supertest in any `package.json`; no `describe`/`it`/`expect` in any file |
| node_modules / logs tracked | `git ls-files` → 4,439 `node_modules` entries, 4 log files |
| Committed logs are clean | Read all 182 lines — test output only |
| Upstream vs. fork identical bar one file | `git diff --stat origin/main fork/main` → `zerotrust.html` only |

**Not verified** (requires credentials or a running stack, deliberately out of scope for a read-only audit): live OTP email delivery, MongoDB Atlas connectivity, Redis behavior under load, and whether the private fork's full history ever contained a real `.env`.

---

## 10. Bottom Line

`PLAN.md`'s §2 "central inconsistency" is real but understated. The paper-vs-repo gap on blockchain and Postgres is genuine — and there is a second, larger gap the plan did not know about: **the frontend is a self-contained simulation with no backend connection at all.** Meanwhile the team has built something the paper never asked for and the plan nearly deleted — a documented zero-trust access layer with a hash-chained audit log — which is both good work and a running head start on Phase 5.

Realistically: Phases 1 and 2 are substantially pre-built, Phases 3–8 are greenfield against a solid auth foundation, and Phase 9 is the critical path.
