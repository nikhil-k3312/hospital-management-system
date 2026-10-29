/* Doctor dashboard. Every screen below is filled from the MediChain API. */
(function doctorPortal() {
  const { esc, icon, tag, fmtDate, fmtDateTime, fmtTime, relTime, titleCase, age } = UI;
  const RECORD_TYPES = [['diagnosis', 'Diagnosis'], ['lab_result', 'Lab result'], ['imaging', 'Imaging'], ['visit_note', 'Visit note'], ['vaccination', 'Vaccination'], ['allergy', 'Allergy'], ['other', 'Other']];
  const VITALS = [['heartRate', 'HR', 'bpm'], ['systolic', 'SYS', 'mmHg'], ['diastolic', 'DIA', 'mmHg'], ['spo2', 'SpO₂', '%'], ['temperature', 'Temp', '°C'], ['glucose', 'Glu', 'mg/dL']];

  // The patient whose chart is open (set before navigating to #chart).
  let chartPatient = null;
  function openChart(c, patient) {
    chartPatient = patient;
    c.navigate('chart');
  }

  const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

  /* ================================================================ dashboard */

  async function dashboard(c) {
    const [appts, patients, rx, monitor] = await Promise.all([
      c.api.get('/api/appointments'),
      c.user.approvalStatus === 'approved' ? c.api.get('/api/patients') : Promise.resolve({ data: [] }),
      c.user.approvalStatus === 'approved' ? c.api.get('/api/prescriptions', { status: 'active' }) : Promise.resolve({ data: [] }),
      c.user.approvalStatus === 'approved' ? c.api.get('/api/vitals/monitor') : Promise.resolve({ data: { patients: [] } }),
    ]);
    if (c.stale()) return;
    const now = new Date();
    const today = appts.data.filter((a) => sameDay(a.startTime, now) && a.status !== 'cancelled');
    const pending = appts.data.filter((a) => a.status === 'pending' && new Date(a.startTime) > now);
    const refills = rx.data.filter((p) => p.refillRequest.status === 'pending');
    const alerts = monitor.data.patients.filter((p) => p.latest && p.latest.abnormal.length);

    // Patients seen per day over the last 7 days, from completed appointments.
    const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - 6 + i); return d; });
    const seen = days.map((d) => appts.data.filter((a) => a.status === 'completed' && sameDay(a.startTime, d)).length);
    const booked = days.map((d) => appts.data.filter((a) => a.status !== 'cancelled' && sameDay(a.startTime, d)).length);

    c.container.innerHTML = `
      <div class="welcome-banner"><div><h2>Good ${now.getHours() < 12 ? 'morning' : now.getHours() < 17 ? 'afternoon' : 'evening'}, Dr. ${esc(c.user.fullName.split(' ').slice(-1)[0])}</h2>
        <p>${today.length} appointment(s) today · ${pending.length} awaiting confirmation</p></div>${icon('stethoscope', 'class="welcome-banner-icon"')}</div>
      ${alerts.length ? `<div class="banner banner-danger">${icon('siren')} Vitals alert for ${alerts.map((a) => esc(a.fullName)).join(', ')}. <button class="btn btn-sm btn-secondary" data-nav="iot">Open monitor</button></div>` : ''}
      <div class="dashboard-stats-grid">
        ${UI.statCard('calendar', 'blue', today.length, 'Appointments today', 'appointments')}
        ${UI.statCard('clock', 'orange', pending.length, 'Awaiting confirmation', 'appointments')}
        ${UI.statCard('users', 'purple', patients.data.filter((p) => p.consent && p.consent.status === 'active').length, 'Patients with consent', 'patients')}
        ${UI.statCard('pill', refills.length ? 'red' : 'green', refills.length, 'Refill requests', 'prescriptions')}
      </div>
      <div class="dashboard-main-grid">
        ${UI.card('Last 7 days', 'bar-chart-2', '<div class="chart-box"><canvas id="volumeChart"></canvas></div>')}
        ${UI.card("Today's schedule", 'list', today.length ? today.map((a) => `<div class="list-item"><div class="grow">
            <div class="title">${esc(fmtTime(a.startTime))} · ${esc(a.patientId.fullName)}</div><div class="meta">${esc(titleCase(a.type))} · ${esc(a.reason)}</div></div>${tag(a.status)}</div>`).join('')
          : UI.emptyHtml('No appointments today', '', 'calendar-check'))}
      </div>`;

    const p = c.palette();
    c.chart(document.getElementById('volumeChart'), {
      type: 'bar',
      data: { labels: days.map((d) => d.toLocaleDateString('en-IN', { weekday: 'short' })), datasets: [
        { label: 'Booked', data: booked, backgroundColor: p.info },
        { label: 'Completed', data: seen, backgroundColor: p.accent },
      ] },
      options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } },
    });
  }

  /* ================================================================ appointments */

  async function appointments(c) {
    const res = await c.api.get('/api/appointments');
    if (c.stale()) return;
    const now = new Date();
    const today = res.data.filter((a) => sameDay(a.startTime, now));
    const upcoming = res.data.filter((a) => new Date(a.startTime) > now && !sameDay(a.startTime, now));
    const past = res.data.filter((a) => new Date(a.startTime) < now && !sameDay(a.startTime, now)).reverse();

    const actions = (a) => {
      const btn = [];
      if (a.status === 'pending') btn.push(`<button class="btn btn-sm btn-primary" data-action="confirm" data-id="${a._id}">Confirm</button>`);
      if (a.status === 'confirmed' && new Date(a.startTime) <= now) {
        btn.push(`<button class="btn btn-sm btn-primary" data-action="complete" data-id="${a._id}">Complete</button>`);
        btn.push(`<button class="btn btn-sm btn-secondary" data-action="noshow" data-id="${a._id}">No-show</button>`);
      }
      if (['pending', 'confirmed'].includes(a.status)) btn.push(`<button class="btn btn-sm btn-danger" data-action="cancel" data-id="${a._id}">Cancel</button>`);
      btn.push(`<button class="btn btn-sm btn-ghost" data-action="chart" data-id="${a.patientId._id}" data-name="${esc(a.patientId.fullName)}">Chart</button>`);
      return `<div class="actions">${btn.join('')}</div>`;
    };
    const columns = [
      { label: 'When', render: (a) => `<strong>${esc(fmtTime(a.startTime))}</strong><br><span class="text-muted text-small">${esc(fmtDate(a.startTime))}</span>` },
      { label: 'Patient', render: (a) => `${esc(a.patientId.fullName)}<br><span class="text-muted text-small">${a.patientId.dateOfBirth ? `${age(a.patientId.dateOfBirth)} y` : ''} ${esc(a.patientId.gender || '')}</span>` },
      { label: 'Visit', render: (a) => `${esc(titleCase(a.type))}<br><span class="text-muted text-small">${esc(a.reason)}</span>${a.notes ? `<br><span class="text-small">Notes: ${esc(a.notes)}</span>` : ''}` },
      { label: 'Status', render: (a) => tag(a.status) },
      { label: '', render: actions },
    ];
    c.container.innerHTML = `<div class="glass-card">
      <div class="tab-nav"><button class="tab-btn active" data-action="tab" data-tab="t-today">Today (${today.length})</button>
        <button class="tab-btn" data-action="tab" data-tab="t-up">Upcoming (${upcoming.length})</button>
        <button class="tab-btn" data-action="tab" data-tab="t-past">Past (${past.length})</button></div>
      <div id="t-today" class="tab-pane active">${UI.table(columns, today, 'No appointments today')}</div>
      <div id="t-up" class="tab-pane">${UI.table(columns, upcoming, 'No upcoming appointments')}</div>
      <div id="t-past" class="tab-pane">${UI.table(columns, past, 'No past appointments')}</div></div>`;

    c.on({
      tab: (el) => {
        c.container.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === el));
        c.container.querySelectorAll('.tab-pane').forEach((p) => p.classList.toggle('active', p.id === el.dataset.tab));
      },
      confirm: (el) => c.act(() => c.api.patch(`/api/appointments/${el.dataset.id}`, { status: 'confirmed' }), { success: 'Appointment confirmed. The patient was notified.' }),
      noshow: (el) => c.act(() => c.api.patch(`/api/appointments/${el.dataset.id}`, { status: 'no_show' })),
      cancel: async (el) => {
        if (await UI.confirmDialog('Cancel appointment', 'The patient will be notified and the slot released.', { confirmLabel: 'Cancel appointment', danger: true })) {
          await c.act(() => c.api.del(`/api/appointments/${el.dataset.id}`, { reason: 'Cancelled by doctor' }));
        }
      },
      complete: (el) => UI.modal({
        title: 'Complete appointment',
        submitLabel: 'Mark completed',
        body: `<div class="form-group"><label>Visit notes</label><textarea name="notes" maxlength="2000" placeholder="Findings, advice, follow-up plan"></textarea></div>
          <p class="text-muted text-small">A consultation bill for your fee is raised for the patient automatically.</p>`,
        onSubmit: async (v) => { await c.api.patch(`/api/appointments/${el.dataset.id}`, { status: 'completed', notes: v.notes }); UI.toast('Completed and billed', 'success'); c.reload(); },
      }),
      chart: (el) => openChart(c, { _id: el.dataset.id, fullName: el.dataset.name }),
    });
  }

  /* ================================================================ patients */

  async function patients(c) {
    const res = await c.api.get('/api/patients');
    if (c.stale()) return;
    c.container.innerHTML = `
      <div class="banner banner-info">${icon('shield')} You can open a patient's chart only while they have given you consent. Request access from a patient, or use Emergency access in a genuine emergency.</div>
      ${UI.card('My patients', 'users', UI.table([
        { label: 'Patient', render: (p) => `<strong>${esc(p.fullName)}</strong><br><span class="text-muted text-small">${esc(p.email)}</span>` },
        { label: 'Age / gender', render: (p) => `${p.dateOfBirth ? `${age(p.dateOfBirth)} y` : '—'} ${esc(p.gender || '')}` },
        { label: 'Last visit', render: (p) => esc(fmtDate(p.lastVisit)) },
        { label: 'Consent', render: (p) => (p.consent ? `${tag(p.consent.status)}${p.consent.status === 'active' ? `<br><span class="text-muted text-small">until ${esc(fmtDate(p.consent.expiresAt))}</span>` : ''}` : tag('none', 'No consent')) },
        { label: '', render: (p) => `<div class="actions">
            <button class="btn btn-sm ${p.consent && p.consent.status === 'active' ? 'btn-primary' : 'btn-secondary'}" data-action="chart" data-id="${p._id}" data-name="${esc(p.fullName)}">Open chart</button>
            ${!p.consent || !['active', 'requested'].includes(p.consent.status) ? `<button class="btn btn-sm btn-ghost" data-action="request" data-id="${p._id}" data-name="${esc(p.fullName)}">Request access</button>` : ''}</div>` },
      ], res.data, 'No patients yet. Patients appear here when they book you or share their records.'),
      `<button class="btn btn-primary" data-action="find">${icon('search')} Find patient by email</button>`)}`;

    const requestAccess = (id, name) => UI.modal({
      title: `Request access: ${name}`,
      submitLabel: 'Send request',
      body: `<div class="form-group"><label>Why do you need access?</label><textarea name="purpose" required minlength="5" maxlength="300" placeholder="e.g. Review of cardiac history before consultation"></textarea>
        <span class="hint">The patient sees this message and decides.</span></div>`,
      onSubmit: async (v) => { await c.api.post('/api/consents/request', { patientId: id, purpose: v.purpose }); UI.toast('Request sent to the patient', 'success'); c.reload(); },
    });
    c.on({
      chart: (el) => openChart(c, { _id: el.dataset.id, fullName: el.dataset.name }),
      request: (el) => requestAccess(el.dataset.id, el.dataset.name),
      find: () => UI.modal({
        title: 'Find a patient',
        submitLabel: 'Search',
        body: '<div class="form-group"><label>Patient email</label><input type="email" name="email" required></div><div data-found></div>',
        onSubmit: async (v, form) => {
          const found = (await c.api.get('/api/patients/search', { email: v.email })).data;
          form.querySelector('[data-found]').innerHTML = `<div class="banner banner-success">${icon('user-check')} Found ${esc(found.fullName)}.
            <button type="button" class="btn btn-sm btn-primary" data-req="${found._id}" data-name="${esc(found.fullName)}">Request access</button></div>`;
          UI.refreshIcons();
          form.querySelector('[data-req]').addEventListener('click', (e) => requestAccess(e.currentTarget.dataset.req, e.currentTarget.dataset.name));
          return true; // keep the dialog open to show the result
        },
      }),
    });
  }

  /* ================================================================ patient chart */

  async function chart(c) {
    if (!chartPatient) { c.navigate('patients'); return; }
    const pid = chartPatient._id;
    let records; let rx; let vitals;
    try {
      [records, rx, vitals] = await Promise.all([
        c.api.get('/api/records', { patientId: pid }),
        c.api.get('/api/prescriptions'),
        c.api.get('/api/vitals', { patientId: pid, days: 7 }),
      ]);
    } catch (error) {
      if (error.code !== 'CONSENT_REQUIRED') throw error;
      c.container.innerHTML = UI.card(chartPatient.fullName, 'lock', `<div class="state state-error">${icon('shield-x')}<h4>No consent (HTTP 403)</h4>
        <div>${esc(error.message)}</div><div class="flex mt-3" style="justify-content:center">
        <button class="btn btn-primary" data-action="request">Request access</button>
        <button class="btn btn-danger" data-shell="break-glass">${icon('siren')} Emergency access</button></div></div>`);
      c.on({ request: () => UI.modal({
        title: `Request access: ${chartPatient.fullName}`,
        submitLabel: 'Send request',
        body: '<div class="form-group"><label>Why do you need access?</label><textarea name="purpose" required minlength="5" maxlength="300"></textarea></div>',
        onSubmit: async (v) => { await c.api.post('/api/consents/request', { patientId: pid, purpose: v.purpose }); UI.toast('Request sent', 'success'); },
      }) });
      return;
    }
    if (c.stale()) return;
    const viaBreakGlass = records.meta.accessVia === 'break_glass';
    const myRx = rx.data.filter((p) => p.patientId._id === pid);
    const latest = vitals.data.readings[vitals.data.readings.length - 1];

    c.container.innerHTML = `
      ${viaBreakGlass ? `<div class="banner banner-danger">${icon('siren')} Viewing under EMERGENCY ACCESS. This access is in the ledger and the patient has been notified.</div>` : ''}
      <div class="flex-between mb-3"><h2>${esc(chartPatient.fullName)}</h2><div class="actions">
        <button class="btn btn-secondary" data-nav="patients">${icon('arrow-left')} Patients</button>
        <button class="btn btn-primary" data-action="new-record">${icon('file-plus')} New record</button>
        <button class="btn btn-primary" data-action="new-rx">${icon('pill')} Prescribe</button></div></div>
      <div class="grid-2">
        ${UI.card('Medical records', 'file-text', records.data.length ? records.data.map((r) => `<div class="list-item"><div class="grow">
            <div class="title">${esc(r.title)} <span class="text-muted text-small">v${r.version}</span></div>
            <div class="meta">${esc(titleCase(r.recordType))} · ${r.doctorId ? `Dr. ${esc(r.doctorId.fullName)}` : 'patient upload'} · ${esc(fmtDate(r.createdAt))}${r.attachments.length ? ` · ${r.attachments.length} file(s)` : ''}</div>
            ${r.diagnosis ? `<div class="text-small">${esc(r.diagnosis)}</div>` : ''}</div>
            <button class="btn btn-sm btn-secondary" data-action="open-record" data-id="${r._id}">Open</button></div>`).join('')
          : UI.emptyHtml('No records', 'Create the first record for this patient.', 'file-text'))}
        <div>
          ${UI.card('Latest vitals', 'activity', latest ? `<div class="flex">${VITALS.filter(([f]) => latest[f] != null).map(([f, l, u]) => `<span class="tag ${latest.abnormal.includes(f) ? 'tag-red' : 'tag-green'}">${l} ${latest[f]} ${u}</span>`).join('')}</div>
            <p class="text-muted text-small mt-1">${esc(relTime(latest.recordedAt))} · ${vitals.data.readings.length} readings this week</p><div class="chart-box mt-2" style="height:200px"><canvas id="chartVitals"></canvas></div>`
            : UI.emptyHtml('No vitals this week', '', 'activity'))}
          ${UI.card('Prescriptions from you', 'pill', UI.table([
            { label: 'Medication', render: (p) => `<strong>${esc(p.medication)}</strong> ${esc(p.dosage)}<br><span class="text-muted text-small">${esc(p.frequency)}</span>` },
            { label: 'Status', render: (p) => tag(p.status) },
          ], myRx, 'None'))}
        </div>
      </div>`;

    if (latest) {
      const p = c.palette();
      const rs = vitals.data.readings;
      c.chart(document.getElementById('chartVitals'), {
        type: 'line',
        data: { labels: rs.map((r) => fmtDate(r.recordedAt)), datasets: [
          { label: 'HR', data: rs.map((r) => r.heartRate), borderColor: p.danger, pointRadius: 0, tension: 0.3, spanGaps: true },
          { label: 'SYS', data: rs.map((r) => r.systolic), borderColor: p.accent, pointRadius: 0, tension: 0.3, spanGaps: true },
        ] },
        options: { responsive: true, maintainAspectRatio: false, scales: { x: { ticks: { maxTicksLimit: 5 } } } },
      });
    }

    c.on({
      'new-record': () => UI.modal({
        title: `New record for ${chartPatient.fullName}`,
        submitLabel: 'Save to ledger',
        wide: true,
        body: `<div class="form-row"><div class="form-group"><label>Type</label><select name="recordType">${UI.options(RECORD_TYPES)}</select></div>
            <div class="form-group"><label>Title</label><input name="title" required minlength="3" maxlength="200"></div></div>
          <div class="form-group"><label>Diagnosis / code</label><input name="diagnosis" maxlength="1000" placeholder="e.g. I10 Essential hypertension"></div>
          <div class="form-group"><label>Description</label><textarea name="description" maxlength="5000"></textarea></div>
          <div class="form-group"><label>Findings</label><textarea name="findings" maxlength="5000"></textarea></div>
          <div class="form-group"><label>Attach a file (optional: PDF, PNG, JPEG, text)</label><input type="file" name="file" accept=".pdf,.png,.jpg,.jpeg,.txt"></div>`,
        onSubmit: async (v, form) => {
          const file = form.querySelector('[name=file]').files[0];
          const { file: ignored, ...body } = v;
          const rec = await c.api.post('/api/records', { ...body, patientId: pid });
          if (file) {
            const fd = new FormData();
            fd.append('file', file);
            await c.api.upload(`/api/records/${rec.data._id}/files`, fd);
          }
          UI.toast('Record saved and chained in the ledger', 'success');
          c.reload();
        },
      }),
      'new-rx': () => UI.modal({
        title: `Prescribe for ${chartPatient.fullName}`,
        submitLabel: 'Issue prescription',
        body: `<div class="form-row"><div class="form-group"><label>Medication</label><input name="medication" required minlength="2" maxlength="120"></div>
            <div class="form-group"><label>Dosage</label><input name="dosage" required maxlength="60" placeholder="e.g. 5 mg"></div></div>
          <div class="form-group"><label>Frequency</label><input name="frequency" required maxlength="120" placeholder="e.g. Once daily, morning"></div>
          <div class="form-group"><label>Instructions</label><textarea name="instructions" maxlength="1000"></textarea></div>
          <div class="form-row"><div class="form-group"><label>Duration (days)</label><input type="number" name="durationDays" min="1" max="365" value="30"></div>
            <div class="form-group"><label>Refills allowed</label><input type="number" name="refillsAllowed" min="0" max="12" value="0"></div></div>`,
        onSubmit: async (v) => { await c.api.post('/api/prescriptions', { ...v, patientId: pid }); UI.toast('Prescription issued', 'success'); c.reload(); },
      }),
      'open-record': async (el) => openRecord(c, el.dataset.id),
    });
  }

  async function openRecord(c, id) {
    const [rec, history] = await Promise.all([c.api.get(`/api/records/${id}`), c.api.get(`/api/records/${id}/ledger-history`)]);
    const r = rec.data;
    const mine = r.doctorId && r.doctorId._id === c.user._id;
    const overlay = UI.modal({
      title: r.title,
      wide: true,
      body: `<dl class="kv"><dt>Type</dt><dd>${esc(titleCase(r.recordType))}</dd><dt>Author</dt><dd>${r.doctorId ? `Dr. ${esc(r.doctorId.fullName)}` : 'Patient upload'}</dd>
          <dt>Version</dt><dd>${r.version} · ${esc(fmtDateTime(r.updatedAt))}</dd>
          ${r.diagnosis ? `<dt>Diagnosis</dt><dd>${esc(r.diagnosis)}</dd>` : ''}${r.description ? `<dt>Description</dt><dd>${esc(r.description)}</dd>` : ''}${r.findings ? `<dt>Findings</dt><dd>${esc(r.findings)}</dd>` : ''}</dl>
        ${mine ? `<details class="mt-3"><summary class="btn btn-sm btn-secondary">Amend this record</summary><form data-amend class="mt-2">
            <div class="form-group"><label>Diagnosis</label><input name="diagnosis" value="${esc(r.diagnosis)}"></div>
            <div class="form-group"><label>Description</label><textarea name="description">${esc(r.description)}</textarea></div>
            <button class="btn btn-primary btn-sm" type="submit">Save amendment (new ledger entry)</button></form></details>` : ''}
        <h4 class="mt-3 mb-2">Files</h4>
        ${r.attachments.map((a) => `<div class="list-item"><div class="grow"><div class="title">${esc(a.filename)}</div><div class="meta mono">SHA-256 ${esc(a.sha256)}</div></div>
          <button type="button" class="btn btn-sm btn-secondary" data-download="${a.fileId}">Open</button></div>`).join('') || '<p class="text-muted">None</p>'}
        <form data-upload class="flex mt-2"><input type="file" name="file" accept=".pdf,.png,.jpg,.jpeg,.txt" required><button class="btn btn-sm btn-secondary" type="submit">${icon('paperclip')} Attach</button></form>
        <div class="flex-between mt-3 mb-2"><h4>Ledger history</h4><button type="button" class="btn btn-sm btn-primary" data-verify>${icon('shield-check')} Verify integrity</button></div>
        <div data-verify-result></div>
        <div class="timeline">${history.data.map((e) => `<div class="timeline-item"><strong>${esc(e.action)}</strong> · ${esc(fmtDateTime(e.timestamp))}
          <div class="text-muted text-small">${esc(e.actorName || e.actorRole)} · block #${e.seq} · <span class="mono">${esc(UI.shortHash(e.entryHash, 16))}</span></div></div>`).join('')}</div>`,
    });

    overlay.addEventListener('click', async (e) => {
      const dl = e.target.closest('[data-download]');
      if (dl) {
        try { const { blob } = await c.api.download(`/api/files/${dl.dataset.download}`); window.open(URL.createObjectURL(blob), '_blank', 'noopener'); } catch (error) { UI.toast(error.message, 'error'); }
      }
      if (e.target.closest('[data-verify]')) {
        try {
          const v = (await c.api.get(`/api/records/${id}/verify`)).data;
          overlay.querySelector('[data-verify-result]').innerHTML = v.intact
            ? `<div class="banner banner-success">${icon('badge-check')} Intact: content matches ledger block #${v.content.ledgerSeq}${v.files.length ? `; ${v.files.length} file hash(es) match` : ''}.</div>`
            : `<div class="banner banner-danger">${icon('shield-x')} TAMPERING DETECTED. The stored record no longer matches the hash in the ledger.</div>`;
          UI.refreshIcons();
        } catch (error) { UI.toast(error.message, 'error'); }
      }
    });
    const amend = overlay.querySelector('[data-amend]');
    if (amend) {
      amend.addEventListener('submit', async (e) => {
        e.preventDefault();
        const ok = await c.act(() => c.api.patch(`/api/records/${id}`, UI.formValues(amend)), { reload: false });
        if (ok) openRecord(c, id);
      });
    }
    overlay.querySelector('[data-upload]').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData();
      fd.append('file', e.target.querySelector('[name=file]').files[0]);
      const ok = await c.act(() => c.api.upload(`/api/records/${id}/files`, fd), { reload: false });
      if (ok) openRecord(c, id);
    });
  }

  /* ================================================================ prescriptions */

  async function prescriptions(c) {
    const res = await c.api.get('/api/prescriptions');
    if (c.stale()) return;
    const refills = res.data.filter((p) => p.refillRequest.status === 'pending');
    const columns = (actions) => [
      { label: 'Patient', render: (p) => esc(p.patientId.fullName) },
      { label: 'Medication', render: (p) => `<strong>${esc(p.medication)}</strong> ${esc(p.dosage)}<br><span class="text-muted text-small">${esc(p.frequency)}</span>` },
      { label: 'Refills', render: (p) => `${p.refillsUsed}/${p.refillsAllowed}` },
      { label: 'Period', render: (p) => `${esc(fmtDate(p.startDate))} → ${esc(fmtDate(p.endDate))}` },
      { label: 'Status', render: (p) => tag(p.status) },
      { label: '', render: actions },
    ];
    c.container.innerHTML = `
      ${UI.card('Refill requests', 'bell-ring', UI.table(columns((p) => `<div class="actions"><button class="btn btn-sm btn-primary" data-action="approve" data-id="${p._id}">Approve</button>
        <button class="btn btn-sm btn-danger" data-action="deny" data-id="${p._id}">Deny</button></div>`), refills, 'No pending refill requests'))}
      ${UI.card('All prescriptions you issued', 'pill', UI.table(columns((p) => (p.status === 'active' ? `<div class="actions">
        <button class="btn btn-sm btn-secondary" data-action="complete" data-id="${p._id}">Complete</button><button class="btn btn-sm btn-danger" data-action="cancel" data-id="${p._id}">Cancel</button></div>` : '')), res.data, 'You have not issued prescriptions yet'))}`;
    const act = (action, label) => (el) => c.act(() => c.api.patch(`/api/prescriptions/${el.dataset.id}`, { action }), { success: label });
    c.on({ approve: act('approve_refill', 'Refill approved'), deny: act('deny_refill', 'Refill denied'), complete: act('complete', 'Marked completed'), cancel: act('cancel', 'Prescription cancelled') });
  }

  /* ================================================================ IoT monitor */

  async function iot(c) {
    async function draw() {
      const res = await c.api.get('/api/vitals/monitor');
      if (c.stale()) return false;
      const { patients: list, ranges } = res.data;
      c.container.innerHTML = `
        <div class="flex-between mb-3"><span class="text-muted">${icon('radio')} Live view of patients who consented. Refreshes every 5 seconds.</span>
          <span class="tag tag-green pulse">LIVE · ${esc(new Date().toLocaleTimeString())}</span></div>
        ${list.length ? `<div class="grid-2">${list.map((p) => {
          const r = p.latest;
          const abnormal = r && r.abnormal.length;
          return `<div class="glass-card" style="${abnormal ? 'border-color:var(--danger)' : ''}">
            <div class="glass-card-header"><div><h3>${esc(p.fullName)}</h3><div class="text-muted text-small">${p.devices.map((d) => `${esc(d.name)} (${esc(d.status)})`).join(', ') || 'No device: manual readings only'}</div></div>
              ${abnormal ? '<span class="tag tag-red pulse">ALERT</span>' : '<span class="tag tag-green">Stable</span>'}</div>
            ${r ? `<div class="vital-grid">${VITALS.filter(([f]) => r[f] != null).map(([f, l, u]) => `<div class="vital-tile ${r.abnormal.includes(f) ? 'abnormal' : ''}">
              <div class="text-muted text-small">${l}</div><div class="value">${r[f]}<small> ${u}</small></div><div class="text-muted text-small">${ranges[f].min}–${ranges[f].max}</div></div>`).join('')}</div>
              <p class="text-muted text-small mt-2">Last reading ${esc(relTime(r.recordedAt))} via ${esc(r.source)}</p>` : UI.emptyHtml('No readings yet', '', 'activity')}
            <button class="btn btn-sm btn-ghost mt-2" data-action="chart" data-id="${p.patientId}" data-name="${esc(p.fullName)}">Open chart</button></div>`;
        }).join('')}</div>` : UI.emptyHtml('No monitored patients', 'Patients appear here once they give you consent.', 'activity')}`;
      UI.refreshIcons();
      return true;
    }
    if (!(await draw())) return;
    c.on({ chart: (el) => openChart(c, { _id: el.dataset.id, fullName: el.dataset.name }) });
    const timer = setInterval(async () => {
      if (c.stale()) { clearInterval(timer); return; }
      try { if (!(await draw())) clearInterval(timer); } catch (e) { clearInterval(timer); }
    }, 5000);
  }

  /* ================================================================ profile extra */

  function profileExtra(user) {
    const d = user.doctorProfile || {};
    const av = d.availability || {};
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return {
      html: `<h4 class="mt-3 mb-2">Practice & availability</h4>
        <div class="form-row">
          <div class="form-group"><label>Specialization</label><input name="specialization" value="${esc(d.specialization)}" required></div>
          <div class="form-group"><label>Department</label><input name="department" value="${esc(d.department)}"></div>
          <div class="form-group"><label>Consultation fee (₹)</label><input type="number" name="consultationFee" min="0" value="${d.consultationFee}"></div>
        </div>
        <div class="form-group"><label>Working days</label><div class="checkbox-row">${DAYS.map((name, i) => `<label><input type="checkbox" name="days" value="${i}" data-array ${(av.days || []).includes(i) ? 'checked' : ''}> ${name}</label>`).join('')}</div></div>
        <div class="form-row">
          <div class="form-group"><label>From (hour)</label><input type="number" name="startHour" min="0" max="23" value="${av.startHour}"></div>
          <div class="form-group"><label>To (hour)</label><input type="number" name="endHour" min="1" max="24" value="${av.endHour}"></div>
          <div class="form-group"><label>Slot length</label><select name="slotMinutes">${UI.options([15, 20, 30, 45, 60].map((m) => [m, `${m} min`]), av.slotMinutes)}</select></div>
        </div>
        <p class="text-muted text-small mb-2">Licence ${esc(d.licenseNumber || '—')} · verification ${esc(user.approvalStatus)}</p>`,
      read: (v) => ({ doctorProfile: {
        specialization: v.specialization, department: v.department, consultationFee: v.consultationFee,
        availability: { days: (v.days || []).map(Number), startHour: v.startHour, endHour: v.endHour, slotMinutes: Number(v.slotMinutes) },
      } }),
    };
  }

  Portal.start({
    role: 'doctor',
    displayName: (u) => `Dr. ${u.fullName}`,
    subtitle: (u) => u.doctorProfile?.specialization || 'Doctor',
    headerActions: () => `<button class="btn btn-danger" data-shell="break-glass">${icon('siren')} Emergency access</button>`,
    nav: [
      { group: 'Clinical', items: [
        { id: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard' },
        { id: 'appointments', label: 'Appointments', icon: 'calendar', badge: 'appointments' },
        { id: 'patients', label: 'My Patients', icon: 'users', title: 'My Patients' },
        { id: 'prescriptions', label: 'Prescriptions', icon: 'pill', badge: 'prescriptions' },
        { id: 'iot', label: 'IoT Monitoring', icon: 'activity', title: 'IoT Vitals Monitor' },
      ] },
      { group: 'Account', items: [
        { id: 'notifications', label: 'Notifications', icon: 'bell', badge: 'notifications' },
        { id: 'profile', label: 'Profile & Security', icon: 'settings' },
      ] },
    ],
    pages: { dashboard, appointments, patients, chart, prescriptions, iot },
    titles: { chart: 'Patient Chart' },
    profileExtra,
    badges: async ({ api, setBadge }) => {
      const [a, p] = await Promise.all([api.get('/api/appointments', { status: 'pending' }), api.get('/api/prescriptions', { status: 'active' })]);
      setBadge('badge-appointments', a.data.length);
      setBadge('badge-prescriptions', p.data.filter((x) => x.refillRequest.status === 'pending').length);
    },
  });
}());
