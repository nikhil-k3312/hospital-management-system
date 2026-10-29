/**
 * Shared UI helpers for the four dashboards. Pure functions where possible so
 * they can be unit-tested with jsdom.
 */
(function initUi(global) {
  /** Escapes text before it is put into innerHTML: the main defence against XSS from data. */
  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const locale = 'en-IN';
  const fmtDate = (d) => (d ? new Date(d).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
  const fmtTime = (d) => (d ? new Date(d).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : '—');
  const fmtDateTime = (d) => (d ? `${fmtDate(d)}, ${fmtTime(d)}` : '—');
  const fmtMoney = (n) => `₹${Number(n || 0).toLocaleString(locale, { maximumFractionDigits: 2 })}`;
  const titleCase = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const shortHash = (h, n = 12) => (h ? `${h.slice(0, n)}…` : '—');

  function relTime(d) {
    const diff = (Date.now() - new Date(d).getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
    if (diff < 7 * 86400) return `${Math.floor(diff / 86400)} d ago`;
    return fmtDate(d);
  }

  function age(dob) {
    if (!dob) return '—';
    const b = new Date(dob);
    const n = new Date();
    let a = n.getFullYear() - b.getFullYear();
    if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) a -= 1;
    return a;
  }

  function initials(name) {
    return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
  }

  const STATUS_COLORS = {
    green: ['active', 'confirmed', 'completed', 'approved', 'settled', 'paid', 'covered', 'allow', 'valid', 'policy_allowed', 'authenticated'],
    yellow: ['pending', 'requested', 'submitted', 'claim_pending', 'partially_covered', 'expired', 'under_review'],
    red: ['cancelled', 'denied', 'revoked', 'rejected', 'unpaid', 'no_show', 'deny', 'inactive', 'tampered'],
    blue: ['info', 'manual', 'device'],
  };
  function tag(status, label) {
    const s = String(status || '').toLowerCase();
    const color = Object.keys(STATUS_COLORS).find((c) => STATUS_COLORS[c].includes(s)) || 'gray';
    return `<span class="tag tag-${color}">${esc(label || titleCase(s))}</span>`;
  }

  const icon = (name, extra = '') => `<i data-lucide="${esc(name)}" ${extra}></i>`;
  const refreshIcons = () => { if (global.lucide) global.lucide.createIcons(); };

  /* ----------------------------------------------------------------- states */

  function loading(container, text = 'Loading…') {
    container.innerHTML = `<div class="state" role="status"><div class="spinner"></div><div>${esc(text)}</div></div>`;
  }

  function emptyHtml(title, message = '', iconName = 'inbox') {
    return `<div class="state">${icon(iconName)}<h4>${esc(title)}</h4><div>${esc(message)}</div></div>`;
  }

  /** A real error state with the server's message and a retry button. */
  function errorState(container, error, onRetry) {
    const offline = error && error.status === 0;
    container.innerHTML = `<div class="state state-error" role="alert">
      ${icon(offline ? 'wifi-off' : 'alert-triangle')}
      <h4>${offline ? 'Server unreachable' : 'Could not load this page'}</h4>
      <div>${esc(error && error.message)}</div>
      ${onRetry ? '<button class="btn btn-secondary mt-3" data-retry>Try again</button>' : ''}
    </div>`;
    if (onRetry) container.querySelector('[data-retry]').addEventListener('click', onRetry);
    refreshIcons();
  }

  /* ----------------------------------------------------------------- toast */

  let toastTimer = null;
  function toast(message, type = 'success') {
    const el = document.getElementById('toast-notification');
    if (!el) return;
    el.querySelector('#toast-message').textContent = message;
    el.className = `toast-${type === 'error' ? 'danger' : type}`;
    const iconEl = el.querySelector('#toast-icon');
    if (iconEl) {
      iconEl.outerHTML = `<i id="toast-icon" data-lucide="${type === 'success' ? 'check-circle' : (type === 'info' ? 'info' : 'alert-circle')}"></i>`;
      refreshIcons();
    }
    requestAnimationFrame(() => el.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), type === 'error' || type === 'danger' ? 6000 : 3500);
  }

  /* ----------------------------------------------------------------- modals */

  function closeModal() {
    const overlay = document.getElementById('app-modal');
    if (overlay) overlay.remove();
  }

  /**
   * modal({ title, body, submitLabel, onSubmit, wide })
   * `body` is HTML. If onSubmit is given, the body is wrapped in a <form>;
   * onSubmit(values, form) may throw an ApiError, which is shown inside the
   * modal instead of closing it.
   */
  function modal({ title, body, submitLabel, onSubmit, wide = false, danger = false, cancelLabel = 'Cancel' }) {
    closeModal();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay show';
    overlay.id = 'app-modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    const inner = onSubmit
      ? `<form novalidate><div class="form-error" data-form-error></div>${body}
           <div class="modal-footer"><button type="button" class="btn btn-secondary" data-close>${esc(cancelLabel)}</button>
           <button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${esc(submitLabel || 'Save')}</button></div></form>`
      : `${body}<div class="modal-footer"><button type="button" class="btn btn-secondary" data-close>Close</button></div>`;
    overlay.innerHTML = `<div class="modal-content ${wide ? 'wide' : ''}">
        <div class="modal-header"><h3>${esc(title)}</h3>
          <button type="button" class="btn btn-secondary btn-sm" data-close aria-label="Close">${icon('x')}</button></div>
        ${inner}</div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.closest('[data-close]')) closeModal();
    });
    const form = overlay.querySelector('form');
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const errorBox = form.querySelector('[data-form-error]');
        errorBox.classList.remove('show');
        if (!form.checkValidity()) {
          form.reportValidity();
          return;
        }
        const button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        try {
          const keepOpen = await onSubmit(formValues(form), form);
          if (keepOpen !== true) closeModal();
        } catch (error) {
          errorBox.textContent = error.message;
          errorBox.classList.add('show');
        } finally {
          button.disabled = false;
        }
      });
      const first = form.querySelector('input:not([type=hidden]), select, textarea');
      if (first) first.focus();
    }
    refreshIcons();
    return overlay;
  }

  /** Promise<boolean> confirmation dialog. */
  function confirmDialog(title, message, { confirmLabel = 'Confirm', danger = false } = {}) {
    return new Promise((resolve) => {
      let answered = false;
      const overlay = modal({
        title,
        body: `<p>${esc(message)}</p>`,
        submitLabel: confirmLabel,
        danger,
        onSubmit: () => { answered = true; resolve(true); },
      });
      const observer = new MutationObserver(() => {
        if (!document.body.contains(overlay)) {
          observer.disconnect();
          if (!answered) resolve(false);
        }
      });
      observer.observe(document.body, { childList: true });
    });
  }

  /** Reads a form into a plain object. Empty number fields are omitted; checkboxes with the same name become arrays. */
  function formValues(form) {
    const out = {};
    Array.from(form.elements).forEach((el) => {
      if (!el.name || el.disabled) return;
      if (el.type === 'checkbox') {
        if (el.dataset.array !== undefined) {
          out[el.name] = out[el.name] || [];
          if (el.checked) out[el.name].push(el.value);
        } else out[el.name] = el.checked;
        return;
      }
      if (el.type === 'number') {
        if (el.value !== '') out[el.name] = Number(el.value);
        return;
      }
      out[el.name] = el.value.trim();
    });
    return out;
  }

  const options = (items, selected) => items.map((item) => {
    const [value, label] = Array.isArray(item) ? item : [item, item];
    return `<option value="${esc(value)}" ${String(value) === String(selected ?? '') ? 'selected' : ''}>${esc(label)}</option>`;
  }).join('');

  /** Simple table builder: columns = [{ label, render(row) }] (render returns HTML). */
  function table(columns, rows, emptyMessage = 'Nothing here yet.') {
    if (!rows.length) return emptyHtml(emptyMessage, '', 'inbox');
    return `<div class="table-wrap"><table><thead><tr>${columns.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${columns.map((c) => `<td>${c.render(r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  function statCard(iconName, color, value, label, page) {
    return `<div class="stat-card ${page ? 'clickable' : ''}" ${page ? `data-nav="${esc(page)}"` : ''}>
      <div class="stat-icon ${color}">${icon(iconName)}</div>
      <div class="stat-info"><h3>${esc(value)}</h3><p>${esc(label)}</p></div></div>`;
  }

  function card(title, iconName, body, actionsHtml = '') {
    return `<div class="glass-card"><div class="glass-card-header"><div class="icon-header">${icon(iconName)}<h3>${esc(title)}</h3></div>${actionsHtml}</div>${body}</div>`;
  }

  /** Local YYYY-MM-DD for date inputs. */
  function isoDate(d = new Date()) {
    const x = new Date(d);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  }

  const ui = {
    esc, fmtDate, fmtTime, fmtDateTime, fmtMoney, relTime, age, initials, titleCase, shortHash, isoDate,
    tag, icon, refreshIcons, loading, emptyHtml, errorState, toast, modal, closeModal, confirmDialog,
    formValues, options, table, statCard, card,
  };

  global.UI = ui;
  if (typeof module !== 'undefined' && module.exports) module.exports = ui;
}(typeof window !== 'undefined' ? window : globalThis));
