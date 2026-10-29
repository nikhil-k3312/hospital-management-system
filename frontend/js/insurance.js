/* Insurance agent dashboard. Agents see billing data only, never clinical records. */
(function insurancePortal() {
  const { esc, icon, tag, fmtDate, fmtDateTime, fmtMoney, relTime, titleCase, shortHash } = UI;
  const NEXT = {
    submitted: [['under_review', 'Start review', 'btn-primary']],
    under_review: [['approved', 'Approve', 'btn-primary'], ['denied', 'Deny', 'btn-danger']],
    approved: [['settled', 'Settle payment', 'btn-success']],
  };

  /* ================================================================ dashboard */

  async function dashboard(c) {
    if (c.user.approvalStatus !== 'approved') {
      c.container.innerHTML = UI.card('Waiting for verification', 'hourglass', UI.emptyHtml('Your account is not verified yet', 'An administrator must verify you before you can see claims.', 'hourglass'));
      return;
    }
    const [claims, report] = await Promise.all([c.api.get('/api/claims'), c.api.get('/api/claims/reports')]);
    if (c.stale()) return;
    const r = report.data;
    const by = (s) => claims.data.filter((x) => x.status === s);
    c.container.innerHTML = `
      <div class="welcome-banner"><div><h2>${esc(c.user.agentProfile?.company || 'Claims')} desk</h2>
        <p>${by('submitted').length} new claim(s) and ${by('under_review').length} under review.</p></div>${icon('briefcase', 'class="welcome-banner-icon"')}</div>
      <div class="dashboard-stats-grid">
        ${UI.statCard('inbox', 'orange', by('submitted').length, 'New claims', 'queue')}
        ${UI.statCard('search', 'blue', by('under_review').length, 'Under review', 'queue')}
        ${UI.statCard('check-circle', 'green', by('approved').length, 'Approved, to settle', 'queue')}
        ${UI.statCard('wallet', 'purple', fmtMoney(r.totalSettled), 'Settled to date', 'settlements')}
      </div>
      <div class="dashboard-main-grid">
        ${UI.card('Claimed vs settled by month', 'bar-chart-2', '<div class="chart-box"><canvas id="monthChart"></canvas></div>')}
        ${UI.card('Needs action', 'list-checks', [...by('submitted'), ...by('under_review'), ...by('approved')].slice(0, 6).map((cl) => `
          <div class="list-item"><div class="grow"><div class="title">${esc(cl.claimNumber)} · ${fmtMoney(cl.amount)}</div>
            <div class="meta">${esc(cl.patientId.fullName)} · ${esc(relTime(cl.createdAt))}</div></div>${tag(cl.status)}</div>`).join('')
          || UI.emptyHtml('All caught up', '', 'check-circle'), '<button class="btn btn-sm btn-secondary" data-nav="queue">Open queue</button>')}
      </div>`;
    const p = c.palette();
    c.chart(document.getElementById('monthChart'), {
      type: 'bar',
      data: { labels: r.monthly.map((m) => m._id), datasets: [
        { label: 'Claimed', data: r.monthly.map((m) => m.claimed), backgroundColor: p.info, borderRadius: 6 },
        { label: 'Settled', data: r.monthly.map((m) => m.settled), backgroundColor: p.accent, borderRadius: 6 },
      ] },
      options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true } } },
    });
  }

  /* ================================================================ queue */

  let statusFilter = '';

  async function openClaim(c, id) {
    const res = await c.api.get(`/api/claims/${id}`);
    const cl = res.data;
    const actions = (NEXT[cl.status] || []).map(([status, label, cls]) => `<button type="button" class="btn ${cls}" data-move="${status}">${label}</button>`).join('');
    const overlay = UI.modal({
      title: `Claim ${cl.claimNumber}`,
      wide: true,
      body: `<div class="flex-between mb-2">${tag(cl.status)}<span class="text-muted text-small">Filed ${esc(fmtDateTime(cl.createdAt))}</span></div>
        <div class="grid-2">
          <dl class="kv"><dt>Patient</dt><dd>${esc(cl.patientId.fullName)}<br><span class="text-muted text-small">${esc(cl.patientId.email)}</span></dd>
            <dt>Insurer</dt><dd>${esc(cl.insuranceProvider)}</dd><dt>Policy</dt><dd class="mono">${esc(cl.policyNumber)}</dd>
            <dt>Claimed</dt><dd><strong>${fmtMoney(cl.amount)}</strong></dd>
            ${cl.approvedAmount ? `<dt>Approved</dt><dd>${fmtMoney(cl.approvedAmount)}</dd>` : ''}
            ${cl.settlementReference ? `<dt>Settlement</dt><dd class="mono">${esc(cl.settlementReference)}</dd>` : ''}</dl>
          <dl class="kv"><dt>Bill</dt><dd class="mono">${esc(cl.billId.billNumber)}</dd><dt>Service</dt><dd>${esc(cl.billId.description)}</dd>
            <dt>Bill date</dt><dd>${esc(fmtDate(cl.billId.createdAt))}</dd><dt>Note</dt><dd>${esc(cl.description || '—')}</dd></dl>
        </div>
        <p class="text-muted text-small mt-2">${icon('lock')} Clinical records are not visible to insurers. Decisions are based on the bill.</p>
        <h4 class="mt-3 mb-2">Status history</h4>
        <div class="timeline">${cl.history.map((h) => `<div class="timeline-item">${tag(h.status)} <span class="text-muted text-small">${esc(fmtDateTime(h.at))} · ${esc(titleCase(h.byRole))}${h.note ? ` · “${esc(h.note)}”` : ''}</span></div>`).join('')}</div>
        <h4 class="mt-3 mb-2">Ledger trail</h4>
        ${res.meta.history.map((e) => `<div class="text-small"><span class="mono">#${e.seq}</span> ${esc(e.action)} · ${esc(fmtDateTime(e.timestamp))} · <span class="mono">${esc(shortHash(e.entryHash, 16))}</span></div>`).join('')}
        ${actions ? `<div class="flex mt-3" data-actions>${actions}</div>` : ''}`,
    });

    overlay.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-move]');
      if (!btn) return;
      const status = btn.dataset.move;
      if (status === 'under_review' || status === 'settled') {
        c.act(() => c.api.patch(`/api/claims/${id}`, { status }), { success: status === 'settled' ? 'Settled. The bill is now covered.' : 'Claim moved to review' })
          .then((ok) => { if (ok) openClaim(c, id); });
        return;
      }
      UI.modal({
        title: status === 'approved' ? 'Approve claim' : 'Deny claim',
        submitLabel: status === 'approved' ? 'Approve' : 'Deny',
        danger: status === 'denied',
        body: status === 'approved'
          ? `<div class="form-group"><label>Approved amount (₹, at most ${fmtMoney(cl.amount)})</label><input type="number" name="approvedAmount" min="0" max="${cl.amount}" step="0.01" value="${cl.amount}" required></div>
             <div class="form-group"><label>Note (optional)</label><input name="note" maxlength="1000"></div>`
          : '<div class="form-group"><label>Reason (shown to the patient)</label><textarea name="note" required maxlength="1000"></textarea></div>',
        onSubmit: async (v) => {
          await c.api.patch(`/api/claims/${id}`, { status, ...v });
          UI.toast(`Claim ${status}`, status === 'approved' ? 'success' : 'info');
          c.reload();
          setTimeout(() => openClaim(c, id), 300);
        },
      });
    });
  }

  async function queue(c) {
    const res = await c.api.get('/api/claims', { status: statusFilter });
    if (c.stale()) return;
    const statuses = [['', 'All'], ['submitted', 'Submitted'], ['under_review', 'Under review'], ['approved', 'Approved'], ['denied', 'Denied'], ['settled', 'Settled']];
    c.container.innerHTML = UI.card('Claims queue', 'inbox', `
      <div class="tab-nav">${statuses.map(([v, l]) => `<button class="tab-btn ${statusFilter === v ? 'active' : ''}" data-action="filter" data-status="${v}">${l}</button>`).join('')}</div>
      ${UI.table([
        { label: 'Claim', render: (cl) => `<strong>${esc(cl.claimNumber)}</strong><br><span class="text-muted text-small">${esc(relTime(cl.createdAt))}</span>` },
        { label: 'Patient', render: (cl) => `${esc(cl.patientId.fullName)}<br><span class="mono">${esc(cl.policyNumber)}</span>` },
        { label: 'Service', render: (cl) => esc(cl.billId.description) },
        { label: 'Amount', render: (cl) => `${fmtMoney(cl.amount)}${cl.approvedAmount ? `<br><span class="text-muted text-small">approved ${fmtMoney(cl.approvedAmount)}</span>` : ''}` },
        { label: 'Status', render: (cl) => tag(cl.status) },
        { label: '', render: (cl) => `<button class="btn btn-sm ${NEXT[cl.status] ? 'btn-primary' : 'btn-secondary'}" data-action="open" data-id="${cl._id}">${NEXT[cl.status] ? 'Process' : 'View'}</button>` },
      ], res.data, 'No claims in this view')}`);
    c.on({
      filter: (el) => { statusFilter = el.dataset.status; c.reload(); },
      open: (el) => openClaim(c, el.dataset.id).catch((e) => UI.toast(e.message, 'error')),
    });
  }

  /* ================================================================ settlements & reports */

  async function settlements(c) {
    const res = await c.api.get('/api/claims/settlements');
    if (c.stale()) return;
    const total = res.data.reduce((n, cl) => n + cl.approvedAmount, 0);
    c.container.innerHTML = UI.card(`Settlements · ${fmtMoney(total)} paid out`, 'wallet', UI.table([
      { label: 'Settled', render: (cl) => esc(fmtDateTime(cl.settledAt)) },
      { label: 'Reference', render: (cl) => `<span class="mono">${esc(cl.settlementReference)}</span>` },
      { label: 'Claim', render: (cl) => esc(cl.claimNumber) },
      { label: 'Patient', render: (cl) => esc(cl.patientId.fullName) },
      { label: 'Claimed', render: (cl) => fmtMoney(cl.amount) },
      { label: 'Paid', render: (cl) => `<strong>${fmtMoney(cl.approvedAmount)}</strong>` },
      { label: 'Agent', render: (cl) => esc(cl.agentId ? cl.agentId.fullName : '—') },
    ], res.data, 'No settlements yet'));
  }

  async function reports(c) {
    const r = (await c.api.get('/api/claims/reports')).data;
    if (c.stale()) return;
    c.container.innerHTML = `
      <div class="dashboard-stats-grid">
        ${UI.statCard('files', 'blue', r.totalClaims, 'Claims received')}
        ${UI.statCard('indian-rupee', 'orange', fmtMoney(r.totalClaimed), 'Total claimed')}
        ${UI.statCard('wallet', 'green', fmtMoney(r.totalSettled), 'Total settled')}
        ${UI.statCard('percent', 'purple', r.approvalRate === null ? '—' : `${Math.round(r.approvalRate * 100)}%`, 'Approval rate')}
      </div>
      <div class="grid-2">
        ${UI.card('Claims by status', 'pie-chart', '<div class="chart-box"><canvas id="statusChart"></canvas></div>')}
        ${UI.card('Summary by status', 'table', UI.table([
          { label: 'Status', render: (s) => tag(s._id) },
          { label: 'Claims', render: (s) => s.count },
          { label: 'Claimed', render: (s) => fmtMoney(s.amount) },
          { label: 'Approved', render: (s) => fmtMoney(s.approved) },
        ], r.byStatus, 'No claims'), `<span class="text-muted text-small">Average time to settle: ${r.avgSettlementHours === null ? '—' : `${r.avgSettlementHours.toFixed(1)} h`}</span>`)}
      </div>`;
    const p = c.palette();
    c.chart(document.getElementById('statusChart'), {
      type: 'doughnut',
      data: { labels: r.byStatus.map((s) => titleCase(s._id)), datasets: [{ data: r.byStatus.map((s) => s.count), backgroundColor: [p.warning, p.info, p.accent, p.danger, p.success] }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } } },
    });
  }

  function profileExtra(user) {
    const a = user.agentProfile || {};
    return {
      html: `<h4 class="mt-3 mb-2">Insurer</h4><div class="form-row">
        <div class="form-group"><label>Company</label><input value="${esc(a.company)}" disabled><span class="hint">Set by the administrator; claims are routed by company.</span></div>
        <div class="form-group"><label>Employee ID</label><input name="employeeId" value="${esc(a.employeeId)}"></div></div>`,
      read: (v) => ({ agentProfile: { employeeId: v.employeeId } }),
    };
  }

  Portal.start({
    role: 'insurance_agent',
    subtitle: (u) => `${u.agentProfile?.company || 'Insurance'} agent`,
    nav: [
      { group: 'Claims', items: [
        { id: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard' },
        { id: 'queue', label: 'Claims Queue', icon: 'inbox', badge: 'queue' },
        { id: 'settlements', label: 'Settlements', icon: 'wallet' },
        { id: 'reports', label: 'Reports', icon: 'bar-chart-3', title: 'Financial Reports' },
      ] },
      { group: 'Account', items: [
        { id: 'notifications', label: 'Notifications', icon: 'bell', badge: 'notifications' },
        { id: 'profile', label: 'Profile & Security', icon: 'settings' },
      ] },
    ],
    pages: { dashboard, queue, settlements, reports },
    profileExtra,
    badges: async ({ api, setBadge, user }) => {
      if (user.approvalStatus !== 'approved') return;
      const res = await api.get('/api/claims');
      setBadge('badge-queue', res.data.filter((cl) => ['submitted', 'under_review', 'approved'].includes(cl.status)).length);
    },
  });
}());
