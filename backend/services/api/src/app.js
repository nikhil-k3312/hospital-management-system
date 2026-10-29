const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const config = require('./config/config');
const logger = require('./utils/logger');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const app = express();
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');

/* ---------------------------------------------------------------- security headers */

// The frontend is served by this same server, so a strict Content-Security-Policy
// can allow scripts only from this origin plus two pinned CDNs. Inline <script>
// and onclick="" handlers are blocked, which shuts the main door to XSS.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'script-src': ["'self'", 'https://cdn.jsdelivr.net', 'https://unpkg.com'],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdn.jsdelivr.net'],
      'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
      'img-src': ["'self'", 'data:', 'blob:', 'https://images.pexels.com'],
      'connect-src': ["'self'"],
      'frame-src': ["'self'", 'blob:'],
      'object-src': ["'self'", 'blob:'],
      'upgrade-insecure-requests': config.isProduction ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: config.cors.origins,
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-break-glass-reason', 'x-device-key'],
  exposedHeaders: ['X-Content-SHA256'],
}));
app.use(cookieParser());
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

/* ---------------------------------------------------------------- rate limiting */

const windowMs = config.rateLimit.windowMinutes * 60 * 1000;
const limiterResponse = (message) => ({ success: false, message, code: 'TOO_MANY_REQUESTS' });

app.use('/api/', rateLimit({
  windowMs, max: config.rateLimit.max, standardHeaders: true, legacyHeaders: false,
  message: limiterResponse('Too many requests from this IP, please try again later.'),
  skip: () => config.isTest,
}));

// Stricter budget for the endpoints an attacker would hammer to guess passwords or codes.
const authLimiter = rateLimit({
  windowMs, max: config.rateLimit.authMax, standardHeaders: true, legacyHeaders: false,
  message: limiterResponse('Too many login attempts from this IP. Try again in 15 minutes.'),
  skip: () => config.isTest,
});
app.use(['/api/auth/login', '/api/auth/register'], authLimiter);

/* ---------------------------------------------------------------- request log */

app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    if (!req.path.startsWith('/api/')) return;
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    logger.info(`${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${ms.toFixed(1)}ms`);
  });
  next();
});

/* ---------------------------------------------------------------- API */

app.get('/health', (req, res) => {
  res.json({ success: true, service: 'MediChain API', status: 'running', timestamp: new Date().toISOString(), uptime: process.uptime(), environment: config.nodeEnv });
});

app.use('/api/auth', require('./modules/auth/auth.routes'));
app.use('/api', require('./modules/users/users.routes'));
app.use('/api/appointments', require('./modules/appointments/appointments.routes'));
app.use('/api/consents', require('./modules/consents/consents.routes'));
app.use('/api/records', require('./modules/records/records.routes'));
app.use('/api/files', require('./modules/records/files.routes'));
app.use('/api/prescriptions', require('./modules/prescriptions/prescriptions.routes'));
app.use('/api', require('./modules/vitals/vitals.routes'));
app.use('/api/bills', require('./modules/billing/billing.routes'));
app.use('/api/claims', require('./modules/claims/claims.routes'));
app.use('/api/notifications', require('./modules/notifications/notifications.routes'));
app.use('/api/admin', require('./modules/admin/admin.routes'));
app.use('/api/ledger', require('./modules/ledger/ledger.routes'));
app.use('/api', notFoundHandler);

/* ---------------------------------------------------------------- frontend */

// Same origin as the API: the SameSite=Strict refresh cookie just works and no
// CORS is needed in the browser. Development files are never served.
app.use((req, res, next) => (/^\/(node_modules|tests|package(-lock)?\.json|jest\.config)/.test(req.path) ? notFoundHandler(req, res) : next()));
app.use(express.static(config.frontendDir, { index: 'homepage.html', extensions: ['html'] }));
app.get('/', (req, res) => res.sendFile(path.join(config.frontendDir, 'homepage.html')));

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
