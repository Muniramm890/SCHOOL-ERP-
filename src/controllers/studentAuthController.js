//controllers/studentAuthController.js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query, queryOne, sql } = require('../config/db');
const { success, badRequest, unauthorized } = require('../utils/response');

const secret = 'my_super_secret_key_2026_xyz';
const signToken = (payload) => jwt.sign(payload, secret, { expiresIn: '24h' });

// ── POST /api/student/auth/login ──────────────────────────────────────────
exports.login = async (req, res, next) => {
  try {
    const { identifier, password } = req.body; // identifier = phone or email
    if (!identifier || !password) return badRequest(res, 'Identifier and password are required');

    const cred = await queryOne(
      `SELECT sc.id, sc.student_id, sc.school_id, sc.password_hash, sc.is_active,
              st.first_name, st.last_name
       FROM student_credentials sc
       JOIN students st ON st.id = sc.student_id AND st.deleted_at IS NULL
       WHERE (sc.login_phone = @idf OR sc.login_email = @idf) AND sc.deleted_at IS NULL`,
      { idf: { type: sql.NVarChar(255), value: identifier.trim() } }
    );

    

    if (!cred) return unauthorized(res, 'Invalid credentials');
    if (!cred.is_active) return unauthorized(res, 'Your account has been blocked. Contact school office.');

    const valid = await bcrypt.compare(password, cred.password_hash);
    if (!valid) return unauthorized(res, 'Invalid credentials');

    await query(`UPDATE student_credentials SET last_login_at=GETUTCDATE() WHERE id=@id`, {
      id: { type: sql.UniqueIdentifier, value: cred.id },
    });

    const token = signToken({ studentId: cred.student_id, schoolId: cred.school_id, type: 'student' });

    await query(
      `INSERT INTO audit_logs (id, school_id, student_id, actor_type, action_type, user_name, created_at)
       VALUES (NEWID(), @sid, @stid, 'student', 'LOGIN', @name, GETUTCDATE())`,
      {
        sid: { type: sql.UniqueIdentifier, value: cred.school_id },
        stid: { type: sql.UniqueIdentifier, value: cred.student_id },
        name: { type: sql.NVarChar(400), value: `${cred.first_name} ${cred.last_name || ''}`.trim() },
      }
    );

    return success(res, {
      token,
      studentId: cred.student_id,
      name: `${cred.first_name} ${cred.last_name || ''}`.trim(),
    });
  } catch (err) { next(err); }
};

// ── GET /api/student/auth/me ───────────────────────────────────────────────
exports.me = async (req, res, next) => {
  try {
    const { studentId, schoolId } = req.student;
    const student = await queryOne(
      `SELECT st.id, st.first_name, st.middle_name, st.last_name, st.photo_url, st.date_of_birth,
              st.gender, st.admission_no, g.name AS class_name, sec.name AS section_name, e.roll_no,
              sc.login_phone, sc.login_email, s.name AS school_name, s.logo_url
       FROM students st
       LEFT JOIN enrolments e ON e.student_id = st.id AND e.is_active=1 AND e.deleted_at IS NULL
       LEFT JOIN sections sec ON sec.id = e.section_id
       LEFT JOIN grades g ON g.id = sec.grade_id
       JOIN student_credentials sc ON sc.student_id = st.id
       JOIN schools s ON s.id = st.school_id
       WHERE st.id=@sid AND st.school_id=@schoolId AND st.deleted_at IS NULL`,
      { sid: { type: sql.UniqueIdentifier, value: studentId }, schoolId: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    return success(res, student);
  } catch (err) { next(err); }
};

// ── PUT /api/student/auth/me ────────────────────────────────────────────────
exports.updateProfile = async (req, res, next) => {
  try {
    const { studentId } = req.student;
    const { photo_url } = req.body; // student sirf apni photo change kar sakta hai
    await query(`UPDATE students SET photo_url = COALESCE(@photo, photo_url), updated_at=GETUTCDATE() WHERE id=@id`, {
      photo: { type: sql.NVarChar(sql.MAX), value: photo_url || null },
      id: { type: sql.UniqueIdentifier, value: studentId },
    });
    return success(res, null, 'Profile updated');
  } catch (err) { next(err); }
};

// ── POST /api/student/auth/change-password ─────────────────────────────────
exports.changePassword = async (req, res, next) => {
  try {
    const { studentId } = req.student;
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return badRequest(res, 'Both passwords are required');

    const cred = await queryOne(`SELECT id, password_hash FROM student_credentials WHERE student_id=@sid`, {
      sid: { type: sql.UniqueIdentifier, value: studentId },
    });
    const valid = await bcrypt.compare(currentPassword, cred.password_hash);
    if (!valid) return badRequest(res, 'Current password is incorrect');

    const newHash = await bcrypt.hash(newPassword, 12);
    await query(`UPDATE student_credentials SET password_hash=@hash, must_reset_password=0, updated_at=GETUTCDATE() WHERE id=@id`, {
      hash: { type: sql.NVarChar(255), value: newHash },
      id: { type: sql.UniqueIdentifier, value: cred.id },
    });
    return success(res, null, 'Password updated successfully');
  } catch (err) { next(err); }
};

// ── POST /api/student/auth/logout ───────────────────────────────────────────
exports.logout = async (req, res) => {
  await query(
    `INSERT INTO audit_logs (id, school_id, student_id, actor_type, action_type, created_at)
     VALUES (NEWID(), @sid, @stid, 'student', 'LOGOUT', GETUTCDATE())`,
    {
      sid: { type: sql.UniqueIdentifier, value: req.student.schoolId },
      stid: { type: sql.UniqueIdentifier, value: req.student.studentId },
    }
  );
  return success(res, null, 'Logged out');
};


// done 
