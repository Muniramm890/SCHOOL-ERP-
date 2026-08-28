// src/controllers/examController.js
const { query, queryOne, withTransaction, sql } = require('../config/db');
const { success, created, notFound, badRequest } = require('../utils/response');

// ═══════════════ EXAM GROUPS ═══════════════════════════════════════════════

// GET /api/exams?academic_year_id=xxx
exports.listExams = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { academic_year_id } = req.query;

    let where = `eg.school_id=@sid AND eg.deleted_at IS NULL`;
    const p = { sid: { type: sql.UniqueIdentifier, value: schoolId } };
    if (academic_year_id) {
      where += ` AND eg.academic_year_id=@ayid`;
      p.ayid = { type: sql.UniqueIdentifier, value: academic_year_id };
    }

    const result = await query(`
      SELECT eg.id, eg.name, eg.exam_type, eg.start_date, eg.end_date,
             eg.weightage_percent, eg.status, eg.academic_year_id,
             ay.name AS academic_year_name,
             COUNT(DISTINCT es.section_id) AS section_count,
             COUNT(DISTINCT exs.id) AS subject_count,
             (SELECT STRING_AGG(CAST(es2.section_id AS NVARCHAR(36)), ',')
                FROM exam_sections es2 WHERE es2.exam_group_id = eg.id) AS section_ids_csv
      FROM exam_groups eg
      JOIN academic_years ay ON ay.id = eg.academic_year_id
      LEFT JOIN exam_sections es ON es.exam_group_id = eg.id
      LEFT JOIN exam_subjects exs ON exs.exam_group_id = eg.id AND exs.deleted_at IS NULL
      WHERE ${where}
      GROUP BY eg.id, eg.name, eg.exam_type, eg.start_date, eg.end_date,
               eg.weightage_percent, eg.status, eg.academic_year_id, ay.name
      ORDER BY eg.start_date DESC
    `, p);

    const rows = result.recordset.map((r) => ({
      ...r,
      section_ids: r.section_ids_csv ? r.section_ids_csv.split(',') : [],
    }));
    return success(res, rows);
  } catch (err) { next(err); }
};

// GET /api/exams/:id  (full detail: exam + participating sections)
exports.getExam = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { id } = req.params;

    const exam = await queryOne(
      `SELECT * FROM exam_groups WHERE id=@id AND school_id=@sid AND deleted_at IS NULL`,
      { id: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    if (!exam) return notFound(res, 'Exam not found');

    const sections = await query(`
      SELECT sc.id, sc.name, sc.grade_id, g.name AS grade_name
      FROM exam_sections es
      JOIN sections sc ON sc.id = es.section_id
      JOIN grades g ON g.id = sc.grade_id
      WHERE es.exam_group_id = @id
      ORDER BY g.numeric_order, sc.name
    `, { id: { type: sql.UniqueIdentifier, value: id } });

    return success(res, { ...exam, sections: sections.recordset });
  } catch (err) { next(err); }
};

// POST /api/exams
exports.createExam = async (req, res, next) => {
  try {
    const { schoolId, userId } = req.user;
    const { name, exam_type, academic_year_id, start_date, end_date, weightage_percent } = req.body;

    if (!name || !academic_year_id || !start_date || !end_date) {
      return badRequest(res, 'name, academic_year_id, start_date and end_date are required');
    }

    const r = await query(`
      INSERT INTO exam_groups (id, school_id, academic_year_id, name, exam_type, start_date, end_date, weightage_percent, status, created_by)
      OUTPUT INSERTED.id
      VALUES (NEWID(), @sid, @ayid, @name, @etype, @sd, @ed, @wt, 'draft', @uid)
    `, {
      sid: { type: sql.UniqueIdentifier, value: schoolId },
      ayid: { type: sql.UniqueIdentifier, value: academic_year_id },
      name: { type: sql.NVarChar(200), value: name },
      etype: { type: sql.VarChar(30), value: exam_type || 'unit_test' },
      sd: { type: sql.Date, value: start_date },
      ed: { type: sql.Date, value: end_date },
      wt: { type: sql.Decimal(5, 2), value: Number(weightage_percent) || 0 },
      uid: { type: sql.UniqueIdentifier, value: userId },
    });

    return created(res, { id: r.recordset[0].id }, 'Exam created successfully');
  } catch (err) { next(err); }
};

// PUT /api/exams/:id
exports.updateExam = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { id } = req.params;
    const { name, exam_type, academic_year_id, start_date, end_date, weightage_percent, status } = req.body;

    await query(`
      UPDATE exam_groups
      SET name = ISNULL(@name, name),
          exam_type = ISNULL(@etype, exam_type),
          academic_year_id = ISNULL(@ayid, academic_year_id),
          start_date = ISNULL(@sd, start_date),
          end_date = ISNULL(@ed, end_date),
          weightage_percent = ISNULL(@wt, weightage_percent),
          status = ISNULL(@status, status),
          updated_at = GETUTCDATE()
      WHERE id=@id AND school_id=@sid AND deleted_at IS NULL
    `, {
      id: { type: sql.UniqueIdentifier, value: id },
      sid: { type: sql.UniqueIdentifier, value: schoolId },
      name: { type: sql.NVarChar(200), value: name || null },
      etype: { type: sql.VarChar(30), value: exam_type || null },
      ayid: { type: sql.UniqueIdentifier, value: academic_year_id || null },
      sd: { type: sql.Date, value: start_date || null },
      ed: { type: sql.Date, value: end_date || null },
      wt: { type: sql.Decimal(5, 2), value: weightage_percent != null ? Number(weightage_percent) : null },
      status: { type: sql.VarChar(20), value: status || null },
    });

    return success(res, null, 'Exam updated successfully');
  } catch (err) { next(err); }
};

// DELETE /api/exams/:id  (soft delete — hides exam + everything under it)
exports.deleteExam = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { id } = req.params;

    const exam = await queryOne(
      `SELECT id FROM exam_groups WHERE id=@id AND school_id=@sid AND deleted_at IS NULL`,
      { id: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    if (!exam) return notFound(res, 'Exam not found');

    await query(
      `UPDATE exam_groups SET deleted_at=GETUTCDATE(), updated_at=GETUTCDATE() WHERE id=@id AND school_id=@sid`,
      { id: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );

    return success(res, null, 'Exam deleted successfully');
  } catch (err) { next(err); }
};

// PUT /api/exams/:id/classes   Body: { section_ids: ["uuid", ...] }
exports.setExamClasses = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { id } = req.params;
    const { section_ids } = req.body;

    if (!Array.isArray(section_ids)) return badRequest(res, 'section_ids must be an array');

    const exam = await queryOne(
      `SELECT id FROM exam_groups WHERE id=@id AND school_id=@sid AND deleted_at IS NULL`,
      { id: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    if (!exam) return notFound(res, 'Exam not found');

    await withTransaction(async (tx) => {
      const rDel = tx.request();
      rDel.input('eid', sql.UniqueIdentifier, id);
      await rDel.query(`DELETE FROM exam_sections WHERE exam_group_id=@eid`);

      for (const sectionId of section_ids) {
        const rIns = tx.request();
        rIns.input('sid', sql.UniqueIdentifier, schoolId);
        rIns.input('eid', sql.UniqueIdentifier, id);
        rIns.input('secid', sql.UniqueIdentifier, sectionId);
        await rIns.query(
          `INSERT INTO exam_sections (id, exam_group_id, section_id, school_id) VALUES (NEWID(), @eid, @secid, @sid)`
        );
      }
    });

    return success(res, null, 'Exam classes updated successfully');
  } catch (err) { next(err); }
};

// ═══════════════ DATE SHEET ═════════════════════════════════════════════════

// GET /api/exams/:id/datesheet?section_id=xxx
exports.getDatesheet = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { id } = req.params;
    const { section_id } = req.query;
    if (!section_id) return badRequest(res, 'section_id query param is required');

    const result = await query(`
      SELECT exs.id, exs.subject_id, s.name AS subject_name, exs.exam_date,
             exs.start_time, exs.duration_minutes, exs.max_marks, exs.passing_marks
      FROM exam_subjects exs
      JOIN subjects s ON s.id = exs.subject_id
      WHERE exs.exam_group_id=@eid AND exs.section_id=@secid AND exs.school_id=@sid AND exs.deleted_at IS NULL
      ORDER BY exs.exam_date, exs.start_time
    `, {
      eid: { type: sql.UniqueIdentifier, value: id },
      secid: { type: sql.UniqueIdentifier, value: section_id },
      sid: { type: sql.UniqueIdentifier, value: schoolId },
    });

    return success(res, result.recordset);
  } catch (err) { next(err); }
};

// PUT /api/exams/:id/datesheet
// Body: { section_id, entries: [{ subject_id, exam_date, start_time, duration_minutes, max_marks, passing_marks }] }
exports.saveDatesheet = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { id } = req.params;
    const { section_id, entries } = req.body;

    if (!section_id) return badRequest(res, 'section_id is required');
    if (!Array.isArray(entries)) return badRequest(res, 'entries must be an array');

    await withTransaction(async (tx) => {
      const rDel = tx.request();
      rDel.input('sid', sql.UniqueIdentifier, schoolId);
      rDel.input('eid', sql.UniqueIdentifier, id);
      rDel.input('secid', sql.UniqueIdentifier, section_id);
      await rDel.query(
        `DELETE FROM exam_subjects WHERE school_id=@sid AND exam_group_id=@eid AND section_id=@secid`
      );

      for (const e of entries) {
        const r = tx.request();
        r.input('sid', sql.UniqueIdentifier, schoolId);
        r.input('eid', sql.UniqueIdentifier, id);
        r.input('secid', sql.UniqueIdentifier, section_id);
        r.input('subid', sql.UniqueIdentifier, e.subject_id);
        r.input('edate', sql.Date, e.exam_date || null);
        r.input('stime', sql.VarChar(8), e.start_time ? `${e.start_time}:00`.slice(0, 8) : '09:00:00');
        r.input('dur', sql.SmallInt, Number(e.duration_minutes) || 120);
        r.input('maxm', sql.Decimal(6, 2), Number(e.max_marks) || 100);
        r.input('passm', sql.Decimal(6, 2), Number(e.passing_marks) || 33);
        await r.query(`
          INSERT INTO exam_subjects
            (id, school_id, exam_group_id, section_id, subject_id, exam_date, start_time, duration_minutes, max_marks, passing_marks)
          VALUES (NEWID(), @sid, @eid, @secid, @subid, @edate, @stime, @dur, @maxm, @passm)
        `);
      }
    });

    return success(res, null, 'Date sheet saved successfully');
  } catch (err) { next(err); }
};

// DELETE /api/exams/:id/datesheet/:rowId
exports.deleteDatesheetRow = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { id, rowId } = req.params;
    await query(
      `DELETE FROM exam_subjects WHERE id=@rid AND exam_group_id=@eid AND school_id=@sid`,
      {
        rid: { type: sql.UniqueIdentifier, value: rowId },
        eid: { type: sql.UniqueIdentifier, value: id },
        sid: { type: sql.UniqueIdentifier, value: schoolId },
      }
    );
    return success(res, null, 'Removed from date sheet');
  } catch (err) { next(err); }
};

// ═══════════════ MARKS ENTRY ═══════════════════════════════════════════════

// GET /api/exams/:id/marks-roster?section_id=&subject_id=
exports.getMarksRoster = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { id } = req.params;
    const { section_id, subject_id } = req.query;
    if (!section_id || !subject_id) return badRequest(res, 'section_id and subject_id are required');

    const examSubject = await queryOne(
      `SELECT id, max_marks, passing_marks FROM exam_subjects
       WHERE exam_group_id=@eid AND section_id=@secid AND subject_id=@subid AND school_id=@sid AND deleted_at IS NULL`,
      {
        eid: { type: sql.UniqueIdentifier, value: id },
        secid: { type: sql.UniqueIdentifier, value: section_id },
        subid: { type: sql.UniqueIdentifier, value: subject_id },
        sid: { type: sql.UniqueIdentifier, value: schoolId },
      }
    );
    if (!examSubject) return notFound(res, 'This subject is not scheduled for this exam/class — build the date sheet first');

    const roster = await query(`
      SELECT st.id AS student_id, st.first_name, st.last_name, e.roll_no,
             em.marks_obtained, ISNULL(em.status, 'present') AS status, em.remarks
      FROM enrolments e
      JOIN students st ON st.id = e.student_id
      LEFT JOIN exam_marks em ON em.exam_subject_id = @esid AND em.student_id = st.id
      WHERE e.section_id = @secid AND e.school_id = @sid AND e.is_active = 1 AND e.deleted_at IS NULL
      ORDER BY e.roll_no
    `, {
      esid: { type: sql.UniqueIdentifier, value: examSubject.id },
      secid: { type: sql.UniqueIdentifier, value: section_id },
      sid: { type: sql.UniqueIdentifier, value: schoolId },
    });

    return success(res, roster.recordset);
  } catch (err) { next(err); }
};

// POST /api/exams/:id/marks
// Body: { exam_subject_id, entries: [{ student_id, marks_obtained, status, remarks }] }
exports.saveMarks = async (req, res, next) => {
  try {
    const { schoolId, userId } = req.user;
    const { exam_subject_id, entries } = req.body;

    if (!exam_subject_id) return badRequest(res, 'exam_subject_id is required');
    if (!Array.isArray(entries)) return badRequest(res, 'entries must be an array');

    await withTransaction(async (tx) => {
      for (const e of entries) {
        const rFind = tx.request();
        rFind.input('esid', sql.UniqueIdentifier, exam_subject_id);
        rFind.input('stuid', sql.UniqueIdentifier, e.student_id);
        const existing = await rFind.query(
          `SELECT id FROM exam_marks WHERE exam_subject_id=@esid AND student_id=@stuid`
        );

        if (existing.recordset.length > 0) {
          const rUpd = tx.request();
          rUpd.input('id', sql.UniqueIdentifier, existing.recordset[0].id);
          rUpd.input('marks', sql.Decimal(6, 2), Number(e.marks_obtained) || 0);
          rUpd.input('status', sql.VarChar(20), e.status || 'present');
          rUpd.input('remarks', sql.NVarChar(500), e.remarks || null);
          await rUpd.query(
            `UPDATE exam_marks SET marks_obtained=@marks, status=@status, remarks=@remarks, updated_at=GETUTCDATE() WHERE id=@id`
          );
        } else {
          const rIns = tx.request();
          rIns.input('sid', sql.UniqueIdentifier, schoolId);
          rIns.input('esid', sql.UniqueIdentifier, exam_subject_id);
          rIns.input('stuid', sql.UniqueIdentifier, e.student_id);
          rIns.input('marks', sql.Decimal(6, 2), Number(e.marks_obtained) || 0);
          rIns.input('status', sql.VarChar(20), e.status || 'present');
          rIns.input('remarks', sql.NVarChar(500), e.remarks || null);
          rIns.input('uid', sql.UniqueIdentifier, userId || null);
          await rIns.query(`
            INSERT INTO exam_marks (id, school_id, exam_subject_id, student_id, marks_obtained, status, remarks, entered_by)
            VALUES (NEWID(), @sid, @esid, @stuid, @marks, @status, @remarks, @uid)
          `);
        }
      }
    });

    return success(res, null, 'Marks saved successfully');
  } catch (err) { next(err); }
};

// ═══════════════ RESULT PROCESSING & PUBLISH ═══════════════════════════════

// POST /api/exams/:id/process   Body: { section_id }
exports.processResults = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { id } = req.params;
    const { section_id } = req.body;
    if (!section_id) return badRequest(res, 'section_id is required');

    const totalsRes = await query(`
      SELECT e.student_id, e.roll_no,
             SUM(ISNULL(em.marks_obtained, 0)) AS total_marks,
             (SELECT SUM(max_marks) FROM exam_subjects
                WHERE exam_group_id=@eid AND section_id=@secid AND deleted_at IS NULL) AS max_total
      FROM enrolments e
      LEFT JOIN exam_subjects exs ON exs.exam_group_id=@eid AND exs.section_id=@secid AND exs.deleted_at IS NULL
      LEFT JOIN exam_marks em ON em.exam_subject_id = exs.id AND em.student_id = e.student_id
      WHERE e.section_id=@secid AND e.school_id=@sid AND e.is_active=1 AND e.deleted_at IS NULL
      GROUP BY e.student_id, e.roll_no
    `, {
      eid: { type: sql.UniqueIdentifier, value: id },
      secid: { type: sql.UniqueIdentifier, value: section_id },
      sid: { type: sql.UniqueIdentifier, value: schoolId },
    });

    const gradingRes = await query(
      `SELECT grade_label, min_percent, max_percent FROM grading_scale WHERE school_id=@sid ORDER BY min_percent DESC`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    const scale = gradingRes.recordset;
    const gradeFor = (pct) => {
      const band = scale.find((b) => pct >= b.min_percent && pct <= b.max_percent);
      return band ? band.grade_label : (pct >= 33 ? 'D' : 'F');
    };

    const rows = totalsRes.recordset.map((r) => {
      const maxTotal = Number(r.max_total) || 0;
      const percentage = maxTotal > 0 ? Math.round((Number(r.total_marks) / maxTotal) * 10000) / 100 : 0;
      return { ...r, percentage, grade: gradeFor(percentage) };
    });

    // rank within this class-section for this exam (ties share rank)
    const sorted = [...rows].sort((a, b) => b.percentage - a.percentage);
    sorted.forEach((r, i) => {
      r.class_rank = i > 0 && sorted[i - 1].percentage === r.percentage ? sorted[i - 1].class_rank : i + 1;
    });

    await withTransaction(async (tx) => {
      const rDel = tx.request();
      rDel.input('eid', sql.UniqueIdentifier, id);
      rDel.input('secid', sql.UniqueIdentifier, section_id);
      await rDel.query(`DELETE FROM exam_results WHERE exam_group_id=@eid AND section_id=@secid`);

      for (const r of rows) {
        const rIns = tx.request();
        rIns.input('sid', sql.UniqueIdentifier, schoolId);
        rIns.input('eid', sql.UniqueIdentifier, id);
        rIns.input('secid', sql.UniqueIdentifier, section_id);
        rIns.input('stuid', sql.UniqueIdentifier, r.student_id);
        rIns.input('total', sql.Decimal(8, 2), Number(r.total_marks) || 0);
        rIns.input('maxtot', sql.Decimal(8, 2), Number(r.max_total) || 0);
        rIns.input('pct', sql.Decimal(5, 2), r.percentage);
        rIns.input('grade', sql.VarChar(10), r.grade);
        rIns.input('rank', sql.Int, r.class_rank);
        await rIns.query(`
          INSERT INTO exam_results (id, school_id, exam_group_id, section_id, student_id, total_marks, max_total, percentage, grade, class_rank, status)
          VALUES (NEWID(), @sid, @eid, @secid, @stuid, @total, @maxtot, @pct, @grade, @rank, 'draft')
        `);
      }
    });

    return success(res, null, 'Results processed successfully');
  } catch (err) { next(err); }
};

// GET /api/exams/:id/results?section_id=xxx
exports.getResults = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { id } = req.params;
    const { section_id } = req.query;
    if (!section_id) return badRequest(res, 'section_id is required');

    const subjectsRes = await query(`
      SELECT exs.id, s.name FROM exam_subjects exs
      JOIN subjects s ON s.id = exs.subject_id
      WHERE exs.exam_group_id=@eid AND exs.section_id=@secid AND exs.deleted_at IS NULL
      ORDER BY exs.exam_date
    `, { eid: { type: sql.UniqueIdentifier, value: id }, secid: { type: sql.UniqueIdentifier, value: section_id } });

    const resultsRes = await query(`
      SELECT er.student_id, st.first_name, st.last_name, e.roll_no,
             er.total_marks, er.max_total, er.percentage, er.grade, er.class_rank, er.status
      FROM exam_results er
      JOIN students st ON st.id = er.student_id
      LEFT JOIN enrolments e ON e.student_id = er.student_id AND e.section_id = er.section_id AND e.is_active=1
      WHERE er.exam_group_id=@eid AND er.section_id=@secid AND er.school_id=@sid
      ORDER BY er.class_rank
    `, {
      eid: { type: sql.UniqueIdentifier, value: id },
      secid: { type: sql.UniqueIdentifier, value: section_id },
      sid: { type: sql.UniqueIdentifier, value: schoolId },
    });

    const marksRes = await query(`
      SELECT em.student_id, em.exam_subject_id, em.marks_obtained
      FROM exam_marks em
      JOIN exam_subjects exs ON exs.id = em.exam_subject_id
      WHERE exs.exam_group_id=@eid AND exs.section_id=@secid
    `, { eid: { type: sql.UniqueIdentifier, value: id }, secid: { type: sql.UniqueIdentifier, value: section_id } });

    const marksMap = {};
    marksRes.recordset.forEach((m) => {
      if (!marksMap[m.student_id]) marksMap[m.student_id] = {};
      marksMap[m.student_id][m.exam_subject_id] = m.marks_obtained;
    });

    const rows = resultsRes.recordset.map((r) => ({ ...r, marks: marksMap[r.student_id] || {} }));

    return success(res, { subjects: subjectsRes.recordset, rows });
  } catch (err) { next(err); }
};

// PUT /api/exams/:id/publish
exports.publishExam = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { id } = req.params;

    await query(`UPDATE exam_groups SET status='published', updated_at=GETUTCDATE() WHERE id=@id AND school_id=@sid`, {
      id: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId },
    });
    await query(`UPDATE exam_results SET status='published' WHERE exam_group_id=@id AND school_id=@sid`, {
      id: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId },
    });

    return success(res, null, 'Results published successfully');
  } catch (err) { next(err); }
};

// PUT /api/exams/:id/unpublish
exports.unpublishExam = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { id } = req.params;

    await query(`UPDATE exam_groups SET status='completed', updated_at=GETUTCDATE() WHERE id=@id AND school_id=@sid`, {
      id: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId },
    });
    await query(`UPDATE exam_results SET status='draft' WHERE exam_group_id=@id AND school_id=@sid`, {
      id: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId },
    });

    return success(res, null, 'Results reopened for editing');
  } catch (err) { next(err); }
};

// DELETE /api/exams/:id/results/:studentId
exports.deleteStudentResult = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { id, studentId } = req.params;

    await query(
      `DELETE FROM exam_results WHERE exam_group_id=@eid AND student_id=@stuid AND school_id=@sid`,
      {
        eid: { type: sql.UniqueIdentifier, value: id },
        stuid: { type: sql.UniqueIdentifier, value: studentId },
        sid: { type: sql.UniqueIdentifier, value: schoolId },
      }
    );

    return success(res, null, 'Result deleted successfully');
  } catch (err) { next(err); }
};

// ═══════════════ GRADING SCALE ══════════════════════════════════════════════
// (These two are meant to be wired under /api/setup — see routes note below)

// GET /api/setup/grading-scale
exports.getGradingScale = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const result = await query(
      `SELECT grade_label, min_percent, max_percent FROM grading_scale WHERE school_id=@sid ORDER BY min_percent DESC`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    return success(res, result.recordset);
  } catch (err) { next(err); }
};

// PUT /api/setup/grading-scale   Body: { scale: [{ grade_label, min_percent, max_percent }] }
exports.saveGradingScale = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { scale } = req.body;
    if (!Array.isArray(scale)) return badRequest(res, 'scale must be an array');

    await withTransaction(async (tx) => {
      const rDel = tx.request();
      rDel.input('sid', sql.UniqueIdentifier, schoolId);
      await rDel.query(`DELETE FROM grading_scale WHERE school_id=@sid`);

      for (let i = 0; i < scale.length; i++) {
        const band = scale[i];
        const r = tx.request();
        r.input('sid', sql.UniqueIdentifier, schoolId);
        r.input('label', sql.VarChar(10), band.grade_label);
        r.input('minp', sql.Decimal(5, 2), Number(band.min_percent) || 0);
        r.input('maxp', sql.Decimal(5, 2), Number(band.max_percent) || 0);
        r.input('sort', sql.SmallInt, i);
        await r.query(`
          INSERT INTO grading_scale (id, school_id, grade_label, min_percent, max_percent, sort_order)
          VALUES (NEWID(), @sid, @label, @minp, @maxp, @sort)
        `);
      }
    });

    return success(res, null, 'Grading scale saved successfully');
  } catch (err) { next(err); }
};
