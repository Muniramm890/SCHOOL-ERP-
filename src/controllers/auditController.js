// src/controllers/auditController.js
const sql = require('mssql');
const { success, badRequest } = require('../utils/response');
const { query } = require('../config/db');


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



// GET /api/audit/recent-activity
exports.getRecentActivity = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const result = await query(
      `SELECT TOP 8 action_type, user_name, details, created_at
       FROM audit_logs
       WHERE school_id=@sid
         AND action_type IN ('ATTENDANCE_MARKED','FEE_PAID','NOTICE_CREATED','TEST_CREATED','STUDENT_ADDED','HOMEWORK_ASSIGNED','EXAM_CREATED')
       ORDER BY created_at DESC`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    return success(res, result.recordset, 'Recent activity fetched');
  } catch (err) { next(err); }
};
