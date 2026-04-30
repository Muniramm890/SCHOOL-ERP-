// src/controllers/instanceController.js
const { sql, poolPromise } = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');

const sch = process.env.DB_SCHEMA || 'whatsapp';

// ── LIST INSTANCES ────────────────────────────────────────────
const listInstances = async (req, res, next) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('clientId', sql.Int, req.clientId)
      .query(`
        SELECT id, instance_name, phone_number, waba_id, phone_id,
               status, api_type, webhook_url, last_seen_at, connected_at, created_at
        FROM ${sch}.whatsapp_instances 
        WHERE client_id = @clientId 
        ORDER BY created_at DESC
      `);
    return sendSuccess(res, result.recordset);
  } catch (err) {
    next(err);
  }
};

// ── CREATE INSTANCE ───────────────────────────────────────────
const createInstance = async (req, res, next) => {
  try {
    const { instance_name, phone_number, waba_id, phone_id, access_token, api_type, webhook_url } = req.body;
    const pool = await poolPromise;

    // Check plan limit using MSSQL subquery logic
    const planResult = await pool.request()
      .input('clientId', sql.Int, req.clientId)
      .query(`
        SELECT max_instances FROM ${sch}.plans 
        WHERE id = (SELECT plan_id FROM ${sch}.clients WHERE id = @clientId)
      `);

    const countResult = await pool.request()
      .input('clientId', sql.Int, req.clientId)
      .query(`
        SELECT COUNT(*) AS cnt FROM ${sch}.whatsapp_instances 
        WHERE client_id = @clientId
      `);

    const plan = planResult.recordset[0];
    const currentCount = countResult.recordset[0].cnt;

    if (plan && currentCount >= plan.max_instances) {
      return sendError(res, 403, 'Instance limit reached for your plan. Please upgrade.');
    }

    const result = await pool.request()
      .input('clientId', sql.Int, req.clientId)
      .input('name', sql.VarChar, instance_name)
      .input('phone', sql.VarChar, phone_number)
      .input('waba', sql.VarChar, waba_id || null)
      .input('phoneId', sql.VarChar, phone_id || null)
      .input('token', sql.NVarChar, access_token || null)
      .input('type', sql.VarChar, api_type || 'cloud')
      .input('webhook', sql.VarChar, webhook_url || null)
      .query(`
        INSERT INTO ${sch}.whatsapp_instances
          (client_id, instance_name, phone_number, waba_id, phone_id, access_token, api_type, webhook_url, status)
        OUTPUT inserted.id
        VALUES (@clientId, @name, @phone, @waba, @phoneId, @token, @type, @webhook, 'pending')
      `);

    return sendSuccess(res, { id: result.recordset[0].id }, 'Instance created', 201);
  } catch (err) {
    next(err);
  }
};

// ── GET INSTANCE ──────────────────────────────────────────────
const getInstance = async (req, res, next) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('id', sql.Int, req.params.id)
      .input('clientId', sql.Int, req.clientId)
      .query(`
        SELECT id, instance_name, phone_number, waba_id, phone_id, status,
               api_type, webhook_url, last_seen_at, connected_at, created_at
        FROM ${sch}.whatsapp_instances 
        WHERE id = @id AND client_id = @clientId
      `);
    
    if (!result.recordset.length) return sendError(res, 404, 'Instance not found');
    return sendSuccess(res, result.recordset[0]);
  } catch (err) {
    next(err);
  }
};

// ── UPDATE INSTANCE ───────────────────────────────────────────
const updateInstance = async (req, res, next) => {
  try {
    const { instance_name, webhook_url, access_token } = req.body;
    const pool = await poolPromise;

    const result = await pool.request()
      .input('name', sql.VarChar, instance_name || null)
      .input('webhook', sql.VarChar, webhook_url || null)
      .input('token', sql.NVarChar, access_token || null)
      .input('id', sql.Int, req.params.id)
      .input('clientId', sql.Int, req.clientId)
      .query(`
        UPDATE ${sch}.whatsapp_instances
        SET instance_name = COALESCE(@name, instance_name),
            webhook_url   = COALESCE(@webhook, webhook_url),
            access_token  = COALESCE(@token, access_token)
        WHERE id = @id AND client_id = @clientId
      `);

    if (result.rowsAffected[0] === 0) return sendError(res, 404, 'Instance not found');
    return sendSuccess(res, {}, 'Instance updated');
  } catch (err) {
    next(err);
  }
};

// ── DELETE INSTANCE ───────────────────────────────────────────
const deleteInstance = async (req, res, next) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('id', sql.Int, req.params.id)
      .input('clientId', sql.Int, req.clientId)
      .query(`DELETE FROM ${sch}.whatsapp_instances WHERE id = @id AND client_id = @clientId`);

    if (result.rowsAffected[0] === 0) return sendError(res, 404, 'Instance not found');
    return sendSuccess(res, {}, 'Instance deleted');
  } catch (err) {
    next(err);
  }
};

// ── INSTANCE STATUS UPDATE (from webhook or manual) ───────────
const updateStatus = async (req, res, next) => {
  try {
    const { status } = req.body;
    const validStatuses = ['pending', 'connected', 'disconnected', 'banned', 'expired'];
    if (!validStatuses.includes(status)) return sendError(res, 400, 'Invalid status');

    const connectedAt = status === 'connected' ? new Date() : null;
    const pool = await poolPromise;

    await pool.request()
      .input('status', sql.VarChar, status)
      .input('connectedAt', sql.DateTime, connectedAt)
      .input('id', sql.Int, req.params.id)
      .input('clientId', sql.Int, req.clientId)
      .query(`
        UPDATE ${sch}.whatsapp_instances
        SET status = @status, 
            last_seen_at = GETDATE(),
            connected_at = COALESCE(@connectedAt, connected_at)
        WHERE id = @id AND client_id = @clientId
      `);

    return sendSuccess(res, {}, 'Status updated');
  } catch (err) {
    next(err);
  }
};

module.exports = { listInstances, createInstance, getInstance, updateInstance, deleteInstance, updateStatus };