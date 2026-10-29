/**
 * Dashboard shell shared by the patient, doctor, admin and insurance pages.
 *
 * A role page calls Portal.start({ role, nav, pages, ... }). The shell then:
 *  1. restores the session from the HttpOnly refresh cookie (or sends the
 *     user to the login page), and redirects users who opened another role's
 *     dashboard to their own
 *  2. renders the sidebar, header, banners and the current page (hash routing)
 *  3. polls unread notifications, and offers the shared Notifications and
 *     Profile & Security pages to every role
 */
(function initPortal(global) {
  const { esc, icon, refreshIcons } = global.UI;
  const api = global.MediApi;
  const UI = global.UI;

  const DASHBOARDS = { patient: '/patient.html', doctor: '/doctor.html', admin: '/admin.html', insurance_agent: '/insurance.html' };
  const ROLE_LABELS = { patient: 'Patient', doctor: 'Doctor', admin: 'Administrator', insurance_agent: 'Insurance Agent' };

  const state = { config: null, user: null, page: null, charts: [], handlers: {}, pollTimer: null, renderToken: 0 };

  /* ----------------------------------------------------------------- theme */

  function applyTheme(theme) {
    document.body.classList.toggle('dark-mode', theme === 'dark');
    try { localStorage.setItem('mc-theme', theme); } catch (e) { /* storage unavailable: theme just isn't remembered */ }
  }
  function savedTheme() {
    try { return localStorage.getItem('mc-theme') || 'dark'; } catch (e) { return 'dark'; }
  }

  /* ----------------------------------------------------------------- charts */

  function cssVar(name) {
    return getComputedStyle(document.body).getPropertyValue(name).trim();
  }
  /** Creates a Chart.js chart that is destroyed automatically when the page changes. */
  function chart(canvas, config) {
    if (!global.Chart || !canvas) return null;
    const grid = cssVar('--border-primary');
    const text = cssVar('--text-tertiary');
    global.Chart.defaults.color = text;
    global.Chart.defaults.borderColor = grid;
    const instance = new global.Chart(canvas, config);
    state.charts.push(instance);
    return instance;
  }
  const palette = () => ({
    accent: cssVar('--accent-primary'), success: cssVar('--success'), warning: cssVar('--warning'),
    danger: cssVar('--danger'), info: cssVar('--info'), muted: cssVar('--text-quaternary'),
  });

  /* ----------------------------------------------------------------- layout */

  function renderLayout() {
    const { user, config } = state;
    const navHtml = config.nav.map((group) => `
      <div class="nav-group"><div class="nav-group-title">${esc(group.group)}</div>
        ${group.items.map((item) => `<a class="nav-item" href="#${item.id}" data-page-link="${item.id}">
          ${icon(item.icon)}<span>${esc(item.label)}</span>
          ${item.badge ? `<div class="nav-item-badge" id="badge-${item.badge}" style="display:none">0</div>` : ''}</a>`).join('')}
      </div>`).join('');

    document.getElementById('app').innerHTML = `
      <div class="portal-layout">
        <aside class="sidebar" id="portal-sidebar">
          <a class="sidebar-header" href="#dashboard">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2L13.88 7.33L19.5 8.24L15.25 12.37L16.3 18.02L12 15.27L7.7 18.02L8.75 12.37L4.5 8.24L10.12 7.33L12 2Z" fill="var(--accent-primary)"/></svg>
            <span style="font-family:'Lora',serif;">MediChain</span>
          </a>
          <nav class="sidebar-nav" aria-label="Main">${navHtml}</nav>
          <div class="sidebar-footer">
            <div class="user-profile">
              <div class="user-profile-avatar">${esc(UI.initials(user.fullName))}</div>
              <div class="user-profile-info">
                <div class="user-profile-name">${esc(config.displayName ? config.displayName(user) : user.fullName)}</div>
                <div class="user-profile-email">${esc(config.subtitle ? config.subtitle(user) : ROLE_LABELS[user.role])}</div>
              </div>
            </div>
            <button class="btn btn-danger" style="width:100%;justify-content:center;margin-bottom:0.5rem;" data-shell="logout">${icon('log-out')} Log out</button>
            <button class="btn btn-secondary" style="width:100%;justify-content:center;" data-shell="theme">${icon('sun')} Theme</button>
          </div>
        </aside>
        <header class="mobile-header">
          <div class="mobile-logo">MediChain <span class="role-chip">${esc(ROLE_LABELS[user.role])}</span></div>
          <button class="mobile-menu-btn" data-shell="menu" aria-label="Open menu">${icon('menu')}</button>
        </header>
        <main class="main-content">
          <header class="main-content-header">
            <div><div class="role-chip">${esc(ROLE_LABELS[user.role])} portal</div><h1 id="page-title">Dashboard</h1></div>
            <div class="header-actions">
              ${config.headerActions ? config.headerActions(user) : ''}
              <button class="notification-btn" data-nav="notifications" aria-label="Notifications">${icon('bell')}
                <div class="notification-badge" id="header-notif-badge" style="display:none">0</div></button>
            </div>
          </header>
          <div id="banners"></div>
          <div id="page-container"></div>
        </main>
      </div>`;

    refreshIcons();
  }

  function renderBanners() {
    const { user } = state;
    const banners = [];
    if (user.approvalStatus === 'pending') {
      banners.push(`<div class="banner banner-warning">${icon('hourglass')} Your account is awaiting administrator verification. Clinical and claims features unlock once you are approved.</div>`);
    } else if (user.approvalStatus === 'rejected') {
      banners.push(`<div class="banner banner-danger">${icon('x-octagon')} Your verification was declined. ${esc(user.approvalNote || '')}</div>`);
    }
    if (api.getBreakGlass()) {
      banners.push(`<div class="banner banner-danger pulse-border">${icon('siren')} EMERGENCY ACCESS IS ON. Consent checks are bypassed: every access is written to the ledger and the patient is notified. Reason: “${esc(api.getBreakGlass())}”
        <button class="btn btn-sm btn-secondary" data-shell="break-glass-off">Turn off</button></div>`);
    }
    document.getElementById('banners').innerHTML = banners.join('');
    refreshIcons();
  }

  /* ----------------------------------------------------------------- routing */

  function currentPageId() {
    const id = (location.hash || '#dashboard').slice(1);
    return state.config.pages[id] || SHARED_PAGES[id] ? id : 'dashboard';
  }

  async function showPage(pageId = currentPageId()) {
    const token = ++state.renderToken;
    state.page = pageId;
    state.handlers = {};
    state.charts.forEach((c) => c.destroy());
    state.charts = [];

    document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.pageLink === pageId));
    document.getElementById('portal-sidebar').classList.remove('active');
    const navItem = state.config.nav.flatMap((g) => g.items).find((i) => i.id === pageId);
    const title = navItem ? navItem.title || navItem.label : ((state.config.titles || {})[pageId] || SHARED_TITLES[pageId] || 'Dashboard');
    document.getElementById('page-title').textContent = title;
    document.title = `${title} · MediChain`;

    const container = document.getElementById('page-container');
    UI.loading(container);
    const render = state.config.pages[pageId] || SHARED_PAGES[pageId];
    try {
      await render(ctx(container, token));
    } catch (error) {
      if (token !== state.renderToken) return;
      if (error.code === 'SESSION_ENDED') return sendToLogin();
      UI.errorState(container, error, () => showPage(pageId));
    }
    if (token === state.renderToken) refreshIcons();
  }

  /** The context object each page renderer receives. */
  function ctx(container, token) {
    return {
      container,
      api,
      ui: UI,
      user: state.user,
      palette,
      chart,
      /** True if the user navigated away while this page was loading. */
      stale: () => token !== state.renderToken,
      /** Registers click handlers for [data-action="name"] elements on this page. */
      on: (handlers) => Object.assign(state.handlers, handlers),
      navigate: (page) => { if (location.hash === `#${page}`) showPage(page); else location.hash = page; },
      reload: () => showPage(state.page),
      refreshUser: async () => { state.user = (await api.get('/api/users/me')).data.user; renderBanners(); return state.user; },
      refreshBadges,
      /** Runs an action with a toast on success and a toast on failure, then optionally reloads the page. */
      async act(promiseFactory, { success, reload = true } = {}) {
        try {
          const res = await promiseFactory();
          if (success !== false) UI.toast(success || res.message || 'Done', 'success');
          if (reload) showPage(state.page);
          refreshBadges();
          return res;
        } catch (error) {
          UI.toast(error.message, 'error');
          return null;
        }
      },
    };
  }

  async function onClick(event) {
    const shell = event.target.closest('[data-shell]');
    if (shell) return onShellAction(shell.dataset.shell);

    const nav = event.target.closest('[data-nav]');
    if (nav) {
      event.preventDefault();
      location.hash = nav.dataset.nav;
      return undefined;
    }

    const actionEl = event.target.closest('[data-action]');
    if (actionEl && state.handlers[actionEl.dataset.action]) {
      event.preventDefault();
      if (actionEl.disabled) return undefined;
      actionEl.disabled = true;
      try {
        await state.handlers[actionEl.dataset.action](actionEl, event);
      } finally {
        actionEl.disabled = false;
      }
    }
    return undefined;
  }

  async function onShellAction(action) {
    if (action === 'menu') document.getElementById('portal-sidebar').classList.toggle('active');
    if (action === 'theme') {
      applyTheme(document.body.classList.contains('dark-mode') ? 'light' : 'dark');
      showPage(state.page); // redraw charts with the new colours
    }
    if (action === 'logout') {
      try { await api.logout(); } catch (e) { /* the session is cleared locally either way */ }
      location.replace('/login.html?loggedOut=1');
    }
    if (action === 'break-glass') openBreakGlass();
    if (action === 'break-glass-off') {
      api.setBreakGlass(null);
      renderBanners();
      UI.toast('Emergency access turned off', 'info');
      showPage(state.page);
    }
  }

  function openBreakGlass() {
    UI.modal({
      title: 'Emergency (break-glass) access',
      submitLabel: 'Turn on emergency access',
      danger: true,
      body: `<div class="banner banner-warning">${icon('alert-triangle')} Use only in a genuine emergency. It bypasses patient consent for this browser tab. Every access is written to the tamper-evident ledger, the patient is notified, and administrators review it.</div>
        <div class="form-group"><label for="bg-reason">Clinical reason (required, at least 10 characters)</label>
        <textarea id="bg-reason" name="reason" required minlength="10" maxlength="300" placeholder="e.g. Unconscious patient in ER, need allergy and medication history"></textarea></div>`,
      onSubmit: ({ reason }) => {
        api.setBreakGlass(reason);
        renderBanners();
        UI.toast('Emergency access is ON for this tab', 'warning');
        showPage(state.page);
      },
    });
  }

  /* ----------------------------------------------------------------- notifications */

  function setBadge(id, count) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = count > 99 ? '99+' : count;
    el.style.display = count > 0 ? 'flex' : 'none';
  }

  async function refreshBadges() {
    try {
      const res = await api.get('/api/notifications', { unread: true, limit: 1 });
      setBadge('header-notif-badge', res.meta.unreadCount);
      setBadge('badge-notifications', res.meta.unreadCount);
      if (state.config.badges) await state.config.badges({ api, setBadge, user: state.user });
    } catch (error) {
      if (error.code === 'SESSION_ENDED') sendToLogin();
    }
  }

  const NOTE_TYPES = { info: 'info', success: 'success', warning: 'warning', danger: 'danger' };

  async function notificationsPage(c) {
    const res = await c.api.get('/api/notifications', { limit: 100 });
    if (c.stale()) return;
    const items = res.data;
    c.container.innerHTML = UI.card('Notifications', 'bell', items.length
      ? items.map((n) => `<div class="list-item ${n.read ? '' : 'unread'}">
          <div class="dot ${NOTE_TYPES[n.type] || ''}"></div>
          <div class="grow"><div class="title">${esc(n.title)}</div><div>${esc(n.message)}</div>
            <div class="meta">${esc(UI.relTime(n.createdAt))}</div></div>
          <div class="actions">${n.page ? `<button class="btn btn-sm btn-secondary" data-action="open" data-id="${n._id}" data-page="${esc(n.page)}">Open</button>` : ''}
          ${n.read ? '' : `<button class="btn btn-sm btn-ghost" data-action="read" data-id="${n._id}">Mark read</button>`}</div></div>`).join('')
      : UI.emptyHtml('No notifications', 'Updates about your appointments, records and claims appear here.', 'bell-off'),
    res.meta.unreadCount ? '<button class="btn btn-sm btn-secondary" data-action="read-all">Mark all as read</button>' : '');
    c.on({
      read: (el) => c.act(() => c.api.patch(`/api/notifications/${el.dataset.id}/read`), { success: false }),
      'read-all': () => c.act(() => c.api.post('/api/notifications/read-all')),
      open: async (el) => {
        await c.api.patch(`/api/notifications/${el.dataset.id}/read`).catch(() => {});
        const target = state.config.pages[el.dataset.page] ? el.dataset.page : 'dashboard';
        refreshBadges();
        c.navigate(target);
      },
    });
  }

  async function profilePage(c) {
    const res = await c.api.get('/api/users/me');
    if (c.stale()) return;
    const { user, trustScore } = res.data;
    state.user = user;
    const extra = state.config.profileExtra ? state.config.profileExtra(user) : null;
    const trustColor = trustScore.score >= trustScore.highSensitivityMinScore ? 'var(--success)' : (trustScore.score >= trustScore.minScore ? 'var(--warning)' : 'var(--danger)');

    c.container.innerHTML = `<div class="grid-2">
      ${UI.card('Personal details', 'user', `<form id="profile-form">
        <div class="form-group"><label>Full name</label><input name="fullName" value="${esc(user.fullName)}" required minlength="2"></div>
        <div class="form-row">
          <div class="form-group"><label>Phone</label><input name="phone" value="${esc(user.phone)}"></div>
          <div class="form-group"><label>Date of birth</label><input type="date" name="dateOfBirth" value="${user.dateOfBirth ? UI.isoDate(user.dateOfBirth) : ''}"></div>
          <div class="form-group"><label>Gender</label><select name="gender">${UI.options([['', 'Prefer not to say'], ['female', 'Female'], ['male', 'Male'], ['other', 'Other']], user.gender)}</select></div>
        </div>
        <div class="form-group"><label>Address</label><input name="address" value="${esc(user.address)}"></div>
        ${extra ? extra.html : ''}
        <button class="btn btn-primary" type="submit">${icon('save')} Save profile</button></form>`)}
      <div>
        ${UI.card('Zero-trust session status', 'shield-check', `
          <div class="flex-between"><strong>Trust score for this request</strong><span style="font-size:1.6rem;font-weight:700;color:${trustColor}">${trustScore.score}/100</span></div>
          <div class="meter mt-1"><span style="width:${trustScore.score}%;background:${trustColor}"></span></div>
          <dl class="kv mt-3">
            <dt>Minimum to use the API</dt><dd>${trustScore.minScore}</dd>
            <dt>Needed for medical records</dt><dd>${trustScore.highSensitivityMinScore}</dd>
            <dt>Risk signals</dt><dd>${trustScore.reasons.length ? trustScore.reasons.map((r) => UI.tag('pending', UI.titleCase(r))).join(' ') : 'None'}</dd>
            <dt>Session age</dt><dd>${Math.round((trustScore.sessionAgeSeconds || 0) / 60)} min</dd>
            <dt>Device fingerprint</dt><dd class="mono">${esc(UI.shortHash(trustScore.deviceFingerprint, 24))}</dd>
            <dt>Ledger address</dt><dd class="mono">${esc(user.ledgerAddress)}</dd>
            <dt>Email verified</dt><dd>${user.isVerified ? UI.tag('approved', 'Yes') : UI.tag('pending', 'No')}</dd>
            <dt>Last login</dt><dd>${esc(UI.fmtDateTime(user.lastLogin))}</dd>
          </dl>`)}
        ${UI.card('Change password', 'key-round', `<form id="password-form">
          <div class="form-group"><label>Current password</label><input type="password" name="currentPassword" required autocomplete="current-password"></div>
          <div class="form-group"><label>New password</label><input type="password" name="newPassword" required minlength="8" autocomplete="new-password">
            <span class="hint">8+ characters with upper case, lower case, a number and a symbol. You will be signed out everywhere.</span></div>
          <button class="btn btn-secondary" type="submit">Change password</button></form>`)}
      </div></div>`;

    c.container.querySelector('#profile-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const values = UI.formValues(e.target);
      const body = { fullName: values.fullName, phone: values.phone, address: values.address, gender: values.gender, dateOfBirth: values.dateOfBirth || null };
      if (extra) Object.assign(body, extra.read(values));
      const done = await c.act(() => c.api.patch('/api/users/me', body), { success: 'Profile saved', reload: false });
      if (done) { state.user = done.data.user; renderLayout(); renderBanners(); showPage('profile'); }
    });
    c.container.querySelector('#password-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const done = await c.act(() => c.api.post('/api/auth/change-password', UI.formValues(e.target)), { reload: false });
      if (done) setTimeout(() => location.replace('/login.html?passwordChanged=1'), 1500);
    });
  }

  const SHARED_PAGES = { notifications: notificationsPage, profile: profilePage };
  const SHARED_TITLES = { notifications: 'Notifications', profile: 'Profile & Security' };

  /* ----------------------------------------------------------------- boot */

  function sendToLogin() {
    location.replace(`/login.html?next=${encodeURIComponent(location.pathname + location.hash)}`);
  }

  async function start(config) {
    state.config = config;
    applyTheme(savedTheme());
    let user;
    try {
      user = await api.refreshSession();
    } catch (error) {
      if (error.status === 0) {
        document.getElementById('app').innerHTML = '<div class="boot-screen"><div class="state state-error"><h4>Server unreachable</h4><div>Start the MediChain API and reload this page.</div></div></div>';
        return;
      }
      sendToLogin();
      return;
    }
    if (user.role !== config.role) {
      location.replace(DASHBOARDS[user.role]);
      return;
    }
    state.user = user;
    document.getElementById('app').addEventListener('click', onClick); // one delegated listener for the whole app
    renderLayout();
    renderBanners();
    window.addEventListener('hashchange', () => showPage());
    await showPage();
    refreshBadges();
    state.pollTimer = setInterval(refreshBadges, 20000);
  }

  global.Portal = { start, DASHBOARDS, ROLE_LABELS };
}(window));
