// src/controllers/authController.js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query, queryOne, sql } = require('../config/db');
const { success, badRequest, unauthorized } = require('../utils/response');

// ── Helpers ────────────────────────────────────────────────────────────────
const signToken = (payload) => jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
const signRefresh = (payload) => jwt.sign(payload, process.env.JWT_REFRESH_SECRET, { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d' });

// ── POST /api/auth/login ───────────────────────────────────────────────────
exports.login = async (req, res, next) => {
  try {
    // 🔥 Smart Login: Sirf email aur password chahiye (school_slug hataya)
    const { email, password } = req.body;
    if (!email || !password) return badRequest(res, 'Email and password are required');

    // 1. Find User by Email (Direct from users table)
    const user = await queryOne(`SELECT id, full_name, email, password, is_active FROM users WHERE email = @email AND deleted_at IS NULL`, {
      email: { type: sql.NVarChar(255), value: email }
    });
    
    if (!user) return unauthorized(res, 'Invalid credentials');
    if (!user.is_active) return unauthorized(res, 'Account is inactive');

    // 2. Verify Password using Bcrypt
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return unauthorized(res, 'Invalid credentials');

    // 3. Find which School this User belongs to via school_members
    const memberData = await queryOne(`
      SELECT sm.school_id, sm.role, sm.permissions, sm.is_active AS member_active, 
             s.name AS school_name, s.slug AS school_code
      FROM school_members sm
      JOIN schools s ON sm.school_id = s.id
      WHERE sm.user_id = @userId AND sm.deleted_at IS NULL AND s.deleted_at IS NULL AND s.is_active = 1
    `, { userId: { type: sql.UniqueIdentifier, value: user.id } });

    if (!memberData) return unauthorized(res, 'User is not linked to any active school');
    if (!memberData.member_active) return unauthorized(res, 'Your school access is currently suspended');

    // 4. Update Last Login Time
    await query(`UPDATE users SET last_login_at = GETUTCDATE() WHERE id = @userId`, { 
      userId: { type: sql.UniqueIdentifier, value: user.id } 
    });

    // 5. Generate Secure JWT Token (Contains DB school_id)
    const payload = { userId: user.id, schoolId: memberData.school_id, role: memberData.role };
    const token = signToken(payload);
    const refreshToken = signRefresh(payload);

    return success(res, {
      token,
      refreshToken,
      user: {
        id: user.id,
        fullName: user.full_name,
        email: user.email,
        role: memberData.role,
        permissions: JSON.parse(memberData.permissions || '{}'),
        school: { 
          id: memberData.school_id, // Frontend requires this ID for context, but backend relies on Token's ID
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
    
    if (!user) return unauthorized(res, 'User session invalid');
    return success(res, user);
  } catch (err) { next(err); }
};

// ── POST /api/auth/change-password ────────────────────────────────────────
exports.changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    
    const user = await queryOne(`SELECT password FROM users WHERE id = @userId`, { 
      userId: { type: sql.UniqueIdentifier, value: req.user.userId } 
    });

    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) return badRequest(res, 'Current password incorrect');

    const newHash = await bcrypt.hash(newPassword, 12);
    await query(`UPDATE users SET password = @hash WHERE id = @userId`, { 
      hash: { type: sql.NVarChar(255), value: newHash }, 
      userId: { type: sql.UniqueIdentifier, value: req.user.userId } 
    });

    return success(res, null, 'Password updated successfully');
  } catch (err) { next(err); }
};

