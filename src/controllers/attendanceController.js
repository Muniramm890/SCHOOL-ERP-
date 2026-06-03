// src/controllers/attendanceController.js
const { query, queryOne, withTransaction, sql } = require('../config/db');
const { success, created, notFound, badRequest, paginated } = require('../utils/response');
const { audit } = require('../utils/audit');
const { v4: uuidv4 } = require('uuid');

// ── GET /api/attendance?section_id=&date= ─────────────────────────────────
// Returns attendance for a section on a date (for marking page)
exports.getBySection = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { section_id, date } = req.query;
    if (!section_id || !date) return badRequest(res, 'section_id and date required');

    const records = await query(
      `SELECT s.id AS student_id,
              s.first_name + ' ' + s.last_name AS full_name,
              s.photo_url, e.roll_no,
              sa.id AS attendance_id, sa.status, sa.note, sa.period_no,
              sa.marked_by, sa.marked_at, sa.is_edited
       FROM enrolments e
       JOIN students s ON s.id = e.student_id
       LEFT JOIN student_attendance sa
             ON sa.student_id = s.id
            AND sa.section_id = @sectionId
            AND CONVERT(DATE, sa.date) = @date
            AND sa.school_id = @sid
            AND sa.deleted_at IS NULL
       WHERE e.section_id = @sectionId
         AND e.school_id = @sid
         AND e.is_active = 1
         AND e.deleted_at IS NULL
       ORDER BY e.roll_no, s.first_name`,
      {
        sectionId: { type: sql.UniqueIdentifier, value: section_id },
        date:      { type: sql.Date, value: date },
        sid:       { type: sql.UniqueIdentifier, value: schoolId },
      }
    );

    return success(res, records.recordset);
  } catch (err) { next(err); }
};

// ── POST /api/attendance/bulk ──────────────────────────────────────────────
// Bulk upsert attendance for a full section day
// Body: { section_id, date, period_no?, records: [{student_id, enrolment_id, status, note}] }
exports.markBulk = async (req, res, next) => {
  try {
    const { schoolId, userId } = req.user;
    const { section_id, date, period_no = null, records } = req.body;
    if (!section_id || !date || !Array.isArray(records) || records.length === 0)
      return badRequest(res, 'section_id, date, and records[] required');

    await withTransaction(async (tx) => {
      for (const r of records) {
        // Check if record exists
        const req0 = tx.request();
        req0.input('sid', sql.UniqueIdentifier, schoolId);
        req0.input('studentId', sql.UniqueIdentifier, r.student_id);
        req0.input('sectionId', sql.UniqueIdentifier, section_id);
        req0.input('date', sql.Date, date);
        req0.input('periodNo', sql.SmallInt, period_no);
        const existing = await req0.query(
          `SELECT id FROM student_attendance
           WHERE school_id=@sid AND student_id=@studentId AND section_id=@sectionId
             AND CONVERT(DATE,date)=@date
             AND (period_no = @periodNo OR (@periodNo IS NULL AND period_no IS NULL))
             AND deleted_at IS NULL`
        );

        if (existing.recordset.length > 0) {
          // Update existing
          const req2 = tx.request();
          req2.input('status', sql.VarChar(50), r.status);
          req2.input('note', sql.NVarChar(sql.MAX), r.note || null);
          req2.input('editedBy', sql.UniqueIdentifier, userId);
          req2.input('id', sql.UniqueIdentifier, existing.recordset[0].id);
          await req2.query(
            `UPDATE student_attendance SET status=@status, note=@note,
               is_edited=1, edited_by=@editedBy, edited_at=GETUTCDATE()
             WHERE id=@id`
          );
        } else {
          // Insert new
          const req3 = tx.request();
          req3.input('id', sql.UniqueIdentifier, uuidv4());
          req3.input('sid', sql.UniqueIdentifier, schoolId);
          req3.input('enrolId', sql.UniqueIdentifier, r.enrolment_id);
          req3.input('studentId', sql.UniqueIdentifier, r.student_id);
          req3.input('sectionId', sql.UniqueIdentifier, section_id);
          req3.input('date', sql.Date, date);
          req3.input('periodNo', sql.SmallInt, period_no);
          req3.input('status', sql.VarChar(50), r.status || 'present');
          req3.input('note', sql.NVarChar(sql.MAX), r.note || null);
          req3.input('markedBy', sql.UniqueIdentifier, userId);
          await req3.query(
            `INSERT INTO student_attendance
               (id,school_id,enrolment_id,student_id,section_id,date,period_no,status,note,marked_by)
             VALUES(@id,@sid,@enrolId,@studentId,@sectionId,@date,@periodNo,@status,@note,@markedBy)`
          );
        }
      }
    });

    await audit({ req, action: 'BULK_MARK_ATTENDANCE', tableName: 'student_attendance',
      newValues: { section_id, date, count: records.length } });
    return success(res, null, `Attendance saved for ${records.length} students`);
  } catch (err) { next(err); }
};

// ── GET /api/attendance/student/:studentId ────────────────────────────────
// Individual student attendance — monthly summary
exports.getStudentAttendance = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { studentId } = req.params;
    const { from, to } = req.query; // YYYY-MM-DD

    const records = await query(
      `SELECT CONVERT(DATE, date) AS att_date, status, note, period_no
       FROM student_attendance
       WHERE school_id = @sid AND student_id = @studentId
         AND deleted_at IS NULL
         ${from ? 'AND CONVERT(DATE,date) >= @from' : ''}
         ${to   ? 'AND CONVERT(DATE,date) <= @to'   : ''}
       ORDER BY att_date`,
      {
        sid:       { type: sql.UniqueIdentifier, value: schoolId },
        studentId: { type: sql.UniqueIdentifier, value: studentId },
        ...(from ? { from: { type: sql.Date, value: from } } : {}),
        ...(to   ? { to:   { type: sql.Date, value: to   } } : {}),
      }
    );

    const all = records.recordset;
    const present = all.filter(r => r.status === 'present').length;
    const absent  = all.filter(r => r.status === 'absent').length;
    const total   = all.length;
    const pct     = total > 0 ? Math.round((present / total) * 100) : 0;

    return success(res, {
      summary: { total, present, absent, percentage: pct },
      records: all,
    });
  } catch (err) { next(err); }
};

// ── GET /api/attendance/analysis?section_id= ─────────────────────────────
// Section-level analysis (all students, monthly stats)
exports.getSectionAnalysis = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { section_id, month, year } = req.query;
    if (!section_id) return badRequest(res, 'section_id required');

    const analysis = await query(
      `SELECT s.id AS student_id,
              s.first_name + ' ' + s.last_name AS full_name,
              s.photo_url, e.roll_no,
              COUNT(sa.id) AS total_days,
              SUM(CASE WHEN sa.status = 'present' THEN 1 ELSE 0 END) AS present_days,
              SUM(CASE WHEN sa.status = 'absent'  THEN 1 ELSE 0 END) AS absent_days,
              CAST(
                CAST(SUM(CASE WHEN sa.status='present' THEN 1.0 ELSE 0 END) AS FLOAT)
                / NULLIF(COUNT(sa.id), 0) * 100
              AS DECIMAL(5,1)) AS attendance_pct
       FROM enrolments e
       JOIN students s ON s.id = e.student_id
       LEFT JOIN student_attendance sa
             ON sa.student_id = s.id
            AND sa.section_id = @sectionId
            AND sa.school_id  = @sid
            AND sa.deleted_at IS NULL
            ${month && year ? 'AND MONTH(sa.date)=@month AND YEAR(sa.date)=@year' : ''}
       WHERE e.section_id = @sectionId AND e.school_id = @sid AND e.is_active = 1
       GROUP BY s.id, s.first_name, s.last_name, s.photo_url, e.roll_no
       ORDER BY attendance_pct ASC`,
      {
        sectionId: { type: sql.UniqueIdentifier, value: section_id },
        sid:       { type: sql.UniqueIdentifier, value: schoolId },
        ...(month ? { month: { type: sql.Int, value: +month } } : {}),
        ...(year  ? { year:  { type: sql.Int, value: +year  } } : {}),
      }
    );

    return success(res, analysis.recordset);
  } catch (err) { next(err); }
};

// ── GET /api/attendance/class-summary ─────────────────────────────────────
// Per-class average attendance — for dashboard chart
exports.getClassSummary = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const summary = await query(
      `SELECT g.name AS class_name, g.numeric_order,
              CAST(
                CAST(SUM(CASE WHEN sa.status='present' THEN 1.0 ELSE 0 END) AS FLOAT)
                / NULLIF(COUNT(sa.id), 0) * 100
              AS DECIMAL(5,1)) AS avg_pct
       FROM grades g
       JOIN sections sc ON sc.grade_id = g.id AND sc.school_id = @sid
       JOIN student_attendance sa ON sa.section_id = sc.id AND sa.school_id = @sid
       WHERE g.school_id = @sid AND sa.deleted_at IS NULL
       GROUP BY g.name, g.numeric_order
       ORDER BY g.numeric_order`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    return success(res, summary.recordset);
  } catch (err) { next(err); }
};

// ── Staff Attendance ──────────────────────────────────────────────────────

// POST /api/attendance/staff/mark
exports.markStaff = async (req, res, next) => {
  try {
    const { schoolId, userId } = req.user;
    const { staff_id, date, status, check_in_time, check_out_time, note } = req.body;

    const existing = await queryOne(
      `SELECT id FROM staff_attendance WHERE school_id=@sid AND staff_id=@staffId AND CONVERT(DATE,date)=@date`,
      {
        sid:     { type: sql.UniqueIdentifier, value: schoolId },
        staffId: { type: sql.UniqueIdentifier, value: staff_id },
        date:    { type: sql.Date, value: date },
      }
    );

    if (existing) {
      await query(
        `UPDATE staff_attendance SET status=@status, check_in_time=@cin, check_out_time=@cout,
           note=@note, marked_by=@markedBy, updated_at=GETUTCDATE()
         WHERE id=@id`,
        {
          id:       { type: sql.UniqueIdentifier, value: existing.id },
          status:   { type: sql.VarChar(50), value: status },
          cin:      { type: sql.Time, value: check_in_time || null },
          cout:     { type: sql.Time, value: check_out_time || null },
          note:     { type: sql.NVarChar(sql.MAX), value: note || null },
          markedBy: { type: sql.UniqueIdentifier, value: userId },
        }
      );
    } else {
      await query(
        `INSERT INTO staff_attendance (id,school_id,staff_id,date,status,check_in_time,check_out_time,marked_by,note)
         VALUES(NEWID(),@sid,@staffId,@date,@status,@cin,@cout,@markedBy,@note)`,
        {
          sid:     { type: sql.UniqueIdentifier, value: schoolId },
          staffId: { type: sql.UniqueIdentifier, value: staff_id },
          date:    { type: sql.Date, value: date },
          status:  { type: sql.VarChar(50), value: status },
          cin:     { type: sql.Time, value: check_in_time || null },
          cout:    { type: sql.Time, value: check_out_time || null },
          markedBy:{ type: sql.UniqueIdentifier, value: userId },
          note:    { type: sql.NVarChar(sql.MAX), value: note || null },
        }
      );
    }
    return success(res, null, 'Staff attendance saved');
  } catch (err) { next(err); }
};
