// src/controllers/timetableController.js
const { query, queryOne, withTransaction, sql } = require('../config/db');
const { success, created, notFound, badRequest } = require('../utils/response');
const { audit } = require('../utils/audit');
const { v4: uuidv4 } = require('uuid');

// ── GET /api/timetables?section_id=&academic_year_id= ─────────────────────
exports.getBySection = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { section_id, academic_year_id } = req.query;
    if (!section_id) return badRequest(res, 'section_id required');

    // Get active timetable for this section
    const timetable = await queryOne(
      `SELECT t.*, u.full_name AS created_by_name
       FROM timetables t
       LEFT JOIN users u ON u.id = t.created_by
       WHERE t.school_id = @sid AND t.section_id = @secId AND t.is_active = 1 AND t.deleted_at IS NULL
         ${academic_year_id ? 'AND t.academic_year_id = @ayId' : ''}
       ORDER BY t.effective_from DESC
       OFFSET 0 ROWS FETCH NEXT 1 ROWS ONLY`,
      {
        sid:   { type: sql.UniqueIdentifier, value: schoolId },
        secId: { type: sql.UniqueIdentifier, value: section_id },
        ...(academic_year_id ? { ayId: { type: sql.UniqueIdentifier, value: academic_year_id } } : {}),
      }
    );

    if (!timetable) return success(res, null, 'No active timetable found');

    // Get all slots for this timetable with subject + teacher info
    const slots = await query(
      `SELECT ts.*,
              sub.name         AS subject_name,
              sub.code         AS subject_code,
              u.full_name      AS teacher_name,
              r.name           AS room_name,
              -- Check if teacher is absent today
              CASE WHEN sa.status = 'absent' THEN 1 ELSE 0 END AS teacher_absent,
              -- Substitute if any
              sub2.full_name   AS substitute_name
       FROM timetable_slots ts
       LEFT JOIN subjects sub  ON sub.id  = ts.subject_id
       LEFT JOIN users u       ON u.id    = ts.teacher_id
       LEFT JOIN rooms r       ON r.id    = ts.room_id
       LEFT JOIN staff_attendance sa ON sa.staff_id = ts.teacher_id
                 AND sa.school_id = @sid
                 AND CONVERT(DATE, sa.date) = CONVERT(DATE, GETUTCDATE())
       LEFT JOIN substitutions sub_rec ON sub_rec.slot_id = ts.id
                 AND sub_rec.school_id = @sid
                 AND CONVERT(DATE, sub_rec.date) = CONVERT(DATE, GETUTCDATE())
                 AND sub_rec.deleted_at IS NULL
       LEFT JOIN users sub2    ON sub2.id = sub_rec.substitute_teacher_id
       WHERE ts.timetable_id = @ttId AND ts.deleted_at IS NULL
       ORDER BY
         CASE ts.day_of_week
           WHEN 'monday' THEN 1 WHEN 'tuesday' THEN 2 WHEN 'wednesday' THEN 3
           WHEN 'thursday' THEN 4 WHEN 'friday' THEN 5 WHEN 'saturday' THEN 6
           ELSE 7 END,
         ts.period_no`,
      {
        sid:  { type: sql.UniqueIdentifier, value: schoolId },
        ttId: { type: sql.UniqueIdentifier, value: timetable.id },
      }
    );

    // Group by day
    const grouped = {};
    for (const slot of slots.recordset) {
      if (!grouped[slot.day_of_week]) grouped[slot.day_of_week] = [];
      grouped[slot.day_of_week].push(slot);
    }

    return success(res, { timetable, slots: grouped });
  } catch (err) { next(err); }
};

// ── POST /api/timetables ──────────────────────────────────────────────────
exports.create = async (req, res, next) => {
  try {
    const { schoolId, userId } = req.user;
    const { section_id, academic_year_id, effective_from, effective_till } = req.body;

    // Deactivate previous timetables for same section
    await query(
      `UPDATE timetables SET is_active = 0, effective_till = DATEADD(DAY,-1,@from), updated_at = GETUTCDATE()
       WHERE school_id = @sid AND section_id = @secId AND is_active = 1 AND deleted_at IS NULL`,
      {
        sid:   { type: sql.UniqueIdentifier, value: schoolId },
        secId: { type: sql.UniqueIdentifier, value: section_id },
        from:  { type: sql.Date, value: effective_from },
      }
    );

    const r = await query(
      `INSERT INTO timetables (id,school_id,section_id,academic_year_id,effective_from,effective_till,created_by)
       OUTPUT INSERTED.id
       VALUES(NEWID(),@sid,@secId,@ayId,@from,@till,@createdBy)`,
      {
        sid:       { type: sql.UniqueIdentifier, value: schoolId },
        secId:     { type: sql.UniqueIdentifier, value: section_id },
        ayId:      { type: sql.UniqueIdentifier, value: academic_year_id },
        from:      { type: sql.Date, value: effective_from },
        till:      { type: sql.Date, value: effective_till || null },
        createdBy: { type: sql.UniqueIdentifier, value: userId },
      }
    );

    const ttId = r.recordset[0].id;
    await audit({ req, action: 'CREATE', tableName: 'timetables', recordId: ttId });
    return created(res, { id: ttId }, 'Timetable created');
  } catch (err) { next(err); }
};

// ── POST /api/timetables/:id/slots ────────────────────────────────────────
// Bulk upsert slots (full week at once)
exports.saveSlots = async (req, res, next) => {
  try {
    const { id: timetableId } = req.params;
    const { schoolId } = req.user;
    const { slots } = req.body; // [{day_of_week, period_no, start_time, end_time, subject_id, teacher_id, room_id, is_break, break_label}]

    if (!Array.isArray(slots) || slots.length === 0) return badRequest(res, 'slots[] required');

    await withTransaction(async (tx) => {
      // Delete existing slots for this timetable
      const del = tx.request();
      del.input('ttId', sql.UniqueIdentifier, timetableId);
      del.input('sid',  sql.UniqueIdentifier, schoolId);
      await del.query(`UPDATE timetable_slots SET deleted_at = GETUTCDATE() WHERE timetable_id = @ttId AND school_id = @sid AND deleted_at IS NULL`);

      // Insert new slots
      for (const s of slots) {
        const r = tx.request();
        r.input('id',          sql.UniqueIdentifier, uuidv4());
        r.input('sid',         sql.UniqueIdentifier, schoolId);
        r.input('ttId',        sql.UniqueIdentifier, timetableId);
        r.input('day',         sql.VarChar(20),       s.day_of_week.toLowerCase());
        r.input('periodNo',    sql.SmallInt,          s.period_no);
        r.input('startTime',   sql.Time,              s.start_time);
        r.input('endTime',     sql.Time,              s.end_time);
        r.input('subjectId',   sql.UniqueIdentifier,  s.subject_id   || null);
        r.input('teacherId',   sql.UniqueIdentifier,  s.teacher_id   || null);
        r.input('roomId',      sql.UniqueIdentifier,  s.room_id      || null);
        r.input('isBreak',     sql.Bit,               s.is_break  ? 1 : 0);
        r.input('breakLabel',  sql.NVarChar(100),     s.break_label  || null);
        await r.query(
          `INSERT INTO timetable_slots (id,school_id,timetable_id,day_of_week,period_no,start_time,end_time,subject_id,teacher_id,room_id,is_break,break_label)
           VALUES(@id,@sid,@ttId,@day,@periodNo,@startTime,@endTime,@subjectId,@teacherId,@roomId,@isBreak,@breakLabel)`
        );
      }
    });

    return success(res, null, `${slots.length} slots saved`);
  } catch (err) { next(err); }
};

// ── GET /api/timetables/today-absent ─────────────────────────────────────
// For dashboard: which slots today have absent teacher + who can substitute
exports.getTodayAbsent = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
    const dayName = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][new Date().getDay()];

    const affected = await query(
      `SELECT DISTINCT
              ts.id AS slot_id, ts.period_no, ts.start_time, ts.end_time,
              sub.name  AS subject_name,
              u.id      AS absent_teacher_id,
              u.full_name AS absent_teacher_name,
              g.name    AS class_name, sc.name AS section_name,
              sc.id     AS section_id
       FROM timetable_slots ts
       JOIN timetables tt      ON tt.id = ts.timetable_id AND tt.is_active = 1 AND tt.school_id = @sid
       JOIN sections sc        ON sc.id = tt.section_id
       JOIN grades g           ON g.id  = sc.grade_id
       JOIN subjects sub       ON sub.id = ts.subject_id
       JOIN users u            ON u.id  = ts.teacher_id
       JOIN staff_attendance sa ON sa.staff_id = ts.teacher_id AND sa.school_id = @sid
                 AND CONVERT(DATE, sa.date) = @today AND sa.status = 'absent'
       WHERE ts.school_id = @sid AND ts.day_of_week = @day AND ts.is_break = 0 AND ts.deleted_at IS NULL`,
      {
        sid:   { type: sql.UniqueIdentifier, value: schoolId },
        today: { type: sql.Date,            value: today },
        day:   { type: sql.VarChar(20),     value: dayName },
      }
    );

    return success(res, affected.recordset);
  } catch (err) { next(err); }
};

// ── POST /api/timetables/substitute ──────────────────────────────────────
exports.createSubstitution = async (req, res, next) => {
  try {
    const { schoolId, userId } = req.user;
    const { slot_id, date, absent_teacher_id, substitute_teacher_id, reason } = req.body;

    await query(
      `INSERT INTO substitutions (id,school_id,slot_id,date,absent_teacher_id,substitute_teacher_id,reason,approved_by)
       VALUES(NEWID(),@sid,@slotId,@date,@absentId,@subId,@reason,@approvedBy)`,
      {
        sid:       { type: sql.UniqueIdentifier, value: schoolId },
        slotId:    { type: sql.UniqueIdentifier, value: slot_id },
        date:      { type: sql.Date,             value: date },
        absentId:  { type: sql.UniqueIdentifier, value: absent_teacher_id },
        subId:     { type: sql.UniqueIdentifier, value: substitute_teacher_id },
        reason:    { type: sql.NVarChar(sql.MAX), value: reason || null },
        approvedBy:{ type: sql.UniqueIdentifier, value: userId },
      }
    );

    return created(res, null, 'Substitution arranged');
  } catch (err) { next(err); }
};
