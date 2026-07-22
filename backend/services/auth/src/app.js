const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const config = require('./config/config');
const logger = require('../../../shared/utils/logger');
const authRoutes = require('./routes/authRoutes');

// Create Express app
const app = express();

/**
 * MIDDLEWARE SETUP
 */

// Security headers
app.use(helmet());

// CORS - Allow frontend to access backend
app.use(cors({
  origin: config.cors.origins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Parse JSON bodies
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting - Prevent spam/abuse
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Max 100 requests per 15 minutes per IP
  message: {
    success: false,
    message: 'Too many requests from this IP, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', limiter);

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  
  // Log after response is sent
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.path} ${res.statusCode} - ${duration}ms`);
  });
  
  next();
});

/**
 * ROUTES
 */

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    success: true, 
    service: 'Authentication Service',
    status: 'running',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: config.nodeEnv
  });
});

// Auth routes
app.use('/api/auth', authRoutes);

// 404 handler - Route not found
app.use((req, res) => {
  logger.warn(`404 - Route not found: ${req.method} ${req.path}`);
  res.status(404).json({
    success: false,
    message: 'Route not found',
    path: req.path,
    method: req.method
  });
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error('❌ Server error:', err);
  
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error',
    error: config.nodeEnv === 'development' ? {
      message: err.message,
      stack: err.stack
    } : undefined
  });
});

/**
 * DATABASE CONNECTION & SERVER START
 */

const startServer = async () => {
  try {
    // Connect to MongoDB
    logger.info('🔄 Connecting to MongoDB...');
    await mongoose.connect(config.mongodb.uri);
    logger.info('✅ Connected to MongoDB successfully');
    
    // Start Express server
    const PORT = config.port;
    const server = app.listen(PORT, () => {
      logger.info('='.repeat(50));
      logger.info('🚀 Authentication Service Started');
      logger.info('='.repeat(50));
      logger.info(`📍 Server: http://localhost:${PORT}`);
      logger.info(`📧 Email: ${config.email.user}`);
      logger.info(`🌍 Environment: ${config.nodeEnv}`);
      logger.info(`⏰ Started at: ${new Date().toLocaleString()}`);
      logger.info('='.repeat(50));
    });
    
    // Graceful shutdown
    process.on('SIGTERM', () => {
      logger.info('⚠️ SIGTERM received. Shutting down gracefully...');
      server.close(() => {
        logger.info('✅ Server closed');
        mongoose.connection.close();
        process.exit(0);
      });
    });
    
  } catch (error) {
    logger.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

// Handle unhandled promise rejections
process.on('unhandledRejection', (error) => {
  logger.error('❌ Unhandled Promise Rejection:', error);
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

// Start the server
startServer();

module.exports = app;