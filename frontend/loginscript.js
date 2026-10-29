/**
 * MediChain sign-in and registration page.
 *
 * Step 1  POST /api/auth/login/request-otp   email + password -> code is emailed
 * Step 2  POST /api/auth/login/verify-otp    email + code     -> access token + HttpOnly refresh cookie
 * Then the browser goes to the user's dashboard, which restores the session
 * from the cookie. Registration uses POST /api/auth/register.
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
  const forms = ['loginForm', 'twoStepVerification', 'roleSelection', 'registerForm'];
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

  function redirectAfterLogin(role) {
    const next = new URLSearchParams(location.search).get('next');
    // Only follow "next" when it points at this user's own dashboard (prevents open redirects).
    const target = next && next.startsWith(DASHBOARDS[role]) ? next : DASHBOARDS[role];
    location.replace(target);
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
    pending.password = $('loginPassword').value;
    if (await requestCode($('loginSubmitBtn'))) {
      showForm('twoStepVerification');
      clearCode();
      startResendTimer();
      setMessage('otpMessage', '');
      notify('Code sent. Check your email.', 'info');
    }
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
      setTimeout(() => redirectAfterLogin(res.data.user.role), 600);
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
      // Already signed in on this browser? Go straight to the dashboard.
      try {
        const user = await api.refreshSession();
        redirectAfterLogin(user.role);
        return;
      } catch (e) { /* no session: show the form */ }
    }
    if (location.hash === '#register') showForm('roleSelection');

    $('loginForm').addEventListener('submit', onLogin);
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
