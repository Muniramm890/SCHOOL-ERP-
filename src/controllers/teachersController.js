// src/controllers/teachersController.js
const { query, queryOne, withTransaction, sql } = require('../config/db');
const { success, created, notFound, badRequest, paginated } = require('../utils/response');
const { audit } = require('../utils/audit');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

// ── GET /api/teachers ─────────────────────────────────────────────────────
exports.list = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { page = 1, limit = 25, search, role, is_active = '1' } = req.query;
    const offset = (page - 1) * limit;

    let where = `sm.school_id = @sid AND sm.deleted_at IS NULL AND sm.role IN ('teacher','admin','staff')`;
    const params = { sid: { type: sql.UniqueIdentifier, value: schoolId } };

    if (search) { where += ` AND u.full_name LIKE @search`; params.search = { type: sql.NVarChar(255), value: `%${search}%` }; }
    if (role)   { where += ` AND sm.role = @role`;          params.role = { type: sql.VarChar(50), value: role }; }
    if (is_active !== undefined) { where += ` AND sm.is_active = @ia`; params.ia = { type: sql.Bit, value: is_active === '1' ? 1 : 0 }; }

    const count = await queryOne(
      `SELECT COUNT(*) AS total FROM school_members sm JOIN users u ON u.id = sm.user_id WHERE ${where}`,
      params
    );

    const teachers = await query(
      `SELECT u.id AS user_id, u.full_name, u.email, u.phone, u.avatar_url, u.last_login_at,
              sm.id AS member_id, sm.role, sm.employee_code, sm.join_date, sm.is_active,
              sp.designation, sp.department, sp.qualification, sp.experience_years,
              sp.date_of_joining, sp.is_class_teacher, sp.photo_url AS staff_photo,
              -- Today's attendance status
              sa_today.status AS today_status,
              -- Assigned subjects (comma list)
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
      { ...params, offset: { type: sql.Int, value: +offset }, limit: { type: sql.Int, value: +limit } }
    );

    return paginated(res, teachers.recordset, count.total, page, limit);
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
// Creates user + school_member + staff_profile + initial password
exports.create = async (req, res, next) => {
  try {
    const { schoolId, userId: actorId } = req.user;
    const {
      full_name, email, phone, gender, date_of_birth,
      role = 'teacher', employee_code, join_date,
      designation, department, qualification, specialisation,
      experience_years, date_of_joining, salary_grade,
      ctc_paise, is_class_teacher,
      // Initial password (optional, defaults to mobile number last 6)
      initial_password,
    } = req.body;

    // Check email unique
    const existing = await queryOne(
      `SELECT id FROM users WHERE email = @email AND deleted_at IS NULL`,
      { email: { type: sql.NVarChar(255), value: email } }
    );
    if (existing) return badRequest(res, 'Email already registered');

    const newUserId = uuidv4();
    const memberId  = uuidv4();
    const profileId = uuidv4();
    const rawPwd    = initial_password || (phone ? phone.slice(-6) : 'Pass@123');
    const hash      = await bcrypt.hash(rawPwd, 12);

    await withTransaction(async (tx) => {
      // users table
      const r1 = tx.request();
      r1.input('id', sql.UniqueIdentifier, newUserId);
      r1.input('fullName', sql.NVarChar(255), full_name);
      r1.input('email', sql.NVarChar(255), email);
      r1.input('phone', sql.NVarChar(50), phone || null);
      r1.input('gender', sql.VarChar(20), gender || null);
      r1.input('dob', sql.Date, date_of_birth || null);
      await r1.query(`INSERT INTO users (id,full_name,email,phone,gender,date_of_birth) VALUES(@id,@fullName,@email,@phone,@gender,@dob)`);

      // user_auth table (if it exists in the schema)
      const r1b = tx.request();
      r1b.input('userId', sql.UniqueIdentifier, newUserId);
      r1b.input('hash', sql.NVarChar(255), hash);
      await r1b.query(`INSERT INTO user_auth (id,user_id,password_hash) VALUES(NEWID(),@userId,@hash)`).catch(() => {});

      // school_members
      const r2 = tx.request();
      r2.input('id', sql.UniqueIdentifier, memberId);
      r2.input('schoolId', sql.UniqueIdentifier, schoolId);
      r2.input('userId', sql.UniqueIdentifier, newUserId);
      r2.input('role', sql.VarChar(50), role);
      r2.input('empCode', sql.NVarChar(100), employee_code || null);
      r2.input('joinDate', sql.Date, join_date || null);
      await r2.query(`INSERT INTO school_members (id,school_id,user_id,role,employee_code,join_date) VALUES(@id,@schoolId,@userId,@role,@empCode,@joinDate)`);

      // staff_profiles
      const r3 = tx.request();
      r3.input('id', sql.UniqueIdentifier, profileId);
      r3.input('schoolId', sql.UniqueIdentifier, schoolId);
      r3.input('memberId', sql.UniqueIdentifier, newUserId);
      r3.input('empCode', sql.NVarChar(100), employee_code || `EMP-${Date.now()}`);
      r3.input('designation', sql.NVarChar(100), designation);
      r3.input('department', sql.NVarChar(100), department || null);
      r3.input('qualification', sql.NVarChar(255), qualification);
      r3.input('specialisation', sql.NVarChar(255), specialisation || null);
      r3.input('expYears', sql.SmallInt, experience_years || 0);
      r3.input('doj', sql.Date, date_of_joining || join_date || new Date());
      r3.input('salaryGrade', sql.NVarChar(50), salary_grade || null);
      r3.input('ctc', sql.BigInt, ctc_paise || 0);
      r3.input('isClassTeacher', sql.Bit, is_class_teacher ? 1 : 0);
      await r3.query(
        `INSERT INTO staff_profiles (id,school_id,member_id,employee_code,designation,department,
           qualification,specialisation,experience_years,date_of_joining,salary_grade,ctc_paise,is_class_teacher)
         VALUES(@id,@schoolId,@memberId,@empCode,@designation,@department,@qualification,
           @specialisation,@expYears,@doj,@salaryGrade,@ctc,@isClassTeacher)`
      );
    });

    await audit({ req, action: 'CREATE', tableName: 'staff_profiles', recordId: newUserId });
    return created(res, { user_id: newUserId, initial_password: rawPwd }, 'Teacher created');
  } catch (err) { next(err); }
};

// ── PUT /api/teachers/:userId ─────────────────────────────────────────────
exports.update = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { schoolId } = req.user;
    const { full_name, phone, gender, date_of_birth, designation, department,
      qualification, specialisation, experience_years, salary_grade, ctc_paise,
      is_class_teacher, is_active } = req.body;

    await query(
      `UPDATE users SET full_name=ISNULL(@fn,full_name), phone=ISNULL(@ph,phone),
         gender=ISNULL(@gen,gender), date_of_birth=ISNULL(@dob,date_of_birth), updated_at=GETUTCDATE()
       WHERE id = @uid AND deleted_at IS NULL`,
      {
        uid: { type: sql.UniqueIdentifier, value: userId },
        fn:  { type: sql.NVarChar(255), value: full_name ?? null },
        ph:  { type: sql.NVarChar(50),  value: phone ?? null },
        gen: { type: sql.VarChar(20),   value: gender ?? null },
        dob: { type: sql.Date,          value: date_of_birth ?? null },
      }
    );

    if (is_active !== undefined) {
      await query(
        `UPDATE school_members SET is_active=@ia, updated_at=GETUTCDATE() WHERE user_id=@uid AND school_id=@sid`,
        { ia: { type: sql.Bit, value: is_active ? 1 : 0 }, uid: { type: sql.UniqueIdentifier, value: userId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
      );
    }

    await query(
      `UPDATE staff_profiles SET
         designation=ISNULL(@desig,designation), department=ISNULL(@dept,department),
         qualification=ISNULL(@qual,qualification), specialisation=ISNULL(@spec,specialisation),
         experience_years=ISNULL(@exp,experience_years), salary_grade=ISNULL(@sg,salary_grade),
         ctc_paise=ISNULL(@ctc,ctc_paise), is_class_teacher=ISNULL(@ict,is_class_teacher),
         updated_at=GETUTCDATE()
       WHERE member_id=@uid AND school_id=@sid AND deleted_at IS NULL`,
      {
        uid:   { type: sql.UniqueIdentifier, value: userId },
        sid:   { type: sql.UniqueIdentifier, value: schoolId },
        desig: { type: sql.NVarChar(100), value: designation ?? null },
        dept:  { type: sql.NVarChar(100), value: department ?? null },
        qual:  { type: sql.NVarChar(255), value: qualification ?? null },
        spec:  { type: sql.NVarChar(255), value: specialisation ?? null },
        exp:   { type: sql.SmallInt,      value: experience_years ?? null },
        sg:    { type: sql.NVarChar(50),  value: salary_grade ?? null },
        ctc:   { type: sql.BigInt,        value: ctc_paise ?? null },
        ict:   { type: sql.Bit,           value: is_class_teacher != null ? (is_class_teacher ? 1 : 0) : null },
      }
    );

    await audit({ req, action: 'UPDATE', tableName: 'staff_profiles', recordId: userId, newValues: req.body });
    return success(res, null, 'Teacher updated');
  } catch (err) { next(err); }
};

// ── DELETE /api/teachers/:userId ──────────────────────────────────────────
exports.remove = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { schoolId } = req.user;
    await query(
      `UPDATE school_members SET deleted_at=GETUTCDATE(), is_active=0 WHERE user_id=@uid AND school_id=@sid`,
      { uid: { type: sql.UniqueIdentifier, value: userId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    await audit({ req, action: 'DELETE', tableName: 'school_members', recordId: userId });
    return success(res, null, 'Teacher removed from school');
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
