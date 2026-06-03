// src/controllers/examsController.js
const { query, queryOne, withTransaction, sql } = require('../config/db');
const { success, created, notFound, badRequest } = require('../utils/response');
const { audit } = require('../utils/audit');
const { v4: uuidv4 } = require('uuid');

// ── GET /api/exams?academic_year_id= ─────────────────────────────────────
exports.list = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { academic_year_id } = req.query;

    const exams = await query(
      `SELECT e.*,
              ay.name AS academic_year_name,
              g.name  AS grade_name,
              u.full_name AS created_by_name,
              COUNT(DISTINCT es.id) AS schedule_count
       FROM exams e
       JOIN academic_years ay ON ay.id = e.academic_year_id
       LEFT JOIN grades g     ON g.id  = e.grade_id
       LEFT JOIN users u      ON u.id  = e.created_by
       LEFT JOIN exam_schedules es ON es.exam_id = e.id AND es.deleted_at IS NULL
       WHERE e.school_id = @sid AND e.deleted_at IS NULL
         ${academic_year_id ? 'AND e.academic_year_id = @ayId' : ''}
       GROUP BY e.id, e.school_id, e.academic_year_id, e.name, e.exam_type, e.grade_id,
                e.start_date, e.end_date, e.is_published, e.result_published, e.created_by,
                e.instructions, e.created_at, e.updated_at, e.deleted_at,
                ay.name, g.name, u.full_name
       ORDER BY e.start_date DESC`,
      {
        sid:  { type: sql.UniqueIdentifier, value: schoolId },
        ...(academic_year_id ? { ayId: { type: sql.UniqueIdentifier, value: academic_year_id } } : {}),
      }
    );

    return success(res, exams.recordset);
  } catch (err) { next(err); }
};

// ── GET /api/exams/:id ────────────────────────────────────────────────────
exports.getOne = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { id } = req.params;

    const exam = await queryOne(
      `SELECT e.*, ay.name AS academic_year_name, g.name AS grade_name
       FROM exams e
       JOIN academic_years ay ON ay.id = e.academic_year_id
       LEFT JOIN grades g ON g.id = e.grade_id
       WHERE e.id = @id AND e.school_id = @sid AND e.deleted_at IS NULL`,
      { id: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    if (!exam) return notFound(res, 'Exam not found');

    const schedules = await query(
      `SELECT es.*,
              sub.name     AS subject_name,
              g.name       AS grade_name,
              r.name       AS room_name,
              u.full_name  AS invigilator_name
       FROM exam_schedules es
       JOIN subjects sub ON sub.id = es.subject_id
       JOIN grades g     ON g.id   = es.grade_id
       LEFT JOIN rooms r ON r.id   = es.room_id
       LEFT JOIN users u ON u.id   = es.invigilator_id
       WHERE es.exam_id = @id AND es.school_id = @sid AND es.deleted_at IS NULL
       ORDER BY es.date, es.start_time`,
      { id: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );

    return success(res, { ...exam, schedules: schedules.recordset });
  } catch (err) { next(err); }
};

// ── POST /api/exams ───────────────────────────────────────────────────────
exports.create = async (req, res, next) => {
  try {
    const { schoolId, userId } = req.user;
    const { academic_year_id, name, exam_type, grade_id, start_date, end_date, instructions } = req.body;

    const r = await query(
      `INSERT INTO exams (id,school_id,academic_year_id,name,exam_type,grade_id,start_date,end_date,created_by,instructions)
       OUTPUT INSERTED.id
       VALUES(NEWID(),@sid,@ayId,@name,@type,@gradeId,@sd,@ed,@createdBy,@instr)`,
      {
        sid:       { type: sql.UniqueIdentifier, value: schoolId },
        ayId:      { type: sql.UniqueIdentifier, value: academic_year_id },
        name:      { type: sql.NVarChar(255),    value: name },
        type:      { type: sql.VarChar(50),      value: exam_type },
        gradeId:   { type: sql.UniqueIdentifier, value: grade_id || null },
        sd:        { type: sql.Date,             value: start_date || null },
        ed:        { type: sql.Date,             value: end_date || null },
        createdBy: { type: sql.UniqueIdentifier, value: userId },
        instr:     { type: sql.NVarChar(sql.MAX), value: instructions || null },
      }
    );

    const examId = r.recordset[0].id;
    await audit({ req, action: 'CREATE', tableName: 'exams', recordId: examId });
    return created(res, { id: examId }, 'Exam created');
  } catch (err) { next(err); }
};

// ── PUT /api/exams/:id ────────────────────────────────────────────────────
exports.update = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { schoolId } = req.user;
    const { name, exam_type, grade_id, start_date, end_date, instructions, is_published, result_published } = req.body;

    await query(
      `UPDATE exams SET
         name             = ISNULL(@name, name),
         exam_type        = ISNULL(@type, exam_type),
         grade_id         = ISNULL(@gid,  grade_id),
         start_date       = ISNULL(@sd,   start_date),
         end_date         = ISNULL(@ed,   end_date),
         instructions     = ISNULL(@instr, instructions),
         is_published     = ISNULL(@pub,   is_published),
         result_published = ISNULL(@resPub, result_published),
         updated_at       = GETUTCDATE()
       WHERE id = @id AND school_id = @sid AND deleted_at IS NULL`,
      {
        id:     { type: sql.UniqueIdentifier, value: id },
        sid:    { type: sql.UniqueIdentifier, value: schoolId },
        name:   { type: sql.NVarChar(255),   value: name ?? null },
        type:   { type: sql.VarChar(50),     value: exam_type ?? null },
        gid:    { type: sql.UniqueIdentifier, value: grade_id ?? null },
        sd:     { type: sql.Date,            value: start_date ?? null },
        ed:     { type: sql.Date,            value: end_date ?? null },
        instr:  { type: sql.NVarChar(sql.MAX), value: instructions ?? null },
        pub:    { type: sql.Bit,             value: is_published != null ? (is_published ? 1 : 0) : null },
        resPub: { type: sql.Bit,             value: result_published != null ? (result_published ? 1 : 0) : null },
      }
    );

    await audit({ req, action: 'UPDATE', tableName: 'exams', recordId: id, newValues: req.body });
    return success(res, null, 'Exam updated');
  } catch (err) { next(err); }
};

// ── DELETE /api/exams/:id ─────────────────────────────────────────────────
exports.remove = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { schoolId } = req.user;
    await query(
      `UPDATE exams SET deleted_at = GETUTCDATE() WHERE id = @id AND school_id = @sid AND deleted_at IS NULL`,
      { id: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    return success(res, null, 'Exam deleted');
  } catch (err) { next(err); }
};

// ── POST /api/exams/:id/schedule ──────────────────────────────────────────
exports.addSchedule = async (req, res, next) => {
  try {
    const { id: examId } = req.params;
    const { schoolId } = req.user;
    const {
      subject_id, grade_id, date, start_time, end_time,
      room_id, invigilator_id, max_theory_marks = 100,
      max_practical_marks = 0, passing_marks = 33,
    } = req.body;

    const r = await query(
      `INSERT INTO exam_schedules
         (id,school_id,exam_id,subject_id,grade_id,date,start_time,end_time,room_id,
          invigilator_id,max_theory_marks,max_practical_marks,passing_marks)
       OUTPUT INSERTED.id
       VALUES(NEWID(),@sid,@examId,@subId,@gradeId,@date,@st,@et,@roomId,@invId,@maxTh,@maxPr,@pass)`,
      {
        sid:     { type: sql.UniqueIdentifier, value: schoolId },
        examId:  { type: sql.UniqueIdentifier, value: examId },
        subId:   { type: sql.UniqueIdentifier, value: subject_id },
        gradeId: { type: sql.UniqueIdentifier, value: grade_id },
        date:    { type: sql.Date,             value: date },
        st:      { type: sql.Time,             value: start_time || null },
        et:      { type: sql.Time,             value: end_time || null },
        roomId:  { type: sql.UniqueIdentifier, value: room_id || null },
        invId:   { type: sql.UniqueIdentifier, value: invigilator_id || null },
        maxTh:   { type: sql.SmallInt,         value: max_theory_marks },
        maxPr:   { type: sql.SmallInt,         value: max_practical_marks },
        pass:    { type: sql.SmallInt,         value: passing_marks },
      }
    );

    return created(res, { id: r.recordset[0].id }, 'Schedule added');
  } catch (err) { next(err); }
};
