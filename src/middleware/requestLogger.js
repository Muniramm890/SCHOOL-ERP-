// src/middleware/requestLogger.js
const logger = require('../utils/logger');
const { logAudit } = require('../utils/auditLogger');

const SENSITIVE_FIELDS = ['password', 'token', 'otp', 'confirmPassword', 'secret', 'authorization'];

const sanitizeBody = (body) => {
  if (!body || typeof body !== 'object') return body;
  const clone = { ...body };
  for (const key of Object.keys(clone)) {
    if (SENSITIVE_FIELDS.includes(key.toLowerCase())) clone[key] = '***HIDDEN***';
  }
  return clone;
};

const getIp = (req) => {
  const fwd = req.headers['x-forwarded-for'];
  return fwd ? fwd.split(',')[0].trim() : req.socket.remoteAddress;
};

const requestLogger = (req, res, next) => {
  const start = process.hrtime.bigint();
  const requestId = req.headers['x-request-id'] || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  req.requestId = requestId;
  const ip = getIp(req);

  logger.info(`→ ${req.method} ${req.originalUrl}`, {
    requestId, ip, user: req.user?.userId || 'anonymous',
  });

  res.on('finish', () => {
    const durationMs = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

    logger[level](`← ${req.method} ${req.originalUrl} ${res.statusCode} - ${durationMs}ms`, {
      requestId, statusCode: res.statusCode, durationMs, user: req.user?.userId || 'anonymous',
    });

    // 🔴 DB mein bhi likh do — sirf GET requests ko skip mat karo,
    // sab actions track honge (jaisa tumne bola: "kaunsa page visit kiya")
    // Health-check aur static-ish routes ko chhod do taaki table bloat na ho
    if (!req.originalUrl.startsWith('/health')) {
      logAudit({
        schoolId: req.user?.schoolId || null,
        userId: req.user?.userId || null,
        userName: req.user?.fullName || null,
        userRole: req.user?.role || null,
        actionType: 'API_CALL',
        method: req.method,
        endpoint: req.originalUrl,
        statusCode: res.statusCode,
        ipAddress: ip,
        userAgent: req.headers['user-agent'],
        durationMs,
      });
    }
  });

  next();
};

module.exports = requestLogger;
