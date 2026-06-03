// src/controllers/signupController.js
const { query } = require('../config/db');
const sql = require('mssql');
const { sendWhatsAppOtp } = require('../utils/whatsapp');
const logger = require('../utils/logger');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// 1. Send OTP (With Lazy Delete Storage Cleanup)
const sendOtp = async (req, res, next) => {
  const { phone } = req.body;
  if (!phone || phone.length < 10) {
    return res.status(400).json({ success: false, message: 'Valid phone number is required' });
  }

  try {
    // 🟢 LAZY DELETE: Naya OTP insert karne se pehle puraani expired entries saaf karein
    await query(`DELETE FROM OtpVerifications WHERE ExpiresAt < GETDATE()`);

    // Generate 4 digit random OTP
    const otp = Math.floor(1000 + Math.random() * 9000).toString();

    // Insert new OTP with 10 minutes expiry
    const insertQuery = `
      INSERT INTO OtpVerifications (Phone, Otp, ExpiresAt)
      VALUES (@phone, @otp, DATEADD(minute, 10, GETDATE()))
    `;
    
    await query(insertQuery, {
      phone: { type: sql.VarChar, value: phone },
      otp: { type: sql.VarChar, value: otp }
    });

    // Send WhatsApp Message
    await sendWhatsAppOtp(phone, otp);

    res.json({ success: true, message: 'Verification code sent on WhatsApp' });
  } catch (error) {
    next(error);
  }
};

// 2. Verify OTP
const verifyOtp = async (req, res, next) => {
  const { phone, otp } = req.body;
  if (!phone || !otp) {
    return res.status(400).json({ success: false, message: 'Phone and OTP are required' });
  }

  try {
    const checkQuery = `
      SELECT TOP 1 * FROM OtpVerifications 
      WHERE Phone = @phone AND Otp = @otp AND ExpiresAt > GETDATE()
      ORDER BY CreatedAt DESC
    `;

    const result = await query(checkQuery, {
      phone: { type: sql.VarChar, value: phone },
      otp: { type: sql.VarChar, value: otp }
    });

    if (result.recordset.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
    }

    // OTP Valid hai! Use delete kar dein taaki reuse na ho sake
    await query(`DELETE FROM OtpVerifications WHERE Phone = @phone`, {
      phone: { type: sql.VarChar, value: phone }
    });

    res.json({ success: true, message: 'OTP Verified successfully' });
  } catch (error) {
    next(error);
  }
};

// 3. Register School & Admin Account (Final Step)
const registerSchool = async (req, res, next) => {
  const { schoolName, city, adminName, email, phone, password } = req.body;

  try {
    // Check if user already exists
    const checkUser = await query(`SELECT id FROM Users WHERE email = @email OR phone = @phone`, {
      email: { type: sql.VarChar, value: email },
      phone: { type: sql.VarChar, value: phone }
    });

    if (checkUser.recordset.length > 0) {
      return res.status(400).json({ success: false, message: 'Admin with this Email or Phone already exists' });
    }

    // Hash Password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Note: Isko Transaction wrapper me daalna sahi rahega taaki agar ek fail ho toh dusra roll back ho jaye
    // Lekin basic logic ke liye direct insertion:
    
    // Insert School
    const schoolRes = await query(`
      INSERT INTO Schools (name, address, city, is_active) 
      OUTPUT INSERTED.id
      VALUES (@name, @address, @city, 1)
    `, {
      name: { type: sql.VarChar, value: schoolName },
      address: { type: sql.VarChar, value: city }, // Default city as address components
      city: { type: sql.VarChar, value: city }
    });

    const schoolId = schoolRes.recordset[0].id;

    // Insert User Admin Account
    await query(`
      INSERT INTO Users (school_id, role, name, email, phone, password, is_active)
      VALUES (@schoolId, 'school_admin', @name, @email, @phone, @password, 1)
    `, {
      schoolId: { type: sql.Int, value: schoolId },
      name: { type: sql.VarChar, value: adminName },
      email: { type: sql.VarChar, value: email },
      phone: { type: sql.VarChar, value: phone },
      password: { type: sql.VarChar, value: hashedPassword }
    });

    // Generate JWT Token for instant login after signup
    const token = jwt.sign(
      { schoolId, role: 'school_admin', name: adminName },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.status(211).json({
      success: true,
      message: 'School onboarded successfully',
      token
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { sendOtp, verifyOtp, registerSchool };
