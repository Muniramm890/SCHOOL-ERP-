// src/controllers/signupController.js
const { query } = require('../config/db');
const sql = require('mssql');
const { sendWhatsAppOtp } = require('../utils/whatsapp');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Helper: Custom Unique School Code Generator (e.g., SUNRISE -> SUN-260603-458)
const generateSchoolCode = (schoolName) => {
  const initials = schoolName.replace(/[^a-zA-Z]/g, '').substring(0, 3).toUpperCase();
  const dateStr = new Date().toISOString().slice(2, 10).replace(/-/g, ''); // YYMMDD
  const randomNum = Math.floor(100 + Math.random() * 900); // 3 digit random
  return `${initials}-${dateStr}-${randomNum}`;
};

// 1. Send 6-Digit OTP
const sendOtp = async (req, res, next) => {
  const { phone } = req.body;
  if (!phone || phone.length < 10) return res.status(400).json({ success: false, message: 'Valid phone is required' });

  try {
    await query(`DELETE FROM OtpVerifications WHERE ExpiresAt < GETDATE()`);
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    await query(`
      INSERT INTO OtpVerifications (Phone, Otp, ExpiresAt)
      VALUES (@phone, @otp, DATEADD(minute, 10, GETDATE()))
    `, {
      phone: { type: sql.VarChar, value: phone },
      otp: { type: sql.VarChar, value: otp }
    });

    await sendWhatsAppOtp(phone, otp);
    res.json({ success: true, message: '6-digit verification code sent on WhatsApp' });
  } catch (error) { next(error); }
};

// 2. Verify OTP
const verifyOtp = async (req, res, next) => {
  const { phone, otp } = req.body;
  if (!phone || !otp) return res.status(400).json({ success: false, message: 'Phone and OTP are required' });

  try {
    const checkQuery = `
      SELECT TOP 1 * FROM OtpVerifications 
      WHERE Phone = @phone AND Otp = @otp AND ExpiresAt > GETDATE() ORDER BY CreatedAt DESC
    `;
    const result = await query(checkQuery, {
      phone: { type: sql.VarChar, value: phone },
      otp: { type: sql.VarChar, value: otp }
    });

    if (result.recordset.length === 0) return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });

    await query(`DELETE FROM OtpVerifications WHERE Phone = @phone`, { phone: { type: sql.VarChar, value: phone } });
    res.json({ success: true, message: 'OTP Verified successfully' });
  } catch (error) { next(error); }
};

// 3. Register School & Admin Account
const registerSchool = async (req, res, next) => {
  const { schoolName, affiliationNo, addressLine1, city, state, adminName, email, phone, password } = req.body;

  try {
    // 1. Check duplicate Email/Phone in users
    const checkUser = await query(`SELECT id FROM users WHERE email = @email OR phone = @phone`, {
      email: { type: sql.VarChar, value: email },
      phone: { type: sql.VarChar, value: phone }
    });
    if (checkUser.recordset.length > 0) return res.status(400).json({ success: false, message: 'Admin with this Email or Phone already exists' });

    // 2. Generate Hash & Custom School ID
    const salt = await bcrypt.genSalt(12);
    const hashedPassword = await bcrypt.hash(password, salt);
    const customSchoolCode = generateSchoolCode(schoolName); // 🔥 Custom Unique ID Generation

    // 3. Default Organisation
    let orgId;
    const checkOrg = await query(`SELECT id FROM organisations WHERE slug = 'school-office-default'`);
    if (checkOrg.recordset.length > 0) {
      orgId = checkOrg.recordset[0].id;
    } else {
      const orgRes = await query(`
        INSERT INTO organisations (name, slug, owner_email, plan_type) 
        OUTPUT INSERTED.id VALUES ('SCHOOL OFFICE', 'school-office-default', 'admin@schooloffice.tech', 'enterprise')
      `);
      orgId = orgRes.recordset[0].id;
    }

    // 4. Create School (Added Custom Code to slug and udise_code)
    const schoolRes = await query(`
      INSERT INTO schools (organisation_id, name, slug, email, phone, udise_code, affiliation_no, address_line1, city, state, country, is_active) 
      OUTPUT INSERTED.id 
      VALUES (@orgId, @name, @slug, @email, @phone, @udiseCode, @affiliationNo, @addressLine1, @city, @state, 'India', 1)
    `, {
      orgId: { type: sql.UniqueIdentifier, value: orgId },
      name: { type: sql.NVarChar, value: schoolName },
      slug: { type: sql.VarChar, value: customSchoolCode }, // 🔥 Saves SPS-260603-912
      email: { type: sql.VarChar, value: email },
      phone: { type: sql.VarChar, value: phone },
      udiseCode: { type: sql.VarChar, value: customSchoolCode }, // Custom code mapping
      affiliationNo: { type: sql.VarChar, value: affiliationNo },
      addressLine1: { type: sql.NVarChar, value: addressLine1 },
      city: { type: sql.NVarChar, value: city },
      state: { type: sql.NVarChar, value: state }
    });
    const schoolId = schoolRes.recordset[0].id;

    // 5. Auto-Create Current Academic Year
    const currentYear = new Date().getFullYear(); 
    await query(`
      INSERT INTO academic_years (school_id, name, start_date, end_date, is_current)
      VALUES (@schoolId, @name, @startDate, @endDate, 1)
    `, {
      schoolId: { type: sql.UniqueIdentifier, value: schoolId },
      name: { type: sql.VarChar, value: `${currentYear}-${currentYear + 1}` },
      startDate: { type: sql.Date, value: `${currentYear}-04-01` },
      endDate: { type: sql.Date, value: `${currentYear + 1}-03-31` }
    });

    // 6. Create User Admin (Password goes directly to users table)
    const userRes = await query(`
      INSERT INTO users (full_name, email, phone, password, is_active) 
      OUTPUT INSERTED.id 
      VALUES (@fullName, @email, @phone, @password, 1)
    `, {
      fullName: { type: sql.NVarChar, value: adminName }, 
      email: { type: sql.VarChar, value: email },
      phone: { type: sql.VarChar, value: phone },
      password: { type: sql.VarChar, value: hashedPassword } // 🔥 Bulletproof Hashing
    });
    const userId = userRes.recordset[0].id;

    // 7. Link User to School
    await query(`
      INSERT INTO school_members (school_id, user_id, role, is_active) 
      VALUES (@schoolId, @userId, 'school_admin', 1)
    `, {
      schoolId: { type: sql.UniqueIdentifier, value: schoolId },
      userId: { type: sql.UniqueIdentifier, value: userId }
    });

    // 8. Generate JWT
    const token = jwt.sign({ schoolId, userId, role: 'school_admin' }, process.env.JWT_SECRET, { expiresIn: '24h' });

    res.status(201).json({ success: true, message: 'School registered successfully', token, schoolCode: customSchoolCode });
  } catch (error) { next(error); }
};

module.exports = { sendOtp, verifyOtp, registerSchool };
