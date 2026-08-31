// src/controllers/authController.js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query, queryOne, sql } = require('../config/db');
const { success, badRequest, unauthorized } = require('../utils/response');
const { logAudit } = require('../utils/auditLogger');

// ── Helpers ────────────────────────────────────────────────────────────────
// Hardcode the secret for testing right now
const secret = 'my_super_secret_key_2026_xyz'; 
const signToken = (payload) => jwt.sign(payload, secret, { expiresIn: '24h' });
 // 👈 Direct string for testing

const signRefresh = (payload) => 
  jwt.sign(payload, secret, { expiresIn: '30d' }); // 👈 Direct string for testing

// ── POST /api/auth/login ───────────────────────────────────────────────────
exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return badRequest(res, 'Email and password are required');

    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;

    const user = await queryOne(`
      SELECT id, full_name, email, password, is_active 
      FROM users 
      WHERE email = @email AND deleted_at IS NULL
    `, {
      email: { type: sql.NVarChar(255), value: email }
    });

    if (!user) {
      await logAudit({
        actionType: 'LOGIN_FAILED',
        userName: email,
        ipAddress: ip,
        userAgent: req.headers['user-agent'],
        details: { reason: 'user_not_found' },
      });
      return unauthorized(res, 'Invalid email or password');
    }
    if (!user.is_active) return unauthorized(res, 'Your account is inactive. Please contact support.');

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      await logAudit({
        userId: user.id,
        actionType: 'LOGIN_FAILED',
        userName: email,
        ipAddress: ip,
        userAgent: req.headers['user-agent'],
        details: { reason: 'wrong_password' },
      });
      return unauthorized(res, 'Invalid email or password');
    }

    const memberData = await queryOne(`
      SELECT sm.school_id, sm.role, sm.permissions, sm.is_active AS member_active, 
             s.name AS school_name, s.slug AS school_code
      FROM school_members sm
      JOIN schools s ON sm.school_id = s.id
      WHERE sm.user_id = @userId AND sm.deleted_at IS NULL AND s.deleted_at IS NULL AND s.is_active = 1
    `, { userId: { type: sql.UniqueIdentifier, value: user.id } });

    if (!memberData) return unauthorized(res, 'User is not assigned to any active school');
    if (!memberData.member_active) return unauthorized(res, 'Your school access is currently suspended');

    await query(`UPDATE users SET last_login_at = GETUTCDATE() WHERE id = @userId`, { 
      userId: { type: sql.UniqueIdentifier, value: user.id } 
    });

    const payload = { userId: user.id, schoolId: memberData.school_id, role: memberData.role, fullName: user.full_name };
    const token = signToken(payload);
    const refreshToken = signRefresh(payload);

    // 🔴 Audit log — successful login
    await logAudit({
      schoolId: memberData.school_id,
      userId: user.id,
      userName: user.full_name,
      userRole: memberData.role,
      actionType: 'LOGIN',
      ipAddress: ip,
      userAgent: req.headers['user-agent'],
    });

    return success(res, {
      token,
      refreshToken,
      userId: user.id,
      name: user.full_name,
      role: memberData.role,
      schoolId: memberData.school_id,
      user: {
        id: user.id,
        fullName: user.full_name,
        email: user.email,
        role: memberData.role,
        permissions: memberData.permissions ? JSON.parse(memberData.permissions) : {},
        school: { 
          id: memberData.school_id, 
          name: memberData.school_name, 
          code: memberData.school_code 
        },
      },
    });
  } catch (err) { next(err); }
};

// ── GET /api/auth/me ───────────────────────────────────────────────────────
exports.me = async (req, res, next) => {
  try {
    // JWT Token ke payload se req.user mein data aayega (Middleware se)
    const user = await queryOne(`
      SELECT u.id, u.full_name, u.display_name, u.email, u.phone, u.avatar_url,
             u.date_of_birth, u.gender, u.last_login_at,
             sm.role, sm.permissions, sm.employee_code,
             s.id AS school_id, s.name AS school_name, s.slug AS school_code, s.logo_url
      FROM users u
      JOIN school_members sm ON sm.user_id = u.id AND sm.school_id = @schoolId
      JOIN schools s ON s.id = sm.school_id
      WHERE u.id = @userId AND u.deleted_at IS NULL
    `, {
      userId: { type: sql.UniqueIdentifier, value: req.user.userId },
      schoolId: { type: sql.UniqueIdentifier, value: req.user.schoolId }
    });
    
    if (!user) return unauthorized(res, 'User session invalid or expired');

    // Parse JSON permissions if they exist
    if (user.permissions) user.permissions = JSON.parse(user.permissions);

    return success(res, user);
  } catch (err) { next(err); }
};

// ── POST /api/auth/change-password ────────────────────────────────────────
exports.changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return badRequest(res, 'Both current and new passwords are required');
    
    const user = await queryOne(`SELECT password FROM users WHERE id = @userId`, { 
      userId: { type: sql.UniqueIdentifier, value: req.user.userId } 
    });

    // Check old password
    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) return badRequest(res, 'Current password is incorrect');

    // Hash and update new password
    const newHash = await bcrypt.hash(newPassword, 12);
    await query(`UPDATE users SET password = @hash WHERE id = @userId`, { 
      hash: { type: sql.NVarChar(255), value: newHash }, 
      userId: { type: sql.UniqueIdentifier, value: req.user.userId } 
    });

    return success(res, null, 'Password updated successfully');
  } catch (err) { next(err); }
};

// ── POST /api/auth/refresh ─────────────────────────────────────────────────
exports.refresh = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return badRequest(res, 'Refresh token required');

    const decoded = jwt.verify(refreshToken, secret);
    const token = signToken({ userId: decoded.userId, schoolId: decoded.schoolId, role: decoded.role, fullName: decoded.fullName });
    
    return success(res, { token });
  } catch (err) {
    if (err.name === 'TokenExpiredError') return unauthorized(res, 'Refresh token expired. Please log in again.');
    next(err);
  }
};

exports.logout = async (req, res) => {
   await logAudit({
    schoolId: req.user?.schoolId,
    userId: req.user?.userId,
    userName: req.user?.fullName,
    userRole: req.user?.role,
    actionType: 'LOGOUT',
    ipAddress: req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress,
  });
  return success(res, null, 'Logged out');
};
