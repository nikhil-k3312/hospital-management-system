# MediChain demo script

A 20–25 minute walk-through that shows every feature with real data. Every
screen reads from MongoDB through the API. Nothing on any dashboard is
hardcoded.

## 0. Before the demo (5 minutes, once)

1. Start the databases:
   ```bash
   brew services start mongodb-community
   ```
   ```bash
   brew services start redis
   ```
2. Configure `backend/services/api/.env` (copy `.env.example`; see the README):
   * `EMAIL_TRANSPORT=smtp`, `EMAIL_USER=you@gmail.com`,
     `EMAIL_PASSWORD=<16-character Gmail app password>`,
     `EMAIL_FROM=MediChain <you@gmail.com>`
   * `SEED_EMAIL_BASE=you@gmail.com`: all demo accounts become
     `you+admin@gmail.com`, `you+doctor@gmail.com`, ... and Gmail delivers
     all of them to your one inbox.
   * `SEED_DEMO_PASSWORD=...`: the shared demo password.

   No Gmail at hand? `EMAIL_TRANSPORT=console` prints each OTP in the server
   terminal as a `[DEV EMAIL] to=you+patient@gmail.com subject="Your MediChain login code"` block containing the code.
3. Load the demo hospital and start the server (two terminals, both in `backend/services/api`):
   ```bash
   npm run seed -- --reset
   ```
   ```bash
   npm run dev
   ```
4. Open http://localhost:8001. Use a private window per role if you want
   several roles open at the same time (each tab holds its own session).

### Demo accounts (all use `SEED_DEMO_PASSWORD`)

| Who | Email | Notes |
|---|---|---|
| Admin | `you+admin@gmail.com` | |
| Dr Ananya Iyer | `you+doctor@gmail.com` | Cardiology, Mon–Fri 9–17, ₹900 |
| Dr Rahul Menon | `you+doctor2@gmail.com` | Endocrinology; has a pending access request to Arjun |
| Dr Kavya Reddy | `you+doctor3@gmail.com` | Dermatology, **pending verification** |
| Priya Sharma | `you+agent@gmail.com` | Insurance agent, Star Health |
| Arjun Mehta | `you+patient@gmail.com` | Hypertension; consent to Dr Iyer; IoT BP monitor |
| Meera Nair | `you+patient2@gmail.com` | Type 2 diabetes; pulse oximeter |
| Rohan Gupta | `you+patient3@gmail.com` | **No consent** to anyone: the break-glass patient |

## 1. Landing page and secure login (2 min)

1. The homepage numbers (patients, doctors, completed visits, ledger blocks)
   come live from `GET /api/public/stats`.
2. **Sign in** → `you+patient@gmail.com` + password → the OTP arrives by email
   → type the 6 digits (pasting works too) → Arjun's dashboard.
3. Points to make: password + OTP = two factors; the OTP is stored only as a
   hash in Redis and expires in 10 minutes; the access token lives only in
   memory (15 min) and the refresh cookie is HttpOnly and rotated on every use.
   Reloading the page keeps you signed in through that cookie.
4. Optional: **Register** shows the three self-service roles; doctors and
   agents are created "awaiting verification".

## 2. Patient: Arjun Mehta (5 min)

* **Dashboard**: upcoming appointment, active medications, latest vitals,
  unpaid bills: all real queries.
* **Appointments** → **Book appointment** → pick Dr Ananya Iyer and a date →
  the slot grid shows live availability (taken slots are greyed) → book.
  The booking is now *pending* until the doctor confirms.
  *Double-booking is impossible:* a unique database index on
  (doctor, start time) rejects a second booking even if two people click at
  once (HTTP 409).
* **Medical Records** → open "Hypertension" → attachments with their SHA-256 →
  **Verify integrity** (green: matches the ledger) → the ledger history shows
  every create, amend and view with block numbers and hashes.
* **Permissions**: Dr Rahul Menon is *requesting* access → **Approve** (pick an
  expiry). Dr Iyer already has access → **Revoke** would cut it immediately.
* **Medications** → **Request refill** on Amlodipine (if not already pending).
* **Health Metrics**: 7 days of blood-pressure readings from the home device,
  with charts; **Add reading** for a manual entry.
* **Billing & Claims**: a paid bill with a settled claim, an unpaid one →
  **File claim** (the policy number comes from the profile).
* **Notifications** and **Profile & Security** (change password, trust score).

## 3. Doctor: Dr Ananya Iyer (5 min)

* **Dashboard**: today's appointments (seeded relative to the time you ran the
  seed), pending requests, refill queue.
* **Appointments** → Today / Upcoming / Past tabs → **Confirm** Arjun's new
  booking (switch back to Arjun to see it confirmed and notified) →
  **Complete** a confirmed visit: a bill is raised for the patient
  automatically.
* **My Patients** → **Open chart** for Arjun → records, vitals, prescriptions
  → **New record** (diagnosis, notes; sensitivity "high" needs trust score ≥ 70)
  → **Upload document** (PDF/PNG/JPEG/TXT only, 10 MB) → **Prescribe**.
* **Find patient by email** `you+patient3@gmail.com` (Rohan) → opening his
  chart is **refused (403)**: no consent. **Request access** sends him a
  request.
* **Emergency access** (red button) → give a reason ("Unconscious in ER,
  needs history") → Rohan's chart now opens under a red banner. The access is
  written to the ledger as `BREAK_GLASS_ACCESS`, and Rohan and every admin are
  notified. **Turn off** ends it.
* **Prescriptions** → approve or deny Arjun's refill request.
* **IoT Monitoring**: see section 6.

## 4. Admin (4 min)

* **Dashboard / Reports**: users by role, appointments by status, revenue,
  claims: aggregated live.
* **Verification** → Dr Kavya Reddy → **Approve** (she gets an email) or
  **Reject** with a reason. Until approved she can log in but every clinical
  endpoint returns 403.
* **Users**: search, filter, **Deactivate**/**Activate** (sessions are revoked
  at once), **Create staff account** (admins are only ever created here or by
  the seed, never by self-registration).
* **IoT Devices** → **Register device** for a patient: the API key is shown
  once and only its hash is stored.
* **Hospital Settings**: name, departments, insurance providers, booking
  window: used by the login page and the booking screen.
* **Access Control**: every allow/deny decision with trust score, role and
  reason (the `access` chain), including the break-glass entry from step 3.
* **Ledger**: Records chain / Access chain blocks with their hashes →
  **Verify ledger** → *LEDGER VALID*.

## 5. Tamper detection, the key moment (2 min)

In a third terminal (`backend/services/api`):

```bash
npm run demo:tamper
```

This edits Arjun's diagnosis **directly in MongoDB**, like a malicious insider
would, with no API call and no ledger entry.

* Admin → Ledger → **Verify ledger** → **TAMPERING DETECTED**: names the
  medical record whose content no longer matches its last ledger hash.
* Arjun → Medical Records → **Verify integrity** → red: modified outside the system.
* `npm run ledger:verify` shows the same on the command line.

```bash
npm run demo:tamper -- --restore
```

Verify again: valid. Variant: `npm run demo:tamper -- --ledger` edits a
ledger block itself, which breaks the hash chain (`entry_modified`), and
`--restore` undoes it.

## 6. Live IoT vitals (2 min)

```bash
npm run demo:iot -- --interval 2
```

The simulator posts readings to `POST /api/devices/readings` with each
seeded device's key, exactly as hardware would. Dr Iyer → **IoT Monitoring**
updates live. Then stop it and run:

```bash
npm run demo:iot -- --spike
```

The abnormal readings (BP about 168/104, heart rate about 125, SpO₂ about 89 %) raise alerts: red tiles on the
monitor and notifications for the patient and doctor.

## 7. Insurance agent: Priya Sharma (3 min)

* **Dashboard**: queue size, amounts, approval rate.
* **Claims Queue** → open the *submitted* claim → **Process** → move it to
  *under review* → *approved* (enter the approved amount) → *settled*. Each
  step follows the state machine (an invalid jump is refused) and is a ledger
  block. Arjun sees each status change in his notifications and Billing page.
* **Settlements** and **Reports**: claims by status, claimed vs settled per month, average time to settle.

## 8. Failure states (optional, 1 min)

* Stop the server (Ctrl-C) and click around a dashboard: each screen shows
  *Server unreachable* with **Try again**, not stale data.
* Register a brand-new patient: every list shows a real empty state.

## Reset between runs

```bash
npm run seed -- --reset
```
