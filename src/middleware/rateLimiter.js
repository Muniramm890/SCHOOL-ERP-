// src/middleware/rateLimiter.js
const rateLimit = require('express-rate-limit');
const { sql, poolPromise } = require('../config/db');
const { sendError } = require('../utils/response');

const schema = process.env.DB_SCHEMA || 'whatsapp';

// 1. General API limiter (Standard Middleware)
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later' }
});

// 2. Auth routes limiter (Prevent Brute Force)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts, try after 15 minutes' }
});

// 3. Per-API-key dynamic rate limiter
const apiKeyLimiter = async (req, res, next) => {
  if (!req.apiKeyId) return next();

  try {
    const pool = await poolPromise;
    
    // SQL Server Syntax: @param + Schema Prefix
    const result = await pool.request()
      .input('id', sql.Int, req.apiKeyId)
      .query(`SELECT rate_limit_rpm FROM ${schema}.api_keys WHERE id = @id`);

    const keyRow = result.recordset[0];
    if (!keyRow) return next();

    const rpm = keyRow.rate_limit_rpm || 60;
    const key = `api_key:${req.apiKeyId}`;
    const now = Date.now();
    const windowMs = 60 * 1000; // 1 minute

    // In-memory tracker
    if (!global._rateLimitStore) global._rateLimitStore = {};
    const store = global._rateLimitStore;

    // Reset window logic
    if (!store[key] || now - store[key].start > windowMs) {
      store[key] = { start: now, count: 1 };
    } else {
      store[key].count++;
    }

    // Set standard headers
    res.set('X-RateLimit-Limit', rpm);
    res.set('X-RateLimit-Remaining', Math.max(0, rpm - store[key].count));

    if (store[key].count > rpm) {
      return sendError(res, 429, `Rate limit exceeded. Max ${rpm} requests per minute.`);
    }

    next();
  } catch (err) {
    // Agar rate limit query fail ho jaye, tab bhi request allow kar sakte hain (failsafe)
    console.error('Rate Limiter Error:', err);
    next();
  }
};

module.exports = { generalLimiter, authLimiter, apiKeyLimiter };
