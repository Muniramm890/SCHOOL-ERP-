// src/controllers/signupController.js
const { query } = require('../config/db');
const sql = require('mssql');
const { sendWhatsAppOtp } = require('../utils/whatsapp');
const logger = require('../utils/logger');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// 1. Send 6-Digit OTP (With Lazy Delete Storage Cleanup)
const sendOtp = async (req, res, next) => {
  const { phone } = req.body;
  if (!phone || phone.length < 10) {
    return res.status(400).json({ success: false, message: 'Valid phone number is required' });
  }

  try {
    // 🟢 LAZY DELETE: Storage cleanup before inserting new one
    await query(`DELETE FROM OtpVerifications WHERE ExpiresAt < GETDATE()`);

    // 🔴 6-Digit OTP Generation Logic
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

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

    res.json({ success: true, message: '6-digit verification code sent on WhatsApp' });
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

    // OTP Valid hai! Use instantaneous delete kar dein taaki reuse na ho sake
    await query(`DELETE FROM OtpVerifications WHERE Phone = @phone`, {
      phone: { type: sql.VarChar, value: phone }
    });

    res.json({ success: true, message: 'OTP Verified successfully' });
  } catch (error) {
    next(error);
  }
};

// 3. Register School & Admin Account (Multi-Tenant Architecture)
const registerSchool = async (req, res, next) => {
  const { schoolName, affiliationNo, addressLine1, city, state, adminName, email, phone, password } = req.body;

  try {
    // 1. Check duplicate Admin/User
    const checkUser = await query(`SELECT id FROM users WHERE email = @email OR phone = @phone`, {
      email: { type: sql.VarChar, value: email },
      phone: { type: sql.VarChar, value: phone }
    });
    if (checkUser.recordset.length > 0) {
      return res.status(400).json({ success: false, message: 'Admin with this Email or Phone already exists' });
    }

    // 2. Hash Password & Create School Slug
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    const slug = schoolName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');

    // 3. Default "SCHOOL OFFICE" Organisation Logic (Fixed for all)
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

    // 4. Create School (Exact DB Columns: address_line1, affiliation_no)
    const schoolRes = await query(`
      INSERT INTO schools (organisation_id, name, slug, affiliation_no, address_line1, city, state, country, is_active) 
      OUTPUT INSERTED.id 
      VALUES (@orgId, @name, @slug, @affiliationNo, @addressLine1, @city, @state, 'India', 1)
    `, {
      orgId: { type: sql.UniqueIdentifier, value: orgId },
      name: { type: sql.VarChar, value: schoolName },
      slug: { type: sql.VarChar, value: slug },
      affiliationNo: { type: sql.VarChar, value: affiliationNo },
      addressLine1: { type: sql.VarChar, value: addressLine1 },
      city: { type: sql.VarChar, value: city },
      state: { type: sql.VarChar, value: state }
    });
    const schoolId = schoolRes.recordset[0].id;

    // 5. Auto-Create Current Academic Year (Crucial for ERP operations)
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

    // 6. Create User Admin (Using full_name)
    const userRes = await query(`
      INSERT INTO users (full_name, email, phone, password, is_active) 
      OUTPUT INSERTED.id 
      VALUES (@fullName, @email, @phone, @password, 1)
    `, {
      fullName: { type: sql.VarChar, value: adminName }, 
      email: { type: sql.VarChar, value: email },
      phone: { type: sql.VarChar, value: phone },
      password: { type: sql.VarChar, value: hashedPassword }
    });
    const userId = userRes.recordset[0].id;

    // 7. Link User to School as 'school_admin'
    await query(`
      INSERT INTO school_members (school_id, user_id, role, is_active) 
      VALUES (@schoolId, @userId, 'school_admin', 1)
    `, {
      schoolId: { type: sql.UniqueIdentifier, value: schoolId },
      userId: { type: sql.UniqueIdentifier, value: userId }
    });

    // 8. Generate Final Auth Token
    const token = jwt.sign({ schoolId, userId, role: 'school_admin' }, process.env.JWT_SECRET, { expiresIn: '24h' });

    res.status(201).json({ success: true, message: 'School registered successfully', token });
  } catch (error) {
    next(error);
  }
};

module.exports = { sendOtp, verifyOtp, registerSchool };
