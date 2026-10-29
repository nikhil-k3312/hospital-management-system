/* Patient portal. Every screen below is filled from the MediChain API. */
(function patientPortal() {
  const { esc, icon, tag, fmtDate, fmtDateTime, fmtTime, fmtMoney, relTime, titleCase } = UI;

  const RECORD_ICONS = { diagnosis: 'stethoscope', lab_result: 'flask-conical', imaging: 'scan', visit_note: 'notebook-pen', vaccination: 'syringe', allergy: 'alert-octagon', patient_upload: 'upload', other: 'file' };
  const VITAL_FIELDS = [
    ['heartRate', 'Heart rate', 'bpm', 'heart-pulse'], ['systolic', 'Systolic BP', 'mmHg', 'gauge'], ['diastolic', 'Diastolic BP', 'mmHg', 'gauge'],
    ['spo2', 'Blood oxygen', '%', 'wind'], ['temperature', 'Temperature', '°C', 'thermometer'], ['glucose', 'Glucose', 'mg/dL', 'droplet'],
  ];

  let publicSettings = null;
  async function settings(api) {
    if (!publicSettings) publicSettings = (await api.get('/api/settings/public')).data;
    return publicSettings;
  }

  /* ================================================================ dashboard */

  async function dashboard(c) {
    const [appts, rx, consents, bills, vitals] = await Promise.all([
      c.api.get('/api/appointments'),
      c.api.get('/api/prescriptions', { status: 'active' }),
      c.api.get('/api/consents'),
      c.api.get('/api/bills'),
      c.api.get('/api/vitals', { days: 7 }),
    ]);
    if (c.stale()) return;
    const now = new Date();
    const upcoming = appts.data.filter((a) => ['pending', 'confirmed'].includes(a.status) && new Date(a.startTime) > now);
    const requests = consents.data.filter((g) => g.status === 'requested');
    const unpaid = bills.data.filter((b) => b.status === 'unpaid');
    const latest = vitals.data.readings[vitals.data.readings.length - 1];
    const next = upcoming[0];

    c.container.innerHTML = `
      <div class="welcome-banner"><div><h2>Hello, ${esc(c.user.fullName.split(' ')[0])}</h2>
        <p>${next ? `Your next appointment is with Dr. ${esc(next.doctorId.fullName)} on ${esc(fmtDateTime(next.startTime))}.` : 'You have no upcoming appointments.'}</p></div>
        ${icon('heart-pulse', 'class="welcome-banner-icon"')}</div>
      ${requests.length ? `<div class="banner banner-warning">${icon('shield-alert')} ${requests.length} doctor${requests.length > 1 ? 's are' : ' is'} asking for access to your records.
        <button class="btn btn-sm btn-secondary" data-nav="permissions">Review</button></div>` : ''}
      <div class="dashboard-stats-grid">
        ${UI.statCard('calendar', 'blue', upcoming.length, 'Upcoming appointments', 'appointments')}
        ${UI.statCard('pill', 'green', rx.data.length, 'Active prescriptions', 'medications')}
        ${UI.statCard('shield', 'purple', consents.data.filter((g) => g.status === 'active').length, 'Doctors with access', 'permissions')}
        ${UI.statCard('receipt', unpaid.length ? 'orange' : 'green', unpaid.length, 'Unpaid bills', 'billing')}
      </div>
      <div class="dashboard-main-grid">
        ${UI.card('Latest vitals', 'activity', latest ? `<div class="vital-grid">${VITAL_FIELDS.filter(([f]) => latest[f] != null).map(([f, label, unit]) => `
            <div class="vital-tile ${latest.abnormal.includes(f) ? 'abnormal' : ''}"><div class="text-muted text-small">${label}</div>
            <div class="value">${latest[f]} <small>${unit}</small></div></div>`).join('')}</div>
            <p class="text-muted text-small mt-2">Recorded ${esc(relTime(latest.recordedAt))} by ${latest.source === 'device' ? 'your home device' : 'you'}.</p>`
          : UI.emptyHtml('No readings yet', 'Add a reading in Health Metrics or link a device.', 'activity'), '<button class="btn btn-sm btn-secondary" data-nav="metrics">Open</button>')}
        ${UI.card('Upcoming', 'calendar-clock', upcoming.length ? upcoming.slice(0, 4).map((a) => `
          <div class="list-item"><div class="grow"><div class="title">Dr. ${esc(a.doctorId.fullName)}</div>
          <div class="meta">${esc(fmtDateTime(a.startTime))} · ${esc(titleCase(a.type))}</div></div>${tag(a.status)}</div>`).join('')
          : UI.emptyHtml('Nothing booked', 'Book a consultation with a verified doctor.', 'calendar'),
        '<button class="btn btn-sm btn-primary" data-action="book">Book</button>')}
      </div>`;
    c.on({ book: () => bookModal(c) });
  }

  /* ================================================================ appointments */

  async function slotPicker(c, form, doctorSelectName, preselectDoctorId) {
    const dateInput = form.querySelector('[name=date]');
    const doctorSelect = form.querySelector(`[name=${doctorSelectName}]`);
    const grid = form.querySelector('[data-slots]');
    const hidden = form.querySelector('[name=startTime]');
    async function load() {
      hidden.value = '';
      const doctorId = doctorSelect ? doctorSelect.value : preselectDoctorId;
      if (!doctorId || !dateInput.value) { grid.innerHTML = '<span class="text-muted">Choose a doctor and a date.</span>'; return; }
      grid.innerHTML = '<div class="spinner"></div>';
      try {
        const res = await c.api.get(`/api/doctors/${doctorId}/available-slots`, { date: dateInput.value });
        grid.innerHTML = res.data.slots.length
          ? res.data.slots.map((s) => `<button type="button" class="slot-btn" data-start="${s.start}" ${s.available ? '' : 'disabled title="Already booked"'}>${fmtTime(s.start)}</button>`).join('')
          : '<span class="text-muted">No slots on this day. The doctor may not work on this day, or it is outside the booking window.</span>';
      } catch (error) {
        grid.innerHTML = `<span class="state-error">${esc(error.message)}</span>`;
      }
    }
    grid.addEventListener('click', (e) => {
      const b = e.target.closest('.slot-btn');
      if (!b || b.disabled) return;
      grid.querySelectorAll('.slot-btn').forEach((x) => x.classList.remove('selected'));
      b.classList.add('selected');
      hidden.value = b.dataset.start;
    });
    dateInput.addEventListener('change', load);
    if (doctorSelect) doctorSelect.addEventListener('change', load);
    await load();
  }

  async function bookModal(c) {
    const doctors = (await c.api.get('/api/doctors')).data;
    const overlay = UI.modal({
      title: 'Book an appointment',
      submitLabel: 'Request appointment',
      wide: true,
      body: `<div class="form-row">
          <div class="form-group"><label>Doctor</label><select name="doctorId" required>${UI.options(doctors.map((d) => [d._id, `Dr. ${d.fullName} · ${d.doctorProfile.specialization} · ${fmtMoney(d.doctorProfile.consultationFee)}`]))}</select></div>
          <div class="form-group"><label>Date</label><input type="date" name="date" required min="${UI.isoDate()}" value="${UI.isoDate(Date.now() + 86400000)}"></div>
        </div>
        <div class="form-group"><label>Available times</label><div class="slot-grid" data-slots></div><input type="hidden" name="startTime"></div>
        <div class="form-row">
          <div class="form-group"><label>Visit type</label><select name="type">${UI.options([['consultation', 'Consultation'], ['follow_up', 'Follow-up'], ['checkup', 'Check-up']])}</select></div>
        </div>
        <div class="form-group"><label>Reason for visit</label><textarea name="reason" required minlength="3" maxlength="500" placeholder="Describe your symptoms or the reason for the visit"></textarea></div>`,
      onSubmit: async (v) => {
        if (!v.startTime) throw new Error('Choose one of the available times.');
        await c.api.post('/api/appointments', { doctorId: v.doctorId, startTime: v.startTime, type: v.type, reason: v.reason });
        UI.toast('Appointment requested. The doctor will confirm it.', 'success');
        c.reload();
      },
    });
    await slotPicker(c, overlay.querySelector('form'), 'doctorId');
  }

  async function appointments(c) {
    const res = await c.api.get('/api/appointments');
    if (c.stale()) return;
    const now = new Date();
    const upcoming = res.data.filter((a) => new Date(a.startTime) >= now && ['pending', 'confirmed'].includes(a.status));
    const past = res.data.filter((a) => !upcoming.includes(a)).reverse();
    const columns = (actions) => [
      { label: 'When', render: (a) => `<strong>${esc(fmtDate(a.startTime))}</strong><br><span class="text-muted">${esc(fmtTime(a.startTime))}</span>` },
      { label: 'Doctor', render: (a) => `Dr. ${esc(a.doctorId.fullName)}<br><span class="text-muted text-small">${esc(a.doctorId.doctorProfile.specialization)}</span>` },
      { label: 'Type', render: (a) => esc(titleCase(a.type)) },
      { label: 'Reason / notes', render: (a) => `${esc(a.reason)}${a.notes ? `<br><span class="text-muted text-small">Doctor: ${esc(a.notes)}</span>` : ''}${a.cancelReason ? `<br><span class="text-muted text-small">Cancelled: ${esc(a.cancelReason)}</span>` : ''}` },
      { label: 'Status', render: (a) => tag(a.status) },
      ...(actions ? [{ label: '', render: (a) => `<div class="actions"><button class="btn btn-sm btn-secondary" data-action="reschedule" data-id="${a._id}" data-doctor="${a.doctorId._id}">Reschedule</button>
        <button class="btn btn-sm btn-danger" data-action="cancel" data-id="${a._id}">Cancel</button></div>` }] : []),
    ];
    c.container.innerHTML = `
      ${UI.card('Upcoming appointments', 'calendar', UI.table(columns(true), upcoming, 'No upcoming appointments'), '<button class="btn btn-primary" data-action="book">' + icon('plus') + ' Book appointment</button>')}
      ${UI.card('History', 'history', UI.table(columns(false), past, 'No past appointments'))}`;
    c.on({
      book: () => bookModal(c),
      cancel: async (el) => {
        if (await UI.confirmDialog('Cancel appointment', 'Cancel this appointment? The slot will be released for other patients.', { confirmLabel: 'Cancel appointment', danger: true })) {
          await c.act(() => c.api.del(`/api/appointments/${el.dataset.id}`, { reason: 'Cancelled by patient' }));
        }
      },
      reschedule: async (el) => {
        const overlay = UI.modal({
          title: 'Reschedule appointment',
          submitLabel: 'Move appointment',
          body: `<div class="form-group"><label>New date</label><input type="date" name="date" required min="${UI.isoDate()}" value="${UI.isoDate(Date.now() + 86400000)}"></div>
            <div class="form-group"><label>Available times</label><div class="slot-grid" data-slots></div><input type="hidden" name="startTime"></div>`,
          onSubmit: async (v) => {
            if (!v.startTime) throw new Error('Choose one of the available times.');
            await c.api.patch(`/api/appointments/${el.dataset.id}`, { startTime: v.startTime });
            UI.toast('Rescheduled. The doctor will confirm the new time.', 'success');
            c.reload();
          },
        });
        await slotPicker(c, overlay.querySelector('form'), null, el.dataset.doctor);
      },
    });
  }

  /* ================================================================ records */

  async function openRecord(c, id) {
    const [rec, history] = await Promise.all([c.api.get(`/api/records/${id}`), c.api.get(`/api/records/${id}/ledger-history`)]);
    const r = rec.data;
    UI.modal({
      title: r.title,
      wide: true,
      body: `<dl class="kv">
          <dt>Type</dt><dd>${esc(titleCase(r.recordType))}</dd>
          <dt>Author</dt><dd>${r.doctorId ? `Dr. ${esc(r.doctorId.fullName)}` : 'You (uploaded)'}</dd>
          <dt>Created</dt><dd>${esc(fmtDateTime(r.createdAt))} · version ${r.version}</dd>
          ${r.diagnosis ? `<dt>Diagnosis</dt><dd>${esc(r.diagnosis)}</dd>` : ''}
          ${r.description ? `<dt>Details</dt><dd>${esc(r.description)}</dd>` : ''}
          ${r.findings ? `<dt>Findings</dt><dd>${esc(r.findings)}</dd>` : ''}
        </dl>
        <h4 class="mt-3 mb-2">Attachments</h4>
        ${r.attachments.length ? r.attachments.map((a) => `<div class="list-item"><div class="grow"><div class="title">${esc(a.filename)}</div>
          <div class="meta">${(a.size / 1024).toFixed(1)} kB · SHA-256 <span class="mono">${esc(UI.shortHash(a.sha256, 20))}</span></div></div>
          <button type="button" class="btn btn-sm btn-secondary" data-download="${a.fileId}" data-name="${esc(a.filename)}">Open</button></div>`).join('') : '<p class="text-muted">No files attached.</p>'}
        <div class="flex-between mt-3 mb-2"><h4>Ledger history</h4><button type="button" class="btn btn-sm btn-primary" data-verify="${r._id}">${icon('shield-check')} Verify integrity</button></div>
        <div data-verify-result></div>
        <div class="timeline">${history.data.map((e) => `<div class="timeline-item"><strong>${esc(e.action)}</strong> · ${esc(fmtDateTime(e.timestamp))}
          <div class="text-muted text-small">${esc(e.actorName || e.actorRole || 'system')} · block #${e.seq} · <span class="mono">${esc(UI.shortHash(e.entryHash, 16))}</span></div></div>`).join('')}</div>`,
    });
    wireRecordModal(c);
  }

  function wireRecordModal(c) {
    const overlay = document.getElementById('app-modal');
    overlay.addEventListener('click', async (e) => {
      const dl = e.target.closest('[data-download]');
      if (dl) {
        try {
          const { blob } = await c.api.download(`/api/files/${dl.dataset.download}`);
          window.open(URL.createObjectURL(blob), '_blank', 'noopener');
        } catch (error) { UI.toast(error.message, 'error'); }
      }
      const v = e.target.closest('[data-verify]');
      if (v) {
        v.disabled = true;
        try {
          const res = (await c.api.get(`/api/records/${v.dataset.verify}/verify`)).data;
          overlay.querySelector('[data-verify-result]').innerHTML = res.intact
            ? `<div class="banner banner-success">${icon('badge-check')} Intact. The record's content hash matches ledger block #${res.content.ledgerSeq}${res.files.length ? ` and all ${res.files.length} file(s) match their recorded SHA-256` : ''}.</div>`
            : `<div class="banner banner-danger">${icon('shield-x')} TAMPERING DETECTED. ${res.content.matches ? '' : 'The record was changed outside MediChain: it no longer matches its ledger entry. '}${res.files.filter((f) => !f.matches).map((f) => `${esc(f.filename)} does not match its hash. `).join('')}</div>`;
          UI.refreshIcons();
        } catch (error) { UI.toast(error.message, 'error'); }
        v.disabled = false;
      }
    });
  }

  async function records(c) {
    const res = await c.api.get('/api/records');
    if (c.stale()) return;
    c.container.innerHTML = UI.card('My medical records', 'file-text', res.data.length ? res.data.map((r) => `
      <div class="list-item"><div class="stat-icon purple" style="width:40px;height:40px">${icon(RECORD_ICONS[r.recordType] || 'file')}</div>
        <div class="grow"><div class="title">${esc(r.title)}</div>
          <div class="meta">${esc(titleCase(r.recordType))} · ${r.doctorId ? `Dr. ${esc(r.doctorId.fullName)}` : 'Uploaded by you'} · ${esc(fmtDate(r.createdAt))}${r.attachments.length ? ` · ${r.attachments.length} file(s)` : ''}</div>
          ${r.diagnosis ? `<div class="text-small">${esc(r.diagnosis)}</div>` : ''}</div>
        <button class="btn btn-sm btn-secondary" data-action="open" data-id="${r._id}">View</button></div>`).join('')
      : UI.emptyHtml('No records yet', 'Records your doctors write, and documents you upload, appear here.', 'file-text'),
    `<button class="btn btn-primary" data-action="upload">${icon('upload')} Upload document</button>`);
    c.on({
      open: (el) => openRecord(c, el.dataset.id).catch((e) => UI.toast(e.message, 'error')),
      upload: () => UI.modal({
        title: 'Upload a document',
        submitLabel: 'Upload',
        body: `<div class="form-group"><label>Title</label><input name="title" required minlength="3" placeholder="e.g. Blood test from City Lab, March 2026"></div>
          <div class="form-group"><label>Notes</label><textarea name="description" maxlength="2000"></textarea></div>
          <div class="form-group"><label>File (PDF, PNG, JPEG or text, max 10 MB)</label><input type="file" name="file" accept=".pdf,.png,.jpg,.jpeg,.txt" required></div>`,
        onSubmit: async (v, form) => {
          const file = form.querySelector('[name=file]').files[0];
          const rec = await c.api.post('/api/records', { recordType: 'patient_upload', title: v.title, description: v.description });
          const fd = new FormData();
          fd.append('file', file);
          const up = await c.api.upload(`/api/records/${rec.data._id}/files`, fd);
          UI.toast(`Uploaded. SHA-256 ${up.data.sha256.slice(0, 12)}… recorded in the ledger.`, 'success');
          c.reload();
        },
      }),
    });
  }

  /* ================================================================ medications */

  async function medications(c) {
    const res = await c.api.get('/api/prescriptions');
    if (c.stale()) return;
    const active = res.data.filter((p) => p.status === 'active');
    const past = res.data.filter((p) => p.status !== 'active');
    const columns = (withActions) => [
      { label: 'Medication', render: (p) => `<strong>${esc(p.medication)}</strong> ${esc(p.dosage)}<br><span class="text-muted text-small">${esc(p.frequency)}</span>` },
      { label: 'Instructions', render: (p) => esc(p.instructions || '—') },
      { label: 'Prescribed by', render: (p) => `Dr. ${esc(p.doctorId.fullName)}<br><span class="text-muted text-small">${esc(fmtDate(p.startDate))} → ${esc(fmtDate(p.endDate))}</span>` },
      { label: 'Refills', render: (p) => `${p.refillsUsed} of ${p.refillsAllowed} used${p.refillRequest.status !== 'none' ? `<br>${tag(p.refillRequest.status, `Refill ${p.refillRequest.status}`)}` : ''}` },
      { label: 'Status', render: (p) => tag(p.status) },
      ...(withActions ? [{ label: '', render: (p) => (p.refillRequest.status === 'pending' ? '<span class="text-muted text-small">Waiting for doctor</span>'
        : (p.refillsUsed < p.refillsAllowed ? `<button class="btn btn-sm btn-primary" data-action="refill" data-id="${p._id}">Request refill</button>` : '<span class="text-muted text-small">No refills left</span>')) }] : []),
    ];
    c.container.innerHTML = `${UI.card('Active medications', 'pill', UI.table(columns(true), active, 'No active prescriptions'))}
      ${UI.card('Past prescriptions', 'history', UI.table(columns(false), past, 'None'))}`;
    c.on({ refill: (el) => c.act(() => c.api.post(`/api/prescriptions/${el.dataset.id}/refill-request`), { success: 'Refill requested. Your doctor has been notified.' }) });
  }

  /* ================================================================ metrics */

  async function metrics(c) {
    const [vitals, devices] = await Promise.all([c.api.get('/api/vitals', { days: 7 }), c.api.get('/api/devices/mine')]);
    if (c.stale()) return;
    const { readings, ranges } = vitals.data;
    const latest = readings[readings.length - 1];
    const abnormalCount = readings.filter((r) => r.abnormal.length).length;

    c.container.innerHTML = `
      ${abnormalCount ? `<div class="banner banner-warning">${icon('alert-triangle')} ${abnormalCount} reading(s) this week were outside the normal range.</div>` : ''}
      <div class="vital-grid mb-3">${latest ? VITAL_FIELDS.filter(([f]) => latest[f] != null).map(([f, label, unit, ic]) => `
        <div class="vital-tile ${latest.abnormal.includes(f) ? 'abnormal' : ''}"><div class="flex text-muted text-small">${icon(ic)} ${label}</div>
        <div class="value">${latest[f]} <small>${unit}</small></div><div class="text-muted text-small">Normal ${ranges[f].min}–${ranges[f].max}</div></div>`).join('')
        : UI.emptyHtml('No readings in the last 7 days', 'Add one below or link a home device.', 'activity')}</div>
      <div class="grid-2">
        ${UI.card('Heart rate & oxygen (7 days)', 'heart-pulse', '<div class="chart-box"><canvas id="hrChart"></canvas></div>')}
        ${UI.card('Blood pressure (7 days)', 'gauge', '<div class="chart-box"><canvas id="bpChart"></canvas></div>')}
      </div>
      <div class="grid-2">
        ${UI.card('Linked devices', 'cpu', devices.data.length ? devices.data.map((d) => `<div class="list-item"><div class="grow"><div class="title">${esc(d.name)}</div>
          <div class="meta">${esc(titleCase(d.type))} · ${esc(d.serialNumber)} · last reading ${d.lastSeenAt ? esc(relTime(d.lastSeenAt)) : 'never'}</div></div>${tag(d.status)}</div>`).join('')
          : UI.emptyHtml('No devices', 'Ask the hospital to register a home monitoring device.', 'cpu'))}
        ${UI.card('Recent readings', 'list', UI.table([
          { label: 'Time', render: (r) => esc(fmtDateTime(r.recordedAt)) },
          { label: 'Values', render: (r) => VITAL_FIELDS.filter(([f]) => r[f] != null).map(([f, , unit]) => `<span class="${r.abnormal.includes(f) ? 'tag tag-red' : ''}">${r[f]}${unit === '%' ? '%' : ''}</span>`).join(' · ') },
          { label: 'Source', render: (r) => tag(r.source) },
        ], readings.slice(-8).reverse(), 'No readings'), `<button class="btn btn-sm btn-primary" data-action="add">${icon('plus')} Add reading</button>`)}
      </div>`;

    if (readings.length) {
      const p = c.palette();
      const labels = readings.map((r) => new Date(r.recordedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit' }));
      const line = (label, field, color, axis = 'y') => ({ label, data: readings.map((r) => r[field]), borderColor: color, backgroundColor: color, tension: 0.35, pointRadius: readings.map((r) => (r.abnormal.includes(field) ? 5 : 1.5)), spanGaps: true, yAxisID: axis });
      const opts = { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, scales: { x: { ticks: { maxTicksLimit: 7 } } } };
      c.chart(document.getElementById('hrChart'), { type: 'line', data: { labels, datasets: [line('Heart rate (bpm)', 'heartRate', p.danger), line('SpO₂ (%)', 'spo2', p.info, 'y2')] }, options: { ...opts, scales: { ...opts.scales, y2: { position: 'right', min: 85, max: 100, grid: { display: false } } } } });
      c.chart(document.getElementById('bpChart'), { type: 'line', data: { labels, datasets: [line('Systolic', 'systolic', p.accent), line('Diastolic', 'diastolic', p.warning)] }, options: opts });
    }

    c.on({
      add: () => UI.modal({
        title: 'Add a reading',
        submitLabel: 'Save reading',
        body: `<p class="text-muted text-small mb-2">Fill in whatever you measured. Values outside the normal range alert you and your doctors.</p>
          <div class="form-row">${VITAL_FIELDS.map(([f, label, unit]) => `<div class="form-group"><label>${label} (${unit})</label><input type="number" step="any" name="${f}"></div>`).join('')}</div>`,
        onSubmit: async (v) => {
          const res = await c.api.post('/api/vitals', v);
          UI.toast(res.message, res.data.abnormal.length ? 'warning' : 'success');
          c.reload();
        },
      }),
    });
  }

  /* ================================================================ permissions */

  async function permissions(c) {
    const [consents, doctors] = await Promise.all([c.api.get('/api/consents'), c.api.get('/api/doctors')]);
    if (c.stale()) return;
    const requested = consents.data.filter((g) => g.status === 'requested');
    const active = consents.data.filter((g) => g.status === 'active');
    const history = consents.data.filter((g) => !['requested', 'active'].includes(g.status));
    const doctorName = (g) => `Dr. ${esc(g.doctorId.fullName)} <span class="text-muted text-small">${esc(g.doctorId.doctorProfile?.specialization || '')}</span>`;

    c.container.innerHTML = `
      <div class="banner banner-info">${icon('info')} You decide which doctors can read your records. Every grant, denial and revocation is written to the tamper-evident ledger, and a revocation takes effect on the doctor's very next request.</div>
      ${UI.card('Access requests', 'user-check', requested.length ? requested.map((g) => `<div class="list-item"><div class="grow"><div class="title">${doctorName(g)}</div>
          <div>“${esc(g.purpose)}”</div><div class="meta">Requested ${esc(relTime(g.createdAt))}</div></div>
          <div class="actions"><button class="btn btn-sm btn-primary" data-action="approve" data-id="${g._id}">Approve</button>
          <button class="btn btn-sm btn-danger" data-action="deny" data-id="${g._id}">Deny</button></div></div>`).join('')
        : UI.emptyHtml('No pending requests', '', 'check-circle'))}
      ${UI.card('Doctors who can access your records', 'shield-check', UI.table([
        { label: 'Doctor', render: doctorName },
        { label: 'Purpose', render: (g) => esc(g.purpose) },
        { label: 'Granted', render: (g) => esc(fmtDate(g.grantedAt)) },
        { label: 'Expires', render: (g) => esc(fmtDate(g.expiresAt)) },
        { label: '', render: (g) => `<button class="btn btn-sm btn-danger" data-action="revoke" data-id="${g._id}">Revoke</button>` },
      ], active, 'No doctor currently has access'), `<button class="btn btn-primary" data-action="grant">${icon('plus')} Grant access</button>`)}
      ${UI.card('History', 'history', UI.table([
        { label: 'Doctor', render: doctorName },
        { label: 'Purpose', render: (g) => esc(g.purpose) },
        { label: 'Status', render: (g) => tag(g.status) },
        { label: 'Updated', render: (g) => esc(fmtDateTime(g.updatedAt)) },
      ], history, 'No history'))}`;

    c.on({
      approve: (el) => UI.modal({
        title: 'Approve access',
        submitLabel: 'Approve',
        body: `<div class="form-group"><label>For how long?</label><select name="durationDays">${UI.options([[7, '7 days'], [30, '30 days'], [90, '90 days'], [365, '1 year']], 30)}</select></div>`,
        onSubmit: async (v) => { await c.api.post(`/api/consents/${el.dataset.id}/approve`, { durationDays: Number(v.durationDays) }); UI.toast('Access approved', 'success'); c.reload(); },
      }),
      deny: (el) => c.act(() => c.api.post(`/api/consents/${el.dataset.id}/deny`)),
      revoke: async (el) => {
        if (await UI.confirmDialog('Revoke access', 'The doctor will lose access to your records immediately.', { confirmLabel: 'Revoke', danger: true })) {
          await c.act(() => c.api.post(`/api/consents/${el.dataset.id}/revoke`));
        }
      },
      grant: () => UI.modal({
        title: 'Grant a doctor access',
        submitLabel: 'Grant access',
        body: `<div class="form-group"><label>Doctor</label><select name="doctorId" required>${UI.options(doctors.data.map((d) => [d._id, `Dr. ${d.fullName} · ${d.doctorProfile.specialization}`]))}</select></div>
          <div class="form-group"><label>Duration</label><select name="durationDays">${UI.options([[7, '7 days'], [30, '30 days'], [90, '90 days'], [365, '1 year']], 30)}</select></div>
          <div class="form-group"><label>Purpose (optional)</label><input name="purpose" maxlength="300" placeholder="e.g. Second opinion"></div>`,
        onSubmit: async (v) => { await c.api.post('/api/consents/grant', { doctorId: v.doctorId, durationDays: Number(v.durationDays), purpose: v.purpose || 'Granted by patient' }); UI.toast('Access granted', 'success'); c.reload(); },
      }),
    });
  }

  /* ================================================================ billing */

  async function billing(c) {
    const [bills, claims] = await Promise.all([c.api.get('/api/bills'), c.api.get('/api/claims')]);
    if (c.stale()) return;
    const policy = c.user.patientProfile || {};
    c.container.innerHTML = `
      ${policy.insuranceProvider ? `<div class="banner banner-info">${icon('shield')} Insured with ${esc(policy.insuranceProvider)} · policy ${esc(policy.policyNumber || 'not set')}</div>`
        : `<div class="banner banner-warning">${icon('shield-off')} Add your insurance provider and policy number in Profile & Security to file claims. <button class="btn btn-sm btn-secondary" data-nav="profile">Open profile</button></div>`}
      ${UI.card('Bills', 'receipt', UI.table([
        { label: 'Bill', render: (b) => `<strong>${esc(b.billNumber)}</strong><br><span class="text-muted text-small">${esc(fmtDate(b.createdAt))}</span>` },
        { label: 'Description', render: (b) => esc(b.description) },
        { label: 'Amount', render: (b) => `${fmtMoney(b.amount)}${b.coveredAmount ? `<br><span class="text-muted text-small">Insurance paid ${fmtMoney(b.coveredAmount)}</span>` : ''}` },
        { label: 'Status', render: (b) => tag(b.status) },
        { label: '', render: (b) => `<div class="actions">${b.status === 'unpaid' ? `<button class="btn btn-sm btn-primary" data-action="claim" data-id="${b._id}">File claim</button>` : ''}
          ${['unpaid', 'partially_covered'].includes(b.status) ? `<button class="btn btn-sm btn-secondary" data-action="pay" data-id="${b._id}" data-amount="${b.amount - b.coveredAmount}">Record payment</button>` : ''}</div>` },
      ], bills.data, 'No bills'))}
      ${UI.card('Insurance claims', 'file-check', claims.data.length ? claims.data.map((cl) => `
        <div class="list-item"><div class="grow"><div class="flex-between"><div class="title">${esc(cl.claimNumber)} · ${fmtMoney(cl.amount)}</div>${tag(cl.status)}</div>
          <div class="meta">${esc(cl.insuranceProvider)} · bill ${esc(cl.billId?.billNumber || '')}${cl.approvedAmount ? ` · approved ${fmtMoney(cl.approvedAmount)}` : ''}${cl.settlementReference ? ` · ref ${esc(cl.settlementReference)}` : ''}</div>
          ${cl.decisionNote ? `<div class="text-small">Insurer: “${esc(cl.decisionNote)}”</div>` : ''}
          <div class="timeline mt-2">${cl.history.map((h) => `<div class="timeline-item">${esc(titleCase(h.status))} <span class="text-muted text-small">· ${esc(fmtDateTime(h.at))}${h.note ? ` · ${esc(h.note)}` : ''}</span></div>`).join('')}</div>
        </div></div>`).join('') : UI.emptyHtml('No claims yet', 'File a claim on an unpaid bill.', 'file-check'))}`;

    c.on({
      claim: (el) => UI.modal({
        title: 'File an insurance claim',
        submitLabel: 'Submit claim',
        body: `<p>The claim goes to <strong>${esc(policy.insuranceProvider || 'your insurer')}</strong> under policy <strong>${esc(policy.policyNumber || '—')}</strong>. Insurers only see billing details, never your medical records.</p>
          <div class="form-group mt-2"><label>Note for the insurer (optional)</label><textarea name="description" maxlength="1000"></textarea></div>`,
        onSubmit: async (v) => { const r = await c.api.post('/api/claims', { billId: el.dataset.id, description: v.description }); UI.toast(r.message, 'success'); c.reload(); },
      }),
      pay: async (el) => {
        if (await UI.confirmDialog('Record payment', `Record that you paid ${fmtMoney(el.dataset.amount)} at the hospital counter?`, { confirmLabel: 'Record payment' })) {
          await c.act(() => c.api.post(`/api/bills/${el.dataset.id}/pay`));
        }
      },
    });
  }

  /* ================================================================ profile extra */

  function profileExtra(user) {
    const p = user.patientProfile || {};
    const insurers = (publicSettings && publicSettings.insuranceProviders) || [];
    return {
      html: `<h4 class="mt-3 mb-2">Medical & insurance</h4>
        <div class="form-row">
          <div class="form-group"><label>Blood type</label><select name="bloodType">${UI.options(['', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((b) => [b, b || 'Unknown']), p.bloodType)}</select></div>
          <div class="form-group"><label>Allergies (comma separated)</label><input name="allergies" value="${esc((p.allergies || []).join(', '))}"></div>
        </div>
        <div class="form-group"><label>Emergency contact</label><input name="emergencyContact" value="${esc(p.emergencyContact)}"></div>
        <div class="form-row">
          <div class="form-group"><label>Insurance provider</label><select name="insuranceProvider">${UI.options([['', 'None'], ...insurers.map((i) => [i, i])], p.insuranceProvider)}</select></div>
          <div class="form-group"><label>Policy number</label><input name="policyNumber" value="${esc(p.policyNumber)}"></div>
        </div>`,
      read: (v) => ({
        patientProfile: {
          bloodType: v.bloodType, emergencyContact: v.emergencyContact, insuranceProvider: v.insuranceProvider, policyNumber: v.policyNumber,
          allergies: v.allergies ? v.allergies.split(',').map((a) => a.trim()).filter(Boolean) : [],
        },
      }),
    };
  }

  async function startPatient() {
    await settings(MediApi).catch(() => null);
    Portal.start({
      role: 'patient',
      subtitle: (u) => `Patient · ${u.patientProfile?.bloodType || 'blood type not set'}`,
      nav: [
        { group: 'Overview', items: [{ id: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard' }, { id: 'notifications', label: 'Notifications', icon: 'bell', badge: 'notifications' }] },
        { group: 'My health', items: [
          { id: 'appointments', label: 'Appointments', icon: 'calendar' },
          { id: 'records', label: 'Medical Records', icon: 'file-text', title: 'Medical Records' },
          { id: 'medications', label: 'Medications', icon: 'pill' },
          { id: 'metrics', label: 'Health Metrics', icon: 'activity' },
        ] },
        { group: 'Account', items: [
          { id: 'permissions', label: 'Permissions', icon: 'shield', badge: 'permissions', title: 'Access Permissions' },
          { id: 'billing', label: 'Billing & Claims', icon: 'receipt' },
          { id: 'profile', label: 'Profile & Security', icon: 'settings' },
        ] },
      ],
      pages: { dashboard, appointments, records, medications, metrics, permissions, billing },
      profileExtra,
      badges: async ({ api, setBadge }) => {
        const consents = await api.get('/api/consents');
        setBadge('badge-permissions', consents.data.filter((g) => g.status === 'requested').length);
      },
    });
  }

  startPatient();
}());
