// src/controllers/authController.js
// src/controllers/authController.js

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { sql, poolPromise } = require('../config/db');
const logger = require('../config/logger');

// 💡 SABSE ZAROORI FIX: Destructure both functions from response utility
const { sendSuccess, sendError } = require('../utils/response'); 

const sch = process.env.DB_SCHEMA || 'whatsapp';

// Ab niche ka saara signup/login logic sahi chalega

// ── SIGNUP ────────────────────────────────────────────────────
// src/controllers/authController.js -> signup function replace karein

const signup = async (req, res, next) => {
  try {
    const { name, email, password, phone, company_name } = req.body;
    const pool = await poolPromise;

    // 1. Check duplicate email (Strictly trim and lowercase)
    const cleanEmail = email.trim().toLowerCase();
    const existing = await pool.request()
      .input('email', sql.VarChar, cleanEmail)
      .query(`SELECT id FROM ${sch}.clients WHERE email = @email`);

    if (existing.recordset.length) {
       return sendError(res, 409, 'Email already registered. Please Login.');
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // 2. Direct INSERT with ACTIVE status and VERIFIED flag
    const result = await pool.request()
      .input('name', sql.VarChar, name)
      .input('email', sql.VarChar, cleanEmail)
      .input('pass', sql.VarChar, passwordHash)
      .input('phone', sql.VarChar, phone || null)
      .input('company', sql.VarChar, company_name || null)
      .query(`
        INSERT INTO ${sch}.clients (name, email, password_hash, phone, company_name, status, email_verified, created_at)
        OUTPUT inserted.id
        VALUES (@name, @email, @pass, @phone, @company, 'active', 1, GETDATE())
      `);

    const clientId = result.recordset[0].id;

    // 💡 Development bypass: Tokens ki zaroorat nahi jab auto-verify kar rahe hon
    logger.info(`✅ New Client Auto-Verified: ${cleanEmail} (id: ${clientId})`);
    
    return sendSuccess(res, { clientId }, 'Account created successfully! You can now login.', 201);
    
  } catch (err) {
    console.error("🔥 Signup Crash:", err.message);
    next(err);
  }
};

// ── VERIFY EMAIL ──────────────────────────────────────────────
const verifyEmail = async (req, res, next) => {
  try {
    const { token } = req.params;
    const pool = await poolPromise;

    const result = await pool.request()
      .input('token', sql.VarChar, token)
      .query(`
        SELECT * FROM ${sch}.client_tokens 
        WHERE token = @token AND type = 'email_verify' AND used_at IS NULL AND expires_at > GETDATE()
      `);

    if (!result.recordset.length) return sendError(res, 400, 'Invalid or expired verification link');

    const tokenData = result.recordset[0];

    // Azure SQL Transaction
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      await transaction.request()
        .input('cid', sql.Int, tokenData.client_id)
        .query(`UPDATE ${sch}.clients SET email_verified = 1, status = 'active' WHERE id = @cid`);
      
      await transaction.request()
        .input('tid', sql.Int, tokenData.id)
        .query(`UPDATE ${sch}.client_tokens SET used_at = GETDATE() WHERE id = @tid`);
      
      await transaction.commit();
    } catch (e) {
      await transaction.rollback();
      throw e;
    }

    return sendSuccess(res, {}, 'Email verified successfully');
  } catch (err) {
    next(err);
  }
};

// ── LOGIN ─────────────────────────────────────────────────────
const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const pool = await poolPromise;

    const result = await pool.request()
      .input('email', sql.VarChar, email)
      .query(`SELECT * FROM ${sch}.clients WHERE email = @email`);

    const client = result.recordset[0];
    if (!client) return sendError(res, 401, 'Invalid credentials');

    const valid = await bcrypt.compare(password, client.password_hash);
    if (!valid) return sendError(res, 401, 'Invalid credentials');

    if (!client.email_verified) return sendError(res, 403, 'Email not verified');
    if (client.status !== 'active') return sendError(res, 403, `Account ${client.status}`);

    const token = jwt.sign(
      { id: client.id, email: client.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    // Store session (GETDATE() for MSSQL)
    await pool.request()
      .input('cid', sql.Int, client.id)
      .input('stoken', sql.VarChar, token)
      .input('ip', sql.VarChar, req.ip)
      .input('ua', sql.NVarChar, req.headers['user-agent'] || '')
      .input('exp', sql.DateTime, expiresAt)
      .query(`
        INSERT INTO ${sch}.client_sessions (client_id, session_token, ip_address, user_agent, expires_at, last_active_at)
        VALUES (@cid, @stoken, @ip, @ua, @exp, GETDATE())
      `);

    logger.info(`Client login: ${email}`);

    return sendSuccess(res, {
      token,
      client: {
        id: client.id,
        name: client.name,
        email: client.email,
        company_name: client.company_name,
        plan_id: client.plan_id,
      }
    }, 'Login successful');
  } catch (err) {
    next(err);
  }
};

// ── LOGOUT ────────────────────────────────────────────────────
const logout = async (req, res, next) => {
  try {
    const pool = await poolPromise;
    await pool.request()
      .input('sid', sql.Int, req.sessionId)
      .query(`UPDATE ${sch}.client_sessions SET revoked = 1 WHERE id = @sid`);

    return sendSuccess(res, {}, 'Logged out successfully');
  } catch (err) {
    next(err);
  }
};

// ── FORGOT PASSWORD ───────────────────────────────────────────
const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    const pool = await poolPromise;

    const result = await pool.request()
      .input('email', sql.VarChar, email)
      .query(`SELECT id FROM ${sch}.clients WHERE email = @email`);

    if (!result.recordset.length) return sendSuccess(res, {}, 'If that email exists, a reset link has been sent');

    const token = uuidv4();
    await pool.request()
      .input('cid', sql.Int, result.recordset[0].id)
      .input('token', sql.VarChar, token)
      .query(`
        INSERT INTO ${sch}.client_tokens (client_id, token, type, expires_at)
        VALUES (@cid, @token, 'password_reset', DATEADD(hour, 1, GETDATE()))
      `);

    return sendSuccess(res, {}, 'If that email exists, a reset link has been sent');
  } catch (err) {
    next(err);
  }
};

// ── RESET PASSWORD ────────────────────────────────────────────
const resetPassword = async (req, res, next) => {
  try {
    const { token, password } = req.body;
    const pool = await poolPromise;

    const result = await pool.request()
      .input('token', sql.VarChar, token)
      .query(`
        SELECT * FROM ${sch}.client_tokens 
        WHERE token = @token AND type = 'password_reset' AND used_at IS NULL AND expires_at > GETDATE()
      `);

    if (!result.recordset.length) return sendError(res, 400, 'Invalid or expired reset token');

    const hash = await bcrypt.hash(password, 12);
    const clientId = result.recordset[0].client_id;
    const tokenId = result.recordset[0].id;

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      await transaction.request()
        .input('hash', sql.VarChar, hash)
        .input('cid', sql.Int, clientId)
        .query(`UPDATE ${sch}.clients SET password_hash = @hash WHERE id = @cid`);
      
      await transaction.request()
        .input('tid', sql.Int, tokenId)
        .query(`UPDATE ${sch}.client_tokens SET used_at = GETDATE() WHERE id = @tid`);

      // Revoke all sessions
      await transaction.request()
        .input('cid', sql.Int, clientId)
        .query(`UPDATE ${sch}.client_sessions SET revoked = 1 WHERE client_id = @cid`);
      
      await transaction.commit();
    } catch (e) {
      await transaction.rollback();
      throw e;
    }

    return sendSuccess(res, {}, 'Password reset successful. Please login again.');
  } catch (err) {
    next(err);
  }
};

// ── GET PROFILE ───────────────────────────────────────────────
const getProfile = async (req, res, next) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('cid', sql.Int, req.clientId)
      .query(`
        SELECT c.id, c.name, c.email, c.phone, c.company_name, c.country, c.timezone,
               c.email_verified, c.two_fa_enabled, c.created_at,
               p.name AS plan_name, p.max_instances, p.max_messages_pm,
               s.status AS subscription_status, s.ends_at AS subscription_ends
        FROM ${sch}.clients c
        LEFT JOIN ${sch}.plans p ON p.id = c.plan_id
        LEFT JOIN ${sch}.subscriptions s ON s.client_id = c.id
        WHERE c.id = @cid
      `);

    if (!result.recordset.length) return sendError(res, 404, 'Client not found');
    return sendSuccess(res, result.recordset[0]);
  } catch (err) {
    next(err);
  }
};

module.exports = { signup, verifyEmail, login, logout, forgotPassword, resetPassword, getProfile };
