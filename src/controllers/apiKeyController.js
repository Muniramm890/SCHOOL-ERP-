// src/controllers/apiKeyController.js
const crypto = require('crypto');
const { sql, poolPromise } = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');

const sch = process.env.DB_SCHEMA || 'whatsapp';

// Generate a secure API key
const generateKey = () => 'wak_' + crypto.randomBytes(32).toString('hex');

// ── LIST API KEYS ─────────────────────────────────────────────
const listKeys = async (req, res, next) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('clientId', sql.Int, req.clientId)
      .query(`
        SELECT id, key_name, api_key, permissions, ip_whitelist,
               rate_limit_rpm, last_used_at, expires_at, is_active, created_at
        FROM ${sch}.api_keys 
        WHERE client_id = @clientId 
        ORDER BY created_at DESC
      `);
    
    return sendSuccess(res, result.recordset);
  } catch (err) {
    next(err);
  }
};

// ── CREATE API KEY ────────────────────────────────────────────
const createKey = async (req, res, next) => {
  try {
    const { key_name, permissions, ip_whitelist, rate_limit_rpm, expires_at } = req.body;
    const pool = await poolPromise;

    // Check plan limit (Subquery optimized for MSSQL)
    const planResult = await pool.request()
      .input('clientId', sql.Int, req.clientId)
      .query(`
        SELECT max_api_keys FROM ${sch}.plans 
        WHERE id = (SELECT plan_id FROM ${sch}.clients WHERE id = @clientId)
      `);

    const countResult = await pool.request()
      .input('clientId', sql.Int, req.clientId)
      .query(`
        SELECT COUNT(*) AS cnt FROM ${sch}.api_keys 
        WHERE client_id = @clientId AND is_active = 1
      `);

    const plan = planResult.recordset[0];
    const currentCount = countResult.recordset[0].cnt;

    if (plan && currentCount >= plan.max_api_keys) {
      return sendError(res, 403, 'API key limit reached for your plan');
    }

    const apiKey = generateKey();
    
    // Azure SQL: Insert with OUTPUT to get the ID
    const result = await pool.request()
      .input('clientId', sql.Int, req.clientId)
      .input('keyName', sql.VarChar, key_name || 'API Key')
      .input('apiKey', sql.VarChar, apiKey)
      .input('permissions', sql.NVarChar, JSON.stringify(permissions || ['send', 'read']))
      .input('ipWhitelist', sql.NVarChar, JSON.stringify(ip_whitelist || []))
      .input('rateLimit', sql.Int, rate_limit_rpm || 60)
      .input('expiresAt', sql.DateTime, expires_at || null)
      .query(`
        INSERT INTO ${sch}.api_keys
          (client_id, key_name, api_key, permissions, ip_whitelist, rate_limit_rpm, expires_at, is_active)
        OUTPUT inserted.id
        VALUES (@clientId, @keyName, @apiKey, @permissions, @ipWhitelist, @rateLimit, @expiresAt, 1)
      `);

    return sendSuccess(res, { id: result.recordset[0].id, api_key: apiKey },
      'API key created. Store this key safely — it will not be shown again.', 201);
  } catch (err) {
    next(err);
  }
};

// ── REVOKE API KEY ────────────────────────────────────────────
const revokeKey = async (req, res, next) => {
  try {
    const { id } = req.params;
    const pool = await poolPromise;

    const result = await pool.request()
      .input('id', sql.Int, id)
      .input('clientId', sql.Int, req.clientId)
      .query(`
        UPDATE ${sch}.api_keys 
        SET is_active = 0 
        WHERE id = @id AND client_id = @clientId
      `);

    if (result.rowsAffected[0] === 0) {
      return sendError(res, 404, 'API key not found');
    }

    return sendSuccess(res, {}, 'API key revoked');
  } catch (err) {
    next(err);
  }
};

module.exports = { listKeys, createKey, revokeKey };