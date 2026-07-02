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
    const teachers = await query(sqlQuery, params);
    
    return success(res, 'Teachers fetched successfully', teachers || []);
  } catch (err) { next(err); }
};

// ── GET /api/teachers/:userId ─────────────────────────────────────────────
exports.getOne = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { userId } = req.params;

    const sqlQuery = `
      SELECT 
        u.id AS user_id, u.full_name, u.email, u.phone, u.gender, u.date_of_birth,
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

    return success(res, 'Teacher details fetched', teacher);
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
    const list = await query(sqlQuery, params);
    
    return success(res, list || []);
  } catch (err) { next(err); }
};

// ── POST /api/teachers/assignments ────────────────────────────────────────
exports.assignSubject = async (req, res, next) => {
    return res.status(501).json({ success: false, message: "assignSubject API is not implemented yet." });
};

// ── DELETE /api/teachers/assignments/:assignmentId ────────────────────────
exports.removeAssignment = async (req, res, next) => {
    return res.status(501).json({ success: false, message: "removeAssignment API is not implemented yet." });
};
