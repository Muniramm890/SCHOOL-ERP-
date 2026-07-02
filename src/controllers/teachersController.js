// src/controllers/teachersController.js
const { query, queryOne, withTransaction, sql } = require('../config/db');
const { success, created, notFound, badRequest, paginated } = require('../utils/response');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

// ── Helper: Get School ID ─────────────────────────────────────────────────
// Maan kar chal rahe hain ki auth middleware school id req.user.school mein daalta hai (jaise logs mein tha)
const getSchoolId = (req) => req.user.school; 

// ── GET /api/teachers (Optimized & SaaS Scalable) ─────────────────────────
exports.list = async (req, res, next) => {
  try {
    const schoolId = getSchoolId(req);
    
    // JOINing users, school_members, and staff_profiles accurately
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

    const teachers = await query(sqlQuery, { schoolId });
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

    const teacher = await queryOne(sqlQuery, { schoolId, userId });
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
    
    // Default password agar provide nahi kiya
    const hash = await bcrypt.hash(password || 'teacher123', 10);

    // Transaction zaroori hai taaki teeno tables mein data ek saath insert ho
    await withTransaction(async (db) => {
      // 1. Insert into users
      await db.request()
        .input('id', userId)
        .input('full_name', full_name)
        .input('email', email)
        .input('phone', phone)
        .input('gender', gender)
        .input('password', hash)
        .query(`
          INSERT INTO users (id, full_name, email, phone, gender, password)
          VALUES (@id, @full_name, @email, @phone, @gender, @password)
        `);

      // 2. Insert into school_members (Link user with school)
      await db.request()
        .input('id', smId)
        .input('school_id', schoolId)
        .input('user_id', userId)
        .input('role', 'teacher')
        .input('employee_code', employee_code)
        .input('join_date', join_date)
        .query(`
          INSERT INTO school_members (id, school_id, user_id, role, employee_code, join_date)
          VALUES (@id, @school_id, @user_id, @role, @employee_code, @join_date)
        `);

      // 3. Insert into staff_profiles (Extra details)
      await db.request()
        .input('id', spId)
        .input('school_id', schoolId)
        .input('user_id', userId)
        .input('department', department)
        .input('designation', designation)
        .input('qualification', qualification)
        .input('experience_years', experience_years || 0)
        .query(`
          INSERT INTO staff_profiles (id, school_id, user_id, department, designation, qualification, experience_years)
          VALUES (@id, @school_id, @user_id, @department, @designation, @qualification, @experience_years)
        `);
    });

    return created(res, 'Teacher created successfully', { user_id: userId });
  } catch (err) {
    if (err.message.includes('UNIQUE KEY')) {
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

    await withTransaction(async (db) => {
      // Update users table
      await db.request()
        .input('userId', userId)
        .input('full_name', full_name)
        .input('phone', phone)
        .input('gender', gender)
        .query(`UPDATE users SET full_name = @full_name, phone = @phone, gender = @gender, updated_at = GETUTCDATE() WHERE id = @userId`);

      // Update school_members
      await db.request()
        .input('schoolId', schoolId)
        .input('userId', userId)
        .input('employee_code', employee_code)
        .input('is_active', is_active)
        .query(`UPDATE school_members SET employee_code = @employee_code, is_active = @is_active, updated_at = GETUTCDATE() WHERE user_id = @userId AND school_id = @schoolId`);

      // Update staff_profiles
      await db.request()
        .input('schoolId', schoolId)
        .input('userId', userId)
        .input('department', department)
        .input('designation', designation)
        .query(`UPDATE staff_profiles SET department = @department, designation = @designation, updated_at = GETUTCDATE() WHERE user_id = @userId AND school_id = @schoolId`);
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

    // SaaS Soft delete: Hum sirf school_members se delete kar rahe hain (School se naata tod rahe hain)
    const sqlQuery = `
      UPDATE school_members 
      SET is_active = 0, deleted_at = GETUTCDATE() 
      WHERE user_id = @userId AND school_id = @schoolId
    `;
    
    await query(sqlQuery, { userId, schoolId });
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

    // Sections table mein class_teacher_id update karenge
    const sqlQuery = `
      UPDATE sections 
      SET class_teacher_id = @teacherUserId, updated_at = GETUTCDATE()
      WHERE id = @sectionId AND school_id = @schoolId
    `;

    await query(sqlQuery, { sectionId, teacherUserId, schoolId });
    return success(res, 'Class teacher assigned successfully');
  } catch (err) {
    next(err);
  }
};

// ── GET /api/teachers/lookups ─────────────────────────────────────────────
exports.getLookups = async (req, res, next) => {
  try {
    const schoolId = getSchoolId(req);
    // Dropdown list ke liye choti query
    const sqlQuery = `
      SELECT u.id AS user_id, u.full_name, sm.employee_code
      FROM school_members sm
      INNER JOIN users u ON sm.user_id = u.id
      WHERE sm.school_id = @schoolId AND sm.role = 'teacher' AND sm.is_active = 1 AND sm.deleted_at IS NULL
      ORDER BY u.full_name ASC
    `;
    const list = await query(sqlQuery, { schoolId });
    return success(res, 'Lookup fetched', list);
  } catch (err) {
    next(err);
  }
};

// ⚠️ NOTE: Aapke diye gaye database schema report mein "teacher_subjects" ya "timetable" naam ki table nahi mili.
// Isliye assignSubject aur removeAssignment function maine yahan omit kar diye hain. Agar aapne DB mein aisi table banayi hai, toh uska schema batayein.
