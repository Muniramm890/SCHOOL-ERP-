// src/controllers/timetableController.js
const { query, queryOne, withTransaction, sql } = require('../config/db');
const { success, created, badRequest, notFound } = require('../utils/response');

const DAY_NAMES = { 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun' };

// ═══════════════════════════════════════════════════════════════
// PERIOD SLOTS
// ═══════════════════════════════════════════════════════════════

// GET /api/timetable/periods
exports.listPeriods = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const result = await query(
      `SELECT id, period_number, label, is_break, is_active,
              LEFT(CONVERT(varchar, start_time, 108), 5) AS start_time,
              LEFT(CONVERT(varchar, end_time, 108), 5) AS end_time
       FROM period_slots WHERE school_id=@sid AND is_active=1 ORDER BY period_number`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    return success(res, result.recordset, 'Periods fetched');
  } catch (err) { next(err); }
};


// POST /api/timetable/periods/generate-defaults
// Uses schools.periods_per_day / period_duration_min / school_start_time to
// auto-generate a starting structure — minimal manual entry.
exports.generateDefaultPeriods = async (req, res, next) => {
  try {
    const { schoolId } = req.user;

    const school = await queryOne(
      `SELECT periods_per_day, period_duration_min, school_start_time FROM schools WHERE id=@sid`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    if (!school) return notFound(res, 'School not found');

    const periodsPerDay = school.periods_per_day || 8;
    const duration = school.period_duration_min || 45;
    let [h, m] = (school.school_start_time || '08:00:00').toString().split(':').map(Number);

    await withTransaction(async (tx) => {
      const rDel = tx.request();
      rDel.input('sid', sql.UniqueIdentifier, schoolId);
      await rDel.query(`DELETE FROM period_slots WHERE school_id=@sid`);

      for (let i = 1; i <= periodsPerDay; i++) {
        const startH = h, startM = m;
        m += duration;
        h += Math.floor(m / 60);
        m = m % 60;
        const startStr = `${String(startH).padStart(2, '0')}:${String(startM).padStart(2, '0')}:00`;
        const endStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;

        const r = tx.request();
        r.input('sid', sql.UniqueIdentifier, schoolId);
        r.input('num', sql.SmallInt, i);
        r.input('label', sql.NVarChar(50), `Period ${i}`);
        r.input('st', sql.VarChar(15), startStr);
        r.input('et', sql.VarChar(15), endStr);
        await r.query(
          `INSERT INTO period_slots (id, school_id, period_number, label, start_time, end_time)
           VALUES (NEWID(), @sid, @num, @label, CAST(@st AS TIME), CAST(@et AS TIME))`
        );
      }
    });

    return success(res, null, `${periodsPerDay} periods generated successfully`);
  } catch (err) { next(err); }
};

// POST /api/timetable/periods  { period_number, label, start_time, end_time, is_break }
exports.createPeriod = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { period_number, label, start_time, end_time, is_break = false } = req.body;
    if (!period_number || !label || !start_time || !end_time) {
      return badRequest(res, 'period_number, label, start_time and end_time are required');
    }
    const r = await query(
      `INSERT INTO period_slots (id, school_id, period_number, label, start_time, end_time, is_break)
       OUTPUT INSERTED.id
       VALUES (NEWID(), @sid, @num, @label, CAST(@st AS TIME), CAST(@et AS TIME), @brk)`,
      {
        sid: { type: sql.UniqueIdentifier, value: schoolId },
        num: { type: sql.SmallInt, value: period_number },
        label: { type: sql.NVarChar(50), value: label },
        st: { type: sql.VarChar(15), value: start_time },
        et: { type: sql.VarChar(15), value: end_time },
        brk: { type: sql.Bit, value: is_break ? 1 : 0 },
      }
    );
    return created(res, { id: r.recordset[0].id }, 'Period slot created');
  } catch (err) { next(err); }
};

// DELETE /api/timetable/periods/:id
exports.deletePeriod = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { id } = req.params;
    await query(`UPDATE period_slots SET is_active=0, updated_at=GETUTCDATE() WHERE id=@id AND school_id=@sid`, {
      id: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId },
    });
    return success(res, null, 'Period slot removed');
  } catch (err) { next(err); }
};

// ═══════════════════════════════════════════════════════════════
// SECTION TIMETABLE (admin grid)
// ═══════════════════════════════════════════════════════════════

// GET /api/timetable/section/:sectionId?academic_year_id=
exports.getSectionTimetable = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { sectionId } = req.params;
    const { academic_year_id } = req.query;
    if (!academic_year_id) return badRequest(res, 'academic_year_id is required');

    const result = await query(
      `SELECT te.id, te.day_of_week, te.period_slot_id, te.subject_id, te.teacher_id, te.room_no,
              s.name AS subject_name, u.full_name AS teacher_name
       FROM timetable_entries te
       LEFT JOIN subjects s ON s.id = te.subject_id
       LEFT JOIN users u ON u.id = te.teacher_id
       WHERE te.school_id=@sid AND te.academic_year_id=@ayId AND te.section_id=@secId`,
      {
        sid: { type: sql.UniqueIdentifier, value: schoolId },
        ayId: { type: sql.UniqueIdentifier, value: academic_year_id },
        secId: { type: sql.UniqueIdentifier, value: sectionId },
      }
    );

    return success(res, result.recordset, 'Section timetable fetched');
  } catch (err) { next(err); }
};

// PUT /api/timetable/section
// Body: { section_id, academic_year_id, entries: [{ day_of_week, period_slot_id, subject_id, teacher_id, room_no }] }
// Full-replace pattern. Validates teacher double-booking against OTHER
// sections before saving anything (all-or-nothing).
exports.saveSectionTimetable = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { section_id, academic_year_id, entries } = req.body;

    if (!section_id || !academic_year_id || !Array.isArray(entries)) {
      return badRequest(res, 'section_id, academic_year_id and entries[] are required');
    }

    const activeEntries = entries.filter((e) => e.period_slot_id && e.day_of_week);

    // ── Conflict check: teacher already booked elsewhere at same day+period ──
    const conflicts = [];
    for (const e of activeEntries) {
      if (!e.teacher_id) continue;
      const existing = await query(
        `SELECT te.id, sec.name AS section_name, g.name AS grade_name
         FROM timetable_entries te
         JOIN sections sec ON sec.id = te.section_id
         JOIN grades g ON g.id = sec.grade_id
         WHERE te.school_id=@sid AND te.academic_year_id=@ayId AND te.day_of_week=@day
           AND te.period_slot_id=@slot AND te.teacher_id=@teacherId AND te.section_id <> @secId`,
        {
          sid: { type: sql.UniqueIdentifier, value: schoolId },
          ayId: { type: sql.UniqueIdentifier, value: academic_year_id },
          day: { type: sql.TinyInt, value: e.day_of_week },
          slot: { type: sql.UniqueIdentifier, value: e.period_slot_id },
          teacherId: { type: sql.UniqueIdentifier, value: e.teacher_id },
          secId: { type: sql.UniqueIdentifier, value: section_id },
        }
      );
      if (existing.recordset.length > 0) {
        conflicts.push({
          day: DAY_NAMES[e.day_of_week] || e.day_of_week,
          period_slot_id: e.period_slot_id,
          teacher_id: e.teacher_id,
          conflicting_with: `${existing.recordset[0].grade_name} - ${existing.recordset[0].section_name}`,
        });
      }
    }

    if (conflicts.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Teacher scheduling conflicts detected. Nothing was saved.',
        conflicts,
      });
    }

    await withTransaction(async (tx) => {
      const rDel = tx.request();
      rDel.input('sid', sql.UniqueIdentifier, schoolId);
      rDel.input('ayId', sql.UniqueIdentifier, academic_year_id);
      rDel.input('secId', sql.UniqueIdentifier, section_id);
      await rDel.query(`DELETE FROM timetable_entries WHERE school_id=@sid AND academic_year_id=@ayId AND section_id=@secId`);

      for (const e of activeEntries) {
        const r = tx.request();
        r.input('sid', sql.UniqueIdentifier, schoolId);
        r.input('ayId', sql.UniqueIdentifier, academic_year_id);
        r.input('secId', sql.UniqueIdentifier, section_id);
        r.input('day', sql.TinyInt, e.day_of_week);
        r.input('slot', sql.UniqueIdentifier, e.period_slot_id);
        r.input('subId', sql.UniqueIdentifier, e.subject_id || null);
        r.input('teacherId', sql.UniqueIdentifier, e.teacher_id || null);
        r.input('room', sql.NVarChar(50), e.room_no || null);
        await r.query(
          `INSERT INTO timetable_entries (id, school_id, academic_year_id, section_id, day_of_week, period_slot_id, subject_id, teacher_id, room_no)
           VALUES (NEWID(), @sid, @ayId, @secId, @day, @slot, @subId, @teacherId, @room)`
        );
      }
    });

    return success(res, null, 'Timetable saved successfully');
  } catch (err) { next(err); }
};

// ═══════════════════════════════════════════════════════════════
// TEACHER TIMETABLE (7-day view for Teacher Profile)
// ═══════════════════════════════════════════════════════════════

// GET /api/timetable/teacher/:teacherId?academic_year_id=
exports.getTeacherTimetable = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { teacherId } = req.params;
    const { academic_year_id } = req.query;
    if (!academic_year_id) return badRequest(res, 'academic_year_id is required');

    const result = await query(
      `SELECT te.day_of_week, ps.period_number, ps.label AS period_label, 
              LEFT(CONVERT(varchar, ps.start_time, 108), 5) AS start_time, 
              LEFT(CONVERT(varchar, ps.end_time, 108), 5) AS end_time,
              s.name AS subject_name, sec.name AS section_name, g.name AS grade_name, te.room_no
       FROM timetable_entries te
       JOIN period_slots ps ON ps.id = te.period_slot_id
       JOIN sections sec ON sec.id = te.section_id
       JOIN grades g ON g.id = sec.grade_id
       LEFT JOIN subjects s ON s.id = te.subject_id
       WHERE te.school_id=@sid AND te.academic_year_id=@ayId AND te.teacher_id=@tid
       ORDER BY te.day_of_week, ps.period_number`,
      {
        sid: { type: sql.UniqueIdentifier, value: schoolId },
        ayId: { type: sql.UniqueIdentifier, value: academic_year_id },
        tid: { type: sql.UniqueIdentifier, value: teacherId },
      }
    );

    const byDay = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] };
    result.recordset.forEach((r) => { byDay[r.day_of_week]?.push(r); });

    return success(res, { days: byDay, flat: result.recordset }, 'Teacher timetable fetched');
  } catch (err) { next(err); }
};



// PUT /api/timetable/periods  { periods: [{ label, start_time, end_time, is_break }] }
// Full-day routine builder — SINGLE call replaces the entire day structure.
exports.savePeriodsBulk = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { periods } = req.body;
    if (!Array.isArray(periods) || periods.length === 0) {
      return badRequest(res, 'periods[] is required');
    }
    for (const p of periods) {
      if (!p.label || !p.start_time || !p.end_time) {
        return badRequest(res, 'Each period needs label, start_time and end_time');
      }
    }

    await withTransaction(async (tx) => {
      const rDel = tx.request();
      rDel.input('sid', sql.UniqueIdentifier, schoolId);
      await rDel.query(`DELETE FROM period_slots WHERE school_id=@sid`);

      for (let i = 0; i < periods.length; i++) {
        const p = periods[i];
        const r = tx.request();
        r.input('sid', sql.UniqueIdentifier, schoolId);
        r.input('num', sql.SmallInt, i + 1);
        r.input('label', sql.NVarChar(50), p.label);
        r.input('st', sql.VarChar(15), p.start_time.length === 5 ? `${p.start_time}:00` : p.start_time);
        r.input('et', sql.VarChar(15), p.end_time.length === 5 ? `${p.end_time}:00` : p.end_time);
        r.input('brk', sql.Bit, p.is_break ? 1 : 0);
        await r.query(
          `INSERT INTO period_slots (id, school_id, period_number, label, start_time, end_time, is_break)
           VALUES (NEWID(), @sid, @num, @label, CAST(@st AS TIME), CAST(@et AS TIME), @brk)`
        );
      }
    });

    return success(res, null, 'Daily routine saved successfully');
  } catch (err) { next(err); }
};

// GET /api/timetable/check-conflict?academic_year_id=&day_of_week=&period_slot_id=&teacher_id=&exclude_section_id=
// Real-time check — called the instant a teacher is picked in the grid.
exports.checkConflict = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { academic_year_id, day_of_week, period_slot_id, teacher_id, exclude_section_id } = req.query;
    if (!academic_year_id || !day_of_week || !period_slot_id || !teacher_id) {
      return badRequest(res, 'academic_year_id, day_of_week, period_slot_id and teacher_id are required');
    }

    const existing = await queryOne(
      `SELECT TOP 1 sec.name AS section_name, g.name AS grade_name
       FROM timetable_entries te
       JOIN sections sec ON sec.id = te.section_id
       JOIN grades g ON g.id = sec.grade_id
       WHERE te.school_id=@sid AND te.academic_year_id=@ayId AND te.day_of_week=@day
         AND te.period_slot_id=@slot AND te.teacher_id=@tid
         AND (@excludeSec IS NULL OR te.section_id <> @excludeSec)`,
      {
        sid: { type: sql.UniqueIdentifier, value: schoolId },
        ayId: { type: sql.UniqueIdentifier, value: academic_year_id },
        day: { type: sql.TinyInt, value: Number(day_of_week) },
        slot: { type: sql.UniqueIdentifier, value: period_slot_id },
        tid: { type: sql.UniqueIdentifier, value: teacher_id },
        excludeSec: { type: sql.UniqueIdentifier, value: exclude_section_id || null },
      }
    );

    if (existing) {
      return success(res, { conflict: true, with: `${existing.grade_name} - ${existing.section_name}` });
    }
    return success(res, { conflict: false });
  } catch (err) { next(err); }
};
