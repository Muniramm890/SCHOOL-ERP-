// src/controllers/teachersController.js
const { query, queryOne, withTransaction, sql } = require('../config/db');
const { success, created, notFound, badRequest } = require('../utils/response');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

// ── GET /api/teachers (Nested Schema & SaaS Scalable) ─────────────────────
exports.list = async (req, res, next) => {
  try {
    // 🎯 Use Student Module pattern: Direct access from req.user
    const { schoolId } = req.user;

    const sqlQuery = `
      SELECT 
        u.id AS user_id, u.full_name, u.email, u.phone, u.gender, u.avatar_url,
        sm.employee_code, sm.join_date, sm.is_active, sm.role,
        sp.department, sp.designation, sp.qualification, sp.experience_years
      FROM school_members sm
      INNER JOIN users u ON sm.user_id = u.id
      LEFT JOIN staff_profiles sp ON sm.user_id = sp.user_id AND sp.school_id = sm.school_id
      WHERE sm.school_id = @sid 
        AND sm.role = 'teacher' 
        AND sm.deleted_at IS NULL
      ORDER BY u.full_name ASC
    `;

    const params = { sid: { type: sql.UniqueIdentifier, value: schoolId } };
    const result = await query(sqlQuery, params);

    // 🔴 FIX: `query()` returns a mssql recordset object ({ recordset: [...] }),
    // NOT a plain array. Previous code passed `teachers` (which could be that
    // wrapper object) straight into success() in the WRONG argument slot too.
    // Normalize to a plain array here so the frontend always gets `data: [...]`.
    const teachers = result?.recordset || result || [];

    // ✅ FIX: success(res, data, message) — data first, message second.
    // Old code had these swapped: success(res, 'Teachers fetched successfully', teachers || [])
    // which put the STRING into `data` and the ARRAY into `message`, so the
    // frontend's `Array.isArray(tRes?.data)` check always failed and the
    // teacher list rendered empty even though DB inserts (incl. bulk import)
    // were succeeding.
    return success(res, teachers, 'Teachers fetched successfully');
  } catch (err) { next(err); }
};

// ── GET /api/teachers/:userId ─────────────────────────────────────────────
exports.getOne = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { userId } = req.params;

    const sqlQuery = `
      SELECT 
        u.id AS user_id, u.full_name, u.email, u.phone, u.gender, u.date_of_birth, u.avatar_url,
        sm.employee_code, sm.join_date, sm.is_active, sm.role,
        sp.department, sp.designation, sp.qualification, sp.experience_years
      FROM school_members sm
      INNER JOIN users u ON sm.user_id = u.id
      LEFT JOIN staff_profiles sp ON sm.user_id = sp.user_id AND sp.school_id = sm.school_id
      WHERE sm.school_id = @sid 
        AND sm.user_id = @uid 
        AND sm.deleted_at IS NULL
    `;

    const params = {
      sid: { type: sql.UniqueIdentifier, value: schoolId },
      uid: { type: sql.UniqueIdentifier, value: userId }
    };

    const teacher = await queryOne(sqlQuery, params);
    if (!teacher) return notFound(res, 'Teacher not found');

    // ✅ FIX: was success(res, 'Teacher details fetched', teacher) — swapped.
    // Frontend's openView() does `res?.data || t` — with the bug, `res.data`
    // was the string message, so it silently fell back to stale list-row data
    // instead of the freshly fetched profile.
    return success(res, teacher, 'Teacher details fetched');
  } catch (err) { next(err); }
};

// ── POST /api/teachers (Transaction Safe & Strict Typing) ────────────────
exports.create = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { full_name, email, phone, gender, password, employee_code, join_date, department, designation, qualification, experience_years } = req.body;

    const userId = uuidv4();
    const hash = await bcrypt.hash(password || 'teacher123', 10);

    // Force strict Gender constraint
    let finalGender = (gender && ['Male', 'Female', 'Other'].includes(gender)) ? gender : 'Male';

    await withTransaction(async (tx) => {
      // 1. Users
      const r1 = tx.request();
      r1.input('id', sql.UniqueIdentifier, userId);
      r1.input('fn', sql.NVarChar(255), full_name);
      r1.input('em', sql.NVarChar(255), email);
      r1.input('ph', sql.NVarChar(50), phone || null);
      r1.input('gen', sql.VarChar(20), finalGender);
      r1.input('pw', sql.NVarChar(255), hash);
      await r1.query(`INSERT INTO users (id, full_name, email, phone, gender, password) VALUES (@id, @fn, @em, @ph, @gen, @pw)`);

      // 2. School Members
      const r2 = tx.request();
      r2.input('id', sql.UniqueIdentifier, uuidv4());
      r2.input('sid', sql.UniqueIdentifier, schoolId);
      r2.input('uid', sql.UniqueIdentifier, userId);
      r2.input('role', sql.VarChar(50), 'teacher');
      r2.input('emp', sql.NVarChar(100), employee_code || null);
      r2.input('join', sql.Date, join_date || null);
      await r2.query(`INSERT INTO school_members (id, school_id, user_id, role, employee_code, join_date) VALUES (@id, @sid, @uid, @role, @emp, @join)`);

      // 3. Profiles
      const r3 = tx.request();
      r3.input('id', sql.UniqueIdentifier, uuidv4());
      r3.input('sid', sql.UniqueIdentifier, schoolId);
      r3.input('uid', sql.UniqueIdentifier, userId);
      r3.input('dept', sql.NVarChar(100), department || null);
      r3.input('des', sql.NVarChar(100), designation || null);
      r3.input('qual', sql.NVarChar(255), qualification || null);
      r3.input('exp', sql.SmallInt, Number(experience_years) || 0);
      await r3.query(`INSERT INTO staff_profiles (id, school_id, user_id, department, designation, qualification, experience_years) VALUES (@id, @sid, @uid, @dept, @des, @qual, @exp)`);
    });

    return created(res, { userId }, 'Teacher created successfully');
  } catch (err) { next(err); }
};


// ── PUT /api/teachers/:userId ─────────────────────────────────────────────
exports.update = async (req, res, next) => {
  try {
    // 🎯 FIX: Using req.user pattern consistent with Student Module
    const { schoolId } = req.user;
    const { userId } = req.params;
    const { full_name, phone, gender, employee_code, department, designation, is_active } = req.body;

    let finalGender = gender ? String(gender).trim() : 'Male';
    finalGender = finalGender.charAt(0).toUpperCase() + finalGender.slice(1).toLowerCase();
    if (!['Male', 'Female', 'Other'].includes(finalGender)) finalGender = 'Male';

    await withTransaction(async (tx) => {
      // 1. Update users
      const r1 = tx.request();
      r1.input('uid', sql.UniqueIdentifier, userId);
      r1.input('fn', sql.NVarChar(255), full_name);
      r1.input('ph', sql.NVarChar(50), phone || null);
      r1.input('gen', sql.VarChar(20), finalGender);
      await r1.query(`UPDATE users SET full_name = @fn, phone = @ph, gender = @gen, updated_at = GETUTCDATE() WHERE id = @uid`);

      // 2. Update school_members
      const r2 = tx.request();
      r2.input('sid', sql.UniqueIdentifier, schoolId);
      r2.input('uid', sql.UniqueIdentifier, userId);
      r2.input('emp', sql.NVarChar(100), employee_code || null);
      r2.input('act', sql.Bit, is_active !== false ? 1 : 0);
      await r2.query(`UPDATE school_members SET employee_code = @emp, is_active = @act, updated_at = GETUTCDATE() WHERE user_id = @uid AND school_id = @sid`);

      // 3. Update staff_profiles
      const r3 = tx.request();
      r3.input('sid', sql.UniqueIdentifier, schoolId);
      r3.input('uid', sql.UniqueIdentifier, userId);
      r3.input('dept', sql.NVarChar(100), department || null);
      r3.input('des', sql.NVarChar(100), designation || null);
      await r3.query(`UPDATE staff_profiles SET department = @dept, designation = @des, updated_at = GETUTCDATE() WHERE user_id = @uid AND school_id = @sid`);
    });

    return success(res, null, 'Teacher updated successfully');
  } catch (err) { next(err); }
};

// ── DELETE /api/teachers/:userId ──────────────────────────────────────────
exports.remove = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { userId } = req.params;

    const sqlQuery = `
      UPDATE school_members 
      SET is_active = 0, deleted_at = GETUTCDATE(), updated_at = GETUTCDATE() 
      WHERE user_id = @uid AND school_id = @sid
    `;

    const params = {
      sid: { type: sql.UniqueIdentifier, value: schoolId },
      uid: { type: sql.UniqueIdentifier, value: userId }
    };

    await query(sqlQuery, params);
    return success(res, null, 'Teacher removed from school successfully');
  } catch (err) { next(err); }
};

// ── PUT /api/teachers/assign-class-teacher ────────────────────────────────
exports.assignClassTeacher = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { sectionId, teacherUserId } = req.body;

    const sqlQuery = `
      UPDATE sections 
      SET class_teacher_id = @tid, updated_at = GETUTCDATE()
      WHERE id = @secId AND school_id = @sid
    `;

    const params = {
      sid: { type: sql.UniqueIdentifier, value: schoolId },
      secId: { type: sql.UniqueIdentifier, value: sectionId },
      tid: { type: sql.UniqueIdentifier, value: teacherUserId || null }
    };

    await query(sqlQuery, params);
    return success(res, null, 'Class teacher assigned successfully');
  } catch (err) { next(err); }
};

// ── GET /api/teachers/lookups ─────────────────────────────────────────────
exports.getLookups = async (req, res, next) => {
  try {
    const { schoolId } = req.user;

    const sqlQuery = `
      SELECT u.id AS user_id, u.full_name, sm.employee_code
      FROM school_members sm
      INNER JOIN users u ON sm.user_id = u.id
      WHERE sm.school_id = @sid 
        AND sm.role = 'teacher' 
        AND sm.is_active = 1 
        AND sm.deleted_at IS NULL
      ORDER BY u.full_name ASC
    `;

    const params = { sid: { type: sql.UniqueIdentifier, value: schoolId } };
    const result = await query(sqlQuery, params);
    const list = result?.recordset || result || [];

    return success(res, list, 'Lookups fetched successfully');
  } catch (err) { next(err); }
};

// ═══════════════════════════════════════════════════════════════
// 🔴 SUBJECT ASSIGNMENT — real implementation (uses teacher_subjects table)
// ═══════════════════════════════════════════════════════════════

// GET /api/teachers/:userId/subjects
// Ek teacher ke saare subject+section assignments — Teacher Profile ke
// "Subjects & Timetable" tab ke liye, aur Timetable grid ke auto-suggest ke liye.
exports.getTeacherSubjects = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { userId } = req.params;

    const result = await query(
      `SELECT ts.id, ts.subject_id, s.name AS subject_name,
              ts.section_id, sec.name AS section_name, g.name AS grade_name, g.id AS grade_id
       FROM teacher_subjects ts
       JOIN subjects s ON s.id = ts.subject_id
       JOIN sections sec ON sec.id = ts.section_id
       JOIN grades g ON g.id = sec.grade_id
       WHERE ts.school_id = @sid AND ts.teacher_user_id = @uid AND ts.is_active = 1 AND ts.deleted_at IS NULL
       ORDER BY g.numeric_order, sec.name, s.name`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId }, uid: { type: sql.UniqueIdentifier, value: userId } }
    );

    return success(res, result.recordset, 'Teacher subject assignments fetched');
  } catch (err) { next(err); }
};

// GET /api/teachers/section-assignments?section_id=xxx
exports.getSectionAssignments = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { section_id } = req.query;
    if (!section_id) return badRequest(res, 'section_id is required');

    const result = await query(
      `SELECT ts.id AS assignment_id, ts.subject_id, s.name AS subject_name, ts.teacher_user_id, u.full_name AS teacher_name
       FROM teacher_subjects ts
       JOIN subjects s ON s.id = ts.subject_id
       JOIN users u ON u.id = ts.teacher_user_id
       WHERE ts.school_id = @sid AND ts.section_id = @secId AND ts.is_active = 1 AND ts.deleted_at IS NULL
       ORDER BY s.name, u.full_name`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId }, secId: { type: sql.UniqueIdentifier, value: section_id } }
    );

    return success(res, result.recordset, 'Section subject-teacher map fetched');
  } catch (err) { next(err); }
};

// POST /api/teachers/assignments

exports.assignSubject = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { teacher_user_id, section_id, subject_id, academic_year_id } = req.body;

    if (!teacher_user_id || !section_id || !subject_id) {
      return badRequest(res, 'teacher_user_id, section_id and subject_id are required');
    }

    const dup = await queryOne(
      `SELECT id FROM teacher_subjects
       WHERE school_id=@sid AND section_id=@secId AND subject_id=@subId AND teacher_user_id=@tid
         AND is_active=1 AND deleted_at IS NULL`,
      {
        sid: { type: sql.UniqueIdentifier, value: schoolId },
        secId: { type: sql.UniqueIdentifier, value: section_id },
        subId: { type: sql.UniqueIdentifier, value: subject_id },
        tid: { type: sql.UniqueIdentifier, value: teacher_user_id },
      }
    );
    if (dup) return badRequest(res, 'This teacher is already assigned to this subject for this class.');

    const r = await query(
      `INSERT INTO teacher_subjects (id, school_id, teacher_user_id, section_id, subject_id, academic_year_id)
       OUTPUT INSERTED.id
       VALUES (NEWID(), @sid, @tid, @secId, @subId, @ayId)`,
      {
        sid: { type: sql.UniqueIdentifier, value: schoolId },
        tid: { type: sql.UniqueIdentifier, value: teacher_user_id },
        secId: { type: sql.UniqueIdentifier, value: section_id },
        subId: { type: sql.UniqueIdentifier, value: subject_id },
        ayId: { type: sql.UniqueIdentifier, value: academic_year_id || null },
      }
    );

    return created(res, { id: r.recordset[0].id }, 'Teacher assigned to subject successfully');
  } catch (err) { next(err); }
};

// DELETE /api/teachers/assignments/:assignmentId
exports.removeAssignment = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { assignmentId } = req.params;

    await query(
      `UPDATE teacher_subjects SET is_active = 0, deleted_at = GETUTCDATE(), updated_at = GETUTCDATE()
       WHERE id = @id AND school_id = @sid`,
      { id: { type: sql.UniqueIdentifier, value: assignmentId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );

    return success(res, null, 'Assignment removed successfully');
  } catch (err) { next(err); }
};

// GET /api/teachers/for-subject?subject_id=xxx
// Suggested teachers: pehle wo jo already kahi is subject ko padha rahe hain,
// fallback me wo jinka department subject name se match kare (fresh setup ke liye).
exports.getTeachersForSubject = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { subject_id } = req.query;
    if (!subject_id) return badRequest(res, 'subject_id is required');

    const result = await query(
      `SELECT DISTINCT u.id AS user_id, u.full_name
       FROM teacher_subjects ts
       JOIN users u ON u.id = ts.teacher_user_id
       JOIN school_members sm ON sm.user_id = u.id AND sm.school_id = ts.school_id AND sm.is_active = 1
       WHERE ts.school_id = @sid AND ts.subject_id = @subId AND ts.is_active = 1 AND ts.deleted_at IS NULL

       UNION

       SELECT u.id AS user_id, u.full_name
       FROM staff_profiles sp
       JOIN users u ON u.id = sp.user_id
       JOIN school_members sm ON sm.user_id = u.id AND sm.school_id = sp.school_id AND sm.role = 'teacher' AND sm.is_active = 1
       JOIN subjects s ON s.school_id = sp.school_id AND s.id = @subId
       WHERE sp.school_id = @sid AND sp.department = s.name

       ORDER BY full_name`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId }, subId: { type: sql.UniqueIdentifier, value: subject_id } }
    );

    return success(res, result.recordset, 'Suggested teachers fetched');
  } catch (err) { next(err); }
};


// GET /api/teachers/subject-teachers/all — bulk map for Timetable grid (1 call, not N)
exports.getAllSubjectTeachers = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const result = await query(
      `SELECT st.subject_id, st.teacher_user_id, u.full_name AS teacher_name
       FROM subject_teachers st
       JOIN users u ON u.id = st.teacher_user_id
       WHERE st.school_id=@sid AND st.is_active=1 AND st.deleted_at IS NULL`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    return success(res, result.recordset, 'All subject-teacher mappings fetched');
  } catch (err) { next(err); }
};

// GET /api/teachers/subject-teachers?subject_id=xxx
exports.getSubjectTeachers = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { subject_id } = req.query;
    if (!subject_id) return badRequest(res, 'subject_id is required');
    const result = await query(
      `SELECT st.id AS assignment_id, st.teacher_user_id, u.full_name AS teacher_name
       FROM subject_teachers st
       JOIN users u ON u.id = st.teacher_user_id
       WHERE st.school_id=@sid AND st.subject_id=@subId AND st.is_active=1 AND st.deleted_at IS NULL
       ORDER BY u.full_name`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId }, subId: { type: sql.UniqueIdentifier, value: subject_id } }
    );
    return success(res, result.recordset, 'Subject teachers fetched');
  } catch (err) { next(err); }
};

// POST /api/teachers/subject-teachers { subject_id, teacher_user_id }
exports.assignSubjectTeacher = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { subject_id, teacher_user_id } = req.body;
    if (!subject_id || !teacher_user_id) return badRequest(res, 'subject_id and teacher_user_id are required');

    const dup = await queryOne(
      `SELECT id FROM subject_teachers WHERE school_id=@sid AND subject_id=@subId AND teacher_user_id=@tid AND is_active=1 AND deleted_at IS NULL`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId }, subId: { type: sql.UniqueIdentifier, value: subject_id }, tid: { type: sql.UniqueIdentifier, value: teacher_user_id } }
    );
    if (dup) return badRequest(res, 'This teacher is already assigned to this subject.');

    const r = await query(
      `INSERT INTO subject_teachers (id, school_id, subject_id, teacher_user_id) OUTPUT INSERTED.id VALUES (NEWID(), @sid, @subId, @tid)`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId }, subId: { type: sql.UniqueIdentifier, value: subject_id }, tid: { type: sql.UniqueIdentifier, value: teacher_user_id } }
    );
    return created(res, { id: r.recordset[0].id }, 'Teacher assigned to subject');
  } catch (err) { next(err); }
};

// DELETE /api/teachers/subject-teachers/:id
exports.removeSubjectTeacher = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { id } = req.params;
    await query(
      `UPDATE subject_teachers SET is_active=0, deleted_at=GETUTCDATE(), updated_at=GETUTCDATE() WHERE id=@id AND school_id=@sid`,
      { id: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    return success(res, null, 'Teacher unassigned from subject');
  } catch (err) { next(err); }
};

// GET /api/teachers/:userId/assigned-subjects — used by Teacher Profile "Subjects Assigned" tab
exports.getTeacherAssignedSubjects = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { userId } = req.params;
    const result = await query(
      `SELECT st.subject_id, s.name AS subject_name, s.category
       FROM subject_teachers st
       JOIN subjects s ON s.id = st.subject_id
       WHERE st.school_id=@sid AND st.teacher_user_id=@uid AND st.is_active=1 AND st.deleted_at IS NULL
       ORDER BY s.name`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId }, uid: { type: sql.UniqueIdentifier, value: userId } }
    );
    return success(res, result.recordset, 'Teacher assigned subjects fetched');
  } catch (err) { next(err); }
};
