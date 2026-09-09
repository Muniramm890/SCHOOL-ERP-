//controllers/studentActivityController.js
const { query, sql } = require('../config/db');
const { success } = require('../utils/response');

// GET /api/student/activity
exports.getMyActivity = async (req, res, next) => {
  try {
    const { studentId, schoolId } = req.student;
    const rows = await query(
      `SELECT TOP 30 id, action_type, details, created_at
       FROM audit_logs
       WHERE school_id=@sid AND student_id=@stid AND actor_type='student'
       ORDER BY created_at DESC`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId }, stid: { type: sql.UniqueIdentifier, value: studentId } }
    );
    return success(res, rows.recordset);
  } catch (err) { next(err); }
};
