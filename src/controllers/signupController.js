// src/controllers/signupController.js
const { query } = require('../config/db');
const sql = require('mssql');
const { sendWhatsAppOtp } = require('../utils/whatsapp');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// ── Helper: Custom Unique School Code Generator ───────────────────────────
const generateSchoolCode = (schoolName) => {
  const initials = schoolName.replace(/[^a-zA-Z]/g, '').substring(0, 3).toUpperCase();
  const dateStr = new Date().toISOString().slice(2, 10).replace(/-/g, ''); // Format: YYMMDD
  const randomNum = Math.floor(100 + Math.random() * 900); // 3-digit random
  return `${initials}-${dateStr}-${randomNum}`; // Example: SUN-260603-458
};

// ── 1. Send 6-Digit OTP ───────────────────────────────────────────────────
const sendOtp = async (req, res, next) => {
  const { phone } = req.body;
  
  // Basic phone validation
  if (!phone || phone.length < 10) {
    return res.status(400).json({ success: false, message: 'Valid 10-digit phone number is required' });
  }

  try {
    // 🟢 LAZY DELETE: Remove globally expired OTPs
    await query(`DELETE FROM OtpVerifications WHERE ExpiresAt < GETUTCDATE()`);

    // 🟢 SMART CLEANUP: Delete any existing OTP for THIS specific user so they don't stack up
    await query(`DELETE FROM OtpVerifications WHERE Phone = @phone`, {
      phone: { type: sql.VarChar, value: phone }
    });

    // 🔴 Generate 6-Digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // 🔴 Insert OTP (Using GETUTCDATE() for Azure Timezone safety)
    const insertQuery = `
      INSERT INTO OtpVerifications (Phone, Otp, ExpiresAt, CreatedAt)
      VALUES (@phone, @otp, DATEADD(minute, 10, GETUTCDATE()), GETUTCDATE())
    `;
    
    await query(insertQuery, {
      phone: { type: sql.VarChar, value: phone },
      otp: { type: sql.VarChar, value: otp }
    });

    // 🔴 WhatsApp API Call with Error Shield
    try {
      await sendWhatsAppOtp(phone, otp);
    } catch (waError) {
      console.error("WhatsApp API Error:", waError);
      return res.status(500).json({ success: false, message: 'Failed to send WhatsApp message. Check API configuration.' });
    }

    return res.json({ success: true, message: '6-digit verification code sent successfully' });
  } catch (error) {
    console.error("Send OTP DB Error:", error);
    next(error);
  }
};

// ── 2. Verify OTP ─────────────────────────────────────────────────────────
const verifyOtp = async (req, res, next) => {
  const { phone, otp } = req.body;
  
  if (!phone || !otp) {
    return res.status(400).json({ success: false, message: 'Phone and OTP are required' });
  }

  try {
    // Timezone safe checking
    const checkQuery = `
      SELECT TOP 1 * FROM OtpVerifications 
      WHERE Phone = @phone AND Otp = @otp AND ExpiresAt > GETUTCDATE() 
      ORDER BY CreatedAt DESC
    `;

    const result = await query(checkQuery, {
      phone: { type: sql.VarChar, value: phone },
      otp: { type: sql.VarChar, value: otp }
    });

    if (result.recordset.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
    }

    // OTP Successful -> Instantly burn it so it can't be reused
    await query(`DELETE FROM OtpVerifications WHERE Phone = @phone`, {
      phone: { type: sql.VarChar, value: phone }
    });

    return res.json({ success: true, message: 'OTP Verified successfully' });
  } catch (error) {
    next(error);
  }
};

// ── 3. Register School & Admin Account ────────────────────────────────────
const registerSchool = async (req, res, next) => {
  const { schoolName, affiliationNo, addressLine1, city, state, adminName, email, phone, password } = req.body;

  try {
    // 1. Initial DB check for duplicate Email/Phone
    const checkUser = await query(`SELECT id FROM users WHERE email = @email OR phone = @phone`, {
      email: { type: sql.VarChar, value: email },
      phone: { type: sql.VarChar, value: phone }
    });
    
    if (checkUser.recordset.length > 0) {
      return res.status(400).json({ success: false, message: 'Admin with this Email or Phone already exists' });
    }

    // 2. Hash Password & Generate School Code
    const salt = await bcrypt.genSalt(12);
    const hashedPassword = await bcrypt.hash(password, salt);
    const customSchoolCode = generateSchoolCode(schoolName); 

    // 3. Auto-Setup Organisation
    let orgId;
    const checkOrg = await query(`SELECT id FROM organisations WHERE slug = 'school-office-default'`);
    if (checkOrg.recordset.length > 0) {
      orgId = checkOrg.recordset[0].id;
    } else {
      const orgRes = await query(`
        INSERT INTO organisations (name, slug, owner_email, plan_type) 
        OUTPUT INSERTED.id 
        VALUES ('SCHOOL OFFICE', 'school-office-default', 'admin@schooloffice.tech', 'enterprise')
      `);
      orgId = orgRes.recordset[0].id;
    }

    // 4. Create School 
    const schoolRes = await query(`
      INSERT INTO schools (organisation_id, name, slug, email, phone, udise_code, affiliation_no, address_line1, city, state, country, is_active) 
      OUTPUT INSERTED.id 
      VALUES (@orgId, @name, @slug, @email, @phone, @udiseCode, @affiliationNo, @addressLine1, @city, @state, 'India', 1)
    `, {
      orgId: { type: sql.UniqueIdentifier, value: orgId },
      name: { type: sql.NVarChar, value: schoolName },
      slug: { type: sql.VarChar, value: customSchoolCode }, 
      email: { type: sql.VarChar, value: email },
      phone: { type: sql.VarChar, value: phone },
      udiseCode: { type: sql.VarChar, value: customSchoolCode }, 
      affiliationNo: { type: sql.VarChar, value: affiliationNo },
      addressLine1: { type: sql.NVarChar, value: addressLine1 },
      city: { type: sql.NVarChar, value: city },
      state: { type: sql.NVarChar, value: state }
    });
    const schoolId = schoolRes.recordset[0].id;

    // 5. Create Academic Year
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

    // 6. Create Admin User 
    const userRes = await query(`
      INSERT INTO users (full_name, email, phone, password, is_active) 
      OUTPUT INSERTED.id 
      VALUES (@fullName, @email, @phone, @password, 1)
    `, {
      fullName: { type: sql.NVarChar, value: adminName }, 
      email: { type: sql.VarChar, value: email },
      phone: { type: sql.VarChar, value: phone },
      password: { type: sql.VarChar, value: hashedPassword } 
    });
    const userId = userRes.recordset[0].id;

    // 7. Map User to School
    await query(`
      INSERT INTO school_members (school_id, user_id, role, is_active) 
      VALUES (@schoolId, @userId, 'school_admin', 1)
    `, {
      schoolId: { type: sql.UniqueIdentifier, value: schoolId },
      userId: { type: sql.UniqueIdentifier, value: userId }
    });

    // 8. Generate Auto-Login JWT
    const token = jwt.sign({ schoolId, userId, role: 'school_admin' }, process.env.JWT_SECRET, { expiresIn: '24h' });

    return res.status(201).json({ 
      success: true, 
      message: 'School registered successfully', 
      token, 
      schoolCode: customSchoolCode 
    });

  } catch (error) { 
    // 🔥 CATCH BLOCK FOR DATABASE CONSTRAINTS (Unique Keys)
    if (error.number === 2627 || error.number === 2601) {
      const isEmail = error.message.includes('email') || error.message.includes('UQ_users_email');
      const field = isEmail ? 'Email' : 'Phone number';
      
      return res.status(400).json({ 
        success: false, 
        message: `Admin account with this ${field} already exists. Please log in or use different details.` 
      });
    }
    
    console.error("Registration Error:", error);
    next(error); 
  }
};

module.exports = { sendOtp, verifyOtp, registerSchool };
