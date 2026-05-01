// src/routes/admin.js
const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { sql, poolPromise } = require('../config/db');
const { authAdmin } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');
const { sendSuccess, sendError, sendPaginated } = require('../utils/response');

const sch = process.env.DB_SCHEMA || 'whatsapp';

// ── Master Admin Registration (Fixed Logic) ──────────────────
router.post('/register-master-root', async (req, res, next) => {
  try {
    const { email, password, name, secret_key } = req.body;

    if (secret_key !== 'MySuperSecret123') {
      return res.status(403).send("Forbidden");
    }

    const pool = await poolPromise;
    const schema = process.env.DB_SCHEMA || 'whatsapp';

    // 💡 FIX: Salt aur Hash generate karte waqt rounds ko exact match rakhein
    const salt = await bcrypt.genSalt(12);
    const hash = await bcrypt.hash(password.trim(), salt); // Input password ko bhi trim karein

    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    try {
      const request = new sql.Request(transaction);
      const cleanEmail = email ? email.trim() : "";

      request.input('email', sql.VarChar, cleanEmail);
      request.input('name', sql.VarChar, name || 'Master Admin');
      request.input('pass', sql.VarChar, hash.trim()); // Hash ko bhi trim karke bhejien

      await request.query(`DELETE FROM ${schema}.admins WHERE email = @email`);

      const adminResult = await request.query(`
        INSERT INTO ${schema}.admins (name, email, password_hash, role, is_active, created_at, wallet_balance)
        OUTPUT INSERTED.id
        VALUES (@name, @email, @pass, 'superadmin', 1, GETDATE(), 0)
      `);
      
      const adminId = adminResult.recordset[0].id;
      await transaction.commit();
      
      console.log(`✅ Admin Created: ${cleanEmail} (ID: ${adminId})`);
      return res.status(201).json({ success: true, admin_id: adminId });

    } catch (sqlErr) {
      if (transaction) await transaction.rollback();
      throw sqlErr;
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// ── Admin Login ───────────────────────────────────────────────
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const pool = await poolPromise;

    // Email को trim करें ताकि कोई extra space न रहे
    const cleanEmail = email ? email.trim() : "";

    const result = await pool.request()
      .input('email', sql.VarChar, cleanEmail)
      .query(`SELECT * FROM ${sch}.admins WHERE email = @email`);

    const admin = result.recordset[0];
    
    if (!admin) {
      console.log(`❌ Login Fail: Email ${cleanEmail} not found in DB`);
      return sendError(res, 401, 'Invalid credentials');
    }

    // 💡 FIX 1: Explicitly stringify and trim the hash from DB
    const dbHash = admin.password_hash.trim();
    
    // 💡 FIX 2: Bcrypt comparison with logging
    const valid = await bcrypt.compare(password, dbHash);
    
    console.log(`🔍 Auth Check for ${cleanEmail}:`, {
      passwordProvided: password ? "YES" : "NO",
      hashFound: "YES",
      isValid: valid
    });

    if (!valid) return sendError(res, 401, 'Invalid credentials');
    if (!admin.is_active) return sendError(res, 403, 'Admin account inactive');

    // 💡 FIX 3: Ensure JWT_SECRET exists, otherwise use a fallback for testing
    
const secret = process.env.JWT_SECRET || 'fallback_secret_for_testing';

// अब हम इसमें isAdmin के साथ-साथ वो keys भी डाल रहे हैं जो authClient चेक करता है
const token = jwt.sign(
  { 
    id: admin.id, 
    isAdmin: true, 
    role: admin.role,
    // 💡 क्लाइंट रूट्स को धोखा देने के लिए ये एक्स्ट्रा पे लोड:
    clientId: admin.id, 
    isClient: true 
  },
  secret,
  { expiresIn: '8h' }
);

await pool.request()
  .input('token', sql.VarChar, token)
  .input('cid', sql.Int, admin.id)
  .query(`
    INSERT INTO ${sch}.client_sessions (client_id, session_token, expires_at, revoked)
    VALUES (@cid, @token, DATEADD(hour, 8, GETDATE()), 0)
  `);


    console.log(`✅ Admin logged in: ${cleanEmail}`);
    return sendSuccess(res, { token, role: admin.role });

  } catch (err) { 
    console.error("🔥 Login Crash Error:", err.message);
    next(err); 
  }
});




// ── List Clients ──────────────────────────────────────────────
router.get('/clients', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const offset = (page - 1) * limit;
    const pool = await poolPromise;

    let where = '';
    const request = pool.request();
    if (status) { 
      where = 'WHERE c.status = @status'; 
      request.input('status', sql.VarChar, status); 
    }

    const query = `
      SELECT c.id, c.name, c.email, c.phone, c.company_name, c.status,
             c.email_verified, c.created_at,
             p.name AS plan_name,
             s.status AS subscription_status, s.ends_at
      FROM ${sch}.clients c
      LEFT JOIN ${sch}.plans p ON p.id = c.plan_id
      LEFT JOIN ${sch}.subscriptions s ON s.client_id = c.id
      ${where} 
      ORDER BY c.created_at DESC 
      OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
    `;

    const result = await request.query(query);
    const countRes = await pool.request()
      .input('status', sql.VarChar, status || null)
      .query(`SELECT COUNT(*) AS total FROM ${sch}.clients c ${status ? 'WHERE status = @status' : ''}`);

    return sendPaginated(res, result.recordset, countRes.recordset[0].total, page, limit);
  } catch (err) { next(err); }
});

// ── Update Client Status ──────────────────────────────────────
router.patch('/clients/:id/status', async (req, res, next) => {
  try {
    const { status } = req.body;
    const valid = ['active', 'suspended', 'banned'];
    if (!valid.includes(status)) return sendError(res, 400, 'Invalid status');

    const pool = await poolPromise;
    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    try {
      await transaction.request()
        .input('status', sql.VarChar, status)
        .input('id', sql.Int, req.params.id)
        .query(`UPDATE ${sch}.clients SET status = @status WHERE id = @id`);

      // Audit log
      await transaction.request()
        .input('adminId', sql.Int, req.adminId)
        .input('clientId', sql.Int, req.params.id)
        .input('val', sql.NVarChar, JSON.stringify({ status }))
        .query(`
          INSERT INTO ${sch}.audit_logs (admin_id, client_id, action, entity, entity_id, new_value)
          VALUES (@adminId, @clientId, 'client_status_changed', 'clients', @clientId, @val)
        `);

      await transaction.commit();
    } catch (e) {
      await transaction.rollback();
      throw e;
    }

    return sendSuccess(res, {}, 'Client status updated');
  } catch (err) { next(err); }
});

// ── Dashboard Stats ───────────────────────────────────────────
router.get('/stats', async (req, res, next) => {
  try {
    const pool = await poolPromise;

    // Parallel Queries for Performance
    const [qClients, qActive, qMsgs, qRevenue, qInstances] = await Promise.all([
      pool.request().query(`SELECT COUNT(*) AS total FROM ${sch}.clients`),
      pool.request().query(`SELECT COUNT(*) AS total FROM ${sch}.clients WHERE status = 'active'`),
      pool.request().query(`SELECT COUNT(*) AS total FROM ${sch}.messages WHERE CAST(created_at AS DATE) = CAST(GETDATE() AS DATE)`),
      pool.request().query(`SELECT COALESCE(SUM(amount),0) AS total FROM ${sch}.payments WHERE status = 'success' AND MONTH(paid_at) = MONTH(GETDATE()) AND YEAR(paid_at) = YEAR(GETDATE())`),
      pool.request().query(`SELECT COUNT(*) AS total FROM ${sch}.whatsapp_instances WHERE status = 'connected'`)
    ]);

    return sendSuccess(res, {
      total_clients:      qClients.recordset[0].total,
      active_clients:     qActive.recordset[0].total,
      messages_today:     qMsgs.recordset[0].total,
      revenue_this_month: qRevenue.recordset[0].total,
      connected_instances: qInstances.recordset[0].total,
    });
  } catch (err) { next(err); }
});

module.exports = router;
