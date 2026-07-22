const redis = require('redis');
const config = require('../config/config');
const logger = require('../../../../shared/utils/logger');

class OTPService {
  constructor() {
    this.redisClient = redis.createClient({
      socket: {
        host: config.redis?.host || 'localhost',
        port: config.redis?.port || 6379,
      },
    });
    
    this.redisClient.on('error', (err) => {
      logger.error('Redis Client Error:', err);
    });
    
    this.redisClient.on('connect', () => {
      logger.info('✅ Redis connected successfully');
    });
    
    // Connect to Redis
    this.connect();
  }
  
  async connect() {
    try {
      await this.redisClient.connect();
    } catch (error) {
      logger.error('❌ Failed to connect to Redis:', error);
    }
  }
  
  /**
   * Generate a random 6-digit OTP
   */
  generateOTP() {
    const length = config.otp.length;
    const min = Math.pow(10, length - 1);
    const max = Math.pow(10, length) - 1;
    return Math.floor(min + Math.random() * (max - min + 1)).toString();
  }
  
  /**
   * Store OTP in Redis with expiry
   */
  async storeOTP(email, otp) {
    try {
      const key = `otp:${email}`;
      const expirySeconds = config.otp.expiryMinutes * 60;
      
      await this.redisClient.setEx(key, expirySeconds, otp);
      
      logger.info(`📧 OTP stored for ${email}, expires in ${config.otp.expiryMinutes} minutes`);
      return { success: true };
    } catch (error) {
      logger.error('❌ Error storing OTP:', error);
      throw new Error('Failed to store OTP');
    }
  }
  
  /**
   * Verify OTP
   */
  async verifyOTP(email, otp) {
    try {
      const key = `otp:${email}`;
      const storedOTP = await this.redisClient.get(key);
      
      if (!storedOTP) {
        return { 
          success: false, 
          message: 'OTP expired or not found' 
        };
      }
      
      if (storedOTP !== otp) {
        return { 
          success: false, 
          message: 'Invalid OTP' 
        };
      }
      
      // Delete OTP after successful verification
      await this.redisClient.del(key);
      
      logger.info(`✅ OTP verified successfully for ${email}`);
      return { 
        success: true, 
        message: 'OTP verified successfully' 
      };
    } catch (error) {
      logger.error('❌ Error verifying OTP:', error);
      throw new Error('Failed to verify OTP');
    }
  }
  
  /**
   * Delete OTP
   */
  async deleteOTP(email) {
    try {
      const key = `otp:${email}`;
      await this.redisClient.del(key);
      return { success: true };
    } catch (error) {
      logger.error('❌ Error deleting OTP:', error);
      throw new Error('Failed to delete OTP');
    }
  }
  
  /**
   * Check if OTP exists
   */
  async otpExists(email) {
    try {
      const key = `otp:${email}`;
      const exists = await this.redisClient.exists(key);
      return exists === 1;
    } catch (error) {
      logger.error('❌ Error checking OTP existence:', error);
      return false;
    }
  }
}

module.exports = new OTPService();