// src/controllers/auditController.js
const sql = require('mssql');
const { query } = require('../utils/db');
const { success, badRequest } = require('../utils/response');

exports.getAuditLogs = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { userId, actionType, from, to, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    const result = await query(
      `SELECT * FROM audit_logs
       WHERE school_id=@sid
         AND (@userId IS NULL OR user_id=@userId)
         AND (@actionType IS NULL OR action_type=@actionType)
         AND (@from IS NULL OR created_at >= @from)
         AND (@to IS NULL OR created_at <= @to)
       ORDER BY created_at DESC
       OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
      {
        sid: { type: sql.UniqueIdentifier, value: schoolId },
        userId: { type: sql.UniqueIdentifier, value: userId || null },
        actionType: { type: sql.NVarChar, value: actionType || null },
        from: { type: sql.DateTime2, value: from || null },
        to: { type: sql.DateTime2, value: to || null },
        offset: { type: sql.Int, value: offset },
        limit: { type: sql.Int, value: Number(limit) },
      }
    );
    return success(res, result.recordset, 'Audit logs fetched');
  } catch (err) { next(err); }
};
