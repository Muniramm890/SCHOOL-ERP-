// src/controllers/arrangementController.js
const { query, queryOne, sql } = require('../config/db');
const { success, created, notFound, badRequest } = require('../utils/response');
const { v4: uuidv4 } = require('uuid');

async function assertStaffBelongsToSchool(schoolId, staffId) {
  const row = await queryOne(
    `SELECT id FROM school_members WHERE school_id=@sid AND user_id=@uid AND is_active=1 AND deleted_at IS NULL`,
    { sid: { type: sql.UniqueIdentifier, value: schoolId }, uid: { type: sql.UniqueIdentifier, value: staffId } }
  );
  return !!row;
}

// ══════════════════════════════════════════════════
// DRAFT — raw ingredients for a date; all gap/match logic happens on frontend
// ══════════════════════════════════════════════════
exports.getDraft = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { date } = req.query; // 'YYYY-MM-DD'
    if (!date) return badRequest(res, 'date is required (YYYY-MM-DD)');

    // ⚠️ Confirm convention matches your timetable module: 0=Sunday...6=Saturday
    const dayOfWeek = new Date(date + 'T00:00:00').getDay();

    const [periodSlots, teachers, attendance, timetable, subjectTeachers, existingSubs] = await Promise.all([
      query(`SELECT id, period_number, label, start_time, end_time, is_break
             FROM period_slots WHERE school_id=@sid AND is_active=1 AND is_break=0 ORDER BY period_number`,
        { sid: { type: sql.UniqueIdentifier, value: schoolId } }),

      query(`SELECT sm.user_id AS teacher_id, u.full_name, u.avatar_url, sp.designation, sp.department
             FROM school_members sm
             JOIN users u ON u.id = sm.user_id
             LEFT JOIN staff_profiles sp ON sp.user_id = sm.user_id AND sp.school_id = sm.school_id
             WHERE sm.school_id=@sid AND sm.role='teacher' AND sm.is_active=1 AND sm.deleted_at IS NULL`,
        { sid: { type: sql.UniqueIdentifier, value: schoolId } }),

      query(`SELECT user_id AS teacher_id, status FROM staff_attendance
             WHERE school_id=@sid AND attendance_date=@date AND deleted_at IS NULL`,
        { sid: { type: sql.UniqueIdentifier, value: schoolId }, date: { type: sql.Date, value: date } }),

      query(`SELECT te.id, te.period_slot_id, te.section_id, te.subject_id, te.teacher_id, te.room_no,
                    sec.name AS section_name, g.name AS class_name, sub.name AS subject_name
             FROM timetable_entries te
             JOIN sections sec ON sec.id = te.section_id
             JOIN grades g ON g.id = sec.grade_id
             LEFT JOIN subjects sub ON sub.id = te.subject_id
             WHERE te.school_id=@sid AND te.day_of_week=@dow`,
        { sid: { type: sql.UniqueIdentifier, value: schoolId }, dow: { type: sql.TinyInt, value: dayOfWeek } }),

      query(`SELECT subject_id, teacher_user_id AS teacher_id FROM subject_teachers
             WHERE school_id=@sid AND is_active=1 AND deleted_at IS NULL`,
        { sid: { type: sql.UniqueIdentifier, value: schoolId } }),

      query(`SELECT id, period_slot_id, section_id, subject_id, original_teacher_id, substitute_teacher_id, notified_at
             FROM substitution_logs WHERE school_id=@sid AND substitution_date=@date AND deleted_at IS NULL`,
        { sid: { type: sql.UniqueIdentifier, value: schoolId }, date: { type: sql.Date, value: date } }),
    ]);

    return success(res, {
      date, day_of_week: dayOfWeek,
      period_slots: periodSlots.recordset,
      teachers: teachers.recordset,
      attendance: attendance.recordset,
      timetable: timetable.recordset,
      subject_teachers: subjectTeachers.recordset,
      existing_substitutions: existingSubs.recordset,
    });
  } catch (err) { next(err); }
};

// ══════════════════════════════════════════════════
// CONFIRM — persist admin's final selections for the day
// ══════════════════════════════════════════════════
exports.confirmArrangement = async (req, res, next) => {
  try {
    const { schoolId, userId } = req.user;
    const { date, entries } = req.body;
    // entries = [{period_slot_id, section_id, subject_id, original_teacher_id, substitute_teacher_id, original_status, is_suggested_match}]
    if (!date || !Array.isArray(entries) || entries.length === 0) return badRequest(res, 'date and entries[] are required.');

    let savedCount = 0;
    for (const e of entries) {
      if (!(await assertStaffBelongsToSchool(schoolId, e.substitute_teacher_id))) continue; // SaaS safety

      const existing = await queryOne(
        `SELECT id FROM substitution_logs WHERE school_id=@sid AND substitution_date=@date AND period_slot_id=@ps AND section_id=@sec AND deleted_at IS NULL`,
        { sid: { type: sql.UniqueIdentifier, value: schoolId }, date: { type: sql.Date, value: date },
          ps: { type: sql.UniqueIdentifier, value: e.period_slot_id }, sec: { type: sql.UniqueIdentifier, value: e.section_id } });

      const p = {
        sid: { type: sql.UniqueIdentifier, value: schoolId }, date: { type: sql.Date, value: date },
        ps: { type: sql.UniqueIdentifier, value: e.period_slot_id }, sec: { type: sql.UniqueIdentifier, value: e.section_id },
        subj: { type: sql.UniqueIdentifier, value: e.subject_id || null },
        orig: { type: sql.UniqueIdentifier, value: e.original_teacher_id },
        sub: { type: sql.UniqueIdentifier, value: e.substitute_teacher_id },
        stat: { type: sql.VarChar(2), value: e.original_status || null },
        suggested: { type: sql.Bit, value: e.is_suggested_match ? 1 : 0 },
        by: { type: sql.UniqueIdentifier, value: userId }, now: { type: sql.DateTime2, value: new Date() },
      };

      if (existing) {
        await query(`UPDATE substitution_logs SET substitute_teacher_id=@sub, is_suggested_match=@suggested WHERE id=@id`,
          { ...p, id: { type: sql.UniqueIdentifier, value: existing.id } });
      } else {
        await query(
          `INSERT INTO substitution_logs (id, school_id, substitution_date, period_slot_id, section_id, subject_id,
             original_teacher_id, substitute_teacher_id, original_status, is_suggested_match, created_by, created_at)
           VALUES (@id, @sid, @date, @ps, @sec, @subj, @orig, @sub, @stat, @suggested, @by, @now)`,
          { ...p, id: { type: sql.UniqueIdentifier, value: uuidv4() } });
      }
      savedCount++;
    }

    return success(res, { saved: savedCount }, 'Arrangement confirmed successfully');
  } catch (err) { next(err); }
};

// ══════════════════════════════════════════════════
// CANCEL a single substitution entry
// ══════════════════════════════════════════════════
exports.cancelEntry = async (req, res, next) => {
  try {
    const { id } = req.params; const { schoolId } = req.user;
    await query(`UPDATE substitution_logs SET deleted_at=@now WHERE id=@id AND school_id=@sid`,
      { id: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId }, now: { type: sql.DateTime2, value: new Date() } });
    return success(res, null, 'Substitution cancelled');
  } catch (err) { next(err); }
};

// ══════════════════════════════════════════════════
// HISTORY — raw list for a date range; frontend aggregates for Overview charts
// ══════════════════════════════════════════════════
exports.listHistory = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { from, to } = req.query;
    let where = `sl.school_id=@sid AND sl.deleted_at IS NULL`;
    const params = { sid: { type: sql.UniqueIdentifier, value: schoolId } };
    if (from) { where += ` AND sl.substitution_date >= @from`; params.from = { type: sql.Date, value: from }; }
    if (to) { where += ` AND sl.substitution_date <= @to`; params.to = { type: sql.Date, value: to }; }

    const rows = await query(
      `SELECT sl.*, sec.name AS section_name, g.name AS class_name, sub.name AS subject_name,
              uo.full_name AS original_teacher_name, us.full_name AS substitute_teacher_name,
              ps.label AS period_label, ps.period_number
       FROM substitution_logs sl
       JOIN sections sec ON sec.id = sl.section_id
       JOIN grades g ON g.id = sec.grade_id
       LEFT JOIN subjects sub ON sub.id = sl.subject_id
       JOIN users uo ON uo.id = sl.original_teacher_id
       JOIN users us ON us.id = sl.substitute_teacher_id
       JOIN period_slots ps ON ps.id = sl.period_slot_id
       WHERE ${where}
       ORDER BY sl.substitution_date DESC, ps.period_number`, params);
    return success(res, rows.recordset);
  } catch (err) { next(err); }
};

// ══════════════════════════════════════════════════
// NOTIFY (stub — wired later to email/WhatsApp)
// ══════════════════════════════════════════════════
exports.notifySubstitutes = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { date } = req.body;
    // TODO: fetch confirmed entries for `date`, send email/WhatsApp per substitute teacher
    // with exact period time, section, subject, room_no. Placeholder for now.
    await query(`UPDATE substitution_logs SET notified_at=@now WHERE school_id=@sid AND substitution_date=@date AND deleted_at IS NULL`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId }, date: { type: sql.Date, value: date }, now: { type: sql.DateTime2, value: new Date() } });
    return success(res, null, 'Notifications marked as sent (channel integration pending)');
  } catch (err) { next(err); }
};