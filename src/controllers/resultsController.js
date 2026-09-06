
const sql = require('mssql');
const { query, queryOne, withTransaction } = require('../config/db');
const { success, created, notFound, badRequest } = require('../utils/response');
const { generateStudentReportCardPdf } = require('../services/resultCardService');

// ═══════════════════════════════════════════════════════════════
// GET /api/results/exam-groups
// List exam groups available for result analysis (selector at top
// of the Results Hub)
// ═══════════════════════════════════════════════════════════════
exports.listExamGroups = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { academic_year_id } = req.query;
    const result = await query(
      `SELECT eg.id, eg.name, eg.exam_type, eg.status, eg.start_date, eg.end_date, eg.weightage_percent,
              (SELECT COUNT(*) FROM exam_results er WHERE er.exam_group_id = eg.id) AS results_computed_count
       FROM exam_groups eg
       WHERE eg.school_id=@sid AND eg.deleted_at IS NULL
         AND (@ayId IS NULL OR eg.academic_year_id=@ayId)
       ORDER BY eg.start_date DESC`,
      {
        sid: { type: sql.UniqueIdentifier, value: schoolId },
        ayId: { type: sql.UniqueIdentifier, value: academic_year_id || null },
      }
    );
    return success(res, result.recordset, 'Exam groups fetched');
  } catch (err) { next(err); }
};

// ═══════════════════════════════════════════════════════════════
// POST /api/results/compute/:examGroupId
// FIXED: Section-wise calculation & NULL constraint fix for DB
// ═══════════════════════════════════════════════════════════════
exports.computeResults = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { examGroupId } = req.params;
    const { section_id } = req.body; // 🔴 Bring back section_id from Frontend

    if (!section_id) return badRequest(res, 'section_id is required in body');

    const examGroup = await queryOne(
      `SELECT id, academic_year_id FROM exam_groups WHERE id=@id AND school_id=@sid AND deleted_at IS NULL`,
      { id: { type: sql.UniqueIdentifier, value: examGroupId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    if (!examGroup) return notFound(res, 'Exam group not found');

    // Fetch subjects ONLY for this specific section
    const esRows = await query(
      `SELECT id AS exam_subject_id, section_id, subject_id, max_marks, passing_marks, is_grade_only
       FROM exam_subjects WHERE exam_group_id=@egId AND section_id=@secId AND school_id=@sid AND deleted_at IS NULL`,
      { 
        egId: { type: sql.UniqueIdentifier, value: examGroupId }, 
        secId: { type: sql.UniqueIdentifier, value: section_id }, 
        sid: { type: sql.UniqueIdentifier, value: schoolId } 
      }
    );
    const examSubjects = esRows.recordset;
    if (!examSubjects.length) return badRequest(res, 'No subjects configured for this class/section');

    const gsRows = await query(
      `SELECT grade_label, min_percent, max_percent FROM grading_scale WHERE school_id=@sid ORDER BY sort_order`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    const gradingScale = gsRows.recordset;
    const resolveGrade = (pct) => {
      const row = gradingScale.find((g) => pct >= g.min_percent && pct <= g.max_percent);
      return row ? row.grade_label : null;
    };

    const allExamSubjectIds = examSubjects.map((es) => es.exam_subject_id);
    const idParams = {};
    const idNames = allExamSubjectIds.map((id, i) => {
      idParams[`es${i}`] = { type: sql.UniqueIdentifier, value: id };
      return `@es${i}`;
    });
    
    const marksRows = await query(
      `SELECT exam_subject_id, student_id, marks_obtained, grade_obtained, status
       FROM exam_marks WHERE exam_subject_id IN (${idNames.join(',')})`,
      idParams
    );
    const marksByStudentSubject = {};
    marksRows.recordset.forEach((m) => {
      if (!marksByStudentSubject[m.student_id]) marksByStudentSubject[m.student_id] = {};
      marksByStudentSubject[m.student_id][m.exam_subject_id] = m;
    });

    const computedRows = [];
    
    // MaxTotal exclusively from Scholastic subjects
    const maxTotal = examSubjects
      .filter(s => !s.is_grade_only)
      .reduce((s, x) => s + Number(x.max_marks), 0);

    const enrolRows = await query(
      `SELECT student_id FROM enrolments
       WHERE section_id=@secId AND school_id=@sid AND academic_year_id=@ayId AND is_active=1 AND deleted_at IS NULL`,
      {
        secId: { type: sql.UniqueIdentifier, value: section_id },
        sid: { type: sql.UniqueIdentifier, value: schoolId },
        ayId: { type: sql.UniqueIdentifier, value: examGroup.academic_year_id },
      }
    );

    for (const { student_id } of enrolRows.recordset) {
      const studentMarks = marksByStudentSubject[student_id] || {};
      let enteredCount = 0;
      let totalMarks = 0;
      let anyFail = false;

      for (const es of examSubjects) {
        const row = studentMarks[es.exam_subject_id];
        
        if (!row) continue;
        if (row.status === 'present') {
            if (es.is_grade_only && !row.grade_obtained) continue; 
            if (!es.is_grade_only && (row.marks_obtained === null || row.marks_obtained === undefined)) continue;
        }
        
        enteredCount++;

        if (es.is_grade_only) {
          if (row.status === 'absent') anyFail = true;
        } else {
          const obtained = Number(row.marks_obtained);
          totalMarks += obtained;
          if (row.status === 'absent' || obtained < Number(es.passing_marks)) {
            anyFail = true;
          }
        }
      }

      // Incomplete Result Logic
      if (enteredCount < examSubjects.length) {
        computedRows.push({
          student_id, section_id,
          total_marks: totalMarks, // 🔴 Bug Fix: Assign current total instead of NULL
          max_total: maxTotal, 
          percentage: 0,           // 🔴 Bug Fix: 0 instead of NULL
          grade: null, status: 'incomplete',
        });
        continue;
      }

      const percentage = maxTotal > 0 ? (totalMarks / maxTotal) * 100 : 0;
      computedRows.push({
        student_id, section_id,
        total_marks: totalMarks, max_total: maxTotal,
        percentage: Math.round(percentage * 100) / 100,
        grade: resolveGrade(percentage),
        status: anyFail ? 'fail' : 'pass',
      });
    }

    // Ranking Logic (Only for complete results)
    const ranked = computedRows.filter((r) => r.status !== 'incomplete');
    ranked.sort((a, b) => b.percentage - a.percentage);
    let rank = 0, prevPct = null;
    ranked.forEach((r, idx) => {
      if (r.percentage !== prevPct) rank = idx + 1;
      r.class_rank = rank;
      prevPct = r.percentage;
    });

    await withTransaction(async (tx) => {
      // 🔴 Delete only for THIS specific section, not the whole exam
      const rDel = tx.request();
      rDel.input('egId', sql.UniqueIdentifier, examGroupId);
      rDel.input('secId', sql.UniqueIdentifier, section_id);
      rDel.input('sid', sql.UniqueIdentifier, schoolId);
      await rDel.query(`DELETE FROM exam_results WHERE exam_group_id=@egId AND section_id=@secId AND school_id=@sid`);

      for (const r of computedRows) {
        const req2 = tx.request();
        req2.input('sid', sql.UniqueIdentifier, schoolId);
        req2.input('egId', sql.UniqueIdentifier, examGroupId);
        req2.input('secId', sql.UniqueIdentifier, r.section_id);
        req2.input('stuId', sql.UniqueIdentifier, r.student_id);
        // 🔴 NULL FIX: Using fallback || 0 for DB constraints
        req2.input('total', sql.Decimal(10, 2), r.total_marks || 0);
        req2.input('maxTotal', sql.Decimal(10, 2), r.max_total || 0);
        req2.input('pct', sql.Decimal(5, 2), r.percentage || 0);
        req2.input('grade', sql.VarChar(10), r.grade || null);
        req2.input('crank', sql.Int, r.class_rank || null);
        req2.input('status', sql.VarChar(20), r.status);
        await req2.query(
          `INSERT INTO exam_results
             (id, exam_group_id, section_id, student_id, school_id, total_marks, max_total, percentage, grade, class_rank, status, computed_at)
           VALUES
             (NEWID(), @egId, @secId, @stuId, @sid, @total, @maxTotal, @pct, @grade, @crank, @status, GETUTCDATE())`
        );
      }
    });

    return success(res, {
      total_students: computedRows.length,
      computed: ranked.length,
      incomplete: computedRows.length - ranked.length,
    }, 'Results computed successfully');
  } catch (err) { next(err); }
};

// ═══════════════════════════════════════════════════════════════
// GET /api/results/overview?exam_group_id=
// ═══════════════════════════════════════════════════════════════
exports.getOverview = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { exam_group_id } = req.query;
    if (!exam_group_id) return badRequest(res, 'exam_group_id is required');

    const stats = await queryOne(
      `SELECT
         COUNT(*) AS total_appeared,
         SUM(CASE WHEN status='pass' THEN 1 ELSE 0 END) AS total_pass,
         SUM(CASE WHEN status='fail' THEN 1 ELSE 0 END) AS total_fail,
         SUM(CASE WHEN status='incomplete' THEN 1 ELSE 0 END) AS total_incomplete,
         AVG(CASE WHEN percentage IS NOT NULL THEN percentage END) AS avg_percentage,
         MAX(percentage) AS highest_percentage
       FROM exam_results WHERE exam_group_id=@egId AND school_id=@sid`,
      { egId: { type: sql.UniqueIdentifier, value: exam_group_id }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );

    const topper = await queryOne(
      `SELECT TOP 1 er.student_id, (s.first_name + ' ' + ISNULL(s.last_name,'')) AS full_name,
              er.percentage, g.name AS grade_name, sec.name AS section_name
       FROM exam_results er
       JOIN students s ON s.id = er.student_id
       JOIN sections sec ON sec.id = er.section_id
       JOIN grades g ON g.id = sec.grade_id
       WHERE er.exam_group_id=@egId AND er.school_id=@sid AND er.status='pass'
       ORDER BY er.percentage DESC`,
      { egId: { type: sql.UniqueIdentifier, value: exam_group_id }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );

    const denom = (stats.total_appeared || 0) - (stats.total_incomplete || 0);
    return success(res, {
      total_appeared: stats.total_appeared || 0,
      total_pass: stats.total_pass || 0,
      total_fail: stats.total_fail || 0,
      total_incomplete: stats.total_incomplete || 0,
      pass_percent: denom > 0 ? Math.round((stats.total_pass / denom) * 10000) / 100 : 0,
      avg_percentage: stats.avg_percentage ? Math.round(stats.avg_percentage * 100) / 100 : 0,
      highest_percentage: stats.highest_percentage,
      topper,
    }, 'Overview fetched');
  } catch (err) { next(err); }
};

// ═══════════════════════════════════════════════════════════════
// GET /api/results/class-wise?exam_group_id=
// ═══════════════════════════════════════════════════════════════
exports.getClassWise = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { exam_group_id } = req.query;
    if (!exam_group_id) return badRequest(res, 'exam_group_id is required');

    const result = await query(
      `SELECT g.id AS grade_id, g.name AS grade_name,
              COUNT(er.id) AS total_students,
              SUM(CASE WHEN er.status='pass' THEN 1 ELSE 0 END) AS pass_count,
              AVG(CASE WHEN er.percentage IS NOT NULL THEN er.percentage END) AS avg_percentage
       FROM exam_results er
       JOIN sections sec ON sec.id = er.section_id
       JOIN grades g ON g.id = sec.grade_id
       WHERE er.exam_group_id=@egId AND er.school_id=@sid
       GROUP BY g.id, g.name, g.numeric_order
       ORDER BY g.numeric_order`,
      { egId: { type: sql.UniqueIdentifier, value: exam_group_id }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    const rows = result.recordset.map((r) => ({
      ...r,
      avg_percentage: r.avg_percentage ? Math.round(r.avg_percentage * 100) / 100 : 0,
      pass_percent: r.total_students ? Math.round((r.pass_count / r.total_students) * 10000) / 100 : 0,
    }));
    return success(res, rows, 'Class-wise analysis fetched');
  } catch (err) { next(err); }
};

// ═══════════════════════════════════════════════════════════════
// GET /api/results/section-wise?exam_group_id=&grade_id=
// ═══════════════════════════════════════════════════════════════
exports.getSectionWise = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { exam_group_id, grade_id } = req.query;
    if (!exam_group_id) return badRequest(res, 'exam_group_id is required');

    const result = await query(
      `SELECT sec.id AS section_id, sec.name AS section_name, g.name AS grade_name,
              COUNT(er.id) AS total_students,
              SUM(CASE WHEN er.status='pass' THEN 1 ELSE 0 END) AS pass_count,
              AVG(CASE WHEN er.percentage IS NOT NULL THEN er.percentage END) AS avg_percentage
       FROM exam_results er
       JOIN sections sec ON sec.id = er.section_id
       JOIN grades g ON g.id = sec.grade_id
       WHERE er.exam_group_id=@egId AND er.school_id=@sid
         AND (@gradeId IS NULL OR g.id=@gradeId)
       GROUP BY sec.id, sec.name, g.name
       ORDER BY g.name, sec.name`,
      {
        egId: { type: sql.UniqueIdentifier, value: exam_group_id },
        sid: { type: sql.UniqueIdentifier, value: schoolId },
        gradeId: { type: sql.UniqueIdentifier, value: grade_id || null },
      }
    );
    const rows = result.recordset.map((r) => ({
      ...r,
      avg_percentage: r.avg_percentage ? Math.round(r.avg_percentage * 100) / 100 : 0,
      pass_percent: r.total_students ? Math.round((r.pass_count / r.total_students) * 10000) / 100 : 0,
    }));
    return success(res, rows, 'Section-wise analysis fetched');
  } catch (err) { next(err); }
};

// ═══════════════════════════════════════════════════════════════
// GET /api/results/section-results?exam_group_id=&section_id=
// Drilldown: every student in a section, with their result
// ═══════════════════════════════════════════════════════════════
exports.getSectionResults = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { exam_group_id, section_id } = req.query;
    if (!exam_group_id || !section_id) return badRequest(res, 'exam_group_id and section_id are required');

    const result = await query(
      `SELECT er.student_id, (s.first_name + ' ' + ISNULL(s.last_name,'')) AS student_name,
              enr.roll_no, er.total_marks, er.max_total, er.percentage, er.grade,
              er.class_rank, er.school_rank, er.status
       FROM exam_results er
       JOIN students s ON s.id = er.student_id
       LEFT JOIN enrolments enr ON enr.student_id=er.student_id AND enr.section_id=er.section_id AND enr.is_active=1
       WHERE er.exam_group_id=@egId AND er.section_id=@secId AND er.school_id=@sid
       ORDER BY ISNULL(er.class_rank, 999999) ASC`,
      { egId: { type: sql.UniqueIdentifier, value: exam_group_id }, secId: { type: sql.UniqueIdentifier, value: section_id }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    return success(res, result.recordset, 'Section results fetched');
  } catch (err) { next(err); }
};

// ═══════════════════════════════════════════════════════════════
// GET /api/results/subject-wise?exam_group_id=
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// GET /api/results/subject-wise?exam_group_id=
// ═══════════════════════════════════════════════════════════════
exports.getSubjectWise = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { exam_group_id } = req.query;
    if (!exam_group_id) return badRequest(res, 'exam_group_id is required');

    const result = await query(
      `SELECT s.id AS subject_id, s.name AS subject_name, es.is_grade_only,
              COUNT(em.id) AS total_attempted,
              SUM(CASE WHEN em.status='absent' THEN 1 ELSE 0 END) AS absent_count,
              SUM(CASE WHEN em.status<>'absent' AND es.is_grade_only = 0 AND em.marks_obtained >= es.passing_marks THEN 1 ELSE 0 END) AS pass_count,
              -- 🔴 FIX: Prevent Divide by Zero by filtering is_grade_only = 0
              AVG(CASE WHEN em.status<>'absent' AND em.marks_obtained IS NOT NULL AND es.is_grade_only = 0
                       THEN (em.marks_obtained / es.max_marks) * 100 END) AS avg_percentage,
              MAX(CASE WHEN em.status<>'absent' AND es.is_grade_only = 0 THEN em.marks_obtained END) AS highest_marks,
              MIN(CASE WHEN em.status<>'absent' AND es.is_grade_only = 0 THEN em.marks_obtained END) AS lowest_marks
       FROM exam_subjects es
       JOIN subjects s ON s.id = es.subject_id
       LEFT JOIN exam_marks em ON em.exam_subject_id = es.id
       WHERE es.exam_group_id=@egId AND es.school_id=@sid AND es.deleted_at IS NULL
       GROUP BY s.id, s.name, es.is_grade_only
       ORDER BY s.name`,
      { egId: { type: sql.UniqueIdentifier, value: exam_group_id }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    
    const rows = result.recordset.map((r) => {
      const attemptedPresent = (r.total_attempted || 0) - (r.absent_count || 0);
      return {
        ...r,
        avg_percentage: r.avg_percentage ? Math.round(r.avg_percentage * 100) / 100 : 0,
        pass_percent: (attemptedPresent > 0 && !r.is_grade_only) ? Math.round((r.pass_count / attemptedPresent) * 10000) / 100 : 0,
      };
    });
    return success(res, rows, 'Subject-wise analysis fetched');
  } catch (err) { next(err); }
};

// ═══════════════════════════════════════════════════════════════
// GET /api/results/teacher-wise?exam_group_id=
// ═══════════════════════════════════════════════════════════════
// GET /api/results/teacher-wise?exam_group_id=
// ═══════════════════════════════════════════════════════════════
exports.getTeacherWise = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { exam_group_id } = req.query;
    if (!exam_group_id) return badRequest(res, 'exam_group_id is required');

    const result = await query(
      `SELECT u.id AS teacher_user_id, u.full_name AS teacher_name, s.name AS subject_name,
              g.name AS grade_name, sec.name AS section_name, es.is_grade_only,
              COUNT(em.id) AS total_attempted,
              SUM(CASE WHEN em.status<>'absent' AND es.is_grade_only = 0 AND em.marks_obtained >= es.passing_marks THEN 1 ELSE 0 END) AS pass_count,
              -- 🔴 FIX: Prevent Divide by Zero
              AVG(CASE WHEN em.status<>'absent' AND em.marks_obtained IS NOT NULL AND es.is_grade_only = 0
                       THEN (em.marks_obtained / es.max_marks) * 100 END) AS avg_percentage
       FROM exam_subjects es
       JOIN subjects s ON s.id = es.subject_id
       JOIN sections sec ON sec.id = es.section_id
       JOIN grades g ON g.id = sec.grade_id
       LEFT JOIN exam_marks em ON em.exam_subject_id = es.id
       OUTER APPLY (
         SELECT TOP 1 te.teacher_id FROM timetable_entries te
         WHERE te.section_id = es.section_id AND te.subject_id = es.subject_id AND te.school_id = es.school_id
         GROUP BY te.teacher_id ORDER BY COUNT(*) DESC
       ) assigned
       JOIN users u ON u.id = assigned.teacher_id
       WHERE es.exam_group_id=@egId AND es.school_id=@sid AND es.deleted_at IS NULL
       GROUP BY u.id, u.full_name, s.name, g.name, sec.name, es.is_grade_only
       ORDER BY u.full_name`,
      { egId: { type: sql.UniqueIdentifier, value: exam_group_id }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    const rows = result.recordset.map((r) => ({
      ...r,
      avg_percentage: r.avg_percentage ? Math.round(r.avg_percentage * 100) / 100 : 0,
      pass_percent: (r.total_attempted && !r.is_grade_only) ? Math.round((r.pass_count / r.total_attempted) * 10000) / 100 : 0,
    }));
    return success(res, rows, 'Teacher-wise analysis fetched');
  } catch (err) { next(err); }
};

// ═══════════════════════════════════════════════════════════════
// GET /api/results/toppers?exam_group_id=&grade_id=&limit=
// ═══════════════════════════════════════════════════════════════
exports.getToppers = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { exam_group_id, grade_id, limit } = req.query;
    if (!exam_group_id) return badRequest(res, 'exam_group_id is required');
    const top = Math.min(Number(limit) || 10, 50);

    const result = await query(
      `SELECT TOP (@top) er.student_id, (s.first_name + ' ' + ISNULL(s.last_name,'')) AS student_name,
              er.percentage, er.grade, er.class_rank, er.school_rank,
              g.name AS grade_name, sec.name AS section_name, enr.roll_no
       FROM exam_results er
       JOIN students s ON s.id = er.student_id
       JOIN sections sec ON sec.id = er.section_id
       JOIN grades g ON g.id = sec.grade_id
       LEFT JOIN enrolments enr ON enr.student_id = er.student_id AND enr.section_id = er.section_id AND enr.is_active=1
       WHERE er.exam_group_id=@egId AND er.school_id=@sid AND er.status='pass'
         AND (@gradeId IS NULL OR g.id=@gradeId)
       ORDER BY er.percentage DESC`,
      {
        top: { type: sql.Int, value: top },
        egId: { type: sql.UniqueIdentifier, value: exam_group_id },
        sid: { type: sql.UniqueIdentifier, value: schoolId },
        gradeId: { type: sql.UniqueIdentifier, value: grade_id || null },
      }
    );
    return success(res, result.recordset, 'Toppers fetched');
  } catch (err) { next(err); }
};

// ═══════════════════════════════════════════════════════════════
// GET /api/results/student/:studentId/trend
// A student's percentage across ALL exam groups they've appeared
// in — feeds the line-chart "previous exams comparison" view.
// ═══════════════════════════════════════════════════════════════
exports.getStudentTrend = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { studentId } = req.params;

    const result = await query(
      `SELECT eg.id AS exam_group_id, eg.name AS exam_name, eg.exam_type, eg.start_date,
              er.percentage, er.grade, er.class_rank, er.school_rank, er.status
       FROM exam_results er
       JOIN exam_groups eg ON eg.id = er.exam_group_id
       WHERE er.student_id=@stuId AND er.school_id=@sid
       ORDER BY eg.start_date ASC`,
      { stuId: { type: sql.UniqueIdentifier, value: studentId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    return success(res, result.recordset, 'Student exam trend fetched');
  } catch (err) { next(err); }
};

// ═══════════════════════════════════════════════════════════════
// GET /api/results/student/:studentId/report-card?exam_group_id=
// Full subject-wise marksheet for one student, one exam.
// ═══════════════════════════════════════════════════════════════

exports.getStudentReportCard = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { studentId } = req.params;
    const { exam_group_id } = req.query;
    if (!exam_group_id) return badRequest(res, 'exam_group_id is required');

    const overall = await queryOne(
      `SELECT total_marks, max_total, percentage, grade, class_rank, school_rank, status
       FROM exam_results WHERE exam_group_id=@egId AND student_id=@stuId AND school_id=@sid`,
      { egId: { type: sql.UniqueIdentifier, value: exam_group_id }, stuId: { type: sql.UniqueIdentifier, value: studentId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    if (!overall) return notFound(res, 'Result not computed for this student yet');

    // 🔴 UPDATE: Added is_grade_only and grade_obtained to this query
    const subjects = await query(
      `SELECT s.name AS subject_name, em.marks_obtained, em.grade_obtained, em.status, 
              es.max_marks, es.passing_marks, es.is_grade_only
       FROM exam_marks em
       JOIN exam_subjects es ON es.id = em.exam_subject_id
       JOIN subjects s ON s.id = es.subject_id
       WHERE es.exam_group_id=@egId AND em.student_id=@stuId AND em.school_id=@sid
       ORDER BY s.name`,
      { egId: { type: sql.UniqueIdentifier, value: exam_group_id }, stuId: { type: sql.UniqueIdentifier, value: studentId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );

    return success(res, { ...overall, subjects: subjects.recordset }, 'Report card fetched');
  } catch (err) { next(err); }
};



// ═══════════════════════════════════════════════════════════════
// GET /api/results/student/:studentId/report-card/pdf?exam_group_id=
// ═══════════════════════════════════════════════════════════════
exports.downloadReportCardPdf = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { studentId } = req.params;
    const { exam_group_id } = req.query;
    if (!exam_group_id) return badRequest(res, 'exam_group_id is required');

    const url = await generateStudentReportCardPdf(schoolId, studentId, exam_group_id);
    return success(res, { url }, 'Report card PDF generated');
  } catch (err) { next(err); }
};
