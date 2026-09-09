// src/controllers/userManagementController.js
const bcrypt = require('bcryptjs');
const { query, queryOne, sql } = require('../config/db');
const { success, badRequest, notFound } = require('../utils/response');
const { logAudit } = require('../utils/auditLogger');

// ── GET /api/admin/users/staff ──────────────────────────────────────────
exports.listStaff = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const result = await query(
      `SELECT sm.id AS member_id, sm.user_id, sm.role, sm.is_active, sm.employee_code,
              sm.join_date, sm.permissions,
              u.full_name, u.email, u.phone, u.avatar_url, u.last_login_at,
              sp.department, sp.designation
       FROM school_members sm
       JOIN users u ON u.id = sm.user_id
       LEFT JOIN staff_profiles sp ON sp.user_id = sm.user_id AND sp.school_id = sm.school_id
       WHERE sm.school_id = @sid AND sm.deleted_at IS NULL
       ORDER BY CASE WHEN sm.role = 'school_admin' THEN 0 ELSE 1 END, u.full_name`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );

    const staff = result.recordset.map((r) => ({
      ...r,
      permissions: (() => { try { return JSON.parse(r.permissions || '{}'); } catch { return {}; } })(),
      is_self: r.user_id === req.user.userId,
    }));

    return success(res, staff, 'Staff list fetched');
  } catch (err) { next(err); }
};

// ── GET /api/admin/users/students-overview ──────────────────────────────
exports.getStudentsOverview = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const row = await queryOne(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN s.is_active = 1 THEN 1 ELSE 0 END) AS active_count,
              SUM(CASE WHEN sc.is_active = 1 THEN 1 ELSE 0 END) AS login_enabled_count
       FROM students s
       LEFT JOIN student_credentials sc ON sc.student_id = s.id AND sc.deleted_at IS NULL
       WHERE s.school_id = @sid AND s.deleted_at IS NULL`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    return success(res, {
      total: row?.total || 0,
      active: row?.active_count || 0,
      login_enabled: row?.login_enabled_count || 0,
    }, 'Students overview fetched');
  } catch (err) { next(err); }
};

// ═══════════════════════════════════════════════════════════════
// STUDENT LOGIN AUTHORIZATION — admin decides who gets student-app access
// ═══════════════════════════════════════════════════════════════

// ── GET /api/admin/users/students ──────────────────────────────────────
exports.listStudentsForAuth = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { search, grade_id, section_id, status } = req.query;

    let where = `st.school_id=@sid AND st.deleted_at IS NULL`;
    const params = { sid: { type: sql.UniqueIdentifier, value: schoolId } };

    if (search) {
      where += ` AND (st.first_name + ' ' + ISNULL(st.last_name,'') LIKE @search OR st.admission_no LIKE @search)`;
      params.search = { type: sql.NVarChar(255), value: `%${search.trim()}%` };
    }
    if (grade_id) { where += ` AND g.id=@gradeId`; params.gradeId = { type: sql.UniqueIdentifier, value: grade_id }; }
    if (section_id) { where += ` AND sec.id=@sectionId`; params.sectionId = { type: sql.UniqueIdentifier, value: section_id }; }
    if (status === 'authorized') where += ` AND sc.id IS NOT NULL AND sc.is_active=1`;
    if (status === 'blocked') where += ` AND sc.id IS NOT NULL AND sc.is_active=0`;
    if (status === 'not_authorized') where += ` AND sc.id IS NULL`;

    const result = await query(
      `SELECT st.id AS student_id, st.first_name, st.last_name, st.photo_url, st.admission_no,
              g.name AS class_name, sec.name AS section_name, e.roll_no,
              sg.phone AS guardian_phone,
              sc.id AS credential_id, sc.is_active AS login_active, sc.identifier_type,
              sc.login_identifier, sc.login_phone, sc.login_email, sc.last_login_at
       FROM students st
       LEFT JOIN enrolments e ON e.student_id=st.id AND e.school_id=@sid AND e.is_active=1 AND e.deleted_at IS NULL
       LEFT JOIN sections sec ON sec.id=e.section_id
       LEFT JOIN grades g ON g.id=sec.grade_id
       LEFT JOIN student_guardians sg ON sg.student_id=st.id AND sg.is_primary=1 AND sg.deleted_at IS NULL
       LEFT JOIN student_credentials sc ON sc.student_id=st.id AND sc.deleted_at IS NULL
       WHERE ${where}
       ORDER BY ISNULL(g.numeric_order,999), sec.name, st.first_name`,
      params
    );

    const rows = result.recordset.map((r) => ({
      ...r,
      login_status: !r.credential_id ? 'not_authorized' : r.login_active ? 'active' : 'blocked',
    }));

    return success(res, rows, 'Students fetched');
  } catch (err) { next(err); }
};

// ── POST /api/admin/users/students/:studentId/authorize ─────────────────
// Body: { identifier_type: 'phone'|'admission_no'|'roll_no'|'email', identifier_value, password? }
exports.authorizeStudent = async (req, res, next) => {
  try {
    const { schoolId, userId: actingUserId, fullName: actingUserName } = req.user;
    const { studentId } = req.params;
    let { identifier_type, identifier_value, password } = req.body;

    const ALLOWED_TYPES = ['phone', 'admission_no', 'roll_no', 'email'];
    if (!ALLOWED_TYPES.includes(identifier_type)) return badRequest(res, `identifier_type must be one of: ${ALLOWED_TYPES.join(', ')}`);
    if (!identifier_value || !String(identifier_value).trim()) return badRequest(res, 'identifier_value is required');

    const student = await queryOne(
      `SELECT id, first_name, last_name FROM students WHERE id=@sid AND school_id=@schoolId AND deleted_at IS NULL`,
      { sid: { type: sql.UniqueIdentifier, value: studentId }, schoolId: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    if (!student) return notFound(res, 'Student not found');

    const value = String(identifier_value).trim();
    const generated = !password;
    if (generated) password = 'Stu@' + Math.floor(1000 + Math.random() * 9000);
    if (String(password).length < 6) return badRequest(res, 'Password must be at least 6 characters');
    const hash = await bcrypt.hash(password, 12);

    const existing = await queryOne(
      `SELECT id FROM student_credentials WHERE student_id=@stid AND deleted_at IS NULL`,
      { stid: { type: sql.UniqueIdentifier, value: studentId } }
    );

    const loginPhone = identifier_type === 'phone' ? value : null;
    const loginEmail = identifier_type === 'email' ? value : null;
    const loginIdentifier = ['admission_no', 'roll_no'].includes(identifier_type) ? value : null;

    if (existing) {
      await query(
        `UPDATE student_credentials
         SET identifier_type=@itype, login_identifier=@lid, login_phone=@lp, login_email=@le,
             password_hash=@hash, is_active=1, updated_at=GETUTCDATE()
         WHERE id=@id`,
        {
          itype: { type: sql.VarChar(20), value: identifier_type },
          lid: { type: sql.NVarChar(100), value: loginIdentifier },
          lp: { type: sql.NVarChar(20), value: loginPhone },
          le: { type: sql.NVarChar(255), value: loginEmail },
          hash: { type: sql.NVarChar(255), value: hash },
          id: { type: sql.UniqueIdentifier, value: existing.id },
        }
      );
    } else {
      await query(
        `INSERT INTO student_credentials (id, school_id, student_id, identifier_type, login_identifier, login_phone, login_email, password_hash, is_active)
         VALUES (NEWID(), @sid, @stid, @itype, @lid, @lp, @le, @hash, 1)`,
        {
          sid: { type: sql.UniqueIdentifier, value: schoolId },
          stid: { type: sql.UniqueIdentifier, value: studentId },
          itype: { type: sql.VarChar(20), value: identifier_type },
          lid: { type: sql.NVarChar(100), value: loginIdentifier },
          lp: { type: sql.NVarChar(20), value: loginPhone },
          le: { type: sql.NVarChar(255), value: loginEmail },
          hash: { type: sql.NVarChar(255), value: hash },
        }
      );
    }

    await logAudit({
      schoolId, userId: actingUserId, userName: actingUserName, userRole: req.user.role,
      actionType: 'STUDENT_LOGIN_AUTHORIZED',
      details: { studentId, studentName: `${student.first_name} ${student.last_name || ''}`.trim(), identifierType: identifier_type },
    });

    return success(res, { temporaryPassword: generated ? password : undefined }, 'Student login authorized');
  } catch (err) {
    if (err.number === 2601 || err.number === 2627) return badRequest(res, 'This identifier is already used by another student');
    next(err);
  }
};

// ── PUT /api/admin/users/students/:studentId/status ──────────────────────
exports.updateStudentLoginStatus = async (req, res, next) => {
  try {
    const { schoolId, userId: actingUserId, fullName: actingUserName } = req.user;
    const { studentId } = req.params;
    const { is_active } = req.body;
    if (typeof is_active !== 'boolean') return badRequest(res, 'is_active (boolean) is required');

    const cred = await queryOne(
      `SELECT sc.id, st.first_name, st.last_name FROM student_credentials sc
       JOIN students st ON st.id=sc.student_id
       WHERE sc.student_id=@stid AND sc.school_id=@sid AND sc.deleted_at IS NULL`,
      { stid: { type: sql.UniqueIdentifier, value: studentId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    if (!cred) return notFound(res, 'This student is not yet authorized for login');

    await query(
      `UPDATE student_credentials SET is_active=@act, updated_at=GETUTCDATE() WHERE id=@id`,
      { act: { type: sql.Bit, value: is_active ? 1 : 0 }, id: { type: sql.UniqueIdentifier, value: cred.id } }
    );

    await logAudit({
      schoolId, userId: actingUserId, userName: actingUserName, userRole: req.user.role,
      actionType: is_active ? 'STUDENT_LOGIN_UNBLOCKED' : 'STUDENT_LOGIN_BLOCKED',
      details: { studentId, studentName: `${cred.first_name} ${cred.last_name || ''}`.trim() },
    });

    return success(res, null, is_active ? 'Student login unblocked' : 'Student login blocked');
  } catch (err) { next(err); }
};

// ── POST /api/admin/users/students/:studentId/reset-password ─────────────
exports.resetStudentPassword = async (req, res, next) => {
  try {
    const { schoolId, userId: actingUserId, fullName: actingUserName } = req.user;
    const { studentId } = req.params;
    let { newPassword } = req.body;

    const cred = await queryOne(
      `SELECT sc.id, st.first_name, st.last_name FROM student_credentials sc
       JOIN students st ON st.id=sc.student_id
       WHERE sc.student_id=@stid AND sc.school_id=@sid AND sc.deleted_at IS NULL`,
      { stid: { type: sql.UniqueIdentifier, value: studentId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    if (!cred) return notFound(res, 'This student is not yet authorized for login');

    const generated = !newPassword;
    if (generated) newPassword = 'Stu@' + Math.floor(1000 + Math.random() * 9000);
    if (String(newPassword).length < 6) return badRequest(res, 'Password must be at least 6 characters');

    const hash = await bcrypt.hash(newPassword, 12);
    await query(
      `UPDATE student_credentials SET password_hash=@hash, updated_at=GETUTCDATE() WHERE id=@id`,
      { hash: { type: sql.NVarChar(255), value: hash }, id: { type: sql.UniqueIdentifier, value: cred.id } }
    );

    await logAudit({
      schoolId, userId: actingUserId, userName: actingUserName, userRole: req.user.role,
      actionType: 'STUDENT_PASSWORD_RESET',
      details: { studentId, studentName: `${cred.first_name} ${cred.last_name || ''}`.trim() },
    });

    return success(res, { temporaryPassword: generated ? newPassword : undefined }, 'Password reset successfully');
  } catch (err) { next(err); }
};

// ── PUT /api/admin/users/:memberId/status ───────────────────────────────
// Block / unblock — is_active middleware level pe har request pe check hota
// hai, isliye ye turant effective ho jaata hai, active session ke beech mein bhi.
exports.updateStatus = async (req, res, next) => {
  try {
    const { schoolId, userId: actingUserId, fullName: actingUserName } = req.user;
    const { memberId } = req.params;
    const { is_active } = req.body;

    if (typeof is_active !== 'boolean') return badRequest(res, 'is_active (boolean) is required');

    const target = await queryOne(
      `SELECT sm.id, sm.user_id, sm.role, u.full_name
       FROM school_members sm JOIN users u ON u.id = sm.user_id
       WHERE sm.id = @mid AND sm.school_id = @sid AND sm.deleted_at IS NULL`,
      { mid: { type: sql.UniqueIdentifier, value: memberId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    if (!target) return notFound(res, 'Staff member not found');
    if (target.user_id === actingUserId) return badRequest(res, 'You cannot block your own account');

    if (!is_active && target.role === 'school_admin') {
      const activeAdmins = await queryOne(
        `SELECT COUNT(*) AS cnt FROM school_members WHERE school_id=@sid AND role='school_admin' AND is_active=1 AND deleted_at IS NULL`,
        { sid: { type: sql.UniqueIdentifier, value: schoolId } }
      );
      if ((activeAdmins?.cnt || 0) <= 1) return badRequest(res, 'Cannot block the only active Super Admin');
    }

    await query(
      `UPDATE school_members SET is_active=@act, updated_at=GETUTCDATE() WHERE id=@mid AND school_id=@sid`,
      { act: { type: sql.Bit, value: is_active ? 1 : 0 }, mid: { type: sql.UniqueIdentifier, value: memberId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );

    await logAudit({
      schoolId, userId: actingUserId, userName: actingUserName, userRole: req.user.role,
      actionType: is_active ? 'USER_UNBLOCKED' : 'USER_BLOCKED',
      details: { targetUserId: target.user_id, targetName: target.full_name },
    });

    return success(res, null, is_active ? 'Staff member unblocked' : 'Staff member blocked');
  } catch (err) { next(err); }
};

// ── PUT /api/admin/users/:memberId/role ─────────────────────────────────
exports.updateRole = async (req, res, next) => {
  try {
    const { schoolId, userId: actingUserId, fullName: actingUserName } = req.user;
    const { memberId } = req.params;
    const { role } = req.body;

    const ALLOWED_ROLES = ['school_admin', 'teacher', 'accountant', 'staff'];
    if (!ALLOWED_ROLES.includes(role)) return badRequest(res, `role must be one of: ${ALLOWED_ROLES.join(', ')}`);

    const target = await queryOne(
      `SELECT sm.id, sm.user_id, sm.role, u.full_name
       FROM school_members sm JOIN users u ON u.id = sm.user_id
       WHERE sm.id = @mid AND sm.school_id = @sid AND sm.deleted_at IS NULL`,
      { mid: { type: sql.UniqueIdentifier, value: memberId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    if (!target) return notFound(res, 'Staff member not found');

    if (target.role === 'school_admin' && role !== 'school_admin') {
      const activeAdmins = await queryOne(
        `SELECT COUNT(*) AS cnt FROM school_members WHERE school_id=@sid AND role='school_admin' AND is_active=1 AND deleted_at IS NULL`,
        { sid: { type: sql.UniqueIdentifier, value: schoolId } }
      );
      if ((activeAdmins?.cnt || 0) <= 1) return badRequest(res, 'Cannot demote the only Super Admin — promote someone else first');
    }

    await query(
      `UPDATE school_members SET role=@role, updated_at=GETUTCDATE() WHERE id=@mid AND school_id=@sid`,
      { role: { type: sql.VarChar(50), value: role }, mid: { type: sql.UniqueIdentifier, value: memberId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );

    await logAudit({
      schoolId, userId: actingUserId, userName: actingUserName, userRole: req.user.role,
      actionType: 'USER_ROLE_CHANGED',
      details: { targetUserId: target.user_id, targetName: target.full_name, fromRole: target.role, toRole: role },
    });

    return success(res, null, `Role updated to ${role}`);
  } catch (err) { next(err); }
};

// ── PUT /api/admin/users/:memberId/permissions ──────────────────────────
// Module-wise access — existing permissions JSON column reuse karta hai:
// { "modules": ["students", "fees", "attendance"] }
exports.updatePermissions = async (req, res, next) => {
  try {
    const { schoolId, userId: actingUserId, fullName: actingUserName } = req.user;
    const { memberId } = req.params;
    const { modules } = req.body;

    if (!Array.isArray(modules)) return badRequest(res, 'modules must be an array of module keys');

    const target = await queryOne(
      `SELECT sm.id, sm.user_id, u.full_name FROM school_members sm JOIN users u ON u.id = sm.user_id
       WHERE sm.id=@mid AND sm.school_id=@sid AND sm.deleted_at IS NULL`,
      { mid: { type: sql.UniqueIdentifier, value: memberId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    if (!target) return notFound(res, 'Staff member not found');

    const permissionsJson = JSON.stringify({ modules });
    await query(
      `UPDATE school_members SET permissions=@perm, updated_at=GETUTCDATE() WHERE id=@mid AND school_id=@sid`,
      { perm: { type: sql.NVarChar(sql.MAX), value: permissionsJson }, mid: { type: sql.UniqueIdentifier, value: memberId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );

    await logAudit({
      schoolId, userId: actingUserId, userName: actingUserName, userRole: req.user.role,
      actionType: 'USER_PERMISSIONS_CHANGED',
      details: { targetUserId: target.user_id, targetName: target.full_name, modules },
    });

    return success(res, null, "Permissions updated. Changes apply on the user's next login.");
  } catch (err) { next(err); }
};

// ── POST /api/admin/users/:memberId/reset-password ──────────────────────
exports.resetPassword = async (req, res, next) => {
  try {
    const { schoolId, userId: actingUserId, fullName: actingUserName } = req.user;
    const { memberId } = req.params;
    let { newPassword } = req.body;

    const target = await queryOne(
      `SELECT sm.user_id, u.full_name FROM school_members sm JOIN users u ON u.id = sm.user_id
       WHERE sm.id=@mid AND sm.school_id=@sid AND sm.deleted_at IS NULL`,
      { mid: { type: sql.UniqueIdentifier, value: memberId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    if (!target) return notFound(res, 'Staff member not found');

    const generated = !newPassword;
    if (generated) newPassword = 'Temp@' + Math.floor(1000 + Math.random() * 9000);
    if (String(newPassword).length < 6) return badRequest(res, 'Password must be at least 6 characters');

    const hash = await bcrypt.hash(newPassword, 12);
    await query(
      `UPDATE users SET password=@pw, updated_at=GETUTCDATE() WHERE id=@uid`,
      { pw: { type: sql.NVarChar(255), value: hash }, uid: { type: sql.UniqueIdentifier, value: target.user_id } }
    );

    await logAudit({
      schoolId, userId: actingUserId, userName: actingUserName, userRole: req.user.role,
      actionType: 'USER_PASSWORD_RESET',
      details: { targetUserId: target.user_id, targetName: target.full_name },
    });

    return success(res, { temporaryPassword: generated ? newPassword : undefined }, 'Password reset successfully');
  } catch (err) { next(err); }
};
