const User = require('../models/User');
const otpService = require('../services/otpService');
const emailService = require('../services/emailService');
const jwt = require('jsonwebtoken');
const config = require('../config/config');
const logger = require('../../../../shared/utils/logger');

class AuthController {
  /**
   * REGISTER NEW USER
   * POST /api/auth/register
   */
  async register(req, res) {
    try {
      const { email, password, role, fullName, walletAddress } = req.body;
      
      logger.info(`📝 Registration attempt for: ${email}`);
      
      // Check if user already exists
      const existingUser = await User.findOne({ email: email.toLowerCase() });
      if (existingUser) {
        logger.warn(`⚠️ Registration failed: Email already exists - ${email}`);
        return res.status(400).json({
          success: false,
          message: 'User with this email already exists'
        });
      }
      
      // Create new user
      const user = new User({
        email: email.toLowerCase(),
        passwordHash: password,
        role: role || 'patient',
        walletAddress: walletAddress || null,
      });
      
      // Save to database (password will be hashed automatically)
      await user.save();
      
      logger.info(`✅ New user registered: ${email} (${user.role})`);
      
      // Send welcome email (don't wait for it)
      emailService.sendWelcomeEmail(email, fullName || 'User', user.role)
        .catch(err => logger.error('Failed to send welcome email:', err));
      
      // Return success response
      return res.status(201).json({
        success: true,
        message: 'User registered successfully',
        data: {
          user: user.toJSON(),
        }
      });
      
    } catch (error) {
      logger.error('❌ Registration error:', error);
      
      // Handle duplicate key error (unique constraint violation)
      if (error.code === 11000) {
        return res.status(400).json({
          success: false,
          message: 'User with this email already exists'
        });
      }
      
      return res.status(500).json({
        success: false,
        message: 'Registration failed. Please try again.',
        error: config.nodeEnv === 'development' ? error.message : undefined
      });
    }
  }
  
  /**
   * REQUEST OTP FOR LOGIN
   * POST /api/auth/login
   */
  async requestOTP(req, res) {
    try {
      const { email } = req.body;
      
      logger.info(`🔐 Login attempt for: ${email}`);
      
      // Find user
      const user = await User.findOne({ email: email.toLowerCase() });
      if (!user) {
        logger.warn(`⚠️ Login failed: User not found - ${email}`);
        return res.status(404).json({
          success: false,
          message: 'User not found. Please register first.'
        });
      }
      
      // Check if account is locked
      if (user.isAccountLocked()) {
        logger.warn(`⚠️ Login blocked: Account locked - ${email}`);
        return res.status(403).json({
          success: false,
          message: 'Account is locked due to too many failed attempts. Please try again later.'
        });
      }
      
      // Check if account is active
      if (!user.isActive) {
        logger.warn(`⚠️ Login blocked: Account deactivated - ${email}`);
        return res.status(403).json({
          success: false,
          message: 'Account is deactivated. Please contact administrator.'
        });
      }
      
      // Generate OTP
      const otp = otpService.generateOTP();
      
      // Store OTP in Redis
      await otpService.storeOTP(email, otp);
      
      // Send OTP via email
      await emailService.sendOTP(email, otp, user.role);
      
      logger.info(`📧 OTP sent to ${email}`);
      
      return res.status(200).json({
        success: true,
        message: 'OTP sent to your email successfully',
        data: {
          email,
          expiresIn: `${config.otp.expiryMinutes} minutes`
        }
      });
      
    } catch (error) {
      logger.error('❌ OTP request error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to send OTP. Please try again.',
        error: config.nodeEnv === 'development' ? error.message : undefined
      });
    }
  }
  
  /**
   * VERIFY OTP AND LOGIN
   * POST /api/auth/verify-otp
   */
  async verifyOTP(req, res) {
    try {
      const { email, otp } = req.body;
      
      logger.info(`🔓 OTP verification attempt for: ${email}`);
      
      // Find user
      const user = await User.findOne({ email: email.toLowerCase() });
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
      
      // Verify OTP
      const otpResult = await otpService.verifyOTP(email, otp);
      
      if (!otpResult.success) {
        // Increment failed attempts using updateOne to avoid validation issues
        const currentAttempts = user.failedLoginAttempts || 0;
        const newAttempts = currentAttempts + 1;
        
        // Prepare update object
        const updateData = {
          failedLoginAttempts: newAttempts,
        };
        
        // Lock account after 5 failed attempts for 30 minutes
        if (newAttempts >= 5) {
          updateData.accountLockedUntil = new Date(Date.now() + 30 * 60 * 1000);
          logger.warn(`🔒 Account locked after 5 failed attempts: ${email}`);
        }
        
        await User.updateOne(
          { _id: user._id },
          { $set: updateData }
        );
        
        logger.warn(`⚠️ OTP verification failed for ${email}: ${otpResult.message}`);
        
        return res.status(401).json({
          success: false,
          message: otpResult.message,
          attemptsRemaining: Math.max(0, 5 - newAttempts)
        });
      }
      
      // OTP is valid! Reset failed attempts using updateOne
      await User.updateOne(
        { _id: user._id },
        {
          $set: {
            failedLoginAttempts: 0,
            accountLockedUntil: null,
            lastLogin: new Date(),
            isVerified: true,
          }
        }
      );
      
      // Fetch updated user to get latest data
      const updatedUser = await User.findById(user._id);
      
      // Generate JWT token
      const token = jwt.sign(
        {
          userId: updatedUser._id,
          email: updatedUser.email,
          role: updatedUser.role,
        },
        config.jwt.secret,
        { expiresIn: config.jwt.expiry }
      );
      
      logger.info(`✅ User logged in successfully: ${email}`);
      
      return res.status(200).json({
        success: true,
        message: 'Login successful',
        data: {
          user: updatedUser.toJSON(),
          token,
          expiresIn: config.jwt.expiry
        }
      });
      
    } catch (error) {
      logger.error('❌ OTP verification error:', error);
      return res.status(500).json({
        success: false,
        message: 'OTP verification failed. Please try again.',
        error: config.nodeEnv === 'development' ? error.message : undefined
      });
    }
  }
  
  /**
   * GET CURRENT USER INFO
   * GET /api/auth/me
   */
  async getCurrentUser(req, res) {
    try {
      // req.user is set by auth middleware
      const user = await User.findById(req.user.userId);
      
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
      
      logger.info(`👤 User info retrieved: ${user.email}`);
      
      return res.status(200).json({
        success: true,
        data: {
          user: user.toJSON()
        }
      });
      
    } catch (error) {
      logger.error('❌ Get current user error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to get user information',
        error: config.nodeEnv === 'development' ? error.message : undefined
      });
    }
  }
  
  /**
   * LOGOUT (Optional - mainly for clearing client-side token)
   * POST /api/auth/logout
   */
  async logout(req, res) {
    try {
      logger.info(`👋 User logged out: ${req.user.email}`);
      
      return res.status(200).json({
        success: true,
        message: 'Logged out successfully'
      });
    } catch (error) {
      logger.error('❌ Logout error:', error);
      return res.status(500).json({
        success: false,
        message: 'Logout failed',
        error: config.nodeEnv === 'development' ? error.message : undefined
      });
    }
  }
  
  /**
   * REFRESH TOKEN (Optional - for token renewal)
   * POST /api/auth/refresh
   */
  async refreshToken(req, res) {
    try {
      const { refreshToken } = req.body;
      
      if (!refreshToken) {
        return res.status(400).json({
          success: false,
          message: 'Refresh token is required'
        });
      }
      
      // Verify refresh token
      const decoded = jwt.verify(refreshToken, config.jwt.secret);
      
      // Find user
      const user = await User.findById(decoded.userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
      
      // Generate new access token
      const newToken = jwt.sign(
        {
          userId: user._id,
          email: user.email,
          role: user.role,
        },
        config.jwt.secret,
        { expiresIn: config.jwt.expiry }
      );
      
      logger.info(`🔄 Token refreshed for: ${user.email}`);
      
      return res.status(200).json({
        success: true,
        message: 'Token refreshed successfully',
        data: {
          token: newToken,
          expiresIn: config.jwt.expiry
        }
      });
      
    } catch (error) {
      logger.error('❌ Token refresh error:', error);
      
      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          message: 'Refresh token expired. Please login again.'
        });
      }
      
      if (error.name === 'JsonWebTokenError') {
        return res.status(401).json({
          success: false,
          message: 'Invalid refresh token'
        });
      }
      
      return res.status(500).json({
        success: false,
        message: 'Token refresh failed',
        error: config.nodeEnv === 'development' ? error.message : undefined
      });
    }
  }
  
  /**
   * CHANGE PASSWORD (Optional - for authenticated users)
   * POST /api/auth/change-password
   */
  async changePassword(req, res) {
    try {
      const { currentPassword, newPassword } = req.body;
      
      // Find user
      const user = await User.findById(req.user.userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
      
      // Verify current password
      const isPasswordValid = await user.comparePassword(currentPassword);
      if (!isPasswordValid) {
        return res.status(401).json({
          success: false,
          message: 'Current password is incorrect'
        });
      }
      
      // Validate new password
      if (newPassword.length < 8) {
        return res.status(400).json({
          success: false,
          message: 'New password must be at least 8 characters long'
        });
      }
      
      // Update password
      user.passwordHash = newPassword;
      await user.save(); // Password will be hashed by pre-save hook
      
      logger.info(`🔑 Password changed for: ${user.email}`);
      
      return res.status(200).json({
        success: true,
        message: 'Password changed successfully'
      });
      
    } catch (error) {
      logger.error('❌ Change password error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to change password',
        error: config.nodeEnv === 'development' ? error.message : undefined
      });
    }
  }
}

module.exports = new AuthController();