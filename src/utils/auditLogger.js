// src/utils/auditLogger.js
const sql = require('mssql');
const { query } = require('./db');   // ya jahan bhi tumhara query() function hai
const logger = require('./logger');

/**
 * Fire-and-forget audit log insert. Kabhi bhi request ko block nahi karega,
 * agar DB insert fail bhi ho jaye to sirf console mein warning ayegi.
 */
const logAudit = async ({
  schoolId = null,
  userId = null,
  userName = null,
  userRole = null,
  actionType,
  method = null,
  endpoint = null,
  statusCode = null,
  ipAddress = null,
  userAgent = null,
  durationMs = null,
  details = null,
}) => {
  try {
    await query(
      `INSERT INTO audit_logs
         (school_id, user_id, user_name, user_role, action_type, method, endpoint,
          status_code, ip_address, user_agent, duration_ms, details, created_at)
       VALUES
         (@schoolId, @userId, @userName, @userRole, @actionType, @method, @endpoint,
          @statusCode, @ipAddress, @userAgent, @durationMs, @details, GETUTCDATE())`,
      {
        schoolId: { type: sql.UniqueIdentifier, value: schoolId },
        userId: { type: sql.UniqueIdentifier, value: userId },
        userName: { type: sql.NVarChar, value: userName },
        userRole: { type: sql.NVarChar, value: userRole },
        actionType: { type: sql.NVarChar, value: actionType },
        method: { type: sql.NVarChar, value: method },
        endpoint: { type: sql.NVarChar, value: endpoint },
        statusCode: { type: sql.Int, value: statusCode },
        ipAddress: { type: sql.NVarChar, value: ipAddress },
        userAgent: { type: sql.NVarChar, value: userAgent },
        durationMs: { type: sql.Int, value: durationMs },
        details: { type: sql.NVarChar, value: details ? JSON.stringify(details) : null },
      }
    );
  } catch (err) {
    // DB insert fail ho to bhi app crash na ho, sirf log kar do
    logger.error('Audit log insert failed', { error: err.message });
  }
};

module.exports = { logAudit };
