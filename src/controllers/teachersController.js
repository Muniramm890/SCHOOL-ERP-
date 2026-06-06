// src/controllers/teachersController.js
const { query, queryOne, withTransaction, sql } = require('../config/db');
const { success, created, notFound, badRequest, paginated } = require('../utils/response');
const { audit } = require('../utils/audit');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

// ── GET /api/teachers (Optimized & SaaS Scalable) ─────────────────────────
exports.list = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { page = 1, limit = 12, search, role, department, is_active } = req.query;
    
    // Convert to integers to prevent SQL Injection
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 12;
    const offset = (pageNum - 1) * limitNum;

    // 🛡️ Filter Logic (Base Query)
    let where = `sm.school_id = @sid AND sm.deleted_at IS NULL AND u.deleted_at IS NULL`;
    const params = { sid: { type: sql.UniqueIdentifier, value: schoolId } };

    if (search) { 
      where += ` AND (u.full_name LIKE @search OR u.email LIKE @search OR sm.employee_code LIKE @search)`; 
      params.search = { type: sql.NVarChar(255), value: `%${search}%` }; 
    }
    if (role) { 
      where += ` AND sm.role = @role`; 
      params.role = { type: sql.VarChar(50), value: role }; 
    }
    if (department) { 
      where += ` AND sp.department = @dept`; 
      params.dept = { type: sql.NVarChar(100), value: department }; 
    }
    if (is_active !== undefined && is_active !== '') { 
      where += ` AND sm.is_active = @ia`; 
      params.ia = { type: sql.Bit, value: is_active === '1' || is_active === 'true' ? 1 : 0 }; 
    }

    // 🔥 1. KPI STATS (Calculated at DB level for 100% Accuracy)
    // ISNULL lagaya hai taaki count NULL na aaye, zero aaye
    const statsResult = await queryOne(
      `SELECT 
          COUNT(sm.id) AS total,
          ISNULL(SUM(CASE WHEN sm.is_active = 1 THEN 1 ELSE 0 END), 0) AS active_count,
          ISNULL(SUM(CASE WHEN sa_today.status = 'present' THEN 1 ELSE 0 END), 0) AS present_count,
          ISNULL(SUM(CASE WHEN sa_today.status = 'absent' THEN 1 ELSE 0 END), 0) AS absent_count
       FROM school_members sm
       JOIN users u ON u.id = sm.user_id AND u.deleted_at IS NULL
       LEFT JOIN staff_profiles sp ON sp.member_id = sm.user_id AND sp.school_id = @sid AND sp.deleted_at IS NULL
       LEFT JOIN staff_attendance sa_today ON sa_today.staff_id = sm.user_id AND sa_today.school_id = @sid 
                 AND CONVERT(DATE, sa_today.date) = CONVERT(DATE, GETUTCDATE())
       WHERE ${where}`, params
    );

    // 🚀 2. PAGINATED DATA (Efficient Fetch)
    const rawData = await query(
      `SELECT u.id AS user_id, u.full_name, u.email, u.phone, u.avatar_url, u.last_login_at, u.gender, u.date_of_birth,
              sm.id AS member_id, sm.role, sm.employee_code, sm.is_active,
              sp.designation, sp.department, sp.qualification, sp.experience_years, sp.specialisation, sp.salary_grade, sp.ctc_paise,
              sp.date_of_joining, sp.is_class_teacher, sp.photo_url AS staff_photo,
              sa_today.status AS today_status,
              (SELECT STRING_AGG(sub.name, ', ')
               FROM teacher_assignments ta2
               JOIN subjects sub ON sub.id = ta2.subject_id
               WHERE ta2.staff_id = sm.user_id AND ta2.school_id = @sid AND ta2.deleted_at IS NULL
              ) AS assigned_subjects
       FROM school_members sm
       JOIN users u ON u.id = sm.user_id AND u.deleted_at IS NULL
       LEFT JOIN staff_profiles sp ON sp.member_id = sm.user_id AND sp.school_id = @sid AND sp.deleted_at IS NULL
       LEFT JOIN staff_attendance sa_today ON sa_today.staff_id = sm.user_id AND sa_today.school_id = @sid 
                 AND CONVERT(DATE, sa_today.date) = CONVERT(DATE, GETUTCDATE())
       WHERE ${where}
       ORDER BY u.full_name
       OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
      { ...params, offset: { type: sql.Int, value: +offset }, limit: { type: sql.Int, value: +limitNum } }
    );

    // Return format consistent with frontend states
    return res.json({ 
      data: rawData.recordset, 
      total: statsResult.total || 0,
      stats: {
          active: statsResult.active_count || 0,
          present: statsResult.present_count || 0,
          absent: statsResult.absent_count || 0
      }
    });
  } catch (err) { next(err); }
};

// ── GET /api/teachers/:userId ─────────────────────────────────────────────
exports.getOne = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { userId } = req.params;

    const teacher = await queryOne(
      `SELECT u.*, sm.role, sm.employee_code, sm.join_date, sm.permissions, sm.is_active,
              sp.*
       FROM school_members sm
       JOIN users u ON u.id = sm.user_id
       LEFT JOIN staff_profiles sp ON sp.member_id = sm.user_id AND sp.school_id = @sid
       WHERE sm.user_id = @uid AND sm.school_id = @sid AND sm.deleted_at IS NULL`,
      { uid: { type: sql.UniqueIdentifier, value: userId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    if (!teacher) return notFound(res, 'Teacher not found');

    const assignments = await query(
      `SELECT ta.*, sub.name AS subject_name, g.name AS class_name, sc.name AS section_name
       FROM teacher_assignments ta
       JOIN subjects sub ON sub.id = ta.subject_id
       JOIN sections sc  ON sc.id  = ta.section_id
       JOIN grades g     ON g.id   = sc.grade_id
       WHERE ta.staff_id = @uid AND ta.school_id = @sid AND ta.deleted_at IS NULL`,
      { uid: { type: sql.UniqueIdentifier, value: userId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );

    return success(res, { ...teacher, assignments: assignments.recordset });
  } catch (err) { next(err); }
};

// ── POST /api/teachers ────────────────────────────────────────────────────
exports.create = async (req, res, next) => {
  try {
    const { schoolId, userId: actorId } = req.user;
    
    // Destructuring with safe defaults to match TeachersModule state
    const {
      full_name, email, phone, gender, date_of_birth,
      role = 'teacher', employee_code, join_date,
      designation, department, qualification, specialisation,
      experience_years, salary_grade, ctc_paise, is_class_teacher,
      initial_password, avatar_url
    } = req.body;

    // 🛡️ Backend Validation
    if (!full_name || !email) return badRequest(res, 'Full name and email are required');

    // Check uniqueness
    const existing = await queryOne(
      `SELECT id FROM users WHERE email = @email AND deleted_at IS NULL`,
      { email: { type: sql.NVarChar(255), value: email.trim() } }
    );
    if (existing) return badRequest(res, 'Email already registered');

    const newUserId = uuidv4();
    const memberId  = uuidv4();
    const profileId = uuidv4();
    const rawPwd    = initial_password || (phone ? phone.toString().slice(-6) : 'Pass@123');
    const hash      = await bcrypt.hash(rawPwd, 12);

    // 🔒 Atomic Transaction
    await withTransaction(async (tx) => {
      // 1. Insert into users (Added avatar_url)
      const r1 = tx.request();
      r1.input('id', sql.UniqueIdentifier, newUserId);
      r1.input('fullName', sql.NVarChar(255), full_name.trim());
      r1.input('email', sql.NVarChar(255), email.trim());
      r1.input('phone', sql.NVarChar(50), phone || null);
      r1.input('gender', sql.VarChar(20), gender || null);
      r1.input('dob', sql.Date, date_of_birth || null);
      r1.input('avatar', sql.NVarChar(sql.MAX), avatar_url || null);
      await r1.query(`INSERT INTO users (id,full_name,email,phone,gender,date_of_birth,avatar_url) 
                      VALUES(@id,@fullName,@email,@phone,@gender,@dob,@avatar)`);

      // 2. Insert into user_auth (Removed silent catch - failure will rollback transaction)
      const r1b = tx.request();
      r1b.input('userId', sql.UniqueIdentifier, newUserId);
      r1b.input('hash', sql.NVarChar(255), hash);
      await r1b.query(`INSERT INTO user_auth (id,user_id,password_hash) VALUES(NEWID(),@userId,@hash)`);

      // 3. Insert into school_members
      const r2 = tx.request();
      r2.input('id', sql.UniqueIdentifier, memberId);
      r2.input('schoolId', sql.UniqueIdentifier, schoolId);
      r2.input('userId', sql.UniqueIdentifier, newUserId);
      r2.input('role', sql.VarChar(50), role);
      r2.input('empCode', sql.NVarChar(100), employee_code || null);
      r2.input('joinDate', sql.Date, join_date || null);
      await r2.query(`INSERT INTO school_members (id,school_id,user_id,role,employee_code,join_date) 
                      VALUES(@id,@schoolId,@userId,@role,@empCode,@joinDate)`);

      // 4. Insert into staff_profiles (Matches Frontend State)
      const r3 = tx.request();
      r3.input('id', sql.UniqueIdentifier, profileId);
      r3.input('schoolId', sql.UniqueIdentifier, schoolId);
      r3.input('memberId', sql.UniqueIdentifier, newUserId);
      r3.input('empCode', sql.NVarChar(100), employee_code || `EMP-${Date.now()}`);
      r3.input('designation', sql.NVarChar(100), designation || null);
      r3.input('department', sql.NVarChar(100), department || null);
      r3.input('qualification', sql.NVarChar(255), qualification || null);
      r3.input('specialisation', sql.NVarChar(255), specialisation || null);
      r3.input('expYears', sql.SmallInt, Number(experience_years) || 0);
      r3.input('doj', sql.Date, join_date || new Date());
      r3.input('salaryGrade', sql.NVarChar(50), salary_grade || null);
      r3.input('ctc', sql.BigInt, Number(ctc_paise) || 0);
      r3.input('isClassTeacher', sql.Bit, is_class_teacher ? 1 : 0);
      
      await r3.query(
        `INSERT INTO staff_profiles (id,school_id,member_id,employee_code,designation,department,
            qualification,specialisation,experience_years,date_of_joining,salary_grade,ctc_paise,is_class_teacher)
         VALUES(@id,@schoolId,@memberId,@empCode,@designation,@department,@qualification,
            @specialisation,@expYears,@doj,@salaryGrade,@ctc,@isClassTeacher)`
      );
    });

    await audit({ req, action: 'CREATE', tableName: 'staff_profiles', recordId: newUserId });
    return created(res, { user_id: newUserId, initial_password: rawPwd }, 'Teacher created successfully');
  } catch (err) { next(err); }
};


// ── PUT /api/teachers/:userId ─────────────────────────────────────────────
// ── PUT /api/teachers/:userId ─────────────────────────────────────────────
exports.update = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { schoolId } = req.user;
    
    // Frontend payload match 1:1
    const { 
        full_name, email, phone, gender, date_of_birth, role, employee_code, 
        join_date, designation, department, qualification, specialisation, 
        experience_years, salary_grade, ctc_paise, is_class_teacher, 
        is_active, initial_password, avatar_url 
    } = req.body;

    await withTransaction(async (tx) => {
        // 1. Update Users Table (Added avatar_url)
        const r1 = tx.request();
        r1.input('uid', sql.UniqueIdentifier, userId);
        r1.input('fn', sql.NVarChar(255), full_name || null);
        r1.input('em', sql.NVarChar(255), email || null);
        r1.input('ph', sql.NVarChar(50), phone || null);
        r1.input('gen', sql.VarChar(20), gender || null);
        r1.input('dob', sql.Date, date_of_birth || null);
        r1.input('av', sql.NVarChar(sql.MAX), avatar_url || null);
        
        await r1.query(`UPDATE users SET 
            full_name=ISNULL(@fn,full_name), email=ISNULL(@em,email), 
            phone=ISNULL(@ph,phone), gender=ISNULL(@gen,gender), 
            date_of_birth=ISNULL(@dob,date_of_birth), avatar_url=ISNULL(@av,avatar_url),
            updated_at=GETUTCDATE()
            WHERE id = @uid`);

        // 2. Update School Members (Role & Employee Code)
        const r2 = tx.request();
        r2.input('uid', sql.UniqueIdentifier, userId);
        r2.input('sid', sql.UniqueIdentifier, schoolId);
        r2.input('ia', sql.Bit, is_active !== undefined ? (is_active ? 1 : 0) : null);
        r2.input('role', sql.VarChar(50), role || null);
        r2.input('ec', sql.NVarChar(100), employee_code || null);
        r2.input('jd', sql.Date, join_date || null);
        
        await r2.query(`UPDATE school_members SET 
            is_active=ISNULL(@ia,is_active), role=ISNULL(@role,role), 
            employee_code=ISNULL(@ec,employee_code), join_date=ISNULL(@jd,join_date),
            updated_at=GETUTCDATE()
            WHERE user_id=@uid AND school_id=@sid`);

        // 3. Update Staff Profiles
        const r3 = tx.request();
        r3.input('uid', sql.UniqueIdentifier, userId);
        r3.input('sid', sql.UniqueIdentifier, schoolId);
        r3.input('desig', sql.NVarChar(100), designation || null);
        r3.input('dept', sql.NVarChar(100), department || null);
        r3.input('qual', sql.NVarChar(255), qualification || null);
        r3.input('spec', sql.NVarChar(255), specialisation || null);
        r3.input('exp', sql.SmallInt, experience_years ?? null);
        r3.input('sg', sql.NVarChar(50), salary_grade || null);
        r3.input('ctc', sql.BigInt, ctc_paise ?? null);
        r3.input('ict', sql.Bit, is_class_teacher != null ? (is_class_teacher ? 1 : 0) : null);

        await r3.query(`UPDATE staff_profiles SET 
            designation=ISNULL(@desig,designation), department=ISNULL(@dept,department),
            qualification=ISNULL(@qual,qualification), specialisation=ISNULL(@spec,specialisation),
            experience_years=ISNULL(@exp,experience_years), salary_grade=ISNULL(@sg,salary_grade),
            ctc_paise=ISNULL(@ctc,ctc_paise), is_class_teacher=ISNULL(@ict,is_class_teacher),
            updated_at=GETUTCDATE()
            WHERE member_id=@uid AND school_id=@sid`);

        // 4. Reset Password Logic (Only if provided)
        if (initial_password) {
            const hash = await bcrypt.hash(initial_password, 12);
            const r4 = tx.request();
            r4.input('uid', sql.UniqueIdentifier, userId);
            r4.input('hash', sql.NVarChar(255), hash);
            await r4.query(`UPDATE user_auth SET password_hash=@hash WHERE user_id=@uid`);
        }
    });

    await audit({ req, action: 'UPDATE', tableName: 'teachers', recordId: userId, newValues: req.body });
    return success(res, null, 'Teacher updated successfully');
  } catch (err) { next(err); }
};

// ── DELETE /api/teachers/:userId ──────────────────────────────────────────
// ── DELETE /api/teachers/:userId (Cascading Soft Delete) ──────────────────
exports.remove = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { schoolId } = req.user;

    await withTransaction(async (tx) => {
      // 1. Remove from School Members (Core Access)
      const r1 = tx.request();
      r1.input('uid', sql.UniqueIdentifier, userId);
      r1.input('sid', sql.UniqueIdentifier, schoolId);
      await r1.query(`UPDATE school_members SET deleted_at=GETUTCDATE(), is_active=0 
                      WHERE user_id=@uid AND school_id=@sid`);

      // 2. Remove from Assignments (Prevent Orphans in Timetables)
      const r2 = tx.request();
      r2.input('uid', sql.UniqueIdentifier, userId);
      r2.input('sid', sql.UniqueIdentifier, schoolId);
      await r2.query(`UPDATE teacher_assignments SET deleted_at=GETUTCDATE() 
                      WHERE staff_id=@uid AND school_id=@sid AND deleted_at IS NULL`);

      // 3. Remove Staff Profile (Cleanup Active Directory)
      const r3 = tx.request();
      r3.input('uid', sql.UniqueIdentifier, userId);
      r3.input('sid', sql.UniqueIdentifier, schoolId);
      await r3.query(`UPDATE staff_profiles SET deleted_at=GETUTCDATE() 
                      WHERE member_id=@uid AND school_id=@sid AND deleted_at IS NULL`);
    });

    await audit({ req, action: 'DELETE', tableName: 'school_members', recordId: userId });
    return success(res, null, 'Teacher removed from school and assignments cleared');
  } catch (err) { next(err); }
};

// ── POST /api/teachers/assignments ────────────────────────────────────────
exports.assignSubject = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { staff_id, section_id, subject_id, academic_year_id, is_primary = true } = req.body;

    // Prevent duplicate
    const existing = await queryOne(
      `SELECT id FROM teacher_assignments WHERE school_id=@sid AND staff_id=@staffId
         AND section_id=@secId AND subject_id=@subId AND deleted_at IS NULL`,
      {
        sid:    { type: sql.UniqueIdentifier, value: schoolId },
        staffId:{ type: sql.UniqueIdentifier, value: staff_id },
        secId:  { type: sql.UniqueIdentifier, value: section_id },
        subId:  { type: sql.UniqueIdentifier, value: subject_id },
      }
    );
    if (existing) return badRequest(res, 'Assignment already exists');

    await query(
      `INSERT INTO teacher_assignments (id,school_id,staff_id,section_id,subject_id,academic_year_id,is_primary)
       VALUES(NEWID(),@sid,@staffId,@secId,@subId,@ayId,@isPrimary)`,
      {
        sid:      { type: sql.UniqueIdentifier, value: schoolId },
        staffId:  { type: sql.UniqueIdentifier, value: staff_id },
        secId:    { type: sql.UniqueIdentifier, value: section_id },
        subId:    { type: sql.UniqueIdentifier, value: subject_id },
        ayId:     { type: sql.UniqueIdentifier, value: academic_year_id },
        isPrimary:{ type: sql.Bit, value: is_primary ? 1 : 0 },
      }
    );
    return created(res, null, 'Subject assigned');
  } catch (err) { next(err); }
};

// ── POST /api/teachers/assignments ────────────────────────────────────────
exports.assignSubject = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    // Frontend assignForm: staff_id, section_id, subject_id, academic_year_id
    const { staff_id, section_id, subject_id, academic_year_id, is_primary = true } = req.body;

    // 🛡️ SECURITY LAYER: Cross-School access prevention
    // Verify karo ki ye IDs isi school ke hain
    const valid = await queryOne(
      `SELECT 
          (SELECT COUNT(*) FROM school_members WHERE user_id = @staffId AND school_id = @sid AND deleted_at IS NULL) as isStaffValid,
          (SELECT COUNT(*) FROM sections WHERE id = @secId AND school_id = @sid) as isSectionValid,
          (SELECT COUNT(*) FROM subjects WHERE id = @subId AND school_id = @sid) as isSubjectValid`,
      { 
        sid: { type: sql.UniqueIdentifier, value: schoolId },
        staffId: { type: sql.UniqueIdentifier, value: staff_id },
        secId: { type: sql.UniqueIdentifier, value: section_id },
        subId: { type: sql.UniqueIdentifier, value: subject_id }
      }
    );

    if (!valid.isStaffValid || !valid.isSectionValid || !valid.isSubjectValid) {
      return badRequest(res, 'Invalid assignment data or access denied');
    }

    // 🛡️ Prevent duplicate assignment
    const existing = await queryOne(
      `SELECT id FROM teacher_assignments 
       WHERE school_id=@sid AND staff_id=@staffId AND section_id=@secId AND subject_id=@subId 
       AND academic_year_id=@ayId AND deleted_at IS NULL`,
      {
        sid: { type: sql.UniqueIdentifier, value: schoolId },
        staffId: { type: sql.UniqueIdentifier, value: staff_id },
        secId: { type: sql.UniqueIdentifier, value: section_id },
        subId: { type: sql.UniqueIdentifier, value: subject_id },
        ayId: { type: sql.UniqueIdentifier, value: academic_year_id },
      }
    );
    if (existing) return badRequest(res, 'Assignment already exists for this academic year');

    // ✅ EXECUTE
    await query(
      `INSERT INTO teacher_assignments (id,school_id,staff_id,section_id,subject_id,academic_year_id,is_primary)
       VALUES(NEWID(),@sid,@staffId,@secId,@subId,@ayId,@isPrimary)`,
      {
        sid: { type: sql.UniqueIdentifier, value: schoolId },
        staffId: { type: sql.UniqueIdentifier, value: staff_id },
        secId: { type: sql.UniqueIdentifier, value: section_id },
        subId: { type: sql.UniqueIdentifier, value: subject_id },
        ayId: { type: sql.UniqueIdentifier, value: academic_year_id },
        isPrimary: { type: sql.Bit, value: is_primary ? 1 : 0 },
      }
    );

    return created(res, null, 'Subject assigned successfully');
  } catch (err) { next(err); }
};

// ── PUT /api/teachers/assign-class-teacher ────────────────────────────────
exports.assignClassTeacher = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { staff_id, section_id } = req.body;

    // Transaction to ensure 1 section has only 1 class teacher
    await query(
      `UPDATE sections SET class_teacher_id = @staffId WHERE id = @secId AND school_id = @sid`,
      {
        sid: { type: sql.UniqueIdentifier, value: schoolId },
        staffId: { type: sql.UniqueIdentifier, value: staff_id },
        secId: { type: sql.UniqueIdentifier, value: section_id },
      }
    );
    return success(res, null, 'Class teacher assigned');
  } catch (err) { next(err); }
};

// ── DELETE /api/teachers/assignments/:assignmentId ────────────────────────
exports.removeAssignment = async (req, res, next) => {
  try {
    const { assignmentId } = req.params;
    const { schoolId } = req.user;

    await query(
      `UPDATE teacher_assignments SET deleted_at = GETUTCDATE() 
       WHERE id = @aid AND school_id = @sid`,
      { 
        aid: { type: sql.UniqueIdentifier, value: assignmentId },
        sid: { type: sql.UniqueIdentifier, value: schoolId } 
      }
    );
    return success(res, null, 'Assignment removed');
  } catch (err) { next(err); }
};

// ── GET /api/teachers/lookups ─────────────────────────────────────────────
exports.getLookups = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const data = await query(
      `SELECT DISTINCT department FROM staff_profiles WHERE school_id = @sid AND department IS NOT NULL AND deleted_at IS NULL;
       SELECT DISTINCT designation FROM staff_profiles WHERE school_id = @sid AND designation IS NOT NULL AND deleted_at IS NULL;`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    return success(res, { 
        departments: data.recordsets[0].map(r => r.department),
        designations: data.recordsets[1].map(r => r.designation)
    });
  } catch (err) { next(err); }
}; 
