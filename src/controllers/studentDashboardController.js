//controllers/studentDashboardController.js
const { query, queryOne, sql } = require('../config/db');
const { success } = require('../utils/response');

exports.getDashboard = async (req, res, next) => {
  try {
    const { studentId, schoolId, sectionId } = req.student;
    const sid = { type: sql.UniqueIdentifier, value: schoolId };
    const stid = { type: sql.UniqueIdentifier, value: studentId };
    const secid = { type: sql.UniqueIdentifier, value: sectionId };

    const [attendance, fee, todayClasses, unreadNotifs] = await Promise.all([
      queryOne(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN status='P' THEN 1 ELSE 0 END) AS present
         FROM student_attendance
         WHERE school_id=@sid AND student_id=@stid AND deleted_at IS NULL
           AND attendance_date >= DATEADD(DAY, -30, GETUTCDATE())`,
        { sid, stid }
      ),
      queryOne(
        `SELECT ISNULL(total_fee_paise,0) AS total_fee_paise, ISNULL(paid_paise,0) AS paid_paise, ISNULL(pending_paise,0) AS pending_paise
         FROM student_fee_accounts WHERE school_id=@sid AND student_id=@stid AND deleted_at IS NULL`,
        { sid, stid }
      ),
      query(
        `SELECT ps.period_number, ps.label, LEFT(CONVERT(varchar, ps.start_time, 108),5) AS start_time,
                LEFT(CONVERT(varchar, ps.end_time, 108),5) AS end_time, s.name AS subject_name, u.full_name AS teacher_name
         FROM timetable_entries te
         JOIN period_slots ps ON ps.id = te.period_slot_id
         JOIN academic_years ay ON ay.id = te.academic_year_id AND ay.is_current=1
         LEFT JOIN subjects s ON s.id = te.subject_id
         LEFT JOIN users u ON u.id = te.teacher_id
         WHERE te.school_id=@sid AND te.section_id=@secid AND te.day_of_week=DATEPART(WEEKDAY, GETUTCDATE())
         ORDER BY ps.period_number`,
        { sid, secid }
      ),
      queryOne(`SELECT COUNT(*) AS cnt FROM student_notifications WHERE school_id=@sid AND student_id=@stid AND is_read=0`, { sid, stid }),
    ]);

    return success(res, {
      attendancePercent: attendance?.total > 0 ? Math.round((attendance.present / attendance.total) * 100) : null,
      fee,
      todayClasses: todayClasses.recordset,
      unreadNotifications: unreadNotifs?.cnt || 0,
    });
  } catch (err) { next(err); }
};

// GET /api/student/dashboard/notifications
exports.getNotifications = async (req, res, next) => {
  try {
    const { studentId, schoolId } = req.student;
    const rows = await query(
      `SELECT TOP 30 id, type, title, message, related_id, is_read, created_at
       FROM student_notifications WHERE school_id=@sid AND student_id=@stid ORDER BY created_at DESC`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId }, stid: { type: sql.UniqueIdentifier, value: studentId } }
    );
    return success(res, rows.recordset);
  } catch (err) { next(err); }
};

// PUT /api/student/dashboard/notifications/:id/read
exports.markNotificationRead = async (req, res, next) => {
  try {
    await query(`UPDATE student_notifications SET is_read=1 WHERE id=@id AND student_id=@stid`, {
      id: { type: sql.UniqueIdentifier, value: req.params.id },
      stid: { type: sql.UniqueIdentifier, value: req.student.studentId },
    });
    return success(res, null, 'Marked as read');
  } catch (err) { next(err); }
};
