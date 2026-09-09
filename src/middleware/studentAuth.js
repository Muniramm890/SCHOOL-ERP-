// src/middleware/studentAuth.js
const jwt = require('jsonwebtoken');
const { unauthorized } = require('../utils/response');
const { queryOne, sql } = require('../config/db');

const secretKey = 'my_super_secret_key_2026_xyz'; // Dono me same secret

const authenticateStudent = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return unauthorized(res, 'No token provided');
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, secretKey);
    
    if (decoded.type !== 'student') {
        return unauthorized(res, 'Invalid token type');
    }

    const row = await queryOne(
      `SELECT sc.student_id, sc.school_id, sc.is_active,
              st.first_name, st.last_name, st.photo_url,
              e.section_id, sec.grade_id
       FROM student_credentials sc
       JOIN students st ON st.id = sc.student_id AND st.deleted_at IS NULL
       LEFT JOIN enrolments e ON e.student_id = sc.student_id AND e.is_active = 1 AND e.deleted_at IS NULL
       LEFT JOIN sections sec ON sec.id = e.section_id
       WHERE sc.student_id = @sid AND sc.deleted_at IS NULL`,
      { sid: { type: sql.UniqueIdentifier, value: decoded.studentId } }
    );

    if (!row || !row.is_active) {
        return unauthorized(res, 'Account inactive or not found');
    }

    const fullName = `${row.first_name} ${row.last_name || ''}`.trim();

    // 1. Student specific routes ke liye
    req.student = {
      studentId: row.student_id,
      schoolId: row.school_id,
      sectionId: row.section_id,
      gradeId: row.grade_id,
      fullName: fullName,
      photoUrl: row.photo_url,
    };

    // 2. 🔥 THE FIX: Shared/Old controllers ke liye `req.user` inject kar diya
    req.user = {
      userId: row.student_id, // student_id ko userId map kar diya 
      schoolId: row.school_id,
      role: 'student',        // Role specify kar diya safety ke liye
      fullName: fullName
    };

    next();
  } catch (err) {
    console.error('StudentAuth Error:', err.message);
    if (err.name === 'TokenExpiredError') return unauthorized(res, 'Token expired');
    if (err.name === 'JsonWebTokenError') return unauthorized(res, 'Invalid token');
    next(err);
  }
};

module.exports = { authenticateStudent };
