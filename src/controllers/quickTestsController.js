
// src/controllers/quickTestsController.js
const { query, queryOne, withTransaction, sql } = require('../config/db');
const { success, created, notFound, badRequest, paginated } = require('../utils/response');
const { v4: uuidv4 } = require('uuid');

// ── GET /api/quick-tests ──────────────────────────────────────────────────
// Filters: section_id, subject_id, academic_year_id, status
exports.list = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { section_id, subject_id, academic_year_id, status, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    let where = `qt.school_id = @sid AND qt.deleted_at IS NULL`;
    const params = { sid: { type: sql.UniqueIdentifier, value: schoolId } };

    if (section_id) { where += ` AND qt.section_id = @secId`; params.secId = { type: sql.UniqueIdentifier, value: section_id }; }
    if (subject_id) { where += ` AND qt.subject_id = @subId`; params.subId = { type: sql.UniqueIdentifier, value: subject_id }; }
    if (academic_year_id) { where += ` AND qt.academic_year_id = @ayId`; params.ayId = { type: sql.UniqueIdentifier, value: academic_year_id }; }
    if (status) { where += ` AND qt.status = @status`; params.status = { type: sql.VarChar(20), value: status.toUpperCase() }; }

    const count = await queryOne(`SELECT COUNT(*) AS total FROM quick_tests qt WHERE ${where}`, params);

    const tests = await query(
      `SELECT qt.id AS test_id, qt.title AS test_name, qt.chapter_name, qt.topic, qt.date, 
              qt.max_marks, qt.duration_minutes, qt.status, qt.result_visibility, qt.created_at,
              sub.name AS subject_name, sub.id AS subject_id,
              u.full_name AS teacher_name,
              g.name AS class_name, sc.name AS section_name,
              -- Aggregate stats
              ISNULL(AVG(CAST(qtr.marks_obtained AS FLOAT)), 0) AS avg_marks,
              ISNULL(MAX(qtr.marks_obtained), 0) AS max_marks_obtained,
              ISNULL(MIN(qtr.marks_obtained), 0) AS min_marks_obtained,
              COUNT(qtr.id) AS attempt_count
       FROM quick_tests qt
       JOIN subjects sub ON sub.id = qt.subject_id
       JOIN users u      ON u.id   = qt.teacher_id
       JOIN sections sc  ON sc.id  = qt.section_id
       JOIN grades g     ON g.id   = sc.grade_id
       LEFT JOIN quick_test_results qtr ON qtr.quick_test_id = qt.id AND qtr.deleted_at IS NULL
       WHERE ${where}
       GROUP BY qt.id, qt.school_id, qt.section_id, qt.subject_id, qt.teacher_id, qt.academic_year_id,
                qt.title, qt.chapter_name, qt.topic, qt.date, qt.max_marks, qt.duration_minutes, 
                qt.status, qt.result_visibility, qt.created_at,
                sub.name, sub.id, u.full_name, g.name, sc.name
       ORDER BY qt.created_at DESC
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

    // Fetch Test Metadata (includes questions_payload for Wizard/Print)
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

    // Fetch Results mapped with Full Class Roster
    const results = await query(
      `SELECT e.student_id, 
              s.first_name + ' ' + ISNULL(s.last_name, '') AS student_name,
              s.photo_url, e.roll_no,
              qtr.id AS result_id, qtr.marks_obtained, qtr.is_absent, qtr.remarks
       FROM enrolments e
       JOIN users s ON s.id = e.student_id
       LEFT JOIN quick_test_results qtr ON qtr.student_id = e.student_id 
                                        AND qtr.quick_test_id = @id 
                                        AND qtr.deleted_at IS NULL
       WHERE e.section_id = @secId AND e.school_id = @sid AND e.is_active = 1 AND e.deleted_at IS NULL
       ORDER BY e.roll_no`,
      {
        id:    { type: sql.UniqueIdentifier, value: id },
        sid:   { type: sql.UniqueIdentifier, value: schoolId },
        secId: { type: sql.UniqueIdentifier, value: test.section_id },
      }
    );

    return success(res, { ...test, results: results.recordset }, "Test details and roster fetched");
  } catch (err) { next(err); }
};

// ── POST /api/quick-tests ─────────────────────────────────────────────────
// Used for creating a test (and optionally saving OCR questions payload)
exports.create = async (req, res, next) => {
  try {
    const { schoolId, userId } = req.user;
    const {
      section_id, subject_id, academic_year_id,
      title, chapter_name = 'Mix Topics', topic, date, 
      max_marks = 20, duration_minutes = 30, 
      status = 'DRAFT', result_visibility = 'HIDDEN',
      questions_payload = null // For upcoming OCR Wizard
    } = req.body;

    if (!section_id || !subject_id || !title) return badRequest(res, "Section, Subject, and Title are required.");

    const testId = uuidv4();

    await query(
      `INSERT INTO quick_tests (
          id, school_id, section_id, subject_id, teacher_id, academic_year_id, 
          title, chapter_name, topic, date, max_marks, duration_minutes, 
          status, result_visibility, questions_payload
       ) VALUES (
          @id, @sid, @secId, @subId, @teacherId, @ayId, 
          @title, @chap, @topic, @date, @maxMarks, @duration, 
          @status, @visibility, @questions
       )`,
      {
        id:         { type: sql.UniqueIdentifier, value: testId },
        sid:        { type: sql.UniqueIdentifier, value: schoolId },
        secId:      { type: sql.UniqueIdentifier, value: section_id },
        subId:      { type: sql.UniqueIdentifier, value: subject_id },
        teacherId:  { type: sql.UniqueIdentifier, value: userId },
        ayId:       { type: sql.UniqueIdentifier, value: academic_year_id || null },
        title:      { type: sql.NVarChar(255),    value: title },
        chap:       { type: sql.NVarChar(255),    value: chapter_name },
        topic:      { type: sql.NVarChar(255),    value: topic || null },
        date:       { type: sql.Date,             value: date || new Date() },
        maxMarks:   { type: sql.SmallInt,         value: max_marks },
        duration:   { type: sql.SmallInt,         value: duration_minutes },
        status:     { type: sql.VarChar(20),      value: status.toUpperCase() },
        visibility: { type: sql.VarChar(20),      value: result_visibility.toUpperCase() },
        questions:  { type: sql.NVarChar(sql.MAX),value: questions_payload ? JSON.stringify(questions_payload) : null }
      }
    );

    return created(res, { test_id: testId }, 'Quick test created successfully');
  } catch (err) { next(err); }
};

// ── PUT /api/quick-tests/:id/meta ─────────────────────────────────────────
// Used for updating Status, Visibility, Duration from the UI Settings Modal
exports.updateMeta = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { schoolId } = req.user;
    const { status, result_visibility, duration_minutes, max_marks } = req.body;

    const test = await queryOne(`SELECT id FROM quick_tests WHERE id = @id AND school_id = @sid AND deleted_at IS NULL`, 
      { id: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId } });
    if (!test) return notFound(res, 'Quick test not found');

    await query(
      `UPDATE quick_tests 
       SET status = ISNULL(@st, status),
           result_visibility = ISNULL(UPPER(@vis), result_visibility),
           duration_minutes = ISNULL(@dur, duration_minutes),
           max_marks = ISNULL(@max, max_marks),
           updated_at = GETUTCDATE()
       WHERE id = @id AND school_id = @sid`,
      {
        id:  { type: sql.UniqueIdentifier, value: id },
        sid: { type: sql.UniqueIdentifier, value: schoolId },
        st:  { type: sql.VarChar(20), value: status ? status.toUpperCase() : null },
        vis: { type: sql.VarChar(20), value: result_visibility || null },
        dur: { type: sql.SmallInt,    value: duration_minutes || null },
        max: { type: sql.SmallInt,    value: max_marks || null }
      }
    );

    return success(res, null, 'Test settings updated successfully');
  } catch (err) { next(err); }
};

// ── PUT /api/quick-tests/:id/results ──────────────────────────────────────
exports.saveResults = async (req, res, next) => {
  try {
    const { id: testId } = req.params;
    const { schoolId } = req.user;
    const { results } = req.body; // Expects: [{ student_id, marks_obtained, is_absent, remarks }]

    if (!Array.isArray(results)) return badRequest(res, 'results array is required');

    const test = await queryOne(`SELECT id, max_marks FROM quick_tests WHERE id = @id AND school_id = @sid`, 
      { id: { type: sql.UniqueIdentifier, value: testId }, sid: { type: sql.UniqueIdentifier, value: schoolId } });
    
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
          upd.input('marks',    sql.Decimal(5,2),     r.is_absent ? 0 : r.marks_obtained);
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
          ins.input('marks',     sql.Decimal(5,2),     r.is_absent ? 0 : r.marks_obtained);
          ins.input('isAbsent',  sql.Bit,              r.is_absent ? 1 : 0);
          ins.input('remarks',   sql.NVarChar(sql.MAX), r.remarks || null);
          await ins.query(
            `INSERT INTO quick_test_results (id, school_id, quick_test_id, student_id, marks_obtained, is_absent, remarks)
             VALUES(@id, @sid, @testId, @studentId, @marks, @isAbsent, @remarks)`
          );
        }
      }
    });

    return success(res, null, `${results.length} marks entries synced successfully`);
  } catch (err) { next(err); }
};

// ── DELETE /api/quick-tests/:id ───────────────────────────────────────────
exports.remove = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { schoolId } = req.user;

    await withTransaction(async (tx) => {
      const rDelRes = tx.request();
      rDelRes.input('id', sql.UniqueIdentifier, id);
      rDelRes.input('sid', sql.UniqueIdentifier, schoolId);
      await rDelRes.query(`UPDATE quick_test_results SET deleted_at = GETUTCDATE() WHERE quick_test_id = @id AND school_id = @sid`);

      const rDelTest = tx.request();
      rDelTest.input('id', sql.UniqueIdentifier, id);
      rDelTest.input('sid', sql.UniqueIdentifier, schoolId);
      await rDelTest.query(`UPDATE quick_tests SET deleted_at = GETUTCDATE() WHERE id = @id AND school_id = @sid`);
    });

    return success(res, null, 'Quick test and its questions/results have been deleted permanently.');
  } catch (err) { next(err); }
};

