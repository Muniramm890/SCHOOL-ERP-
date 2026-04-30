// src/middleware/auth.js
const jwt = require('jsonwebtoken');
const { sql, poolPromise } = require('../config/db'); // poolPromise use karenge
const response = require('../utils/response');
const schema = process.env.DB_SCHEMA || 'whatsapp';

// ── JWT Auth (Dashboard / Client Login) ──────────────────────
const authClient = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer '))
      return sendError(res, 401, 'Authorization token required');

    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const pool = await poolPromise;
    
    // SQL Server Syntax: @param placeholders + Schema Prefix
    const result = await pool.request()
      .input('token', sql.VarChar, token)
      .query(`
        SELECT cs.id, cs.client_id, cs.revoked, cs.expires_at,
               c.status, c.plan_id
        FROM ${schema}.client_sessions cs
        JOIN ${schema}.clients c ON c.id = cs.client_id
        WHERE cs.session_token = @token AND cs.revoked = 0
      `);

    const session = result.recordset[0];

    if (!session) return sendError(res, 401, 'Session not found or revoked');
    if (session.status !== 'active') return sendError(res, 403, 'Account suspended');
    if (new Date(session.expires_at) < new Date())
      return sendError(res, 401, 'Session expired');

    req.clientId  = session.client_id;
    req.planId    = session.plan_id;
    req.sessionId = session.id;

    // Update last_active (GETDATE() for Azure SQL)
    await pool.request()
      .input('id', sql.Int, session.id)
      .query(`UPDATE ${schema}.client_sessions SET last_active_at = GETDATE() WHERE id = @id`);

    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError') return sendError(res, 401, 'Invalid token');
    if (err.name === 'TokenExpiredError') return sendError(res, 401, 'Token expired');
    next(err);
  }
};

// ── API Key Auth (External API Calls) ────────────────────────
const authApiKey = async (req, res, next) => {
  try {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    if (!apiKey) return sendError(res, 401, 'API key required');

    const pool = await poolPromise;
    const result = await pool.request()
      .input('key', sql.VarChar, apiKey)
      .query(`
        SELECT ak.id, ak.client_id, ak.permissions, ak.ip_whitelist,
               ak.rate_limit_rpm, ak.expires_at, ak.is_active,
               c.status, c.plan_id
        FROM ${schema}.api_keys ak
        JOIN ${schema}.clients c ON c.id = ak.client_id
        WHERE ak.api_key = @key
      `);

    const keyData = result.recordset[0];

    if (!keyData) return sendError(res, 401, 'Invalid API key');
    if (!keyData.is_active) return sendError(res, 401, 'API key disabled');
    if (keyData.status !== 'active') return sendError(res, 403, 'Account suspended');
    if (keyData.expires_at && new Date(keyData.expires_at) < new Date())
      return sendError(res, 401, 'API key expired');

    // IP Whitelist (Azure SQL stores JSON as string, so parse it)
    let whitelist = keyData.ip_whitelist;
    if (whitelist) {
      try { whitelist = JSON.parse(whitelist); } catch(e) { whitelist = []; }
      const clientIp = req.ip || req.headers['x-forwarded-for'];
      if (whitelist.length > 0 && !whitelist.includes(clientIp))
        return sendError(res, 403, 'IP not whitelisted');
    }

    req.clientId = keyData.client_id;
    req.apiKeyId = keyData.id;
    req.planId = keyData.plan_id;
    
    // Permissions parsing
    try { 
      req.permissions = typeof keyData.permissions === 'string' ? JSON.parse(keyData.permissions) : keyData.permissions; 
    } catch(e) { req.permissions = []; }

    await pool.request()
      .input('id', sql.Int, keyData.id)
      .query(`UPDATE ${schema}.api_keys SET last_used_at = GETDATE() WHERE id = @id`);

    next();
  } catch (err) {
    next(err);
  }
};

// ── Admin JWT Auth ────────────────────────────────────────────
const authAdmin = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer '))
      return sendError(res, 401, 'Admin token required');

    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded.isAdmin) return sendError(res, 403, 'Admin access only');

    const pool = await poolPromise;
    const result = await pool.request()
      .input('id', sql.Int, decoded.id)
      .query(`SELECT id, role, is_active FROM ${schema}.wa_admins WHERE id = @id`);

    const admin = result.recordset[0];

    if (!admin || !admin.is_active)
      return sendError(res, 403, 'Admin not found or inactive');

    req.adminId = admin.id;
    req.adminRole = admin.role;
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError') return sendError(res, 401, 'Invalid token');
    next(err);
  }
};

module.exports = { authClient, authApiKey, authAdmin };
