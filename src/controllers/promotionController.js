// src/controllers/promotionController.js
// 🔴 Session-transition module: promote/retain/TC students at year-end, keep full audit trail
const { query, queryOne, withTransaction, sql } = require('../config/db');
const { success, created, notFound, badRequest } = require('../utils/response');
const { logAudit } = require('../utils/auditLogger');

// ── GET /api/promotion/overview?from_academic_year_id=&to_academic_year_id= ──
exports.overview = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    let { from_academic_year_id, to_academic_year_id } = req.query;

    if (!from_academic_year_id) {
      const cur = await queryOne(
        `SELECT id FROM academic_years WHERE school_id=@sid AND is_current=1`,
        { sid: { type: sql.UniqueIdentifier, value: schoolId } }
      );
      from_academic_year_id = cur?.id;
    }
    if (!from_academic_year_id) return badRequest(res, 'No academic year found for this school');

    const byGradeRes = await query(
      `SELECT g.id AS grade_id, g.name AS grade_name, sec.id AS section_id, sec.name AS section_name,
              COUNT(e.id) AS total_students,
              SUM(CASE WHEN e.is_active = 0 THEN 1 ELSE 0 END) AS processed,
              SUM(CASE WHEN e.is_active = 1 THEN 1 ELSE 0 END) AS pending
       FROM enrolments e
       JOIN sections sec ON sec.id = e.section_id
       JOIN grades g ON g.id = sec.grade_id
       WHERE e.school_id=@sid AND e.academic_year_id=@fy AND e.deleted_at IS NULL
       GROUP BY g.id, g.name, g.numeric_order, sec.id, sec.name
       ORDER BY g.numeric_order, sec.name`,
      {
        sid: { type: sql.UniqueIdentifier, value: schoolId },
        fy: { type: sql.UniqueIdentifier, value: from_academic_year_id },
      }
    );

    const exitsRes = await query(
      `SELECT exit_type, COUNT(*) AS cnt FROM student_exits WHERE school_id=@sid AND academic_year_id=@fy GROUP BY exit_type`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId }, fy: { type: sql.UniqueIdentifier, value: from_academic_year_id } }
    );

    const transitionsRes = await query(
      `SELECT transition_type, COUNT(*) AS cnt FROM enrolments
       WHERE school_id=@sid AND deleted_at IS NULL AND promoted_from_id IN (
         SELECT id FROM enrolments WHERE school_id=@sid AND academic_year_id=@fy
       )
       GROUP BY transition_type`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId }, fy: { type: sql.UniqueIdentifier, value: from_academic_year_id } }
    );

    const rows = byGradeRes.recordset;
    const totals = rows.reduce(
      (acc, r) => {
        acc.total += r.total_students;
        acc.processed += r.processed;
        acc.pending += r.pending;
        return acc;
      },
      { total: 0, processed: 0, pending: 0, promoted: 0, retained: 0, tc: 0, graduated: 0 }
    );
    exitsRes.recordset.forEach((e) => { totals[e.exit_type] = e.cnt; });
    transitionsRes.recordset.forEach((t) => { if (t.transition_type) totals[t.transition_type] = t.cnt; });

    return success(res, {
      from_academic_year_id,
      to_academic_year_id: to_academic_year_id || null,
      totals,
      by_grade_section: rows,
    });
  } catch (err) { next(err); }
};

// ── GET /api/promotion/section-students?section_id=&academic_year_id= ──
exports.getSectionStudents = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { section_id, academic_year_id } = req.query;
    if (!section_id || !academic_year_id) return badRequest(res, 'section_id and academic_year_id are required');

    const rows = await query(
      `SELECT e.id AS enrolment_id, e.roll_no,
              s.id AS student_id, s.first_name, s.middle_name, s.last_name, s.admission_no, s.photo_url,
              sec.id AS current_section_id, sec.name AS current_section_name,
              g.id AS current_grade_id, g.name AS current_grade_name, g.numeric_order,
              er.percentage, er.grade AS result_grade
       FROM enrolments e
       JOIN students s ON s.id = e.student_id
       JOIN sections sec ON sec.id = e.section_id
       JOIN grades g ON g.id = sec.grade_id
       OUTER APPLY (
         SELECT TOP 1 x.percentage, x.grade
         FROM exam_results x
         JOIN exam_groups eg ON eg.id = x.exam_group_id
         WHERE x.student_id = s.id AND eg.academic_year_id = e.academic_year_id
         ORDER BY eg.end_date DESC
       ) er
       WHERE e.school_id=@sid AND e.section_id=@secId AND e.academic_year_id=@ay
         AND e.is_active=1 AND e.deleted_at IS NULL
       ORDER BY TRY_CAST(e.roll_no AS INT), e.roll_no`,
      {
        sid: { type: sql.UniqueIdentifier, value: schoolId },
        secId: { type: sql.UniqueIdentifier, value: section_id },
        ay: { type: sql.UniqueIdentifier, value: academic_year_id },
      }
    );

    const suggestionRes = await query(
      `SELECT TOP 1 sec2.id, sec2.name
       FROM sections sec2
       JOIN grades g2 ON g2.id = sec2.grade_id
       WHERE sec2.school_id=@sid AND g2.numeric_order = (
         SELECT g.numeric_order + 1 FROM sections sc JOIN grades g ON g.id = sc.grade_id WHERE sc.id=@secId
       )
       ORDER BY sec2.name`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId }, secId: { type: sql.UniqueIdentifier, value: section_id } }
    );

    return success(res, {
      students: rows.recordset,
      suggested_next_section: suggestionRes.recordset[0] || null,
    });
  } catch (err) { next(err); }
};

// ── POST /api/promotion/run ──
// body: { from_academic_year_id, to_academic_year_id, actions: [{ enrolment_id, student_id, action, to_section_id, roll_no, reason }] }
exports.runPromotion = async (req, res, next) => {
  try {
    const { schoolId, id: userId } = req.user;
    const { from_academic_year_id, to_academic_year_id, actions } = req.body;

    if (!from_academic_year_id || !to_academic_year_id) return badRequest(res, 'from_academic_year_id and to_academic_year_id are required');
    if (!Array.isArray(actions) || actions.length === 0) return badRequest(res, 'actions array is required');

    const counts = { promoted: 0, retained: 0, tc: 0, graduated: 0, skipped: 0 };

    const runId = await withTransaction(async (tx) => {
      const runIns = await new sql.Request(tx)
        .input('sid', sql.UniqueIdentifier, schoolId)
        .input('fy', sql.UniqueIdentifier, from_academic_year_id)
        .input('ty', sql.UniqueIdentifier, to_academic_year_id)
        .input('by', sql.UniqueIdentifier, userId || null)
        .query(
          `INSERT INTO promotion_runs (school_id, from_academic_year_id, to_academic_year_id, run_by)
           OUTPUT INSERTED.id
           VALUES (@sid, @fy, @ty, @by)`
        );
      const newRunId = runIns.recordset[0].id;

      for (const act of actions) {
        const { enrolment_id, student_id, action, to_section_id, roll_no, reason } = act;
        if (!enrolment_id || !student_id || !action) { counts.skipped++; continue; }

        const oldEnrRes = await new sql.Request(tx)
          .input('id', sql.UniqueIdentifier, enrolment_id)
          .input('sid', sql.UniqueIdentifier, schoolId)
          .input('stid', sql.UniqueIdentifier, student_id)
          .input('fy', sql.UniqueIdentifier, from_academic_year_id)
          .query(
            `SELECT id, section_id FROM enrolments
             WHERE id=@id AND school_id=@sid AND student_id=@stid AND academic_year_id=@fy AND is_active=1`
          );
        const oldEnr = oldEnrRes.recordset[0];
        if (!oldEnr) { counts.skipped++; continue; } // already processed / invalid — skip silently

        await new sql.Request(tx)
          .input('id', sql.UniqueIdentifier, enrolment_id)
          .query(`UPDATE enrolments SET is_active=0, updated_at=GETUTCDATE() WHERE id=@id`);

        if (action === 'promote' || action === 'retain') {
          const sectionId = action === 'retain' ? oldEnr.section_id : to_section_id;
          if (!sectionId) { counts.skipped++; continue; }
          await new sql.Request(tx)
            .input('sid', sql.UniqueIdentifier, schoolId)
            .input('stid', sql.UniqueIdentifier, student_id)
            .input('secId', sql.UniqueIdentifier, sectionId)
            .input('ty', sql.UniqueIdentifier, to_academic_year_id)
            .input('roll', sql.NVarChar(50), roll_no || null)
            .input('pfid', sql.UniqueIdentifier, enrolment_id)
            .input('runId', sql.UniqueIdentifier, newRunId)
            .input('ttype', sql.VarChar(20), action === 'promote' ? 'promoted' : 'retained')
            .query(
              `INSERT INTO enrolments (school_id, student_id, section_id, academic_year_id, roll_no, promoted_from_id, promotion_run_id, transition_type)
               VALUES (@sid, @stid, @secId, @ty, @roll, @pfid, @runId, @ttype)`
            );
          counts[action === 'promote' ? 'promoted' : 'retained']++;
        } else if (action === 'tc' || action === 'graduate') {
          await new sql.Request(tx)
            .input('sid', sql.UniqueIdentifier, schoolId)
            .input('stid', sql.UniqueIdentifier, student_id)
            .input('fy', sql.UniqueIdentifier, from_academic_year_id)
            .input('etype', sql.VarChar(20), action === 'tc' ? 'tc' : 'graduated')
            .input('reason', sql.NVarChar(500), reason || null)
            .input('by', sql.UniqueIdentifier, userId || null)
            .query(
              `INSERT INTO student_exits (school_id, student_id, academic_year_id, exit_type, reason, issued_by)
               VALUES (@sid, @stid, @fy, @etype, @reason, @by)`
            );
          await new sql.Request(tx)
            .input('id', sql.UniqueIdentifier, student_id)
            .query(`UPDATE students SET is_active=0, updated_at=GETUTCDATE() WHERE id=@id`);
          counts[action === 'tc' ? 'tc' : 'graduated']++;
        } else {
          counts.skipped++;
        }
      }

      await new sql.Request(tx)
        .input('id', sql.UniqueIdentifier, newRunId)
        .input('p', sql.Int, counts.promoted)
        .input('r', sql.Int, counts.retained)
        .input('t', sql.Int, counts.tc)
        .input('g', sql.Int, counts.graduated)
        .query(
          `UPDATE promotion_runs SET total_promoted=@p, total_retained=@r, total_tc=@t, total_graduated=@g WHERE id=@id`
        );

      return newRunId;
    });

    logAudit({
      schoolId, userId, actionType: 'PROMOTION_RUN',
      details: JSON.stringify({ from_academic_year_id, to_academic_year_id, counts }),
    });

    return created(res, { promotion_run_id: runId, counts });
  } catch (err) { next(err); }
};

// ── GET /api/promotion/history ──
exports.history = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const rows = await query(
      `SELECT pr.id, pr.total_promoted, pr.total_retained, pr.total_tc, pr.total_graduated, pr.created_at,
              fy.name AS from_year_name, ty.name AS to_year_name
       FROM promotion_runs pr
       JOIN academic_years fy ON fy.id = pr.from_academic_year_id
       JOIN academic_years ty ON ty.id = pr.to_academic_year_id
       WHERE pr.school_id=@sid
       ORDER BY pr.created_at DESC`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    return success(res, rows.recordset);
  } catch (err) { next(err); }
};

// ── POST /api/students/:id/tc  (single-student TC — wired from Students page) ──
exports.issueTC = async (req, res, next) => {
  try {
    const { schoolId, id: userId } = req.user;
    const { id: studentId } = req.params;
    const { reason, exit_type, tc_number, academic_year_id } = req.body;

    const student = await queryOne(
      `SELECT id, is_active FROM students WHERE id=@id AND school_id=@sid AND deleted_at IS NULL`,
      { id: { type: sql.UniqueIdentifier, value: studentId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    if (!student) return notFound(res, 'Student not found');
    if (!student.is_active) return badRequest(res, 'Student already marked as left / TC already issued');

    let ayId = academic_year_id;
    if (!ayId) {
      const cur = await queryOne(
        `SELECT id FROM academic_years WHERE school_id=@sid AND is_current=1`,
        { sid: { type: sql.UniqueIdentifier, value: schoolId } }
      );
      ayId = cur?.id;
    }

    await withTransaction(async (tx) => {
      await new sql.Request(tx)
        .input('sid', sql.UniqueIdentifier, schoolId)
        .input('stid', sql.UniqueIdentifier, studentId)
        .query(`UPDATE enrolments SET is_active=0, updated_at=GETUTCDATE() WHERE school_id=@sid AND student_id=@stid AND is_active=1`);

      await new sql.Request(tx)
        .input('sid', sql.UniqueIdentifier, schoolId)
        .input('stid', sql.UniqueIdentifier, studentId)
        .input('ay', sql.UniqueIdentifier, ayId)
        .input('etype', sql.VarChar(20), exit_type || 'tc')
        .input('reason', sql.NVarChar(500), reason || null)
        .input('tcno', sql.NVarChar(100), tc_number || null)
        .input('by', sql.UniqueIdentifier, userId || null)
        .query(
          `INSERT INTO student_exits (school_id, student_id, academic_year_id, exit_type, reason, tc_number, issued_by)
           VALUES (@sid, @stid, @ay, @etype, @reason, @tcno, @by)`
        );

      await new sql.Request(tx)
        .input('id', sql.UniqueIdentifier, studentId)
        .query(`UPDATE students SET is_active=0, updated_at=GETUTCDATE() WHERE id=@id`);
    });

    logAudit({ schoolId, userId, actionType: 'TC_ISSUED', details: JSON.stringify({ studentId, reason, exit_type }) });
    return success(res, { message: 'TC issued, student marked as left' });
  } catch (err) { next(err); }
};

// ── GET /api/students/:id/tc  (fetch for print/preview) ──
exports.getTC = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { id: studentId } = req.params;
    const row = await queryOne(
      `SELECT TOP 1 se.*, s.first_name, s.last_name, s.admission_no, s.date_of_birth, s.admission_date,
              g.name AS grade_name, sec.name AS section_name, ay.name AS academic_year_name
       FROM student_exits se
       JOIN students s ON s.id = se.student_id
       LEFT JOIN enrolments e ON e.student_id = s.id AND e.academic_year_id = se.academic_year_id
       LEFT JOIN sections sec ON sec.id = e.section_id
       LEFT JOIN grades g ON g.id = sec.grade_id
       LEFT JOIN academic_years ay ON ay.id = se.academic_year_id
       WHERE se.student_id=@stid AND se.school_id=@sid
       ORDER BY se.created_at DESC`,
      { stid: { type: sql.UniqueIdentifier, value: studentId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    if (!row) return notFound(res, 'No TC record found for this student');
    return success(res, row);
  } catch (err) { next(err); }
};


// ── POST /api/promotion/section-change ── (same-session section transfer, no new enrolment row)
exports.changeSection = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { student_id, enrolment_id, to_section_id, roll_no } = req.body;
    if (!student_id || !enrolment_id || !to_section_id) return badRequest(res, 'student_id, enrolment_id, to_section_id required');

    const enr = await queryOne(
      `SELECT id, academic_year_id FROM enrolments WHERE id=@id AND student_id=@stid AND school_id=@sid AND is_active=1`,
      {
        id: { type: sql.UniqueIdentifier, value: enrolment_id },
        stid: { type: sql.UniqueIdentifier, value: student_id },
        sid: { type: sql.UniqueIdentifier, value: schoolId },
      }
    );
    if (!enr) return notFound(res, 'Active enrolment not found');

    try {
      await query(
        `UPDATE enrolments SET section_id=@secId, roll_no=@roll, updated_at=GETUTCDATE() WHERE id=@id`,
        {
          secId: { type: sql.UniqueIdentifier, value: to_section_id },
          roll: { type: sql.NVarChar, value: roll_no || null },
          id: { type: sql.UniqueIdentifier, value: enrolment_id },
        }
      );
    } catch (e) {
      if (e.message?.includes('UQ_enrolments_section_year_rollno')) {
        return badRequest(res, 'Is naye section me yeh roll number pehle se kisi aur student ka hai');
      }
      throw e;
    }

    return success(res, { message: 'Section updated' });
  } catch (err) { next(err); }
};