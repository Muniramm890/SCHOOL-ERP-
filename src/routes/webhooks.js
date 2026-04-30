// src/routes/webhooks.js
const express = require('express');
const router  = express.Router();
const { sql, poolPromise } = require('../config/db');
const { authClient } = require('../middleware/auth');
const { sendSuccess, sendError } = require('../utils/response');

const sch = process.env.DB_SCHEMA || 'whatsapp';

// Saare webhook management ke liye login zaroori hai
router.use(authClient);

// ── LIST WEBHOOKS ─────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('clientId', sql.Int, req.clientId)
      .query(`
        SELECT id, url, events, is_active, created_at 
        FROM ${sch}.webhooks 
        WHERE client_id = @clientId
      `);
    return sendSuccess(res, result.recordset);
  } catch (err) { next(err); }
});

// ── CREATE WEBHOOK ────────────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const { url, events, secret, instance_id } = req.body;
    const pool = await poolPromise;

    // Azure SQL: Get new ID using OUTPUT inserted.id
    const result = await pool.request()
      .input('clientId', sql.Int, req.clientId)
      .input('instId', sql.Int, instance_id || null)
      .input('url', sql.VarChar, url)
      .input('secret', sql.VarChar, secret || null)
      .input('events', sql.NVarChar, JSON.stringify(events || []))
      .query(`
        INSERT INTO ${sch}.webhooks (client_id, instance_id, url, secret, events) 
        OUTPUT inserted.id
        VALUES (@clientId, @instId, @url, @secret, @events)
      `);

    return sendSuccess(res, { id: result.recordset[0].id }, 'Webhook created', 201);
  } catch (err) { next(err); }
});

// ── DELETE WEBHOOK ────────────────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('id', sql.Int, req.params.id)
      .input('clientId', sql.Int, req.clientId)
      .query(`DELETE FROM ${sch}.webhooks WHERE id = @id AND client_id = @clientId`);

    if (result.rowsAffected[0] === 0) return sendError(res, 404, 'Webhook not found');
    return sendSuccess(res, {}, 'Webhook deleted');
  } catch (err) { next(err); }
});

// ── WEBHOOK LOGS ──────────────────────────────────────────────
router.get('/:id/logs', async (req, res, next) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('id', sql.Int, req.params.id)
      .input('clientId', sql.Int, req.clientId)
      .query(`
        SELECT wl.* FROM ${sch}.webhook_logs wl
        JOIN ${sch}.webhooks w ON w.id = wl.webhook_id
        WHERE wl.webhook_id = @id AND w.client_id = @clientId
        ORDER BY wl.sent_at DESC
        OFFSET 0 ROWS FETCH NEXT 50 ROWS ONLY
      `);
    return sendSuccess(res, result.recordset);
  } catch (err) { next(err); }
});

module.exports = router;