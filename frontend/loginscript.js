/**
 * MediChain sign-in and registration page.
 *
 * Step 1  POST /api/auth/login/request-otp   email + password -> code is emailed
 * Step 2  POST /api/auth/login/verify-otp    email + code     -> access token + HttpOnly refresh cookie
 * Then the browser goes to the user's dashboard, which restores the session
 * from the cookie. Registration uses POST /api/auth/register.
 *
 * After the first login every sign-in goes through the dynamic login algorithm
 * (POST /api/auth/login/dynamic): the server scores location (IP vs GPS), device,
 * time and network and asks for the password only, the password + emailed code, or
 * the password + code + security question. On load the page asks POST /api/auth/route,
 * which can send a trusted, low-risk browser straight to the user's landing page.
 */
(function loginPage() {
  const api = window.MediApi;
  const DASHBOARDS = { patient: '/patient.html', doctor: '/doctor.html', admin: '/admin.html', insurance_agent: '/insurance.html' };
  const ROLE_TEXT = {
    patient: ['Patient registration', 'Create your patient account', 'user'],
    doctor: ['Doctor registration', 'An administrator verifies your licence before you can see patients', 'stethoscope'],
    insurance_agent: ['Insurance agent registration', 'An administrator verifies you before you can process claims', 'file-text'],
  };

  const $ = (id) => document.getElementById(id);
  const forms = ['loginForm', 'returningForm', 'challengeForm', 'twoStepVerification', 'roleSelection', 'registerForm'];
  // Held only in memory between step 1 and step 2 (needed for "resend"), wiped after sign-in.
  const pending = { email: '', password: '' };
  let resendTimer = null;
  let selectedRole = 'patient';

  /* ---------------------------------------------------------------- helpers */

  function showForm(id) {
    forms.forEach((f) => $(f).classList.toggle('form-visible', f === id));
    const signup = id === 'roleSelection' || id === 'registerForm';
    $('loginToggle').classList.toggle('active', !signup);
    $('signupToggle').classList.toggle('active', signup);
    $('loginToggle').setAttribute('aria-selected', String(!signup));
    $('signupToggle').setAttribute('aria-selected', String(signup));
    const first = $(id).querySelector('input:not([type=hidden]), .role-card');
    if (first) first.focus();
  }

  function notify(message, type = 'success') {
    const el = $('notification');
    el.textContent = message;
    el.className = `notification ${type} show`;
    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => el.classList.remove('show'), 5000);
  }

  function setMessage(id, message, type = 'error') {
    const el = $(id);
    el.textContent = message || '';
    el.dataset.type = type;
    el.style.display = message ? 'block' : 'none';
  }

  function setLoading(button, on) {
    button.disabled = on;
    button.querySelector('.loading-spinner').style.display = on ? 'inline-block' : 'none';
  }

  function redirectAfterLogin(role, landing) {
    const next = new URLSearchParams(location.search).get('next');
    // Only follow a path that points at this user's own dashboard (prevents open redirects).
    const own = (path) => path && path.startsWith(DASHBOARDS[role]);
    let target = DASHBOARDS[role];
    if (own(next)) target = next;
    else if (landing && own(landing.path)) target = landing.path;
    location.replace(target);
  }

  /* ---------------------------------------------------------------- dynamic login */

  /**
   * The browser's position for the context check, or null if the user declines or
   * the browser cannot tell within a few seconds. Asked once per page load.
   */
  let gpsPromise = null;
  function getGps() {
    if (!gpsPromise) {
      gpsPromise = new Promise((resolve) => {
        if (!navigator.geolocation) { resolve(null); return; }
        navigator.geolocation.getCurrentPosition(
          (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
          () => resolve(null),
          { timeout: 5000, maximumAge: 60000 },
        );
      });
    }
    return gpsPromise;
  }
  const context = async () => ({ gps: await getGps() });

  const RISK_TEXT = { low: 'Low risk: password only', medium: 'Medium risk: password + emailed code', high: 'High risk: password + code + security question' };
  const RISK_COLOUR = { low: '#059669', medium: '#d97706', high: '#dc2626' };

  /** Draws the trust score and its four parts (location, device, time, network). */
  function renderRisk(elementId, a) {
    const row = (label, part, extra = '') => `
      <div class="risk-row"><span>${label}</span>
        <div class="risk-track"><div class="risk-fill" style="width:${(part.score / part.max) * 100}%"></div></div>
        <strong>${part.score}/${part.max}</strong></div>
      <div class="risk-note">${esc(part.category)}${extra}</div>`;
    const loc = a.breakdown.location;
    $(elementId).innerHTML = `
      <div class="risk-head"><span class="risk-score" style="color:${RISK_COLOUR[a.risk]}">${a.score}</span>
        <span class="risk-badge" style="border-color:${RISK_COLOUR[a.risk]};color:${RISK_COLOUR[a.risk]}">${RISK_TEXT[a.risk]}</span></div>
      ${row('Location', loc, loc.distanceKm !== null ? ` · ${loc.distanceKm} km between IP and GPS` : '')}
      ${row('Device', a.breakdown.device)}
      ${row('Time', a.breakdown.time)}
      ${row('Network', a.breakdown.network)}
      ${a.breakdown.behaviour && a.breakdown.behaviour.score < 0
        ? `<div class="risk-row"><span>Behaviour</span><span class="risk-penalty">${esc(a.breakdown.behaviour.category)}</span><strong>${a.breakdown.behaviour.score}</strong></div>` : ''}`;
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** Asks the server what this browser should see when the page opens. */
  async function resolveRoute() {
    const { data } = await api.post('/api/auth/route', { context: await context() });
    if (data.mode === 'redirect') {
      api.setToken(data.token);
      redirectAfterLogin(data.user.role, data.landing);
      return true;
    }
    if (data.mode === 'returning') {
      $('returningName').textContent = data.firstName;
      $('returningEmail').textContent = data.emailHint;
      renderRisk('returningRisk', data.assessment);
      showForm('returningForm');
      return true;
    }
    return false;
  }

  let challengeId = null;

  /** Emergency sign-in: a clinical reason replaces the security question (doctor/admin only). */
  let emergencyMode = false;
  function setEmergency(on) {
    emergencyMode = on;
    $('challengeEmergencyFields').hidden = !on;
    $('challengeEmergencyReason').value = '';
    $('challengeQuestionBlock').style.display = on || !$('challengeQuestion').textContent ? 'none' : '';
    $('challengeEmergencyToggle').querySelector('span').textContent = on
      ? 'Answer the security question instead' : 'Emergency? Sign in with a clinical reason instead';
  }

  /** Acts on the server's answer to a dynamic login: sign in, normal code step, or challenge. */
  function handleLoginResult(res, password) {
    const { data } = res;
    if (data.mode === 'redirect') {
      pending.password = '';
      api.setToken(data.token);
      if (data.emergency) notify(`Emergency sign-in until ${new Date(data.emergency.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Every action is audited.`, 'warning');
      else notify(`Welcome back, ${data.user.fullName}. ${data.landing.reason}.`);
      setTimeout(() => redirectAfterLogin(data.user.role, data.landing), 600);
    } else if (data.mode === 'otp') {
      // First login after registration: the normal password + code flow.
      pending.email = data.email;
      pending.password = password;
      $('verificationContact').textContent = data.email;
      $('otpMinutes').textContent = data.expiresInMinutes;
      showForm('twoStepVerification');
      clearCode();
      startResendTimer();
      notify('Code sent. Check your email.', 'info');
    } else if (data.mode === 'challenge') {
      challengeId = data.challengeId;
      renderRisk('challengeRisk', data.assessment);
      $('challengeEmail').textContent = data.email;
      $('challengeOtp').value = '';
      $('challengeQuestionBlock').style.display = data.securityQuestion ? '' : 'none';
      $('challengeQuestion').textContent = data.securityQuestion || '';
      $('challengeAnswer').value = '';
      $('challengeAnswer').required = Boolean(data.securityQuestion);
      setEmergency(false);
      $('challengeEmergencyBlock').style.display = data.emergencyAllowed ? '' : 'none';
      setMessage('challengeMessage', '');
      showForm('challengeForm');
      notify(res.message, 'info');
    }
  }

  async function submitDynamic(button, messageId, body) {
    setLoading(button, true);
    try {
      handleLoginResult(await api.post('/api/auth/login/dynamic', { ...body, context: await context() }), body.password);
    } catch (error) {
      const remaining = error.body && error.body.attemptsRemaining;
      setMessage(messageId, remaining !== undefined ? `${error.message}. ${remaining} attempt(s) left before the account locks.` : error.message);
    } finally {
      setLoading(button, false);
    }
  }

  async function onQuickLogin(event) {
    event.preventDefault();
    setMessage('returningMessage', '');
    const password = $('returningPassword').value;
    if (!password) { setMessage('returningMessage', 'Enter your password.'); return; }
    await submitDynamic($('returningSubmitBtn'), 'returningMessage', { password });
  }

  async function onChallenge(event) {
    event.preventDefault();
    const otp = $('challengeOtp').value.trim();
    if (!/^\d{6}$/.test(otp)) { setMessage('challengeMessage', 'Enter the 6-digit code from your email.'); return; }
    const body = { challengeId, otp };
    if (emergencyMode) {
      const reason = $('challengeEmergencyReason').value.trim();
      if (reason.length < 10) { setMessage('challengeMessage', 'Give a clinical reason of at least 10 characters.'); return; }
      body.emergencyReason = reason;
    } else if ($('challengeAnswer').required) body.securityAnswer = $('challengeAnswer').value;
    const button = $('challengeSubmitBtn');
    setLoading(button, true);
    try {
      handleLoginResult(await api.post('/api/auth/login/challenge', body));
    } catch (error) {
      if (error.code === 'CHALLENGE_EXPIRED') { showForm('loginForm'); setMessage('loginMessage', error.message); return; }
      const remaining = error.body && error.body.attemptsRemaining;
      setMessage('challengeMessage', remaining !== undefined ? `${error.message}. ${remaining} attempt(s) left.` : error.message);
    } finally {
      setLoading(button, false);
    }
  }

  /* ---------------------------------------------------------------- sign in */

  async function requestCode(button) {
    setLoading(button, true);
    try {
      const res = await api.post('/api/auth/login/request-otp', { email: pending.email, password: pending.password });
      $('verificationContact').textContent = res.data.email;
      $('otpMinutes').textContent = res.data.expiresInMinutes;
      return true;
    } catch (error) {
      const remaining = error.body && error.body.attemptsRemaining;
      setMessage('loginMessage', remaining !== undefined ? `${error.message}. ${remaining} attempt(s) left before the account locks.` : error.message);
      return false;
    } finally {
      setLoading(button, false);
    }
  }

  async function onLogin(event) {
    event.preventDefault();
    setMessage('loginMessage', '');
    const form = $('loginForm');
    if (!form.checkValidity()) { form.reportValidity(); return; }
    pending.email = $('loginEmail').value.trim().toLowerCase();
    // The server applies the normal flow on the first login and the dynamic algorithm afterwards.
    await submitDynamic($('loginSubmitBtn'), 'loginMessage', { email: pending.email, password: $('loginPassword').value });
  }

  function codeInputs() { return Array.from(document.querySelectorAll('.code-input')); }
  function clearCode() { codeInputs().forEach((i) => { i.value = ''; i.classList.remove('filled'); }); codeInputs()[0].focus(); }

  async function onVerify() {
    const otp = codeInputs().map((i) => i.value).join('');
    if (!/^\d{6}$/.test(otp)) { setMessage('otpMessage', 'Enter all 6 digits of the code.'); return; }
    const button = $('verifyCodeBtn');
    setLoading(button, true);
    try {
      const res = await api.post('/api/auth/login/verify-otp', { email: pending.email, otp });
      pending.password = '';
      notify(`Welcome, ${res.data.user.fullName}. Opening your dashboard…`);
      setTimeout(() => redirectAfterLogin(res.data.user.role, res.data.landing), 600);
    } catch (error) {
      const remaining = error.body && error.body.attemptsRemaining;
      setMessage('otpMessage', remaining !== undefined ? `${error.message}. ${remaining} attempt(s) left.` : error.message);
      clearCode();
    } finally {
      setLoading(button, false);
    }
  }

  function startResendTimer(seconds = 30) {
    const button = $('resendCodeBtn');
    clearInterval(resendTimer);
    let left = seconds;
    button.disabled = true;
    button.innerHTML = `Resend available in <strong>${left}s</strong>`;
    resendTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(resendTimer);
        button.disabled = false;
        button.innerHTML = "Didn't receive the code? <strong>Resend</strong>";
      } else {
        button.innerHTML = `Resend available in <strong>${left}s</strong>`;
      }
    }, 1000);
  }

  function setupCodeInputs() {
    const inputs = codeInputs();
    inputs.forEach((input, index) => {
      input.addEventListener('input', () => {
        // Accept several digits in one box (fast typing, autofill) and spread them forward.
        const digits = input.value.replace(/\D/g, '');
        input.value = digits.slice(0, 1);
        digits.slice(1).split('').forEach((d, i) => { if (inputs[index + 1 + i]) inputs[index + 1 + i].value = d; });
        inputs.forEach((i) => i.classList.toggle('filled', Boolean(i.value)));
        const nextEmpty = inputs.findIndex((i) => !i.value);
        if (nextEmpty > -1 && digits) inputs[nextEmpty].focus();
        if (inputs.every((i) => i.value)) onVerify();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !input.value && index > 0) inputs[index - 1].focus();
        if (e.key === 'ArrowLeft' && index > 0) inputs[index - 1].focus();
        if (e.key === 'ArrowRight' && index < inputs.length - 1) inputs[index + 1].focus();
        if (e.key === 'Enter') onVerify();
      });
      input.addEventListener('paste', (e) => {
        const digits = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
        if (!digits) return;
        e.preventDefault();
        digits.split('').forEach((d, i) => { inputs[i].value = d; inputs[i].classList.add('filled'); });
        if (digits.length === 6) onVerify();
      });
    });
  }

  /* ---------------------------------------------------------------- registration */

  function chooseRole(role) {
    selectedRole = role;
    const [title, subtitle, iconName] = ROLE_TEXT[role];
    $('register-heading').textContent = title;
    $('registerSubtitle').textContent = subtitle;
    $('registerIcon').innerHTML = `<i data-lucide="${iconName}" aria-hidden="true"></i>`;
    document.querySelectorAll('[data-for]').forEach((block) => {
      const on = block.dataset.for === role;
      block.style.display = on ? '' : 'none';
      block.querySelectorAll('input, select').forEach((el) => { el.disabled = !on; });
    });
    $('regSpec').required = role === 'doctor';
    $('regLicense').required = role === 'doctor';
    $('regCompany').required = role === 'insurance_agent';
    setMessage('registerMessage', '');
    if (window.lucide) window.lucide.createIcons();
    showForm('registerForm');
  }

  function passwordScore(pw) {
    return [/.{8,}/, /[a-z]/, /[A-Z]/, /\d/, /[@$!%*?&#^()\-_=+]/].filter((r) => r.test(pw)).length;
  }

  async function onRegister(event) {
    event.preventDefault();
    setMessage('registerMessage', '');
    const form = $('registerForm');
    if (!form.checkValidity()) { form.reportValidity(); return; }
    if ($('regPassword').value !== $('regConfirm').value) { setMessage('registerMessage', 'The passwords do not match.'); return; }

    const body = { role: selectedRole };
    Array.from(form.elements).forEach((el) => {
      if (el.name && !el.disabled && el.value.trim() !== '') body[el.name] = el.name === 'password' ? el.value : el.value.trim();
    });

    const button = $('registerSubmitBtn');
    setLoading(button, true);
    try {
      const res = await api.post('/api/auth/register', body);
      notify(res.message);
      form.reset();
      $('loginEmail').value = body.email;
      showForm('loginForm');
      setMessage('loginMessage', 'Account created. Sign in to continue.', 'success');
    } catch (error) {
      setMessage('registerMessage', error.message);
    } finally {
      setLoading(button, false);
    }
  }

  /* ---------------------------------------------------------------- setup */

  async function loadPublicSettings() {
    try {
      const { data } = await api.get('/api/settings/public');
      document.querySelectorAll('.hospital-name').forEach((el) => { el.textContent = data.hospitalName; });
      $('hospitalTagline').textContent = `${data.hospitalName}: appointments, records, prescriptions and insurance claims in one secure place.`;
      document.querySelectorAll('[data-insurers]').forEach((select) => {
        const keepEmpty = select.name === 'insuranceProvider';
        select.innerHTML = (keepEmpty ? '<option value="">None</option>' : '<option value="">Select company</option>')
          + data.insuranceProviders.map((p) => `<option>${p.replace(/</g, '&lt;')}</option>`).join('');
      });
      $('regSpec').innerHTML = '<option value="">Select specialization</option>'
        + data.departments.map((d) => `<option>${d.replace(/</g, '&lt;')}</option>`).join('');
    } catch (error) {
      notify(error.status === 0 ? 'The MediChain server is not reachable.' : error.message, 'error');
    }
  }

  function applyTheme(dark) {
    document.body.classList.toggle('dark-mode', dark);
    document.body.classList.toggle('light-mode', !dark);
    try { localStorage.setItem('mc-theme', dark ? 'dark' : 'light'); } catch (e) { /* not remembered */ }
  }

  async function init() {
    let theme = 'dark';
    try { theme = localStorage.getItem('mc-theme') || 'dark'; } catch (e) { /* default */ }
    applyTheme(theme === 'dark');
    document.querySelectorAll('.copyright-year').forEach((el) => { el.textContent = new Date().getFullYear(); });

    const params = new URLSearchParams(location.search);
    if (params.has('loggedOut')) setMessage('loginMessage', 'You have been signed out.', 'success');
    else if (params.has('passwordChanged')) setMessage('loginMessage', 'Password changed. Sign in with your new password.', 'success');
    else {
      // Second visit? The dynamic router decides between redirect, welcome-back form or full login.
      try {
        if (await resolveRoute() && !$('returningForm').classList.contains('form-visible')) return;
      } catch (e) { /* server unreachable or first visit: show the normal form */ }
    }
    if (location.hash === '#register') showForm('roleSelection');

    $('loginForm').addEventListener('submit', onLogin);
    $('returningForm').addEventListener('submit', onQuickLogin);
    $('challengeForm').addEventListener('submit', onChallenge);
    $('challengeBackBtn').addEventListener('click', () => { challengeId = null; showForm('loginForm'); });
    $('challengeEmergencyToggle').addEventListener('click', () => setEmergency(!emergencyMode));
    $('notMeBtn').addEventListener('click', () => showForm('loginForm'));
    $('verifyCodeBtn').addEventListener('click', onVerify);
    $('resendCodeBtn').addEventListener('click', async () => {
      if (await requestCode($('verifyCodeBtn'))) { notify('A new code was sent.', 'info'); clearCode(); startResendTimer(); }
      else { showForm('loginForm'); }
    });
    $('twoStepBackBtn').addEventListener('click', () => { pending.password = ''; showForm('loginForm'); });
    $('loginToggle').addEventListener('click', () => showForm('loginForm'));
    $('signupToggle').addEventListener('click', () => showForm('roleSelection'));
    $('registerBackBtn').addEventListener('click', () => showForm('roleSelection'));
    $('registerForm').addEventListener('submit', onRegister);
    $('darkModeToggle').addEventListener('click', () => applyTheme(!document.body.classList.contains('dark-mode')));

    document.querySelectorAll('.role-card').forEach((card) => {
      card.addEventListener('click', () => chooseRole(card.dataset.role));
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chooseRole(card.dataset.role); } });
    });
    document.querySelectorAll('.toggle-password').forEach((button) => {
      button.addEventListener('click', () => {
        const input = button.parentElement.querySelector('input');
        input.type = input.type === 'password' ? 'text' : 'password';
        button.setAttribute('aria-label', input.type === 'password' ? 'Show password' : 'Hide password');
      });
    });
    $('regPassword').addEventListener('input', (e) => {
      const score = passwordScore(e.target.value);
      document.querySelectorAll('#regPasswordStrength .strength-bar').forEach((bar, i) => {
        bar.style.background = i < score - 1 ? ['#dc2626', '#d97706', '#0284c7', '#059669'][Math.min(score - 2, 3)] : '';
      });
    });

    setupCodeInputs();
    await loadPublicSettings();
    if (window.lucide) window.lucide.createIcons();
  }

  document.addEventListener('DOMContentLoaded', init);
}());
