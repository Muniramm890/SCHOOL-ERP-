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
// Students ke paas abhi login account nahi hai — Student App aane tak
// ye sirf read-only snapshot hai (User Management ke "Students" switch-tab ke liye).
exports.getStudentsOverview = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const row = await queryOne(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active_count
       FROM students
       WHERE school_id = @sid AND deleted_at IS NULL`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    return success(res, {
      total: row?.total || 0,
      active: row?.active_count || 0,
      login_enabled: false,
    }, 'Students overview fetched');
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
