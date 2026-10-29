# MediChain — Project Instructions

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

## Phase 0 findings (see AUDIT.md for full detail)

- Frontend is **vanilla multi-page HTML/CSS/JS** — not React, no Redux, no build
  step. It makes **zero** network calls; login and all dashboard data are
  simulated client-side.
- Backend is **one auth service only** (`backend/services/auth/`). 6 of the 30
  endpoints in PLAN.md section 5 exist. Appointments, records, claims, admin,
  ledger, and file storage do not exist.
- The auth service is real and solid: bcrypt, Redis-backed hashed OTP,
  Nodemailer, JWT with revocation, Joi validation, helmet, rate limiting.
- **D6 is resolved: the trust score is a real, documented feature**
  (`docs/zero-trust-improvement-ideas.md` + `src/services/trustService.js`).
  Do not delete it. Its hash-chained audit log is a head start on Phase 5 —
  extend `auditService`, don't build a parallel ledger.
- Known defects to fix in Phase 1: `this`-binding bug in route handlers
  (logout is broken), no refresh-token rotation, stale committed node_modules
  (repo won't boot), unconditional `secure: true` cookie, swallowed Redis
  connection failure.
- No test framework is installed anywhere. Jest + Supertest setup should land
  in Phase 1.
