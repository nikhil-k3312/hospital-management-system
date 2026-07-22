const jwt = require('jsonwebtoken');
const config = require('../config/config');
const logger = require('../../../../shared/utils/logger');

/**
 * Verify JWT token and authenticate user
 */
const authMiddleware = (req, res, next) => {
  try {
    // Get token from header
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. No token provided. Please login.'
      });
    }
    
    // Extract token (format: "Bearer <token>")
    const token = authHeader.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. Invalid token format.'
      });
    }
    
    // Verify token
    const decoded = jwt.verify(token, config.jwt.secret);
    
    // Add user info to request object
    req.user = decoded;
    
    logger.info(`✅ User authenticated: ${decoded.email} (${decoded.role})`);
    
    // Continue to next middleware/route handler
    next();
    
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token expired. Please login again.',
        error: 'TOKEN_EXPIRED'
      });
    }
    
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid token. Please login again.',
        error: 'INVALID_TOKEN'
      });
    }
    
    logger.error('❌ Auth middleware error:', error);
    return res.status(500).json({
      success: false,
      message: 'Authentication failed',
      error: error.message
    });
  }
};

/**
 * Check if user has specific role(s)
 * Usage: requireRole('admin', 'doctor')
 */
const requireRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Not authenticated. Please login first.'
      });
    }
    
    if (!allowedRoles.includes(req.user.role)) {
      logger.warn(`⚠️ Access denied for ${req.user.email}: required role ${allowedRoles.join(' or ')}, has ${req.user.role}`);
      
      return res.status(403).json({
        success: false,
        message: `Access denied. This resource requires ${allowedRoles.join(' or ')} role.`,
        requiredRole: allowedRoles,
        currentRole: req.user.role
      });
    }
    
    next();
  };
};

module.exports = authMiddleware;
module.exports.requireRole = requireRole;