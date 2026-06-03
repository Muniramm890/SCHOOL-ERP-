// src/controllers/authController.js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, sql } = require('../config/db');
const { success, created, badRequest, unauthorized } = require('../utils/response');
const { audit } = require('../utils/audit');

// ── Helpers ────────────────────────────────────────────────────────────────
const signToken = (payload) =>
  jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });

const signRefresh = (payload) =>
  jwt.sign(payload, process.env.JWT_REFRESH_SECRET, { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d' });

// ── POST /api/auth/login ───────────────────────────────────────────────────
exports.login = async (req, res, next) => {
  try {
    const { email, password, school_slug } = req.body;

    // Find school by slug
    const school = await queryOne(
      `SELECT id, name, is_active FROM schools WHERE slug = @slug AND deleted_at IS NULL`,
      { slug: { type: sql.NVarChar(255), value: school_slug } }
    );
    if (!school || !school.is_active) return badRequest(res, 'School not found or inactive');

    // Find user + auth record
    const userAuth = await queryOne(
      `SELECT u.id AS user_id, u.full_name, u.email, u.is_active,
              ua.password_hash, ua.failed_attempts, ua.locked_until,
              sm.id AS member_id, sm.role, sm.permissions, sm.is_active AS member_active
       FROM   users u
       JOIN   user_auth ua ON ua.user_id = u.id
       JOIN   school_members sm ON sm.user_id = u.id AND sm.school_id = @schoolId
       WHERE  u.email = @email AND u.deleted_at IS NULL AND sm.deleted_at IS NULL`,
      {
        email:    { type: sql.NVarChar(255),     value: email },
        schoolId: { type: sql.UniqueIdentifier, value: school.id },
      }
    );

    if (!userAuth) return unauthorized(res, 'Invalid credentials');
    if (!userAuth.is_active || !userAuth.member_active) return unauthorized(res, 'Account is inactive');

    // Lockout check
    if (userAuth.locked_until && new Date(userAuth.locked_until) > new Date()) {
      return unauthorized(res, 'Account locked. Try again later.');
    }

    const valid = await bcrypt.compare(password, userAuth.password_hash);
    if (!valid) {
      await query(
        `UPDATE user_auth SET failed_attempts = failed_attempts + 1,
          locked_until = CASE WHEN failed_attempts + 1 >= 5 THEN DATEADD(MINUTE,30,GETUTCDATE()) ELSE NULL END
         WHERE user_id = @uid`,
        { uid: { type: sql.UniqueIdentifier, value: userAuth.user_id } }
      );
      return unauthorized(res, 'Invalid credentials');
    }

    // Reset failed attempts + update last_login
    await query(
      `UPDATE user_auth SET failed_attempts = 0, locked_until = NULL WHERE user_id = @uid;
       UPDATE users SET last_login_at = GETUTCDATE() WHERE id = @uid`,
      { uid: { type: sql.UniqueIdentifier, value: userAuth.user_id } }
    );

    const payload = { userId: userAuth.user_id, schoolId: school.id, role: userAuth.role };
    const token = signToken(payload);
    const refreshToken = signRefresh(payload);

    await audit({ req, action: 'LOGIN', tableName: 'users', recordId: userAuth.user_id });

    return success(res, {
      token,
      refreshToken,
      user: {
        id:          userAuth.user_id,
        fullName:    userAuth.full_name,
        email:       userAuth.email,
        role:        userAuth.role,
        permissions: JSON.parse(userAuth.permissions || '{}'),
        school: { id: school.id, name: school.name, slug: school_slug },
      },
    });
  } catch (err) { next(err); }
};

// ── POST /api/auth/refresh ─────────────────────────────────────────────────
exports.refresh = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return badRequest(res, 'Refresh token required');

    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const token = signToken({ userId: decoded.userId, schoolId: decoded.schoolId, role: decoded.role });
    return success(res, { token });
  } catch (err) {
    if (err.name === 'TokenExpiredError') return unauthorized(res, 'Refresh token expired. Please log in again.');
    next(err);
  }
};

// ── GET /api/auth/me ───────────────────────────────────────────────────────
exports.me = async (req, res, next) => {
  try {
    const user = await queryOne(
      `SELECT u.id, u.full_name, u.display_name, u.email, u.phone, u.avatar_url,
              u.date_of_birth, u.gender, u.last_login_at,
              sm.role, sm.permissions, sm.employee_code,
              s.id AS school_id, s.name AS school_name, s.slug AS school_slug,
              s.logo_url, s.brand_color
       FROM   users u
       JOIN   school_members sm ON sm.user_id = u.id AND sm.school_id = @schoolId
       JOIN   schools s ON s.id = sm.school_id
       WHERE  u.id = @userId AND u.deleted_at IS NULL`,
      {
        userId:   { type: sql.UniqueIdentifier, value: req.user.userId },
        schoolId: { type: sql.UniqueIdentifier, value: req.user.schoolId },
      }
    );
    return success(res, user);
  } catch (err) { next(err); }
};

// ── POST /api/auth/change-password ────────────────────────────────────────
exports.changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userAuth = await queryOne(
      `SELECT password_hash FROM user_auth WHERE user_id = @uid`,
      { uid: { type: sql.UniqueIdentifier, value: req.user.userId } }
    );
    const valid = await bcrypt.compare(currentPassword, userAuth.password_hash);
    if (!valid) return badRequest(res, 'Current password incorrect');

    const hash = await bcrypt.hash(newPassword, 12);
    await query(
      `UPDATE user_auth SET password_hash = @hash WHERE user_id = @uid`,
      { hash: { type: sql.NVarChar(255), value: hash }, uid: { type: sql.UniqueIdentifier, value: req.user.userId } }
    );
    return success(res, null, 'Password updated');
  } catch (err) { next(err); }
};
