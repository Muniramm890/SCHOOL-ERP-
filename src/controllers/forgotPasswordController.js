// src/controllers/forgotPasswordController.js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sql = require('mssql');
const { query, queryOne } = require('../config/db');
const { sendWhatsAppOtp } = require('../utils/whatsapp');
const { sendHtmlEmail } = require('../services/emailService');
const { logAudit } = require('../utils/auditLogger');

const secret = 'my_super_secret_key_2026_xyz'; // Same secret as authController for now

// ── 1. Send OTP (WhatsApp or Email) ────────────────────────────────────────
// body: { identifier: "phone or email", method: "whatsapp" | "email" }
exports.sendResetOtp = async (req, res, next) => {
  try {
    const { identifier, method } = req.body;

    if (!identifier || !method || !['whatsapp', 'email'].includes(method)) {
      return res.status(400).json({ success: false, message: 'Identifier and a valid method (whatsapp/email) are required' });
    }

    // Confirm this identifier actually belongs to a real, active user
    const columnToCheck = method === 'email' ? 'email' : 'phone';
    const user = await queryOne(`
      SELECT id, full_name, email, phone, is_active
      FROM users
      WHERE ${columnToCheck} = @identifier AND deleted_at IS NULL
    `, {
      identifier: { type: sql.NVarChar(255), value: identifier }
    });

    if (!user) {
      return res.status(404).json({ success: false, message: `No account found with this ${method === 'email' ? 'email' : 'phone number'}` });
    }
    if (!user.is_active) {
      return res.status(403).json({ success: false, message: 'This account is inactive. Please contact your school admin.' });
    }

    // Clean up expired + any existing OTP for this identifier
    await query(`DELETE FROM OtpVerifications WHERE ExpiresAt < GETUTCDATE()`);
    await query(`DELETE FROM OtpVerifications WHERE Phone = @identifier`, {
      identifier: { type: sql.VarChar, value: identifier }
    });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    await query(`
      INSERT INTO OtpVerifications (Phone, Otp, ExpiresAt, CreatedAt)
      VALUES (@identifier, @otp, DATEADD(minute, 10, GETUTCDATE()), GETUTCDATE())
    `, {
      identifier: { type: sql.VarChar, value: identifier },
      otp: { type: sql.VarChar, value: otp }
    });

    // Deliver via chosen channel
    try {
      if (method === 'whatsapp') {
        await sendWhatsAppOtp(user.phone, otp);
      } else {
        await sendHtmlEmail({
          to: user.email,
          from: process.env.SG_FROM_EMAIL || 'noreply@schooloffice.app',
          fromName: 'School Office',
          subject: 'Your Password Reset Code',
          html: `
            <div style="font-family:sans-serif;max-width:480px;margin:auto;">
              <h2>Password Reset Request</h2>
              <p>Hi ${user.full_name},</p>
              <p>Use the code below to reset your password. This code expires in 10 minutes.</p>
              <div style="font-size:28px;font-weight:800;letter-spacing:6px;background:#f1f5f9;padding:16px 24px;border-radius:10px;text-align:center;margin:20px 0;">${otp}</div>
              <p style="color:#64748b;font-size:12px;">If you didn't request this, you can safely ignore this email.</p>
            </div>
          `,
        });
      }
    } catch (deliveryErr) {
      console.error('OTP delivery failed:', deliveryErr);
      return res.status(500).json({ success: false, message: `Failed to send code via ${method}. Please try again.` });
    }

    return res.json({ success: true, message: `Verification code sent via ${method === 'whatsapp' ? 'WhatsApp' : 'email'}` });
  } catch (err) { next(err); }
};

// ── 2. Verify OTP → issue short-lived reset token ──────────────────────────
exports.verifyResetOtp = async (req, res, next) => {
  try {
    const { identifier, otp } = req.body;
    if (!identifier || !otp) {
      return res.status(400).json({ success: false, message: 'Identifier and OTP are required' });
    }

    const record = await queryOne(`
      SELECT TOP 1 * FROM OtpVerifications
      WHERE Phone = @identifier AND Otp = @otp AND ExpiresAt > GETUTCDATE()
      ORDER BY CreatedAt DESC
    `, {
      identifier: { type: sql.VarChar, value: identifier },
      otp: { type: sql.VarChar, value: otp }
    });

    if (!record) {
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
    }

    // Burn OTP immediately so it can't be reused
    await query(`DELETE FROM OtpVerifications WHERE Phone = @identifier`, {
      identifier: { type: sql.VarChar, value: identifier }
    });

    // Find the user this identifier belongs to (email or phone)
    const user = await queryOne(`
      SELECT id, full_name FROM users
      WHERE (email = @identifier OR phone = @identifier) AND deleted_at IS NULL
    `, {
      identifier: { type: sql.NVarChar(255), value: identifier }
    });

    if (!user) {
      return res.status(404).json({ success: false, message: 'Account not found' });
    }

    // Short-lived reset token (10 min) — only usable for password reset
    const resetToken = jwt.sign(
      { userId: user.id, purpose: 'password_reset' },
      secret,
      { expiresIn: '10m' }
    );

    return res.json({ success: true, message: 'OTP verified', resetToken });
  } catch (err) { next(err); }
};

// ── 3. Reset password using the verified token ─────────────────────────────
exports.resetPassword = async (req, res, next) => {
  try {
    const { resetToken, newPassword } = req.body;
    if (!resetToken || !newPassword) {
      return res.status(400).json({ success: false, message: 'Reset token and new password are required' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }

    let decoded;
    try {
      decoded = jwt.verify(resetToken, secret);
    } catch (e) {
      return res.status(401).json({ success: false, message: 'Reset link expired or invalid. Please request a new code.' });
    }

    if (decoded.purpose !== 'password_reset') {
      return res.status(401).json({ success: false, message: 'Invalid reset token' });
    }

    const newHash = await bcrypt.hash(newPassword, 12);
    await query(`UPDATE users SET password = @hash WHERE id = @userId`, {
      hash: { type: sql.NVarChar(255), value: newHash },
      userId: { type: sql.UniqueIdentifier, value: decoded.userId }
    });

    await logAudit({
      userId: decoded.userId,
      actionType: 'PASSWORD_RESET_VIA_OTP',
    });

    return res.json({ success: true, message: 'Password reset successfully. Please log in with your new password.' });
  } catch (err) { next(err); }
};
