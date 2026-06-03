// src/controllers/homeworkController.js
const { query, queryOne, withTransaction, sql } = require('../config/db');
const { success, created, notFound, badRequest, paginated } = require('../utils/response');
const { audit } = require('../utils/audit');
const { v4: uuidv4 } = require('uuid');

// ── GET /api/homework?section_id=&subject_id=&from=&to= ───────────────────
exports.list = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { section_id, subject_id, from, to, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let where = `hw.school_id = @sid AND hw.deleted_at IS NULL`;
    const params = { sid: { type: sql.UniqueIdentifier, value: schoolId } };

    if (section_id) { where += ` AND hw.section_id = @secId`; params.secId = { type: sql.UniqueIdentifier, value: section_id }; }
    if (subject_id) { where += ` AND hw.subject_id = @subId`; params.subId = { type: sql.UniqueIdentifier, value: subject_id }; }
    if (from)       { where += ` AND hw.given_date >= @from`; params.from  = { type: sql.Date, value: from }; }
    if (to)         { where += ` AND hw.due_date   <= @to`;   params.to    = { type: sql.Date, value: to }; }

    const count = await queryOne(`SELECT COUNT(*) AS total FROM homework hw WHERE ${where}`, params);

    const hw = await query(
      `SELECT hw.*,
              sub.name      AS subject_name,
              u.full_name   AS teacher_name,
              g.name        AS class_name,
              sc.name       AS section_name,
              COUNT(hws.id) AS submission_count
       FROM homework hw
       JOIN subjects sub ON sub.id = hw.subject_id
       JOIN users u      ON u.id   = hw.teacher_id
       JOIN sections sc  ON sc.id  = hw.section_id
       JOIN grades g     ON g.id   = sc.grade_id
       LEFT JOIN homework_submissions hws ON hws.homework_id = hw.id AND hws.deleted_at IS NULL
       WHERE ${where}
       GROUP BY hw.id, hw.school_id, hw.section_id, hw.subject_id, hw.teacher_id, hw.title,
                hw.description, hw.given_date, hw.due_date, hw.attachment_urls, hw.is_graded,
                hw.max_marks, hw.created_at, hw.updated_at, hw.deleted_at,
                sub.name, u.full_name, g.name, sc.name
       ORDER BY hw.given_date DESC
       OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
      { ...params, offset: { type: sql.Int, value: +offset }, limit: { type: sql.Int, value: +limit } }
    );

    return paginated(res, hw.recordset, count.total, page, limit);
  } catch (err) { next(err); }
};

// ── POST /api/homework ────────────────────────────────────────────────────
exports.create = async (req, res, next) => {
  try {
    const { schoolId, userId } = req.user;
    const { section_id, subject_id, title, description, given_date, due_date,
      attachment_urls, is_graded = false, max_marks } = req.body;

    const r = await query(
      `INSERT INTO homework (id,school_id,section_id,subject_id,teacher_id,title,description,
         given_date,due_date,attachment_urls,is_graded,max_marks)
       OUTPUT INSERTED.id
       VALUES(NEWID(),@sid,@secId,@subId,@teacherId,@title,@desc,@given,@due,@attach,@isGraded,@maxMarks)`,
      {
        sid:       { type: sql.UniqueIdentifier,  value: schoolId },
        secId:     { type: sql.UniqueIdentifier,  value: section_id },
        subId:     { type: sql.UniqueIdentifier,  value: subject_id },
        teacherId: { type: sql.UniqueIdentifier,  value: userId },
        title:     { type: sql.NVarChar(255),     value: title },
        desc:      { type: sql.NVarChar(sql.MAX), value: description || null },
        given:     { type: sql.Date,              value: given_date },
        due:       { type: sql.Date,              value: due_date },
        attach:    { type: sql.NVarChar(sql.MAX), value: attachment_urls ? JSON.stringify(attachment_urls) : null },
        isGraded:  { type: sql.Bit,               value: is_graded ? 1 : 0 },
        maxMarks:  { type: sql.SmallInt,          value: max_marks || null },
      }
    );

    await audit({ req, action: 'CREATE', tableName: 'homework', recordId: r.recordset[0].id });
    return created(res, { id: r.recordset[0].id }, 'Homework created');
  } catch (err) { next(err); }
};

// ── DELETE /api/homework/:id ──────────────────────────────────────────────
exports.remove = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { schoolId } = req.user;
    await query(
      `UPDATE homework SET deleted_at = GETUTCDATE() WHERE id = @id AND school_id = @sid AND deleted_at IS NULL`,
      { id: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    return success(res, null, 'Homework deleted');
  } catch (err) { next(err); }
};

// ── GET /api/homework/:id/submissions ─────────────────────────────────────
exports.listSubmissions = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { id: homeworkId } = req.params;

    const subs = await query(
      `SELECT hws.*,
              s.first_name + ' ' + s.last_name AS student_name,
              s.photo_url, e.roll_no
       FROM homework_submissions hws
       JOIN students s   ON s.id = hws.student_id
       JOIN enrolments e ON e.student_id = s.id AND e.school_id = @sid AND e.is_active = 1
       WHERE hws.homework_id = @hwId AND hws.school_id = @sid AND hws.deleted_at IS NULL
       ORDER BY e.roll_no`,
      {
        hwId: { type: sql.UniqueIdentifier, value: homeworkId },
        sid:  { type: sql.UniqueIdentifier, value: schoolId },
      }
    );

    return success(res, subs.recordset);
  } catch (err) { next(err); }
};

// ── PUT /api/homework/:id/submissions/:studentId ──────────────────────────
// Grade / update a submission
exports.gradeSubmission = async (req, res, next) => {
  try {
    const { id: homeworkId, studentId } = req.params;
    const { schoolId } = req.user;
    const { marks_obtained, feedback, status } = req.body;

    const existing = await queryOne(
      `SELECT id FROM homework_submissions WHERE homework_id=@hwId AND student_id=@studentId AND school_id=@sid AND deleted_at IS NULL`,
      {
        hwId:      { type: sql.UniqueIdentifier, value: homeworkId },
        studentId: { type: sql.UniqueIdentifier, value: studentId },
        sid:       { type: sql.UniqueIdentifier, value: schoolId },
      }
    );

    if (existing) {
      await query(
        `UPDATE homework_submissions SET marks_obtained=@marks, feedback=@fb, status=@status, updated_at=GETUTCDATE()
         WHERE id=@id`,
        {
          id:     { type: sql.UniqueIdentifier, value: existing.id },
          marks:  { type: sql.Decimal(5,2), value: marks_obtained ?? null },
          fb:     { type: sql.NVarChar(sql.MAX), value: feedback || null },
          status: { type: sql.VarChar(50), value: status || 'submitted' },
        }
      );
    } else {
      await query(
        `INSERT INTO homework_submissions (id,school_id,homework_id,student_id,marks_obtained,feedback,status,submitted_at)
         VALUES(NEWID(),@sid,@hwId,@studentId,@marks,@fb,@status,GETUTCDATE())`,
        {
          sid:       { type: sql.UniqueIdentifier, value: schoolId },
          hwId:      { type: sql.UniqueIdentifier, value: homeworkId },
          studentId: { type: sql.UniqueIdentifier, value: studentId },
          marks:     { type: sql.Decimal(5,2), value: marks_obtained ?? null },
          fb:        { type: sql.NVarChar(sql.MAX), value: feedback || null },
          status:    { type: sql.VarChar(50), value: status || 'submitted' },
        }
      );
    }

    return success(res, null, 'Submission updated');
  } catch (err) { next(err); }
};
