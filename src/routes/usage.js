// src/routes/usage.js
const express = require('express');
const router  = express.Router();
const { sql, poolPromise } = require('../config/db');
const { authClient } = require('../middleware/auth');
const { sendSuccess } = require('../utils/response');

const sch = process.env.DB_SCHEMA || 'whatsapp';

router.use(authClient);

// GET /usage — current month usage + plan limits
router.get('/', async (req, res, next) => {
  try {
    const pool = await poolPromise;
    
    // 1. Current Month Usage (Azure SQL uses GETDATE() instead of NOW())
    const currentUsageRes = await pool.request()
      .input('clientId', sql.Int, req.clientId)
      .query(`
        SELECT u.messages_sent, u.messages_recv, u.api_calls, u.cost_total,
               u.period_year, u.period_month,
               p.max_messages_pm, p.max_instances, p.max_api_keys, p.name AS plan_name
        FROM ${sch}.usage_stats u
        JOIN ${sch}.clients c ON c.id = u.client_id
        JOIN ${sch}.plans p ON p.id = c.plan_id
        WHERE u.client_id = @clientId 
          AND u.period_year = YEAR(GETDATE()) 
          AND u.period_month = MONTH(GETDATE())
      `);

    // 2. Usage History (Last 12 months)
    const historyRes = await pool.request()
      .input('clientId', sql.Int, req.clientId)
      .query(`
        SELECT period_year, period_month, messages_sent, messages_recv, cost_total
        FROM ${sch}.usage_stats 
        WHERE client_id = @clientId
        ORDER BY period_year DESC, period_month DESC
        OFFSET 0 ROWS FETCH NEXT 12 ROWS ONLY
      `);

    return sendSuccess(res, { 
      current: currentUsageRes.recordset[0] || null, 
      history: historyRes.recordset 
    });
  } catch (err) { 
    next(err); 
  }
});

module.exports = router;