
// src/controllers/attendanceController.js
const { query, queryOne, withTransaction, sql } = require('../config/db');
const { success, badRequest, notFound } = require('../utils/response');
const { logAudit } = require('../utils/auditLogger');
const { v4: uuidv4 } = require('uuid');

const VALID_STATUSES = ['P', 'A', 'L', 'OD'];
const todayStr = () => new Date().toISOString().split('T')[0];
const daysAgoStr = (n) => new Date(Date.now() - n * 86400000).toISOString().split('T')[0];

// ═══════════════════════════════════════════════════════════════
// STUDENT ATTENDANCE
// ═══════════════════════════════════════════════════════════════

// GET /api/attendance/students/roster?section_id=&date=
// Returns every actively-enrolled student in a section with today's
// (or given date's) status. Not-yet-marked students default to 'P'
// (virtual default — nothing is written to DB until you hit Save).
exports.getSectionRoster = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { section_id, date } = req.query;
    if (!section_id || !date) return badRequest(res, 'section_id and date are required');

    const result = await query(
      `SELECT 
          st.id AS student_id, st.first_name, st.middle_name, st.last_name, st.photo_url, st.gender,
          e.roll_no,
          ISNULL(sa.status, 'P') AS status,
          sa.remarks
       FROM enrolments e
       JOIN students st ON st.id = e.student_id AND st.school_id = @sid AND st.deleted_at IS NULL AND st.is_active = 1
       LEFT JOIN student_attendance sa 
              ON sa.student_id = st.id AND sa.school_id = @sid 
             AND sa.attendance_date = @date AND sa.deleted_at IS NULL
       WHERE e.school_id = @sid AND e.section_id = @secId AND e.is_active = 1 AND e.deleted_at IS NULL
       ORDER BY ISNULL(TRY_CAST(e.roll_no AS INT), 999999), st.first_name`,
      {
        sid: { type: sql.UniqueIdentifier, value: schoolId },
        secId: { type: sql.UniqueIdentifier, value: section_id },
        date: { type: sql.Date, value: date },
      }
    );

    const rows = result.recordset;
    const counts = { P: 0, A: 0, L: 0, OD: 0 };
    rows.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });

    return success(res, { students: rows, counts, total: rows.length }, 'Roster fetched');
  } catch (err) { next(err); }
};

// POST /api/attendance/students/mark
// POST /api/attendance/students/mark
// Body: { section_id, section_name, date, entries: [{ student_id, status, remarks }] }
exports.markStudentAttendance = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const markedBy = req.user.userId || req.user.id || null;
    
    // NEW: Added section_name from frontend request body
    const { section_id, section_name, date, entries } = req.body;

    if (!section_id || !date || !Array.isArray(entries) || entries.length === 0) {
      return badRequest(res, 'section_id, date and a non-empty entries[] are required');
    }

    await withTransaction(async (tx) => {
      for (const e of entries) {
        if (!e.student_id) continue;
        const status = VALID_STATUSES.includes(e.status) ? e.status : 'P';

        const rCheck = tx.request();
        rCheck.input('sid', sql.UniqueIdentifier, schoolId);
        rCheck.input('stid', sql.UniqueIdentifier, e.student_id);
        rCheck.input('date', sql.Date, date);
        const existing = await rCheck.query(
          `SELECT id FROM student_attendance WHERE school_id=@sid AND student_id=@stid AND attendance_date=@date AND deleted_at IS NULL`
        );

        if (existing.recordset.length > 0) {
          const rUpd = tx.request();
          rUpd.input('id', sql.UniqueIdentifier, existing.recordset[0].id);
          rUpd.input('status', sql.VarChar(2), status);
          rUpd.input('remarks', sql.NVarChar(255), e.remarks || null);
          rUpd.input('mb', sql.UniqueIdentifier, markedBy);
          await rUpd.query(
            `UPDATE student_attendance SET status=@status, remarks=@remarks, marked_by=@mb, updated_at=GETUTCDATE() WHERE id=@id`
          );
        } else {
          const rIns = tx.request();
          rIns.input('sid', sql.UniqueIdentifier, schoolId);
          rIns.input('stid', sql.UniqueIdentifier, e.student_id);
          rIns.input('secid', sql.UniqueIdentifier, section_id);
          rIns.input('date', sql.Date, date);
          rIns.input('status', sql.VarChar(2), status);
          rIns.input('remarks', sql.NVarChar(255), e.remarks || null);
          rIns.input('mb', sql.UniqueIdentifier, markedBy);
          await rIns.query(
            `INSERT INTO student_attendance (id, school_id, student_id, section_id, attendance_date, status, remarks, marked_by)
             VALUES (NEWID(), @sid, @stid, @secid, @date, @status, @remarks, @mb)`
          );
        }
      }
    });

    // 🔴 Audit log — student attendance marked
    await logAudit({
      schoolId,
      userId: markedBy,
      userName: req.user.fullName || null,
      userRole: req.user.role || null,
      actionType: 'ATTENDANCE_MARKED',
      details: { 
        type: 'student', 
        section_id, 
        section_name: section_name || 'Unknown Class', // UI ke liye human-readable naam
        date, 
        count: entries.length 
      },
    });

    return success(res, null, 'Attendance saved successfully');
  } catch (err) { 
    next(err); 
  }
};

// GET /api/attendance/students/analysis?section_id=&from=&to=
// Per-student stats + daily % trend for one section (Class Analysis tab)
exports.getClassAnalysis = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { section_id, from, to } = req.query;
    if (!section_id) return badRequest(res, 'section_id is required');

    const rangeFrom = from || daysAgoStr(29);
    const rangeTo = to || todayStr();
    const p = {
      sid: { type: sql.UniqueIdentifier, value: schoolId },
      secId: { type: sql.UniqueIdentifier, value: section_id },
      from: { type: sql.Date, value: rangeFrom },
      to: { type: sql.Date, value: rangeTo },
    };

    const perStudent = await query(
      `SELECT st.id AS student_id, st.first_name, st.middle_name, st.last_name, e.roll_no,
              COUNT(sa.id) AS marked_days,
              SUM(CASE WHEN sa.status='P' THEN 1 ELSE 0 END) AS present_days,
              SUM(CASE WHEN sa.status='A' THEN 1 ELSE 0 END) AS absent_days,
              SUM(CASE WHEN sa.status='L' THEN 1 ELSE 0 END) AS leave_days,
              SUM(CASE WHEN sa.status='OD' THEN 1 ELSE 0 END) AS od_days
       FROM enrolments e
       JOIN students st ON st.id = e.student_id AND st.deleted_at IS NULL
       LEFT JOIN student_attendance sa 
              ON sa.student_id = st.id AND sa.school_id=@sid 
             AND sa.attendance_date BETWEEN @from AND @to AND sa.deleted_at IS NULL
       WHERE e.school_id=@sid AND e.section_id=@secId AND e.is_active=1 AND e.deleted_at IS NULL
       GROUP BY st.id, st.first_name, st.middle_name, st.last_name, e.roll_no
       ORDER BY ISNULL(TRY_CAST(e.roll_no AS INT), 999999)`,
      p
    );

    const trend = await query(
      `SELECT attendance_date,
              SUM(CASE WHEN status='P' THEN 1 ELSE 0 END) AS present,
              COUNT(*) AS total
       FROM student_attendance
       WHERE school_id=@sid AND section_id=@secId AND attendance_date BETWEEN @from AND @to AND deleted_at IS NULL
       GROUP BY attendance_date ORDER BY attendance_date`,
      p
    );

    return success(res, {
      students: perStudent.recordset.map((r) => ({
        ...r,
        percentage: r.marked_days > 0 ? Math.round((r.present_days / r.marked_days) * 100) : 0,
      })),
      trend: trend.recordset.map((r) => ({
        date: r.attendance_date,
        percentage: r.total > 0 ? Math.round((r.present / r.total) * 100) : 0,
      })),
    }, 'Class analysis fetched');
  } catch (err) { next(err); }
};

// GET /api/attendance/students/school-overview?date=&from=&to=
// School-wide KPI (today) + grade-wise average + overall trend (School Overview tab)
exports.getSchoolOverview = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { date, from, to } = req.query;
    const day = date || todayStr();
    const rangeFrom = from || daysAgoStr(6);
    const rangeTo = to || day;

    const sidParam = { type: sql.UniqueIdentifier, value: schoolId };

    const todayCounts = await queryOne(
      `SELECT 
          SUM(CASE WHEN status='P' THEN 1 ELSE 0 END) AS present,
          SUM(CASE WHEN status='A' THEN 1 ELSE 0 END) AS absent,
          SUM(CASE WHEN status='L' THEN 1 ELSE 0 END) AS leave,
          SUM(CASE WHEN status='OD' THEN 1 ELSE 0 END) AS od,
          COUNT(*) AS total
       FROM student_attendance
       WHERE school_id=@sid AND attendance_date=@date AND deleted_at IS NULL`,
      { sid: sidParam, date: { type: sql.Date, value: day } }
    );

    const gradeWise = await query(
      `SELECT g.name AS grade_name, g.numeric_order,
              SUM(CASE WHEN sa.status='P' THEN 1 ELSE 0 END) AS present,
              COUNT(sa.id) AS total
       FROM student_attendance sa
       JOIN sections s ON s.id = sa.section_id
       JOIN grades g ON g.id = s.grade_id
       WHERE sa.school_id=@sid AND sa.attendance_date BETWEEN @from AND @to AND sa.deleted_at IS NULL
       GROUP BY g.name, g.numeric_order
       ORDER BY g.numeric_order`,
      { sid: sidParam, from: { type: sql.Date, value: rangeFrom }, to: { type: sql.Date, value: rangeTo } }
    );

    const trend = await query(
      `SELECT attendance_date,
              SUM(CASE WHEN status='P' THEN 1 ELSE 0 END) AS present,
              COUNT(*) AS total
       FROM student_attendance
       WHERE school_id=@sid AND attendance_date BETWEEN @from AND @to AND deleted_at IS NULL
       GROUP BY attendance_date ORDER BY attendance_date`,
      { sid: sidParam, from: { type: sql.Date, value: rangeFrom }, to: { type: sql.Date, value: rangeTo } }
    );

    return success(res, {
      today: todayCounts || { present: 0, absent: 0, leave: 0, od: 0, total: 0 },
      gradeWise: gradeWise.recordset.map((r) => ({
        ...r, percentage: r.total > 0 ? Math.round((r.present / r.total) * 100) : 0,
      })),
      trend: trend.recordset.map((r) => ({
        date: r.attendance_date, percentage: r.total > 0 ? Math.round((r.present / r.total) * 100) : 0,
      })),
    }, 'School overview fetched');
  } catch (err) { next(err); }
};

// GET /api/attendance/students/:studentId/history?from=&to=
exports.getStudentHistory = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { studentId } = req.params;
    const { from, to } = req.query;
    const rangeFrom = from || daysAgoStr(29);
    const rangeTo = to || todayStr();

    const rows = await query(
      `SELECT attendance_date, status, remarks
       FROM student_attendance
       WHERE school_id=@sid AND student_id=@stid AND attendance_date BETWEEN @from AND @to AND deleted_at IS NULL
       ORDER BY attendance_date`,
      {
        sid: { type: sql.UniqueIdentifier, value: schoolId },
        stid: { type: sql.UniqueIdentifier, value: studentId },
        from: { type: sql.Date, value: rangeFrom },
        to: { type: sql.Date, value: rangeTo },
      }
    );

    const counts = { P: 0, A: 0, L: 0, OD: 0 };
    rows.recordset.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
    const totalMarked = rows.recordset.length;
    const percentage = totalMarked > 0 ? Math.round((counts.P / totalMarked) * 100) : 0;

    return success(res, { records: rows.recordset, counts, totalMarked, percentage }, 'Student attendance history fetched');
  } catch (err) { next(err); }
};

// ═══════════════════════════════════════════════════════════════
// STAFF / TEACHER ATTENDANCE
// ═══════════════════════════════════════════════════════════════

// GET /api/attendance/staff/roster?date=
exports.getStaffRoster = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { date } = req.query;
    if (!date) return badRequest(res, 'date is required');

    const result = await query(
      `SELECT u.id AS user_id, u.full_name, u.avatar_url, u.gender,
              sp.department, sp.designation,
              ISNULL(sf.status, 'P') AS status,
              sf.remarks
       FROM school_members sm
       JOIN users u ON u.id = sm.user_id
       LEFT JOIN staff_profiles sp ON sp.user_id = sm.user_id AND sp.school_id = sm.school_id
       LEFT JOIN staff_attendance sf 
              ON sf.user_id = u.id AND sf.school_id = @sid 
             AND sf.attendance_date = @date AND sf.deleted_at IS NULL
       WHERE sm.school_id = @sid AND sm.role = 'teacher' AND sm.is_active = 1 AND sm.deleted_at IS NULL
       ORDER BY u.full_name`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId }, date: { type: sql.Date, value: date } }
    );

    const rows = result.recordset;
    const counts = { P: 0, A: 0, L: 0, OD: 0 };
    rows.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });

    return success(res, { teachers: rows, counts, total: rows.length }, 'Staff roster fetched');
  } catch (err) { next(err); }
};

// POST /api/attendance/staff/mark
// Body: { date, entries: [{ user_id, status, remarks }] }
exports.markStaffAttendance = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const markedBy = req.user.userId || req.user.id || null;
    const { date, entries } = req.body;

    if (!date || !Array.isArray(entries) || entries.length === 0) {
      return badRequest(res, 'date and a non-empty entries[] are required');
    }

    await withTransaction(async (tx) => {
      for (const e of entries) {
        if (!e.user_id) continue;
        const status = VALID_STATUSES.includes(e.status) ? e.status : 'P';

        const rCheck = tx.request();
        rCheck.input('sid', sql.UniqueIdentifier, schoolId);
        rCheck.input('uid', sql.UniqueIdentifier, e.user_id);
        rCheck.input('date', sql.Date, date);
        const existing = await rCheck.query(
          `SELECT id FROM staff_attendance WHERE school_id=@sid AND user_id=@uid AND attendance_date=@date AND deleted_at IS NULL`
        );

        if (existing.recordset.length > 0) {
          const rUpd = tx.request();
          rUpd.input('id', sql.UniqueIdentifier, existing.recordset[0].id);
          rUpd.input('status', sql.VarChar(2), status);
          rUpd.input('remarks', sql.NVarChar(255), e.remarks || null);
          rUpd.input('mb', sql.UniqueIdentifier, markedBy);
          await rUpd.query(
            `UPDATE staff_attendance SET status=@status, remarks=@remarks, marked_by=@mb, updated_at=GETUTCDATE() WHERE id=@id`
          );
        } else {
          const rIns = tx.request();
          rIns.input('sid', sql.UniqueIdentifier, schoolId);
          rIns.input('uid', sql.UniqueIdentifier, e.user_id);
          rIns.input('date', sql.Date, date);
          rIns.input('status', sql.VarChar(2), status);
          rIns.input('remarks', sql.NVarChar(255), e.remarks || null);
          rIns.input('mb', sql.UniqueIdentifier, markedBy);
          await rIns.query(
            `INSERT INTO staff_attendance (id, school_id, user_id, attendance_date, status, remarks, marked_by)
             VALUES (NEWID(), @sid, @uid, @date, @status, @remarks, @mb)`
          );
        }
      }
    });
    // 🔴 Audit log — staff attendance marked
   await logAudit({
     schoolId,
     userId: markedBy,
     userName: req.user.fullName || null,
     userRole: req.user.role || null,
     actionType: 'STAFF_ATTENDANCE_MARKED',
     details: { date, count: entries.length },
   });

    return success(res, null, 'Staff attendance saved successfully');
  } catch (err) { next(err); }
};

// GET /api/attendance/staff/analysis?from=&to=
exports.getStaffAnalysis = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { from, to } = req.query;
    const rangeFrom = from || daysAgoStr(29);
    const rangeTo = to || todayStr();
    const p = {
      sid: { type: sql.UniqueIdentifier, value: schoolId },
      from: { type: sql.Date, value: rangeFrom },
      to: { type: sql.Date, value: rangeTo },
    };

    const perTeacher = await query(
      `SELECT u.id AS user_id, u.full_name, sp.department,
              COUNT(sf.id) AS marked_days,
              SUM(CASE WHEN sf.status='P' THEN 1 ELSE 0 END) AS present_days,
              SUM(CASE WHEN sf.status='A' THEN 1 ELSE 0 END) AS absent_days,
              SUM(CASE WHEN sf.status='L' THEN 1 ELSE 0 END) AS leave_days,
              SUM(CASE WHEN sf.status='OD' THEN 1 ELSE 0 END) AS od_days
       FROM school_members sm
       JOIN users u ON u.id = sm.user_id
       LEFT JOIN staff_profiles sp ON sp.user_id = sm.user_id AND sp.school_id = sm.school_id
       LEFT JOIN staff_attendance sf 
              ON sf.user_id = u.id AND sf.school_id = @sid 
             AND sf.attendance_date BETWEEN @from AND @to AND sf.deleted_at IS NULL
       WHERE sm.school_id = @sid AND sm.role = 'teacher' AND sm.is_active = 1 AND sm.deleted_at IS NULL
       GROUP BY u.id, u.full_name, sp.department
       ORDER BY u.full_name`,
      p
    );

    const trend = await query(
      `SELECT attendance_date,
              SUM(CASE WHEN status='P' THEN 1 ELSE 0 END) AS present,
              COUNT(*) AS total
       FROM staff_attendance
       WHERE school_id=@sid AND attendance_date BETWEEN @from AND @to AND deleted_at IS NULL
       GROUP BY attendance_date ORDER BY attendance_date`,
      p
    );

    return success(res, {
      teachers: perTeacher.recordset.map((r) => ({
        ...r, percentage: r.marked_days > 0 ? Math.round((r.present_days / r.marked_days) * 100) : 0,
      })),
      trend: trend.recordset.map((r) => ({
        date: r.attendance_date, percentage: r.total > 0 ? Math.round((r.present / r.total) * 100) : 0,
      })),
    }, 'Staff analysis fetched');
  } catch (err) { next(err); }
};

// GET /api/attendance/staff/:userId/history?from=&to=
exports.getStaffHistory = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { userId } = req.params;
    const { from, to } = req.query;
    const rangeFrom = from || daysAgoStr(29);
    const rangeTo = to || todayStr();

    const rows = await query(
      `SELECT attendance_date, status, remarks
       FROM staff_attendance
       WHERE school_id=@sid AND user_id=@uid AND attendance_date BETWEEN @from AND @to AND deleted_at IS NULL
       ORDER BY attendance_date`,
      {
        sid: { type: sql.UniqueIdentifier, value: schoolId },
        uid: { type: sql.UniqueIdentifier, value: userId },
        from: { type: sql.Date, value: rangeFrom },
        to: { type: sql.Date, value: rangeTo },
      }
    );
    const counts = { P: 0, A: 0, L: 0, OD: 0 };
    rows.recordset.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
    const totalMarked = rows.recordset.length;
    const percentage = totalMarked > 0 ? Math.round((counts.P / totalMarked) * 100) : 0;

    return success(res, { records: rows.recordset, counts, totalMarked, percentage }, 'Staff attendance history fetched');
  } catch (err) { next(err); }
};
