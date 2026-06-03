// src/utils/audit.js
const { query, sql } = require('../config/db');
const logger = require('./logger');

/**
 * Write an audit record — fire-and-forget (never throws)
 */
const audit = async ({ req, action, tableName, recordId, oldValues = null, newValues = null }) => {
  try {
    const diff = {};
    if (oldValues && newValues) {
      for (const key of Object.keys(newValues)) {
        if (JSON.stringify(oldValues[key]) !== JSON.stringify(newValues[key])) {
          diff[key] = { from: oldValues[key], to: newValues[key] };
        }
      }
    }

    await query(
      `INSERT INTO audit_logs
         (id, school_id, actor_id, actor_ip, action, table_name, record_id,
          old_values, new_values, diff, user_agent, created_at)
       VALUES
         (NEWID(), @schoolId, @actorId, @actorIp, @action, @tableName, @recordId,
          @oldValues, @newValues, @diff, @userAgent, GETUTCDATE())`,
      {
        schoolId:   { type: sql.UniqueIdentifier, value: req?.user?.schoolId || null },
        actorId:    { type: sql.UniqueIdentifier, value: req?.user?.userId || null },
        actorIp:    { type: sql.VarChar(50),      value: (req?.headers['x-forwarded-for'] || req?.ip || '').slice(0, 50) },
        action:     { type: sql.NVarChar(50),      value: action },
        tableName:  { type: sql.NVarChar(100),     value: tableName },
        recordId:   { type: sql.UniqueIdentifier, value: recordId || null },
        oldValues:  { type: sql.NVarChar(sql.MAX), value: oldValues ? JSON.stringify(oldValues) : null },
        newValues:  { type: sql.NVarChar(sql.MAX), value: newValues ? JSON.stringify(newValues) : null },
        diff:       { type: sql.NVarChar(sql.MAX), value: Object.keys(diff).length ? JSON.stringify(diff) : null },
        userAgent:  { type: sql.NVarChar(sql.MAX), value: req?.headers['user-agent'] || null },
      }
    );
  } catch (err) {
    logger.warn('Audit log failed (non-critical):', err.message);
  }
};

module.exports = { audit };
