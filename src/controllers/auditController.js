// src/controllers/auditController.js
const sql = require('mssql');
const { success, badRequest } = require('../utils/response');
const { query, queryOne } = require('../config/db');
const { logAudit } = require('../utils/auditLogger');

// Actions that represent routine page/API traffic, not meaningful security events.
// Hidden from the main audit view by default (toggleable) to cut through noise.
const NOISE_ACTIONS = ['API_CALL'];

// ── GET /api/audit ───────────────────────────────────────────────────────
// Paginated, filtered audit trail for the Super Admin's "Audit Logs" screen.
exports.getAuditLogs = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const {
      search, actionType, userRole, from, to,
      includeApiCalls, page = 1, limit = 50,
    } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let where = `school_id=@sid`;
    const params = { sid: { type: sql.UniqueIdentifier, value: schoolId } };

    if (search) {
      where += ` AND (user_name LIKE @search OR endpoint LIKE @search)`;
      params.search = { type: sql.NVarChar(300), value: `%${search.trim()}%` };
    }
    if (actionType) {
      where += ` AND action_type = @actionType`;
      params.actionType = { type: sql.NVarChar(50), value: actionType };
    } else if (!(includeApiCalls === '1' || includeApiCalls === 'true')) {
      where += ` AND action_type NOT IN (${NOISE_ACTIONS.map((a) => `'${a}'`).join(',')})`;
    }
    if (userRole) {
      where += ` AND user_role = @userRole`;
      params.userRole = { type: sql.NVarChar(50), value: userRole };
    }
    if (from) {
      where += ` AND created_at >= @from`;
      params.from = { type: sql.DateTime2, value: from };
    }
    if (to) {
      where += ` AND created_at <= @to`;
      params.to = { type: sql.DateTime2, value: to };
    }

    const result = await query(
      `SELECT COUNT(*) OVER() AS total_count, id, user_id, user_name, user_role, action_type,
              method, endpoint, status_code, ip_address, duration_ms, details, created_at
       FROM audit_logs
       WHERE ${where}
       ORDER BY created_at DESC
       OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
      { ...params, offset: { type: sql.Int, value: offset }, limit: { type: sql.Int, value: Number(limit) } }
    );

    const rows = result.recordset || [];
    const total = rows[0]?.total_count || 0;

    const data = rows.map((r) => {
      let details = null;
      try { details = r.details ? JSON.parse(r.details) : null; } catch { details = r.details; }
      const { total_count, ...rest } = r;
      return { ...rest, details };
    });

    return res.json({
      success: true,
      message: 'Audit logs fetched',
      data,
      pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / limit) || 1 },
    });
  } catch (err) { next(err); }
};

// ── GET /api/audit/stats ─────────────────────────────────────────────────
exports.getStats = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const sidParam = { sid: { type: sql.UniqueIdentifier, value: schoolId } };

    const overview = await queryOne(
      `SELECT
         COUNT(*) AS total_logs,
         SUM(CASE WHEN CAST(created_at AS DATE) = CAST(GETUTCDATE() AS DATE) THEN 1 ELSE 0 END) AS today_count,
         SUM(CASE WHEN action_type = 'LOGIN_FAILED' AND created_at >= DATEADD(day,-7,GETUTCDATE()) THEN 1 ELSE 0 END) AS failed_logins_7d,
         SUM(CASE WHEN created_at < DATEADD(month,-6,GETUTCDATE()) THEN 1 ELSE 0 END) AS old_logs_count,
         MIN(created_at) AS oldest_log
       FROM audit_logs WHERE school_id=@sid`,
      sidParam
    );

    const breakdown = await query(
      `SELECT TOP 8 action_type, COUNT(*) AS cnt
       FROM audit_logs
       WHERE school_id=@sid AND action_type NOT IN (${NOISE_ACTIONS.map((a) => `'${a}'`).join(',')})
         AND created_at >= DATEADD(day,-30,GETUTCDATE())
       GROUP BY action_type
       ORDER BY cnt DESC`,
      sidParam
    );

    return success(res, {
      totalLogs: overview?.total_logs || 0,
      todayCount: overview?.today_count || 0,
      failedLogins7d: overview?.failed_logins_7d || 0,
      oldLogsCount: overview?.old_logs_count || 0,
      oldestLog: overview?.oldest_log || null,
      breakdown: breakdown.recordset || [],
    }, 'Audit stats fetched');
  } catch (err) { next(err); }
};

// ── DELETE /api/audit/cleanup ────────────────────────────────────────────
// Deletes logs older than N months (default 6) for this school — space management.
exports.cleanupOldLogs = async (req, res, next) => {
  try {
    const { schoolId, userId, fullName, role } = req.user;
    const months = Math.max(1, Number(req.body?.months) || 6);

    const before = await queryOne(
      `SELECT COUNT(*) AS cnt FROM audit_logs WHERE school_id=@sid AND created_at < DATEADD(month,-@m,GETUTCDATE())`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId }, m: { type: sql.Int, value: months } }
    );
    const toDelete = before?.cnt || 0;
    if (toDelete === 0) return success(res, { deleted: 0 }, 'No logs old enough to delete');

    await query(
      `DELETE FROM audit_logs WHERE school_id=@sid AND created_at < DATEADD(month,-@m,GETUTCDATE())`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId }, m: { type: sql.Int, value: months } }
    );

    await logAudit({
      schoolId, userId, userName: fullName, userRole: role,
      actionType: 'AUDIT_CLEANUP',
      details: { deletedCount: toDelete, olderThanMonths: months },
    });

    return success(res, { deleted: toDelete }, `${toDelete} old log(s) deleted successfully`);
  } catch (err) { next(err); }
};

// ── GET /api/audit/recent-activity ───────────────────────────────────────
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
    const formattedActivity = result.recordset.map((row) => {
      let parsedDetails = {};
      try { parsedDetails = row.details ? JSON.parse(row.details) : {}; } catch (e) { parsedDetails = row.details; }
      let displayMessage = `${row.user_name || 'Someone'} performed an action.`;
      if (row.action_type === 'ATTENDANCE_MARKED') {
        const className = parsedDetails.section_name ? `for ${parsedDetails.section_name}` : '';
        displayMessage = `${row.user_name} marked attendance ${className} (${parsedDetails.count || 0} students) on ${parsedDetails.date || ''}.`;
      } else if (row.action_type === 'STAFF_ATTENDANCE_MARKED') {
        displayMessage = `${row.user_name} marked staff attendance on ${parsedDetails.date || ''}.`;
      }
      return { ...row, details: parsedDetails, displayMessage };
    });
    return success(res, formattedActivity, 'Recent activity fetched');
  } catch (err) { next(err); }
};
