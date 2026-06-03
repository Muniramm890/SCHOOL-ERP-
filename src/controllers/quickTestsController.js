// src/controllers/quickTestsController.js
const { query, queryOne, withTransaction, sql } = require('../config/db');
const { success, created, notFound, badRequest, paginated } = require('../utils/response');
const { audit } = require('../utils/audit');
const { v4: uuidv4 } = require('uuid');

// ── GET /api/quick-tests?section_id=&subject_id=&academic_year_id= ────────
exports.list = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { section_id, subject_id, academic_year_id, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let where = `qt.school_id = @sid AND qt.deleted_at IS NULL`;
    const params = { sid: { type: sql.UniqueIdentifier, value: schoolId } };

    if (section_id)       { where += ` AND qt.section_id = @secId`;   params.secId = { type: sql.UniqueIdentifier, value: section_id }; }
    if (subject_id)       { where += ` AND qt.subject_id = @subId`;   params.subId = { type: sql.UniqueIdentifier, value: subject_id }; }
    if (academic_year_id) { where += ` AND qt.academic_year_id = @ayId`; params.ayId = { type: sql.UniqueIdentifier, value: academic_year_id }; }

    const count = await queryOne(`SELECT COUNT(*) AS total FROM quick_tests qt WHERE ${where}`, params);

    const tests = await query(
      `SELECT qt.*,
              sub.name       AS subject_name,
              u.full_name    AS teacher_name,
              g.name         AS class_name,
              sc.name        AS section_name,
              -- Aggregate stats from results
              AVG(CAST(qtr.marks_obtained AS FLOAT)) AS avg_marks,
              MAX(qtr.marks_obtained)                AS max_marks_obtained,
              MIN(qtr.marks_obtained)                AS min_marks_obtained,
              COUNT(qtr.id)                          AS entries_count
       FROM quick_tests qt
       JOIN subjects sub ON sub.id = qt.subject_id
       JOIN users u      ON u.id   = qt.teacher_id
       JOIN sections sc  ON sc.id  = qt.section_id
       JOIN grades g     ON g.id   = sc.grade_id
       LEFT JOIN quick_test_results qtr ON qtr.quick_test_id = qt.id AND qtr.deleted_at IS NULL
       WHERE ${where}
       GROUP BY qt.id, qt.school_id, qt.section_id, qt.subject_id, qt.teacher_id, qt.academic_year_id,
                qt.title, qt.topic, qt.date, qt.max_marks, qt.duration_minutes, qt.is_graded,
                qt.created_at, qt.updated_at, qt.deleted_at,
                sub.name, u.full_name, g.name, sc.name
       ORDER BY qt.date DESC
       OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
      { ...params, offset: { type: sql.Int, value: +offset }, limit: { type: sql.Int, value: +limit } }
    );

    return paginated(res, tests.recordset, count.total, page, limit);
  } catch (err) { next(err); }
};

// ── GET /api/quick-tests/:id ──────────────────────────────────────────────
exports.getOne = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { id } = req.params;

    const test = await queryOne(
      `SELECT qt.*, sub.name AS subject_name, g.name AS class_name, sc.name AS section_name,
              u.full_name AS teacher_name
       FROM quick_tests qt
       JOIN subjects sub ON sub.id = qt.subject_id
       JOIN sections sc  ON sc.id  = qt.section_id
       JOIN grades g     ON g.id   = sc.grade_id
       JOIN users u      ON u.id   = qt.teacher_id
       WHERE qt.id = @id AND qt.school_id = @sid AND qt.deleted_at IS NULL`,
      { id: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    if (!test) return notFound(res, 'Quick test not found');

    // Get all results with student names
    const results = await query(
      `SELECT qtr.*,
              s.first_name + ' ' + s.last_name AS student_name,
              s.photo_url, e.roll_no
       FROM quick_test_results qtr
       JOIN students s   ON s.id = qtr.student_id
       JOIN enrolments e ON e.student_id = s.id AND e.section_id = @secId AND e.school_id = @sid AND e.is_active = 1
       WHERE qtr.quick_test_id = @id AND qtr.school_id = @sid AND qtr.deleted_at IS NULL
       ORDER BY e.roll_no`,
      {
        id:    { type: sql.UniqueIdentifier, value: id },
        sid:   { type: sql.UniqueIdentifier, value: schoolId },
        secId: { type: sql.UniqueIdentifier, value: test.section_id },
      }
    );

    return success(res, { ...test, results: results.recordset });
  } catch (err) { next(err); }
};

// ── POST /api/quick-tests ─────────────────────────────────────────────────
exports.create = async (req, res, next) => {
  try {
    const { schoolId, userId } = req.user;
    const {
      section_id, subject_id, academic_year_id,
      title, topic, date, max_marks = 20,
      duration_minutes, is_graded = true,
      results = [],  // optional: [{student_id, marks_obtained, is_absent, remarks}]
    } = req.body;

    const testId = uuidv4();

    await withTransaction(async (tx) => {
      const r1 = tx.request();
      r1.input('id',          sql.UniqueIdentifier, testId);
      r1.input('sid',         sql.UniqueIdentifier, schoolId);
      r1.input('secId',       sql.UniqueIdentifier, section_id);
      r1.input('subId',       sql.UniqueIdentifier, subject_id);
      r1.input('teacherId',   sql.UniqueIdentifier, userId);
      r1.input('ayId',        sql.UniqueIdentifier, academic_year_id);
      r1.input('title',       sql.NVarChar(255),    title);
      r1.input('topic',       sql.NVarChar(255),    topic || null);
      r1.input('date',        sql.Date,             date);
      r1.input('maxMarks',    sql.SmallInt,         max_marks);
      r1.input('duration',    sql.SmallInt,         duration_minutes || null);
      r1.input('isGraded',    sql.Bit,              is_graded ? 1 : 0);
      await r1.query(
        `INSERT INTO quick_tests (id,school_id,section_id,subject_id,teacher_id,academic_year_id,title,topic,date,max_marks,duration_minutes,is_graded)
         VALUES(@id,@sid,@secId,@subId,@teacherId,@ayId,@title,@topic,@date,@maxMarks,@duration,@isGraded)`
      );

      for (const res_row of results) {
        const r2 = tx.request();
        r2.input('id',        sql.UniqueIdentifier, uuidv4());
        r2.input('sid',       sql.UniqueIdentifier, schoolId);
        r2.input('testId',    sql.UniqueIdentifier, testId);
        r2.input('studentId', sql.UniqueIdentifier, res_row.student_id);
        r2.input('marks',     sql.Decimal(5,2),     res_row.marks_obtained ?? null);
        r2.input('isAbsent',  sql.Bit,              res_row.is_absent ? 1 : 0);
        r2.input('remarks',   sql.NVarChar(sql.MAX), res_row.remarks || null);
        await r2.query(
          `INSERT INTO quick_test_results (id,school_id,quick_test_id,student_id,marks_obtained,is_absent,remarks)
           VALUES(@id,@sid,@testId,@studentId,@marks,@isAbsent,@remarks)`
        );
      }
    });

    await audit({ req, action: 'CREATE', tableName: 'quick_tests', recordId: testId, newValues: req.body });
    return created(res, { id: testId }, 'Quick test created');
  } catch (err) { next(err); }
};

// ── PUT /api/quick-tests/:id/results ──────────────────────────────────────
// Save / update marks for existing test
exports.saveResults = async (req, res, next) => {
  try {
    const { id: testId } = req.params;
    const { schoolId } = req.user;
    const { results } = req.body;  // [{student_id, marks_obtained, is_absent, remarks}]

    if (!Array.isArray(results)) return badRequest(res, 'results[] required');

    const test = await queryOne(
      `SELECT id, max_marks FROM quick_tests WHERE id = @id AND school_id = @sid AND deleted_at IS NULL`,
      { id: { type: sql.UniqueIdentifier, value: testId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    if (!test) return notFound(res, 'Quick test not found');

    await withTransaction(async (tx) => {
      for (const r of results) {
        const chk = tx.request();
        chk.input('testId',    sql.UniqueIdentifier, testId);
        chk.input('studentId', sql.UniqueIdentifier, r.student_id);
        chk.input('sid',       sql.UniqueIdentifier, schoolId);
        const existing = await chk.query(
          `SELECT id FROM quick_test_results WHERE quick_test_id=@testId AND student_id=@studentId AND school_id=@sid AND deleted_at IS NULL`
        );

        if (existing.recordset.length > 0) {
          const upd = tx.request();
          upd.input('id',       sql.UniqueIdentifier, existing.recordset[0].id);
          upd.input('marks',    sql.Decimal(5,2),     r.marks_obtained ?? null);
          upd.input('isAbsent', sql.Bit,              r.is_absent ? 1 : 0);
          upd.input('remarks',  sql.NVarChar(sql.MAX), r.remarks || null);
          await upd.query(
            `UPDATE quick_test_results SET marks_obtained=@marks, is_absent=@isAbsent, remarks=@remarks, updated_at=GETUTCDATE() WHERE id=@id`
          );
        } else {
          const ins = tx.request();
          ins.input('id',        sql.UniqueIdentifier, uuidv4());
          ins.input('sid',       sql.UniqueIdentifier, schoolId);
          ins.input('testId',    sql.UniqueIdentifier, testId);
          ins.input('studentId', sql.UniqueIdentifier, r.student_id);
          ins.input('marks',     sql.Decimal(5,2),     r.marks_obtained ?? null);
          ins.input('isAbsent',  sql.Bit,              r.is_absent ? 1 : 0);
          ins.input('remarks',   sql.NVarChar(sql.MAX), r.remarks || null);
          await ins.query(
            `INSERT INTO quick_test_results (id,school_id,quick_test_id,student_id,marks_obtained,is_absent,remarks)
             VALUES(@id,@sid,@testId,@studentId,@marks,@isAbsent,@remarks)`
          );
        }
      }
    });

    await audit({ req, action: 'UPDATE', tableName: 'quick_test_results', recordId: testId });
    return success(res, null, `${results.length} results saved`);
  } catch (err) { next(err); }
};

// ── DELETE /api/quick-tests/:id ───────────────────────────────────────────
exports.remove = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { schoolId } = req.user;
    await query(
      `UPDATE quick_tests SET deleted_at = GETUTCDATE() WHERE id = @id AND school_id = @sid AND deleted_at IS NULL;
       UPDATE quick_test_results SET deleted_at = GETUTCDATE() WHERE quick_test_id = @id AND school_id = @sid`,
      { id: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    return success(res, null, 'Quick test deleted');
  } catch (err) { next(err); }
};
