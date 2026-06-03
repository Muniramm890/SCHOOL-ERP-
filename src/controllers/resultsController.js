// src/controllers/resultsController.js
const { query, queryOne, withTransaction, sql } = require('../config/db');
const { success, created, notFound, badRequest } = require('../utils/response');
const { audit } = require('../utils/audit');
const { v4: uuidv4 } = require('uuid');

// ── GET /api/results?section_id=&exam_id= ─────────────────────────────────
// Fetch all marks for a section + exam (result entry table)
exports.getBySection = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { section_id, exam_id } = req.query;
    if (!section_id || !exam_id) return badRequest(res, 'section_id and exam_id required');

    const marks = await query(
      `SELECT sm.id, sm.student_id, sm.subject_id, sm.enrolment_id,
              sm.theory_marks_obtained, sm.practical_marks_obtained,
              sm.is_absent, sm.is_exempted, sm.grade, sm.remarks,
              sm.entered_by, sm.verified_by,
              s.first_name + ' ' + s.last_name AS student_name,
              s.photo_url, e.roll_no,
              sub.name AS subject_name, sub.code AS subject_code,
              sub.theory_max_marks, sub.practical_max_marks, sub.passing_marks
       FROM student_marks sm
       JOIN students s   ON s.id = sm.student_id
       JOIN subjects sub ON sub.id = sm.subject_id
       JOIN enrolments e ON e.id = sm.enrolment_id
       WHERE sm.school_id = @sid AND sm.exam_id = @examId
         AND e.section_id = @sectionId AND sm.deleted_at IS NULL
       ORDER BY e.roll_no, sub.name`,
      {
        sid:       { type: sql.UniqueIdentifier, value: schoolId },
        examId:    { type: sql.UniqueIdentifier, value: exam_id },
        sectionId: { type: sql.UniqueIdentifier, value: section_id },
      }
    );

    return success(res, marks.recordset);
  } catch (err) { next(err); }
};

// ── POST /api/results/bulk ─────────────────────────────────────────────────
// Bulk upsert marks
// Body: { exam_id, records: [{student_id, enrolment_id, subject_id, theory, practical, is_absent}] }
exports.saveBulk = async (req, res, next) => {
  try {
    const { schoolId, userId } = req.user;
    const { exam_id, records } = req.body;
    if (!exam_id || !Array.isArray(records)) return badRequest(res, 'exam_id and records[] required');

    await withTransaction(async (tx) => {
      for (const r of records) {
        const chk = tx.request();
        chk.input('sid',       sql.UniqueIdentifier, schoolId);
        chk.input('examId',    sql.UniqueIdentifier, exam_id);
        chk.input('studentId', sql.UniqueIdentifier, r.student_id);
        chk.input('subjectId', sql.UniqueIdentifier, r.subject_id);
        const existing = await chk.query(
          `SELECT id FROM student_marks WHERE school_id=@sid AND exam_id=@examId
             AND student_id=@studentId AND subject_id=@subjectId AND deleted_at IS NULL`
        );

        if (existing.recordset.length > 0) {
          const upd = tx.request();
          upd.input('id',         sql.UniqueIdentifier, existing.recordset[0].id);
          upd.input('theory',     sql.Decimal(5,2), r.theory ?? null);
          upd.input('practical',  sql.Decimal(5,2), r.practical ?? null);
          upd.input('isAbsent',   sql.Bit, r.is_absent ? 1 : 0);
          upd.input('isExempted', sql.Bit, r.is_exempted ? 1 : 0);
          upd.input('grade',      sql.VarChar(50), r.grade || null);
          upd.input('remarks',    sql.NVarChar(sql.MAX), r.remarks || null);
          upd.input('enteredBy',  sql.UniqueIdentifier, userId);
          await upd.query(
            `UPDATE student_marks SET theory_marks_obtained=@theory, practical_marks_obtained=@practical,
               is_absent=@isAbsent, is_exempted=@isExempted, grade=@grade, remarks=@remarks,
               entered_by=@enteredBy, entered_at=GETUTCDATE(), updated_at=GETUTCDATE()
             WHERE id=@id`
          );
        } else {
          const ins = tx.request();
          ins.input('id',          sql.UniqueIdentifier, uuidv4());
          ins.input('sid',         sql.UniqueIdentifier, schoolId);
          ins.input('enrolId',     sql.UniqueIdentifier, r.enrolment_id);
          ins.input('studentId',   sql.UniqueIdentifier, r.student_id);
          ins.input('examId',      sql.UniqueIdentifier, exam_id);
          ins.input('subjectId',   sql.UniqueIdentifier, r.subject_id);
          ins.input('theory',      sql.Decimal(5,2), r.theory ?? null);
          ins.input('practical',   sql.Decimal(5,2), r.practical ?? null);
          ins.input('isAbsent',    sql.Bit, r.is_absent ? 1 : 0);
          ins.input('isExempted',  sql.Bit, r.is_exempted ? 1 : 0);
          ins.input('grade',       sql.VarChar(50), r.grade || null);
          ins.input('remarks',     sql.NVarChar(sql.MAX), r.remarks || null);
          ins.input('enteredBy',   sql.UniqueIdentifier, userId);
          await ins.query(
            `INSERT INTO student_marks (id,school_id,enrolment_id,student_id,exam_id,subject_id,
               theory_marks_obtained,practical_marks_obtained,is_absent,is_exempted,grade,remarks,entered_by)
             VALUES(@id,@sid,@enrolId,@studentId,@examId,@subjectId,@theory,@practical,
               @isAbsent,@isExempted,@grade,@remarks,@enteredBy)`
          );
        }
      }
    });

    await audit({ req, action: 'BULK_MARKS_ENTRY', tableName: 'student_marks',
      newValues: { exam_id, count: records.length } });
    return success(res, null, `${records.length} marks saved`);
  } catch (err) { next(err); }
};

// ── GET /api/results/student/:studentId?exam_id= ─────────────────────────
// Full marksheet for one student
exports.getStudentResult = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { studentId } = req.params;
    const { exam_id } = req.query;

    const marks = await query(
      `SELECT sm.*,
              sub.name AS subject_name, sub.theory_max_marks, sub.practical_max_marks, sub.passing_marks,
              ex.name AS exam_name, ex.exam_type
       FROM student_marks sm
       JOIN subjects sub ON sub.id = sm.subject_id
       JOIN exams ex     ON ex.id  = sm.exam_id
       WHERE sm.student_id = @studentId AND sm.school_id = @sid
         AND sm.deleted_at IS NULL
         ${exam_id ? 'AND sm.exam_id = @examId' : ''}
       ORDER BY sub.name`,
      {
        studentId: { type: sql.UniqueIdentifier, value: studentId },
        sid:       { type: sql.UniqueIdentifier, value: schoolId },
        ...(exam_id ? { examId: { type: sql.UniqueIdentifier, value: exam_id } } : {}),
      }
    );

    return success(res, marks.recordset);
  } catch (err) { next(err); }
};

// ── GET /api/results/leaderboard?section_id=&exam_id= ────────────────────
exports.getLeaderboard = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { section_id, exam_id, grade_id } = req.query;

    let studentFilter = `sm.school_id = @sid AND sm.deleted_at IS NULL`;
    const params = { sid: { type: sql.UniqueIdentifier, value: schoolId } };

    if (exam_id) { studentFilter += ` AND sm.exam_id = @examId`; params.examId = { type: sql.UniqueIdentifier, value: exam_id }; }
    if (section_id) { studentFilter += ` AND e.section_id = @sectionId`; params.sectionId = { type: sql.UniqueIdentifier, value: section_id }; }
    if (grade_id) {
      studentFilter += ` AND sc.grade_id = @gradeId`;
      params.gradeId = { type: sql.UniqueIdentifier, value: grade_id };
    }

    const leaderboard = await query(
      `SELECT sm.student_id,
              s.first_name + ' ' + s.last_name AS student_name,
              s.photo_url, e.roll_no,
              g.name AS class_name, sc.name AS section_name,
              SUM(ISNULL(sm.theory_marks_obtained,0) + ISNULL(sm.practical_marks_obtained,0)) AS total_marks,
              COUNT(DISTINCT sm.subject_id) AS subjects_appeared,
              CAST(
                SUM(ISNULL(sm.theory_marks_obtained,0) + ISNULL(sm.practical_marks_obtained,0)) * 100.0
                / NULLIF(SUM(sub.theory_max_marks + sub.practical_max_marks), 0)
              AS DECIMAL(5,2)) AS percentage
       FROM student_marks sm
       JOIN students s   ON s.id = sm.student_id
       JOIN enrolments e ON e.id = sm.enrolment_id
       JOIN sections sc  ON sc.id = e.section_id
       JOIN grades g     ON g.id = sc.grade_id
       JOIN subjects sub ON sub.id = sm.subject_id
       WHERE ${studentFilter} AND sm.is_absent = 0
       GROUP BY sm.student_id, s.first_name, s.last_name, s.photo_url, e.roll_no, g.name, sc.name
       ORDER BY percentage DESC`,
      params
    );

    // Add rank
    const ranked = leaderboard.recordset.map((r, i) => ({ ...r, rank: i + 1 }));
    return success(res, ranked);
  } catch (err) { next(err); }
};

// ── GET /api/results/analytics?section_id=&exam_id= ───────────────────────
exports.getSectionAnalytics = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { section_id, exam_id } = req.query;
    if (!section_id || !exam_id) return badRequest(res, 'section_id and exam_id required');

    const subjectAvg = await query(
      `SELECT sub.name AS subject_name, sub.id AS subject_id,
              AVG(CAST(sm.theory_marks_obtained AS FLOAT))     AS avg_theory,
              AVG(CAST(sm.practical_marks_obtained AS FLOAT))  AS avg_practical,
              MAX(sm.theory_marks_obtained)                    AS max_theory,
              MIN(sm.theory_marks_obtained)                    AS min_theory,
              COUNT(CASE WHEN sm.is_absent=1 THEN 1 END)       AS absent_count,
              COUNT(CASE WHEN sm.theory_marks_obtained < sub.passing_marks THEN 1 END) AS fail_count,
              COUNT(*)                                         AS total
       FROM student_marks sm
       JOIN subjects sub ON sub.id = sm.subject_id
       JOIN enrolments e ON e.id = sm.enrolment_id
       WHERE sm.school_id=@sid AND sm.exam_id=@examId AND e.section_id=@sectionId AND sm.deleted_at IS NULL
       GROUP BY sub.name, sub.id
       ORDER BY sub.name`,
      {
        sid:       { type: sql.UniqueIdentifier, value: schoolId },
        examId:    { type: sql.UniqueIdentifier, value: exam_id },
        sectionId: { type: sql.UniqueIdentifier, value: section_id },
      }
    );

    return success(res, subjectAvg.recordset);
  } catch (err) { next(err); }
};
