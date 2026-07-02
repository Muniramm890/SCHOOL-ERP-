// src/controllers/teachersController.js

const { query, queryOne, withTransaction, sql } = require('../config/db');
const { success, created, notFound, badRequest } = require('../utils/response');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

// ── Helper: Get School ID (Ultimate Fallback Version) ─────────────────────
const getSchoolId = (req) => {
  if (req.headers && req.headers['x-school-id']) return req.headers['x-school-id'];
  if (req.school) return req.school;
  if (req.schoolId) return req.schoolId;
  if (req.school_id) return req.school_id;
  if (req.user) {
    if (req.user.school) return req.user.school;
    if (req.user.school_id) return req.user.school_id;
    if (req.user.schoolId) return req.user.schoolId;
  }
  if (req.body && req.body.school_id) return req.body.school_id;
  if (req.query && req.query.school_id) return req.query.school_id;
  return null;
};

// ── GET /api/teachers (Optimized & SaaS Scalable) ─────────────────────────
exports.list = async (req, res, next) => {
  try {
    const schoolId = getSchoolId(req);
    
    const sqlQuery = `
      SELECT 
        u.id AS user_id, u.full_name, u.email, u.phone, u.gender, u.avatar_url,
        sm.employee_code, sm.join_date, sm.is_active, sm.role,
        sp.department, sp.designation, sp.qualification, sp.experience_years
      FROM school_members sm
      INNER JOIN users u ON sm.user_id = u.id
      LEFT JOIN staff_profiles sp ON sm.user_id = sp.user_id AND sp.school_id = sm.school_id
      WHERE sm.school_id = @schoolId 
        AND sm.role = 'teacher' 
        AND sm.deleted_at IS NULL
      ORDER BY u.full_name ASC
    `;

    // 🎯 Explicit SQL Types applied
    const params = { schoolId: { type: sql.UniqueIdentifier, value: schoolId } };

    const teachers = await query(sqlQuery, params);
    return success(res, 'Teachers fetched successfully', teachers);
  } catch (err) {
    next(err);
  }
};

// ── GET /api/teachers/:userId ─────────────────────────────────────────────
exports.getOne = async (req, res, next) => {
  try {
    const schoolId = getSchoolId(req);
    const { userId } = req.params;

    const sqlQuery = `
      SELECT 
        u.id AS user_id, u.full_name, u.email, u.phone, u.gender, u.date_of_birth,
        sm.employee_code, sm.join_date, sm.is_active, sm.role,
        sp.department, sp.designation, sp.qualification, sp.experience_years
      FROM school_members sm
      INNER JOIN users u ON sm.user_id = u.id
      LEFT JOIN staff_profiles sp ON sm.user_id = sp.user_id AND sp.school_id = sm.school_id
      WHERE sm.school_id = @schoolId 
        AND sm.user_id = @userId 
        AND sm.deleted_at IS NULL
    `;

    // 🎯 Explicit SQL Types applied
    const params = {
      schoolId: { type: sql.UniqueIdentifier, value: schoolId },
      userId: { type: sql.UniqueIdentifier, value: userId }
    };

    const teacher = await queryOne(sqlQuery, params);
    if (!teacher) return notFound(res, 'Teacher not found in this school');

    return success(res, 'Teacher details fetched', teacher);
  } catch (err) {
    next(err);
  }
};

// ── POST /api/teachers ────────────────────────────────────────────────────
exports.create = async (req, res, next) => {
  try {
    const schoolId = getSchoolId(req);
    const { 
      full_name, email, phone, gender, password, 
      employee_code, join_date, department, designation, qualification, experience_years 
    } = req.body;

    const userId = uuidv4();
    const smId = uuidv4();
    const spId = uuidv4();
    
    const hash = await bcrypt.hash(password || 'teacher123', 10);

    // ✅ Smart Gender Sanitization (Bypasses SQL CHECK Constraint errors)
    let finalGender = gender ? String(gender).trim() : 'Male';
    finalGender = finalGender.charAt(0).toUpperCase() + finalGender.slice(1).toLowerCase();
    if (!['Male', 'Female', 'Other'].includes(finalGender)) finalGender = 'Male';

    await withTransaction(async (tx) => {
      // 1. Insert into users (🔥 Typed exactly like studentsController)
      const r1 = tx.request();
      r1.input('id', sql.UniqueIdentifier, userId);
      r1.input('full_name', sql.NVarChar(255), full_name);
      r1.input('email', sql.NVarChar(255), email);
      r1.input('phone', sql.NVarChar(50), phone || null);
      r1.input('gender', sql.VarChar(20), finalGender);
      r1.input('password', sql.NVarChar(255), hash);
      await r1.query(`
        INSERT INTO users (id, full_name, email, phone, gender, password)
        VALUES (@id, @full_name, @email, @phone, @gender, @password)
      `);

      // 2. Insert into school_members
      const r2 = tx.request();
      r2.input('id', sql.UniqueIdentifier, smId);
      r2.input('school_id', sql.UniqueIdentifier, schoolId);
      r2.input('user_id', sql.UniqueIdentifier, userId);
      r2.input('role', sql.VarChar(50), 'teacher');
      r2.input('employee_code', sql.NVarChar(100), employee_code || null);
      r2.input('join_date', sql.Date, join_date === '' ? null : join_date || null);
      await r2.query(`
        INSERT INTO school_members (id, school_id, user_id, role, employee_code, join_date)
        VALUES (@id, @school_id, @user_id, @role, @employee_code, @join_date)
      `);

      // 3. Insert into staff_profiles
      const r3 = tx.request();
      r3.input('id', sql.UniqueIdentifier, spId);
      r3.input('school_id', sql.UniqueIdentifier, schoolId);
      r3.input('user_id', sql.UniqueIdentifier, userId);
      r3.input('department', sql.NVarChar(100), department || null);
      r3.input('designation', sql.NVarChar(100), designation || null);
      r3.input('qualification', sql.NVarChar(255), qualification || null);
      r3.input('experience_years', sql.SmallInt, Number(experience_years) || 0);
      await r3.query(`
        INSERT INTO staff_profiles (id, school_id, user_id, department, designation, qualification, experience_years)
        VALUES (@id, @school_id, @user_id, @department, @designation, @qualification, @experience_years)
      `);
    });

    return created(res, 'Teacher created successfully', { user_id: userId });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE KEY')) {
      return badRequest(res, 'Email or Employee Code already exists');
    }
    next(err);
  }
};

// ── PUT /api/teachers/:userId ─────────────────────────────────────────────
exports.update = async (req, res, next) => {
  try {
    const schoolId = getSchoolId(req);
    const { userId } = req.params;
    const { full_name, phone, gender, employee_code, department, designation, is_active } = req.body;

    let finalGender = gender ? String(gender).trim() : 'Male';
    finalGender = finalGender.charAt(0).toUpperCase() + finalGender.slice(1).toLowerCase();
    if (!['Male', 'Female', 'Other'].includes(finalGender)) finalGender = 'Male';

    await withTransaction(async (tx) => {
      // Update users table
      const r1 = tx.request();
      r1.input('userId', sql.UniqueIdentifier, userId);
      r1.input('full_name', sql.NVarChar(255), full_name);
      r1.input('phone', sql.NVarChar(50), phone || null);
      r1.input('gender', sql.VarChar(20), finalGender);
      await r1.query(`UPDATE users SET full_name = @full_name, phone = @phone, gender = @gender, updated_at = GETUTCDATE() WHERE id = @userId`);

      // Update school_members
      const r2 = tx.request();
      r2.input('schoolId', sql.UniqueIdentifier, schoolId);
      r2.input('userId', sql.UniqueIdentifier, userId);
      r2.input('employee_code', sql.NVarChar(100), employee_code || null);
      r2.input('is_active', sql.Bit, is_active !== false ? 1 : 0);
      await r2.query(`UPDATE school_members SET employee_code = @employee_code, is_active = @is_active, updated_at = GETUTCDATE() WHERE user_id = @userId AND school_id = @schoolId`);

      // Update staff_profiles
      const r3 = tx.request();
      r3.input('schoolId', sql.UniqueIdentifier, schoolId);
      r3.input('userId', sql.UniqueIdentifier, userId);
      r3.input('department', sql.NVarChar(100), department || null);
      r3.input('designation', sql.NVarChar(100), designation || null);
      await r3.query(`UPDATE staff_profiles SET department = @department, designation = @designation, updated_at = GETUTCDATE() WHERE user_id = @userId AND school_id = @schoolId`);
    });

    return success(res, 'Teacher updated successfully');
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/teachers/:userId (Cascading Soft Delete) ──────────────────
exports.remove = async (req, res, next) => {
  try {
    const schoolId = getSchoolId(req);
    const { userId } = req.params;

    const sqlQuery = `
      UPDATE school_members 
      SET is_active = 0, deleted_at = GETUTCDATE() 
      WHERE user_id = @userId AND school_id = @schoolId
    `;
    
    // 🎯 Explicit SQL Types applied
    const params = {
      schoolId: { type: sql.UniqueIdentifier, value: schoolId },
      userId: { type: sql.UniqueIdentifier, value: userId }
    };

    await query(sqlQuery, params);
    return success(res, 'Teacher removed from school successfully');
  } catch (err) {
    next(err);
  }
};

// ── PUT /api/teachers/assign-class-teacher ────────────────────────────────
exports.assignClassTeacher = async (req, res, next) => {
  try {
    const schoolId = getSchoolId(req);
    const { sectionId, teacherUserId } = req.body;

    const sqlQuery = `
      UPDATE sections 
      SET class_teacher_id = @teacherUserId, updated_at = GETUTCDATE()
      WHERE id = @sectionId AND school_id = @schoolId
    `;

    // 🎯 Explicit SQL Types applied
    const params = {
      schoolId: { type: sql.UniqueIdentifier, value: schoolId },
      sectionId: { type: sql.UniqueIdentifier, value: sectionId },
      teacherUserId: { type: sql.UniqueIdentifier, value: teacherUserId || null }
    };

    await query(sqlQuery, params);
    return success(res, 'Class teacher assigned successfully');
  } catch (err) {
    next(err);
  }
};

// ── GET /api/teachers/lookups ─────────────────────────────────────────────
exports.getLookups = async (req, res, next) => {
  try {
    const schoolId = getSchoolId(req);
    
    const sqlQuery = `
      SELECT u.id AS user_id, u.full_name, sm.employee_code
      FROM school_members sm
      INNER JOIN users u ON sm.user_id = u.id
      WHERE sm.school_id = @schoolId AND sm.role = 'teacher' AND sm.is_active = 1 AND sm.deleted_at IS NULL
      ORDER BY u.full_name ASC
    `;

    const params = { schoolId: { type: sql.UniqueIdentifier, value: schoolId } };
    const list = await query(sqlQuery, params);
    return success(res, 'Lookup fetched', list);
  } catch (err) {
    next(err);
  }
};

// ── POST /api/teachers/assignments ────────────────────────────────────────
exports.assignSubject = async (req, res, next) => {
    return res.status(501).json({ success: false, message: "assignSubject API is not implemented yet." });
};

// ── DELETE /api/teachers/assignments/:assignmentId ────────────────────────
exports.removeAssignment = async (req, res, next) => {
    return res.status(501).json({ success: false, message: "removeAssignment API is not implemented yet." });
};
