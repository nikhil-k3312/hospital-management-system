/* Admin dashboard. Every number and row below comes from the MediChain API. */
(function adminPortal() {
  const { esc, icon, tag, fmtDate, fmtDateTime, fmtMoney, relTime, titleCase, shortHash } = UI;
  const ROLE_NAMES = { patient: 'Patients', doctor: 'Doctors', admin: 'Admins', insurance_agent: 'Insurance agents' };

  /* ================================================================ dashboard */

  async function dashboard(c) {
    const s = (await c.api.get('/api/admin/stats')).data;
    if (c.stale()) return;
    const roleTotal = (role) => (s.users.byRole.find((r) => r._id === role) || {}).total || 0;
    const sys = s.system;
    const health = (dep) => (dep.ok ? `${tag('active', 'Up')} <span class="text-muted text-small">${dep.latencyMs} ms</span>` : tag('denied', 'Down'));

    c.container.innerHTML = `
      ${s.users.pendingVerification ? `<div class="banner banner-warning">${icon('user-check')} ${s.users.pendingVerification} account(s) are waiting for credential verification.
        <button class="btn btn-sm btn-secondary" data-nav="verification">Review</button></div>` : ''}
      <div class="dashboard-stats-grid">
        ${UI.statCard('users', 'blue', s.users.total, 'Registered users', 'users')}
        ${UI.statCard('stethoscope', 'green', roleTotal('doctor'), 'Doctors', 'users')}
        ${UI.statCard('calendar', 'purple', s.appointments.today, 'Appointments today', 'reports')}
        ${UI.statCard('file-text', 'orange', s.records, 'Medical records', 'ledger')}
        ${UI.statCard('shield-check', 'green', s.activeConsents, 'Active consents', 'access')}
        ${UI.statCard('link', 'blue', s.ledger.records.entries, 'Ledger blocks', 'ledger')}
        ${UI.statCard('cpu', 'purple', s.iot.readings24h, 'IoT readings (24 h)', 'devices')}
        ${UI.statCard('wallet', 'orange', fmtMoney(s.revenue.billed), 'Total billed', 'reports')}
      </div>
      <div class="grid-2">
        ${UI.card('Appointments, last 7 days', 'bar-chart-2', '<div class="chart-box"><canvas id="apptChart"></canvas></div>')}
        ${UI.card('Users by role', 'pie-chart', '<div class="chart-box"><canvas id="roleChart"></canvas></div>')}
      </div>
      <div class="grid-2">
        ${UI.card('System health (live)', 'server', `<dl class="kv">
          <dt>API uptime</dt><dd>${Math.floor(sys.uptimeSeconds / 3600)} h ${Math.floor((sys.uptimeSeconds % 3600) / 60)} min</dd>
          <dt>MongoDB</dt><dd>${health(sys.mongo)}</dd>
          <dt>Redis</dt><dd>${health(sys.redis)}</dd>
          <dt>Memory (heap)</dt><dd>${sys.memory.heapUsedMB} / ${sys.memory.heapTotalMB} MB · RSS ${sys.memory.rssMB} MB</dd>
          <dt>Load average</dt><dd>${sys.loadAverage.map((l) => l.toFixed(2)).join(' · ')} (${sys.cpus} CPUs)</dd>
          <dt>Node.js</dt><dd>${esc(sys.nodeVersion)}</dd></dl>`, '<button class="btn btn-sm btn-secondary" data-action="refresh">Refresh</button>')}
        ${UI.card('Ledger heads', 'link', `<dl class="kv">
          <dt>Records chain</dt><dd>${s.ledger.records.entries} blocks<br><span class="mono">${esc(shortHash(s.ledger.records.headHash, 32))}</span></dd>
          <dt>Access chain</dt><dd>${s.ledger.access.entries} decisions<br><span class="mono">${esc(shortHash(s.ledger.access.headHash, 32))}</span></dd>
          <dt>Last block</dt><dd>${esc(relTime(s.ledger.records.lastEntryAt))}</dd></dl>`, '<button class="btn btn-sm btn-primary" data-nav="ledger">Verify</button>')}
      </div>`;

    const p = c.palette();
    c.chart(document.getElementById('apptChart'), {
      type: 'bar',
      data: { labels: s.appointments.last7Days.map((d) => new Date(d.date).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric' })),
        datasets: [{ label: 'Appointments', data: s.appointments.last7Days.map((d) => d.count), backgroundColor: p.accent, borderRadius: 6 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } },
    });
    c.chart(document.getElementById('roleChart'), {
      type: 'doughnut',
      data: { labels: s.users.byRole.map((r) => ROLE_NAMES[r._id] || r._id), datasets: [{ data: s.users.byRole.map((r) => r.total), backgroundColor: [p.accent, p.info, p.warning, p.danger] }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } } },
    });
    c.on({ refresh: () => c.reload() });
  }

  /* ================================================================ verification */

  async function verification(c) {
    const res = await c.api.get('/api/admin/doctors/pending-verification');
    if (c.stale()) return;
    c.container.innerHTML = UI.card('Credential verification', 'user-check', res.data.length ? res.data.map((u) => `
      <div class="list-item"><div class="user-profile-avatar">${esc(UI.initials(u.fullName))}</div><div class="grow">
        <div class="title">${u.role === 'doctor' ? 'Dr. ' : ''}${esc(u.fullName)} ${tag('pending', titleCase(u.role))}</div>
        <div class="meta">${esc(u.email)} · registered ${esc(relTime(u.createdAt))}</div>
        <dl class="kv mt-1">${u.role === 'doctor'
          ? `<dt>Specialization</dt><dd>${esc(u.doctorProfile.specialization)}</dd><dt>Licence number</dt><dd class="mono">${esc(u.doctorProfile.licenseNumber)}</dd>`
          : `<dt>Company</dt><dd>${esc(u.agentProfile.company)}</dd><dt>Employee ID</dt><dd>${esc(u.agentProfile.employeeId || '—')}</dd>`}</dl></div>
        <div class="actions"><button class="btn btn-sm btn-primary" data-action="approve" data-id="${u._id}">Approve</button>
        <button class="btn btn-sm btn-danger" data-action="reject" data-id="${u._id}">Reject</button></div></div>`).join('')
      : UI.emptyHtml('Nobody is waiting', 'Doctors and insurance agents who register themselves appear here.', 'check-circle'));
    c.on({
      approve: (el) => c.act(() => c.api.patch(`/api/admin/doctors/${el.dataset.id}/verify`, { decision: 'approve' }), { success: 'Approved. The account can now use clinical features.' }),
      reject: (el) => UI.modal({
        title: 'Reject verification',
        submitLabel: 'Reject',
        danger: true,
        body: '<div class="form-group"><label>Reason (sent to the applicant)</label><textarea name="note" required maxlength="500"></textarea></div>',
        onSubmit: async (v) => { await c.api.patch(`/api/admin/doctors/${el.dataset.id}/verify`, { decision: 'reject', note: v.note }); UI.toast('Rejected', 'info'); c.reload(); },
      }),
    });
  }

  /* ================================================================ users */

  const userFilters = { role: '', status: '', q: '' };

  async function users(c) {
    const res = await c.api.get('/api/admin/users', userFilters);
    if (c.stale()) return;
    c.container.innerHTML = UI.card('User management', 'users', `
      <form class="form-row mb-3" data-filters>
        <div class="form-group"><label>Search</label><input name="q" value="${esc(userFilters.q)}" placeholder="Name or email"></div>
        <div class="form-group"><label>Role</label><select name="role">${UI.options([['', 'All roles'], ['patient', 'Patient'], ['doctor', 'Doctor'], ['insurance_agent', 'Insurance agent'], ['admin', 'Admin']], userFilters.role)}</select></div>
        <div class="form-group"><label>Status</label><select name="status">${UI.options([['', 'Any'], ['active', 'Active'], ['inactive', 'Deactivated'], ['pending', 'Pending verification']], userFilters.status)}</select></div>
      </form>
      ${UI.table([
        { label: 'User', render: (u) => `<strong>${esc(u.fullName)}</strong><br><span class="text-muted text-small">${esc(u.email)}</span>` },
        { label: 'Role', render: (u) => esc(titleCase(u.role)) },
        { label: 'Verification', render: (u) => tag(u.approvalStatus) },
        { label: 'Status', render: (u) => (u.isActive ? tag('active') : tag('inactive', 'Deactivated')) },
        { label: 'Last login', render: (u) => esc(u.lastLogin ? relTime(u.lastLogin) : 'never') },
        { label: '', render: (u) => (u._id === c.user._id ? '<span class="text-muted text-small">You</span>'
          : `<button class="btn btn-sm ${u.isActive ? 'btn-danger' : 'btn-primary'}" data-action="toggle" data-id="${u._id}" data-active="${u.isActive}">${u.isActive ? 'Deactivate' : 'Activate'}</button>`) },
      ], res.data, 'No users match')}`, `<button class="btn btn-primary" data-action="create">${icon('user-plus')} Create staff account</button>`);

    const filterForm = c.container.querySelector('[data-filters]');
    let debounce;
    filterForm.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => { Object.assign(userFilters, UI.formValues(filterForm)); c.reload(); }, 350);
    });
    filterForm.addEventListener('submit', (e) => e.preventDefault());

    c.on({
      toggle: async (el) => {
        const deactivate = el.dataset.active === 'true';
        if (deactivate && !(await UI.confirmDialog('Deactivate account', 'The user is signed out everywhere and cut off within seconds, even with a valid token.', { confirmLabel: 'Deactivate', danger: true }))) return;
        await c.act(() => c.api.patch(`/api/admin/users/${el.dataset.id}`, { isActive: !deactivate }));
      },
      create: async () => {
        const settings = (await c.api.get('/api/admin/settings')).data;
        const overlay = UI.modal({
          title: 'Create staff account',
          submitLabel: 'Create account',
          body: `<div class="form-group"><label>Role</label><select name="role" data-role>${UI.options([['doctor', 'Doctor'], ['insurance_agent', 'Insurance agent'], ['admin', 'Administrator']])}</select></div>
            <div class="form-row"><div class="form-group"><label>Full name</label><input name="fullName" required minlength="2"></div>
              <div class="form-group"><label>Email</label><input type="email" name="email" required></div></div>
            <div class="form-group"><label>Temporary password</label><input type="password" name="password" required minlength="8" autocomplete="new-password"><span class="hint">Share it securely; the user should change it after first login.</span></div>
            <div data-for="doctor" class="form-row"><div class="form-group"><label>Specialization</label><select name="specialization">${UI.options(settings.departments)}</select></div>
              <div class="form-group"><label>Licence number</label><input name="licenseNumber"></div>
              <div class="form-group"><label>Fee (₹)</label><input type="number" name="consultationFee" value="500" min="0"></div></div>
            <div data-for="insurance_agent" class="form-group"><label>Company</label><select name="company">${UI.options(settings.insuranceProviders)}</select></div>`,
          onSubmit: async (v) => {
            const body = { role: v.role, fullName: v.fullName, email: v.email, password: v.password };
            if (v.role === 'doctor') Object.assign(body, { specialization: v.specialization, licenseNumber: v.licenseNumber, consultationFee: v.consultationFee });
            if (v.role === 'insurance_agent') body.company = v.company;
            const r = await c.api.post('/api/admin/users', body);
            UI.toast(r.message, 'success');
            c.reload();
          },
        });
        const roleSelect = overlay.querySelector('[data-role]');
        const sync = () => overlay.querySelectorAll('[data-for]').forEach((b) => {
          const on = b.dataset.for === roleSelect.value;
          b.style.display = on ? '' : 'none';
          b.querySelectorAll('input,select').forEach((i) => { i.disabled = !on; if (i.name === 'licenseNumber') i.required = on; });
        });
        roleSelect.addEventListener('change', sync);
        sync();
      },
    });
  }

  /* ================================================================ ledger */

  let lastVerification = null;
  let ledgerChain = 'records';

  function blockHtml(e) {
    const deny = e.action === 'DENY';
    const glass = e.action === 'BREAK_GLASS_ACCESS' || (e.meta && e.meta.reason === 'break_glass_allowed');
    return `<div class="block ${deny ? 'deny' : ''} ${glass ? 'glass' : ''}">
      <div class="block-head"><span>#${e.seq} · ${esc(e.action)} · ${esc(titleCase(e.entityType))}</span><span class="text-muted text-small">${esc(fmtDateTime(e.timestamp))}</span></div>
      <div class="text-small">${esc(e.actorName || e.actorRole || 'system')}${e.meta && e.meta.reason ? ` · ${esc(titleCase(e.meta.reason))}` : ''}${e.meta && e.meta.path ? ` · <span class="mono">${esc(e.meta.method)} ${esc(e.meta.path)}</span>` : ''}</div>
      <div class="hash-row mono"><span>entity</span><span>${esc(e.entityId || '—')}</span>
        ${e.payloadHash ? `<span>payload</span><span>${esc(e.payloadHash)}</span>` : ''}
        <span>previous</span><span>${esc(e.previousEntryHash || 'null (genesis)')}</span>
        <span>hash</span><span>${esc(e.entryHash)}</span></div></div>`;
  }

  async function ledger(c) {
    const [stats, entries] = await Promise.all([c.api.get('/api/ledger/stats'), c.api.get('/api/ledger/entries', { chain: ledgerChain, limit: 30 })]);
    if (c.stale()) return;
    const v = lastVerification;
    const verifyHtml = v ? (v.valid
      ? `<div class="banner banner-success">${icon('badge-check')} LEDGER VALID. ${v.chains.map((ch) => `${ch.chain}: ${ch.entriesChecked} blocks`).join(' · ')}. ${v.entities.reduce((n, e) => n + e.checked, 0)} documents match their ledger hashes. Checked ${esc(relTime(v.checkedAt))} in ${v.durationMs} ms.</div>`
      : `<div class="banner banner-danger">${icon('shield-x')} TAMPERING DETECTED</div>
         ${v.chains.filter((ch) => !ch.valid).map((ch) => `<p><strong>${esc(ch.chain)} chain broken</strong> at block #${ch.brokenAtSeq}: ${esc(titleCase(ch.problem))}. A ledger entry was edited or removed directly in the database.</p>`).join('')}
         ${v.entities.filter((e) => e.tampered.length).map((e) => `<p><strong>${esc(e.label)}</strong>: ${e.tampered.length} document(s) changed outside MediChain:
           ${e.tampered.map((t) => `<strong>“${esc(t.name)}”</strong> <span class="mono">${esc(t.entityId)}</span> (${esc(titleCase(t.reason))}${t.ledgerSeq !== undefined ? `, last valid block #${t.ledgerSeq}` : ''})`).join(', ')}</p>`).join('')}`)
      : '<p class="text-muted">Run a verification to recompute every block hash and compare every protected document with the ledger.</p>';

    c.container.innerHTML = `
      <div class="dashboard-stats-grid">
        ${UI.statCard('link', 'blue', stats.data.records.entries, 'Records-chain blocks')}
        ${UI.statCard('shield', 'purple', stats.data.access.entries, 'Access decisions')}
        ${UI.statCard('clock', 'green', relTime(stats.data.records.lastEntryAt), 'Last block')}
      </div>
      ${UI.card('Integrity verification', 'shield-check', verifyHtml, `<button class="btn btn-primary" data-action="verify">${icon('scan-search')} Verify ledger</button>`)}
      <div class="grid-2">
        ${UI.card('Latest blocks', 'blocks', `<div class="tab-nav"><button class="tab-btn ${ledgerChain === 'records' ? 'active' : ''}" data-action="chain" data-chain="records">Records chain</button>
            <button class="tab-btn ${ledgerChain === 'access' ? 'active' : ''}" data-action="chain" data-chain="access">Access chain</button></div>
          <div class="chain">${entries.data.map(blockHtml).join('') || UI.emptyHtml('Empty chain', '', 'link')}</div>`)}
        ${UI.card('What the records chain holds', 'list', UI.table([
          { label: 'Entity', render: (r) => esc(titleCase(r._id.entityType)) },
          { label: 'Action', render: (r) => `<span class="mono">${esc(r._id.action)}</span>` },
          { label: 'Blocks', render: (r) => r.count },
        ], stats.data.byAction))}
      </div>`;
    c.on({
      verify: async () => {
        try {
          lastVerification = (await c.api.get('/api/ledger/verify')).data;
          UI.toast(lastVerification.valid ? 'Ledger valid' : 'Tampering detected', lastVerification.valid ? 'success' : 'error');
          c.reload();
        } catch (error) { UI.toast(error.message, 'error'); }
      },
      chain: (el) => { ledgerChain = el.dataset.chain; c.reload(); },
    });
  }

  /* ================================================================ access audit */

  const auditFilter = { decision: '', reason: '' };

  async function access(c) {
    const res = await c.api.get('/api/admin/audit', { ...auditFilter, limit: 150 });
    if (c.stale()) return;
    c.container.innerHTML = `
      <div class="dashboard-stats-grid">
        ${UI.statCard('shield-x', 'red', res.meta.denied24h, 'Denied in the last 24 h')}
        ${UI.statCard('siren', 'orange', res.meta.breakGlassTotal, 'Break-glass uses (all time)')}
      </div>
      ${UI.card('Zero-trust access decisions', 'shield', `
        <form class="form-row mb-3" data-filters>
          <div class="form-group"><label>Decision</label><select name="decision">${UI.options([['', 'All'], ['allow', 'Allowed'], ['deny', 'Denied']], auditFilter.decision)}</select></div>
          <div class="form-group"><label>Reason</label><select name="reason">${UI.options([['', 'Any'], ['break_glass_allowed', 'Break-glass'], ['low_trust_score', 'Low trust score'], ['role_denied', 'Role denied'], ['approval_pending', 'Approval pending'], ['token_revoked', 'Revoked token'], ['invalid_token', 'Invalid token'], ['missing_token', 'Missing token'], ['account_deactivated', 'Deactivated account'], ['authenticated', 'Authenticated']], auditFilter.reason)}</select></div>
        </form>
        ${UI.table([
          { label: 'Time', render: (e) => `<span class="nowrap">${esc(fmtDateTime(e.timestamp))}</span><br><span class="text-muted text-small">block #${e.seq}</span>` },
          { label: 'Who', render: (e) => (e.actor ? `${esc(e.actor.fullName)}<br><span class="text-muted text-small">${esc(titleCase(e.actor.role))}</span>` : '<span class="text-muted">anonymous</span>') },
          { label: 'Request', render: (e) => `<span class="mono">${esc(e.meta.method)} ${esc(e.meta.path)}</span>` },
          { label: 'Decision', render: (e) => `${tag(e.action === 'ALLOW' ? 'allow' : 'deny', e.action)}<br><span class="text-small">${esc(titleCase(e.meta.reason))}</span>` },
          { label: 'Trust', render: (e) => (e.meta.trustScore ?? '—') },
          { label: 'Emergency reason', render: (e) => (e.meta.breakGlassReason ? `<span class="tag tag-yellow">${esc(e.meta.breakGlassReason)}</span>` : '') },
        ], res.data, 'No decisions match')}`)}`;
    c.container.querySelector('[data-filters]').addEventListener('change', (e) => { Object.assign(auditFilter, UI.formValues(e.currentTarget)); c.reload(); });
  }

  /* ================================================================ devices */

  async function devices(c) {
    const res = await c.api.get('/api/admin/devices');
    if (c.stale()) return;
    c.container.innerHTML = UI.card('IoT devices', 'cpu', UI.table([
      { label: 'Device', render: (d) => `<strong>${esc(d.name)}</strong><br><span class="mono">${esc(d.serialNumber)}</span>` },
      { label: 'Type', render: (d) => esc(titleCase(d.type)) },
      { label: 'Patient', render: (d) => esc(d.patientId ? d.patientId.fullName : '—') },
      { label: 'Last reading', render: (d) => esc(d.lastSeenAt ? relTime(d.lastSeenAt) : 'never') },
      { label: 'Status', render: (d) => tag(d.status) },
      { label: '', render: (d) => `<button class="btn btn-sm ${d.status === 'active' ? 'btn-danger' : 'btn-primary'}" data-action="toggle" data-id="${d._id}" data-status="${d.status}">${d.status === 'active' ? 'Deactivate' : 'Activate'}</button>` },
    ], res.data, 'No devices registered'), `<button class="btn btn-primary" data-action="register">${icon('plus')} Register device</button>`);
    c.on({
      toggle: (el) => c.act(() => c.api.patch(`/api/admin/devices/${el.dataset.id}`, { status: el.dataset.status === 'active' ? 'inactive' : 'active' })),
      register: async () => {
        const patients = (await c.api.get('/api/admin/users', { role: 'patient' })).data.filter((u) => u.isActive);
        UI.modal({
          title: 'Register a device',
          submitLabel: 'Register',
          body: `<div class="form-row"><div class="form-group"><label>Serial number</label><input name="serialNumber" required minlength="3"></div>
              <div class="form-group"><label>Name</label><input name="name" required placeholder="e.g. Home BP monitor"></div></div>
            <div class="form-row"><div class="form-group"><label>Type</label><select name="type">${UI.options([['multi_parameter', 'Multi-parameter monitor'], ['heart_monitor', 'Heart monitor'], ['bp_monitor', 'BP monitor'], ['pulse_oximeter', 'Pulse oximeter'], ['thermometer', 'Thermometer']])}</select></div>
              <div class="form-group"><label>Patient</label><select name="patientId" required>${UI.options(patients.map((p) => [p._id, `${p.fullName} (${p.email})`]))}</select></div></div>`,
          onSubmit: async (v) => {
            const r = await c.api.post('/api/admin/devices', v);
            UI.modal({
              title: 'Device API key',
              body: `<div class="banner banner-warning">${icon('key-round')} Copy this key into the device now. Only its hash is stored, so it cannot be shown again.</div>
                <p class="mono" style="font-size:0.95rem;padding:0.8rem;background:var(--bg-tertiary);border-radius:8px">${esc(r.data.apiKey)}</p>
                <p class="text-muted text-small mt-2">The device sends readings to <span class="mono">POST /api/devices/readings</span> with header <span class="mono">x-device-key</span>.</p>`,
            });
            c.reload();
            return true;
          },
        });
      },
    });
  }

  /* ================================================================ reports */

  async function reports(c) {
    const [stats, claims] = await Promise.all([c.api.get('/api/admin/stats'), c.api.get('/api/claims/reports')]);
    if (c.stale()) return;
    const s = stats.data;
    const r = claims.data;
    c.container.innerHTML = `
      <div class="dashboard-stats-grid">
        ${UI.statCard('wallet', 'blue', fmtMoney(s.revenue.billed), 'Billed')}
        ${UI.statCard('banknote', 'green', fmtMoney(s.revenue.paid), 'Paid by patients')}
        ${UI.statCard('shield', 'purple', fmtMoney(s.revenue.covered), 'Covered by insurers')}
        ${UI.statCard('percent', 'orange', r.approvalRate === null ? '—' : `${Math.round(r.approvalRate * 100)}%`, 'Claim approval rate')}
      </div>
      <div class="grid-2">
        ${UI.card('Appointments by status', 'calendar', '<div class="chart-box"><canvas id="statusChart"></canvas></div>')}
        ${UI.card('Claims by status', 'file-check', '<div class="chart-box"><canvas id="claimChart"></canvas></div>')}
      </div>
      ${UI.card('Claims by month', 'table', UI.table([
        { label: 'Month', render: (m) => esc(m._id) },
        { label: 'Claims', render: (m) => m.count },
        { label: 'Claimed', render: (m) => fmtMoney(m.claimed) },
        { label: 'Settled', render: (m) => fmtMoney(m.settled) },
      ], r.monthly, 'No claims yet'))}`;
    const p = c.palette();
    const colors = [p.accent, p.info, p.warning, p.danger, p.success, p.muted];
    c.chart(document.getElementById('statusChart'), { type: 'doughnut', data: { labels: s.appointments.byStatus.map((x) => titleCase(x._id)), datasets: [{ data: s.appointments.byStatus.map((x) => x.count), backgroundColor: colors }] }, options: { responsive: true, maintainAspectRatio: false } });
    c.chart(document.getElementById('claimChart'), { type: 'bar', data: { labels: r.byStatus.map((x) => titleCase(x._id)), datasets: [{ label: 'Amount (₹)', data: r.byStatus.map((x) => x.amount), backgroundColor: p.info, borderRadius: 6 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } } });
  }

  /* ================================================================ settings */

  async function settings(c) {
    const s = (await c.api.get('/api/admin/settings')).data;
    if (c.stale()) return;
    c.container.innerHTML = UI.card('Hospital settings', 'building-2', `<form id="settings-form">
      <div class="form-row"><div class="form-group"><label>Hospital name</label><input name="hospitalName" value="${esc(s.hospitalName)}" required></div>
        <div class="form-group"><label>Contact email</label><input type="email" name="contactEmail" value="${esc(s.contactEmail)}"></div>
        <div class="form-group"><label>Contact phone</label><input name="contactPhone" value="${esc(s.contactPhone)}"></div></div>
      <div class="form-group"><label>Address</label><input name="address" value="${esc(s.address)}"></div>
      <div class="form-row"><div class="form-group"><label>Booking window (days ahead)</label><input type="number" name="maxAdvanceBookingDays" min="1" max="365" value="${s.maxAdvanceBookingDays}"></div>
        <div class="form-group"><label>Default consent duration (days)</label><input type="number" name="defaultConsentDays" min="1" max="365" value="${s.defaultConsentDays}"></div></div>
      <div class="form-row"><div class="form-group"><label>Insurance providers (one per line)</label><textarea name="insuranceProviders" rows="5">${esc(s.insuranceProviders.join('\n'))}</textarea>
          <span class="hint">Shown in registration and used to route claims to agents.</span></div>
        <div class="form-group"><label>Departments (one per line)</label><textarea name="departments" rows="5">${esc(s.departments.join('\n'))}</textarea></div></div>
      <button class="btn btn-primary" type="submit">${icon('save')} Save settings</button>
      <span class="text-muted text-small">Last saved ${esc(fmtDateTime(s.updatedAt))}. Every change is written to the ledger.</span></form>`);
    c.container.querySelector('#settings-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = UI.formValues(e.target);
      const lines = (t) => [...new Set(t.split('\n').map((x) => x.trim()).filter(Boolean))];
      c.act(() => c.api.patch('/api/admin/settings', { ...v, insuranceProviders: lines(v.insuranceProviders), departments: lines(v.departments) }), { success: 'Settings saved' });
    });
  }

  Portal.start({
    role: 'admin',
    subtitle: () => 'Hospital administrator',
    nav: [
      { group: 'Overview', items: [
        { id: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard', title: 'Dashboard Overview' },
        { id: 'reports', label: 'Reports', icon: 'bar-chart-3' },
      ] },
      { group: 'Management', items: [
        { id: 'verification', label: 'Verification', icon: 'user-check', badge: 'verification', title: 'Credential Verification' },
        { id: 'users', label: 'Users', icon: 'users', title: 'User Management' },
        { id: 'devices', label: 'IoT Devices', icon: 'cpu', title: 'IoT Device Management' },
        { id: 'settings', label: 'Hospital Settings', icon: 'building-2' },
      ] },
      { group: 'Security', items: [
        { id: 'ledger', label: 'Ledger', icon: 'link', title: 'Blockchain Ledger' },
        { id: 'access', label: 'Access Control', icon: 'shield', title: 'Access Control Audit' },
        { id: 'notifications', label: 'Notifications', icon: 'bell', badge: 'notifications' },
        { id: 'profile', label: 'Profile & Security', icon: 'settings' },
      ] },
    ],
    pages: { dashboard, verification, users, ledger, access, devices, reports, settings },
    badges: async ({ api, setBadge }) => {
      const res = await api.get('/api/admin/doctors/pending-verification');
      setBadge('badge-verification', res.data.length);
    },
  });
}());
