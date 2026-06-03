// src/middleware/rateLimiter.js
const rateLimit = require('express-rate-limit');

// 🔥 Azure IP Fix: Azure IP ke sath port bhejta hai (e.g., 157.48.91.6:47412)
// Ye function safely us port ko hata dega taaki rate limiter crash na ho
const customKeyGenerator = (req) => {
  let ip = req.headers['x-forwarded-for'] || req.ip || req.connection.remoteAddress || 'unknown';
  
  // Agar multiple IPs comma-separated hain (Proxies ke case mein), toh pehla wala lo
  if (ip.includes(',')) {
    ip = ip.split(',')[0];
  }
  
  // Agar IP ke sath port attach hai (Azure bug), toh usko hata do
  return ip.split(':')[0];
};

// 1. General API Limiter (Standard DDoS Protection for the whole app)
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500, // Limit each IP to 500 requests per 15 mins
  keyGenerator: customKeyGenerator,
  standardHeaders: true, 
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests from this IP, please try again after 15 minutes.' }
});

// 2. Auth Routes Limiter (Brute Force Protection for Login/OTP)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // Limit each IP to 15 login/auth attempts per 15 mins
  keyGenerator: customKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many authentication attempts, please try again after 15 minutes.' }
});

module.exports = { generalLimiter, authLimiter };
