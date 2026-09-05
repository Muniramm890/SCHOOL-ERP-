// src/middleware/auth.js
const jwt = require('jsonwebtoken');
const { unauthorized, forbidden } = require('../utils/response');
const { queryOne, sql } = require('../config/db');

// Verify JWT and attach user context
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return unauthorized(res, 'No token provided');
    }

    const token = authHeader.split(' ')[1];
    
    // 🔥 THE FIX: Yahan same fallback secret use karna zaroori hai!
    // Verification mein bhi wahi string use karein
const secretKey = 'my_super_secret_key_2026_xyz'; 
const decoded = jwt.verify(token, secretKey);
    // Fetch live user + school member record
    const member = await queryOne(
      `SELECT sm.id AS member_id, sm.school_id, sm.user_id, sm.role, sm.permissions, sm.is_active,
              u.full_name, u.email, u.phone
       FROM   school_members sm
       JOIN   users u ON u.id = sm.user_id
       WHERE  sm.user_id  = @userId
         AND  sm.school_id = @schoolId
         AND  sm.deleted_at IS NULL`,
      {
        userId:   { type: sql.UniqueIdentifier, value: decoded.userId },
        schoolId: { type: sql.UniqueIdentifier, value: decoded.schoolId },
      }
    );

    if (!member || !member.is_active) {
      return unauthorized(res, 'Account inactive or not found');
    }

    req.user = {
      userId:    member.user_id,
      memberId:  member.member_id,
      schoolId:  member.school_id,
      role:      member.role,
      fullName:  member.full_name,
      email:     member.email,
      permissions: JSON.parse(member.permissions || '{}'),
    };

    next();
  } catch (err) {
    // Console log add kiya taaki exact error server logs mein dikhe
    console.error("Auth Middleware Error:", err.message);
    
    if (err.name === 'TokenExpiredError') return unauthorized(res, 'Token expired');
    if (err.name === 'JsonWebTokenError') return unauthorized(res, 'Invalid token');
    next(err);
  }
};


const authorize = (...allowedRoles) => (req, res, next) => {
  // Agar user ka role 'school_admin' hai, toh usey har jagah access do
  if (req.user.role === 'school_admin') return next();
  
  // Agar specific roles check karne hain
  if (allowedRoles.includes(req.user.role)) return next();
  
  return forbidden(res, 'Access denied. You do not have the required permissions.');
};

// School ID consistency check — frontend must send X-School-Id header or route param
const requireSchool = (req, res, next) => {
  const headerSchool = req.headers['x-school-id'];
  if (headerSchool && headerSchool !== req.user.schoolId) {
    return forbidden(res, 'School mismatch');
  }
  next();
};

// Future use: per-module permission gate (not wired into any routes yet).
// school_admin (top authority) always passes; everyone else needs the
// moduleKey inside their school_members.permissions.modules array.
const authorizeModule = (moduleKey) => (req, res, next) => {
  if (req.user.role === 'school_admin') return next();
  const allowed = Array.isArray(req.user.permissions?.modules) ? req.user.permissions.modules : [];
  if (allowed.includes(moduleKey)) return next();
  return forbidden(res, `Access denied. You do not have access to the '${moduleKey}' module.`);
};

module.exports = { authenticate, authorize, requireSchool, authorizeModule };
