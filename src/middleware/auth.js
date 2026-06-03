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
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

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
    if (err.name === 'TokenExpiredError') return unauthorized(res, 'Token expired');
    if (err.name === 'JsonWebTokenError') return unauthorized(res, 'Invalid token');
    next(err);
  }
};

// Role-based authorization
const authorize = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return forbidden(res, `Access denied. Required: ${roles.join(' or ')}`);
  }
  next();
};

// School ID consistency check — frontend must send X-School-Id header or route param
const requireSchool = (req, res, next) => {
  const headerSchool = req.headers['x-school-id'];
  if (headerSchool && headerSchool !== req.user.schoolId) {
    return forbidden(res, 'School mismatch');
  }
  next();
};

module.exports = { authenticate, authorize, requireSchool };
