// src/middleware/requestLogger.js
const logger = require('../config/logger');

// Sensitive fields jo kabhi bhi log nahi hone chahiye
const SENSITIVE_FIELDS = ['password', 'token', 'otp', 'confirmPassword', 'secret', 'authorization'];

// Body ko safe banane ke liye — sensitive keys ko mask karta hai
const sanitizeBody = (body) => {
  if (!body || typeof body !== 'object') return body;
  const clone = { ...body };
  for (const key of Object.keys(clone)) {
    if (SENSITIVE_FIELDS.includes(key.toLowerCase())) {
      clone[key] = '***HIDDEN***';
    }
  }
  return clone;
};

// Response body ko capture karne ke liye res.json override
const requestLogger = (req, res, next) => {
  const start = process.hrtime.bigint();
  const requestId = req.headers['x-request-id'] || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  req.requestId = requestId;

  // Incoming request log (dev mein detailed, prod mein halka)
  logger.info(`→ ${req.method} ${req.originalUrl}`, {
    requestId,
    ip: req.ip || req.connection?.remoteAddress,
    userAgent: req.headers['user-agent'],
    query: req.query,
    body: process.env.NODE_ENV === 'development' ? sanitizeBody(req.body) : undefined,
    user: req.user?.userId || 'anonymous',
    school: req.user?.schoolId || null,
  });

  // Response finish hone par log karo
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

    logger[level](`← ${req.method} ${req.originalUrl} ${res.statusCode} - ${durationMs.toFixed(1)}ms`, {
      requestId,
      statusCode: res.statusCode,
      durationMs: Math.round(durationMs),
      user: req.user?.userId || 'anonymous',
      school: req.user?.schoolId || null,
      contentLength: res.getHeader('content-length') || 0,
    });

    // Slow request warning (500ms se zyada)
    if (durationMs > 500) {
      logger.warn(`⚠ Slow request detected: ${req.method} ${req.originalUrl} took ${durationMs.toFixed(0)}ms`, {
        requestId,
      });
    }
  });

  // Client connection abruptly close ho jaye to bhi track ho
  res.on('close', () => {
    if (!res.writableEnded) {
      logger.warn(`✕ Request aborted by client: ${req.method} ${req.originalUrl}`, { requestId });
    }
  });

  next();
};

module.exports = requestLogger;
