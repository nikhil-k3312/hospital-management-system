const nodemailer = require('nodemailer');
const config = require('../config/config');
const logger = require('../utils/logger');

const escapeHtml = (text) => String(text ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const ROLE_LABELS = { patient: 'Patient', doctor: 'Doctor', admin: 'Administrator', insurance_agent: 'Insurance Agent' };

/**
 * Builds the mail transport selected by EMAIL_TRANSPORT:
 *   smtp    real delivery (Gmail app password or any SMTP service)
 *   console development only: the message text is printed to the server log
 *   json    tests: the message is rendered in memory and returned
 */
function createTransport(cfg = config) {
  if (cfg.email.transport === 'json') return nodemailer.createTransport({ jsonTransport: true });
  if (cfg.email.transport === 'console') return nodemailer.createTransport({ streamTransport: true, buffer: true });
  return nodemailer.createTransport({
    service: cfg.email.service || undefined,
    auth: { user: cfg.email.user, pass: cfg.email.password },
  });
}

/** Shared inline-styled layout (email clients strip <style> blocks). */
function layout(title, bodyHtml) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#f0fdfa;font-family:Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #ccfbf1;">
    <div style="background:linear-gradient(135deg,#0d9488,#14b8a6);color:#fff;padding:24px 28px;">
      <div style="font-size:22px;font-weight:bold;">MediChain</div>
      <div style="opacity:.9;margin-top:4px;">${escapeHtml(title)}</div>
    </div>
    <div style="padding:28px;color:#334155;line-height:1.6;">${bodyHtml}</div>
    <div style="padding:16px 28px;background:#f8fafc;color:#64748b;font-size:12px;">
      This is an automated message from MediChain. Please do not reply.
    </div>
  </div></body></html>`;
}

class EmailService {
  constructor(transporter = createTransport()) {
    this.transporter = transporter;
  }

  /** Called once at start-up so bad SMTP credentials show up immediately in the log. */
  async verifyConnection() {
    if (config.email.transport !== 'smtp') {
      logger.warn(`Email transport is "${config.email.transport}": emails are NOT delivered (development only).`);
      return true;
    }
    try {
      await this.transporter.verify();
      logger.info('SMTP transport verified');
      return true;
    } catch (error) {
      logger.error(`SMTP verification failed: ${error.message}`);
      return false;
    }
  }

  async send({ to, subject, html, text }) {
    const info = await this.transporter.sendMail({ from: config.email.from, to, subject, html, text });
    if (config.email.transport === 'console') {
      logger.info(`[DEV EMAIL] to=${to} subject="${subject}"\n${text}`);
    }
    return info;
  }

  /** Throws on failure: without this email the user cannot finish logging in. */
  async sendOTP(email, otp, name) {
    const minutes = config.otp.expiryMinutes;
    try {
      return await this.send({
        to: email,
        subject: 'Your MediChain login code',
        text: `Hello ${name},\n\nYour MediChain login code is ${otp}. It expires in ${minutes} minutes and can be used once.\nIf you did not try to log in, change your password.`,
        html: layout('Login verification', `
          <p>Hello <strong>${escapeHtml(name)}</strong>,</p>
          <p>Use this one-time code to finish logging in:</p>
          <div style="font-size:34px;letter-spacing:10px;font-weight:bold;text-align:center;background:#f0fdfa;border:1px dashed #0d9488;border-radius:10px;padding:18px;margin:20px 0;color:#0f766e;font-family:'Courier New',monospace;">${escapeHtml(otp)}</div>
          <p>The code expires in <strong>${minutes} minutes</strong> and works only once.</p>
          <p style="background:#fef3c7;border-left:4px solid #d97706;padding:10px 14px;border-radius:6px;">Never share this code. MediChain staff will never ask for it. If you did not try to log in, change your password.</p>`),
      });
    } catch (error) {
      logger.error(`OTP email failed: ${error.message}`);
      throw new Error('EMAIL_FAILED');
    }
  }

  /** Never throws: a failed welcome email must not undo a successful registration. */
  async sendWelcome(email, name, role, pendingApproval) {
    try {
      const note = pendingApproval
        ? '<p>Your account is <strong>awaiting verification</strong> by a hospital administrator. You can log in now, and clinical features unlock once you are approved.</p>'
        : '<p>You can now log in to your dashboard.</p>';
      return await this.send({
        to: email,
        subject: 'Welcome to MediChain',
        text: `Hello ${name}, your MediChain ${ROLE_LABELS[role]} account was created.${pendingApproval ? ' It is awaiting administrator verification.' : ''}`,
        html: layout('Welcome', `<p>Hello <strong>${escapeHtml(name)}</strong>,</p>
          <p>Your <strong>${ROLE_LABELS[role]}</strong> account has been created.</p>${note}`),
      });
    } catch (error) {
      logger.error(`Welcome email failed: ${error.message}`);
      return null;
    }
  }

  async sendApprovalDecision(email, name, approved, note) {
    try {
      return await this.send({
        to: email,
        subject: approved ? 'Your MediChain account is verified' : 'Your MediChain verification was declined',
        text: `Hello ${name}, your account verification was ${approved ? 'approved' : 'declined'}. ${note || ''}`,
        html: layout('Account verification', `<p>Hello <strong>${escapeHtml(name)}</strong>,</p>
          <p>Your account verification was <strong>${approved ? 'approved' : 'declined'}</strong>.</p>
          ${note ? `<p>Note from the administrator: ${escapeHtml(note)}</p>` : ''}`),
      });
    } catch (error) {
      logger.error(`Approval email failed: ${error.message}`);
      return null;
    }
  }
}

module.exports = new EmailService();
module.exports.EmailService = EmailService;
module.exports.createTransport = createTransport;
module.exports.escapeHtml = escapeHtml;
