// src/controllers/studentsController.js
const { query, queryOne, withTransaction, sql } = require('../config/db');
const { success, created, notFound, badRequest, paginated } = require('../utils/response');
const { audit } = require('../utils/audit');
const { v4: uuidv4 } = require('uuid');


// ── GET /api/students (Formatted for Frontend Nested Schema & STRICT SaaS) ──
// ── GET /api/students (Formatted for Frontend Nested Schema & STRICT SaaS) ──
exports.list = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const pageNum = parseInt(req.query.page, 10) || 1;
    const limitNum = parseInt(req.query.limit, 10) || 50; // Aligned with frontend PAGE_SIZE = 50
    const offset = (pageNum - 1) * limitNum;
    
    const { search, grade_id, section_id, gender, is_active, sort } = req.query;

    // 🛡️ SaaS Core Rule: ALWAYS filter root table by school_id
    let where = `s.school_id = @sid AND s.deleted_at IS NULL`;
    const params = { sid: { type: sql.UniqueIdentifier, value: schoolId } };

    if (search) {
      where += ` AND (s.first_name + ' ' + ISNULL(s.last_name, '') LIKE @search OR s.admission_no LIKE @search)`;
      params.search = { type: sql.NVarChar(255), value: `%${search}%` };
    }
    if (grade_id) {
      where += ` AND g.id = @gradeId`;
      params.gradeId = { type: sql.UniqueIdentifier, value: grade_id };
    }
    if (section_id) {
      where += ` AND sc.id = @section`;
      params.section = { type: sql.UniqueIdentifier, value: section_id };
    }
    if (gender) {
      // Smart check for gender filter if it comes from UI
      where += ` AND LOWER(s.gender) IN (@gender, CASE WHEN @gender='Male' THEN 'boy' ELSE 'girl' END)`;
      params.gender = { type: sql.VarChar(20), value: gender.toLowerCase() };
    }
    if (is_active !== undefined && is_active !== '') {
      where += ` AND s.is_active = @isActive`;
      params.isActive = { type: sql.Bit, value: is_active === '1' || is_active === 'true' ? 1 : 0 };
    }

    // 🔥 Schema-Matched Aggregation (Handles 'GIRL' / 'BOY' anomaly from bulk imports)
    const countResult = await queryOne(
      `SELECT 
          COUNT(DISTINCT s.id) AS total,
          SUM(CASE WHEN s.is_active = 1 THEN 1 ELSE 0 END) AS active_count,
          SUM(CASE WHEN LOWER(s.gender) IN ('male', 'boy', 'm') THEN 1 ELSE 0 END) AS male_count,
          SUM(CASE WHEN LOWER(s.gender) IN ('female', 'girl', 'f') THEN 1 ELSE 0 END) AS female_count
       FROM students s
       LEFT JOIN enrolments e ON e.student_id = s.id AND e.school_id = @sid AND e.is_active = 1 AND e.deleted_at IS NULL
       LEFT JOIN sections sc ON sc.id = e.section_id AND sc.school_id = @sid
       LEFT JOIN grades g ON g.id = sc.grade_id AND g.school_id = @sid
       WHERE ${where}`, params
    );

    // 🔥 Smart Roll Number Sorting (Since roll_no is NVARCHAR(50) in DB)
    let orderByClause = `ORDER BY ISNULL(g.numeric_order, 999), sc.name, s.first_name`;
    if (sort === 'roll_no') {
        orderByClause = `ORDER BY ISNULL(TRY_CAST(e.roll_no AS INT), 999999) ASC, s.first_name ASC`;
    }

    // 2. DATA Fetch (Exact matching with your DB schema columns)
    const rawData = await query(
      `SELECT s.*, 
              e.id AS enrolment_id, g.id AS grade_id, e.section_id, e.academic_year_id, e.roll_no,
              g.name AS class_name, sc.name AS section_name,
              sg1.relation AS g1_relation, sg1.full_name AS g1_name, sg1.phone AS g1_phone, sg1.email AS g1_email,
              sg2.relation AS g2_relation, sg2.full_name AS g2_name, sg2.phone AS g2_phone, sg2.email AS g2_email,
              sfa.status AS fee_status
       FROM students s
       LEFT JOIN enrolments e ON e.student_id = s.id AND e.school_id = @sid AND e.is_active = 1 AND e.deleted_at IS NULL
       LEFT JOIN sections sc ON sc.id = e.section_id AND sc.school_id = @sid AND sc.deleted_at IS NULL
       LEFT JOIN grades g ON g.id = sc.grade_id AND g.school_id = @sid AND g.deleted_at IS NULL
       -- Primary Guardian Join
       LEFT JOIN student_guardians sg1 ON sg1.student_id = s.id AND sg1.school_id = @sid AND sg1.is_primary = 1 AND sg1.deleted_at IS NULL
       -- Secondary Guardian Join (Takes the latest one)
       LEFT JOIN (
           SELECT * FROM (
               SELECT *, ROW_NUMBER() OVER(PARTITION BY student_id ORDER BY created_at DESC) as rn 
               FROM student_guardians WHERE is_primary = 0 AND deleted_at IS NULL
           ) tmp WHERE rn = 1
       ) sg2 ON sg2.student_id = s.id AND sg2.school_id = @sid
       -- Fee Accounts Join
       LEFT JOIN student_fee_accounts sfa ON sfa.student_id = s.id AND sfa.school_id = @sid AND sfa.deleted_at IS NULL
       WHERE ${where}
       ${orderByClause}
       OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
      { ...params, offset: { type: sql.Int, value: +offset }, limit: { type: sql.Int, value: +limitNum } }
    );

    // 3. FORMAT FOR FRONTEND
    const formattedStudents = rawData.recordset.map(row => ({
      ...row,
      enrolment: row.grade_id ? {
        grade_id: row.grade_id, section_id: row.section_id,
        academic_year_id: row.academic_year_id, roll_no: row.roll_no
      } : null,
      guardians: [
        row.g1_name ? { relation: row.g1_relation, full_name: row.g1_name, phone: row.g1_phone, email: row.g1_email, is_primary: true } : null,
        row.g2_name ? { relation: row.g2_relation, full_name: row.g2_name, phone: row.g2_phone, email: row.g2_email, is_primary: false } : null,
      ].filter(Boolean),
      primary_phone: row.g1_phone || null
    }));

    // 4. RETURN Payload (Including the new stats object for your UI)
    return res.json({ 
      data: formattedStudents, 
      total: countResult.total || 0,
      stats: {
          active: countResult.active_count || 0,
          male: countResult.male_count || 0,
          female: countResult.female_count || 0
      }
    });
    
  } catch (err) { next(err); }
};


// ── GET /api/students/:id ──────────────────────────────────────────────────
exports.getOne = async (req, res, next) => {
  try {
    req.query.search = undefined; // isolate query
    
    // Using list function to get the formatted single student
    const single = await exports.list(
      { ...req, query: { ...req.query, limit: 1 } }, 
      { status: () => ({ json: data => data }), json: data => data }, 
      next
    );
    
    if (!single || !single.data || single.data.length === 0) {
        return notFound(res, 'Student not found');
    }
    
    return success(res, single.data[0]);
  } catch (err) {
    next(err);
  }
};
// ── POST /api/students (Deep Create with Transactions) ────────────────────
exports.create = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { enrolment, guardians, ...s } = req.body; // 🔥 Destructure frontend payload
    const newId = uuidv4();

    await withTransaction(async (tx) => {
      // 1. Insert Student
      const r1 = tx.request();
      r1.input('id', sql.UniqueIdentifier, newId);
      r1.input('sid', sql.UniqueIdentifier, schoolId);
      r1.input('admNo', sql.NVarChar(100), s.admission_no || `ADM-${Date.now().toString().slice(-6)}`);
      r1.input('fName', sql.NVarChar(100), s.first_name);
      r1.input('mName', sql.NVarChar(100), s.middle_name || null);
      r1.input('lName', sql.NVarChar(100), s.last_name || null);
      r1.input('gen', sql.VarChar(20), s.gender || 'Unknown');
      r1.input('dob', sql.Date, s.date_of_birth === '' ? null : s.date_of_birth);
      r1.input('bg', sql.VarChar(10), s.blood_group || null);
      r1.input('nat', sql.NVarChar(100), s.nationality || 'Indian');
      r1.input('rel', sql.NVarChar(100), s.religion || null);
      r1.input('caste', sql.NVarChar(100), s.caste || null);
      r1.input('scaste', sql.NVarChar(100), s.sub_caste || null);
      r1.input('ews', sql.Bit, s.is_ews ? 1 : 0);
      r1.input('aadhar', sql.NVarChar(20), s.aadhaar_no || null);
      r1.input('prevSch', sql.NVarChar(255), s.previous_school || null);
      r1.input('tc', sql.NVarChar(100), s.tc_no || null);
      r1.input('admDate', sql.Date, s.admission_date === '' ? null : s.admission_date || new Date());
      r1.input('addrP', sql.NVarChar(sql.MAX), s.address_permanent || null);
      r1.input('addrC', sql.NVarChar(sql.MAX), s.address_current || null);
      r1.input('city', sql.NVarChar(100), s.city || null);
      r1.input('state', sql.NVarChar(100), s.state || null);
      r1.input('pin', sql.Char(6), s.pincode || null);
      r1.input('photo', sql.NVarChar(sql.MAX), s.photo_url || null);
      r1.input('med', sql.NVarChar(sql.MAX), s.medical_conditions || null);
      r1.input('dis', sql.NVarChar(sql.MAX), s.disabilities || null);
      r1.input('extra', sql.NVarChar(sql.MAX), s.extra_curricular || null);
      r1.input('active', sql.Bit, s.is_active !== false ? 1 : 0);

      await r1.query(
        `INSERT INTO students (id,school_id,admission_no,first_name,middle_name,last_name,gender,date_of_birth,blood_group,nationality,religion,caste,sub_caste,is_ews,aadhaar_no,previous_school,tc_no,admission_date,address_permanent,address_current,city,state,pincode,photo_url,medical_conditions,disabilities,extra_curricular,is_active)
         VALUES (@id,@sid,@admNo,@fName,@mName,@lName,@gen,@dob,@bg,@nat,@rel,@caste,@scaste,@ews,@aadhar,@prevSch,@tc,@admDate,@addrP,@addrC,@city,@state,@pin,@photo,@med,@dis,@extra,@active)`
      );

      // 2. Insert Enrolment (If provided)
      if (enrolment && enrolment.section_id && enrolment.academic_year_id) {
        const r2 = tx.request();
        r2.input('sid', sql.UniqueIdentifier, schoolId);
        r2.input('stId', sql.UniqueIdentifier, newId);
        r2.input('secId', sql.UniqueIdentifier, enrolment.section_id);
        r2.input('ayId', sql.UniqueIdentifier, enrolment.academic_year_id);
        r2.input('roll', sql.NVarChar(50), enrolment.roll_no || null);
        await r2.query(`INSERT INTO enrolments (id,school_id,student_id,section_id,academic_year_id,roll_no) VALUES(NEWID(),@sid,@stId,@secId,@ayId,@roll)`);
      }

      // 3. Insert Guardians
      if (guardians && Array.isArray(guardians)) {
        for (const g of guardians) {
          const r3 = tx.request();
          r3.input('sid', sql.UniqueIdentifier, schoolId);
          r3.input('stId', sql.UniqueIdentifier, newId);
          r3.input('rel', sql.NVarChar(50), g.relation || 'Parent');
          r3.input('fn', sql.NVarChar(255), g.full_name);
          r3.input('ph', sql.NVarChar(50), g.phone);
          r3.input('em', sql.NVarChar(255), g.email || null);
          r3.input('pri', sql.Bit, g.is_primary ? 1 : 0);
          await r3.query(`INSERT INTO student_guardians (id,school_id,student_id,relation,full_name,phone,email,is_primary) VALUES(NEWID(),@sid,@stId,@rel,@fn,@ph,@em,@pri)`);
        }
      }

      // 4. Initialize Fee Account (CRITICAL FOR BULK UPLOADS)
      const r4 = tx.request();
      r4.input('sid', sql.UniqueIdentifier, schoolId);
      r4.input('stId', sql.UniqueIdentifier, newId);
      await r4.query(`INSERT INTO student_fee_accounts (id,school_id,student_id,total_fee_paise,paid_paise,pending_paise,status) VALUES(NEWID(),@sid,@stId,0,0,0,'Pending')`);
    });

    await audit({ req, action: 'CREATE', tableName: 'students', recordId: newId });
    return created(res, { id: newId }, 'Student created successfully');
  } catch (err) { next(err); }
};

// ── PUT /api/students/:id (Deep Update with Transactions) ─────────────────
exports.update = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { schoolId } = req.user;
    const { enrolment, guardians, ...s } = req.body;

    const old = await queryOne(`SELECT id FROM students WHERE id = @id AND school_id = @sid AND deleted_at IS NULL`, 
      { id: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId } });
    if (!old) return notFound(res, 'Student not found');

    await withTransaction(async (tx) => {
      // 1. Update Student Table
      const fields = ['first_name','middle_name','last_name','gender','blood_group','nationality','religion','caste','sub_caste','is_ews','aadhaar_no','previous_school','tc_no','address_permanent','address_current','city','state','pincode','photo_url','medical_conditions','disabilities','extra_curricular','is_active'];
      const sets = []; 
      const r1 = tx.request();
      r1.input('id', sql.UniqueIdentifier, id);
      r1.input('sid', sql.UniqueIdentifier, schoolId);

      // Handle Dates specially to prevent "" crashes
      if (s.date_of_birth !== undefined) { sets.push(`date_of_birth = @dob`); r1.input('dob', sql.Date, s.date_of_birth === '' ? null : s.date_of_birth); }
      if (s.admission_date !== undefined) { sets.push(`admission_date = @admDate`); r1.input('admDate', sql.Date, s.admission_date === '' ? null : s.admission_date); }
      if (s.admission_no !== undefined) { sets.push(`admission_no = @admNo`); r1.input('admNo', sql.NVarChar(100), s.admission_no); }

      for (const f of fields) {
        if (s[f] !== undefined) {
          sets.push(`${f} = @${f}`);
          // Simplified casting
          let val = s[f] === '' ? null : s[f];
          if (typeof val === 'boolean') { r1.input(f, sql.Bit, val ? 1 : 0); }
          else { r1.input(f, sql.NVarChar(sql.MAX), val ? String(val) : null); }
        }
      }
      
      if (sets.length > 0) {
        sets.push('updated_at = GETUTCDATE()');
        await r1.query(`UPDATE students SET ${sets.join(', ')} WHERE id = @id AND school_id = @sid`);
      }

      // 2. Upsert Enrolment
      if (enrolment) {
        const r2 = tx.request();
        r2.input('id', sql.UniqueIdentifier, id);
        r2.input('sid', sql.UniqueIdentifier, schoolId);
        r2.input('secId', sql.UniqueIdentifier, enrolment.section_id || null);
        r2.input('ayId', sql.UniqueIdentifier, enrolment.academic_year_id || null);
        r2.input('roll', sql.NVarChar(50), enrolment.roll_no || null);
        
        // Disable old active enrolments, insert new
        await r2.query(`UPDATE enrolments SET is_active = 0 WHERE student_id = @id AND school_id = @sid`);
        if (enrolment.section_id && enrolment.academic_year_id) {
          await r2.query(`INSERT INTO enrolments (id,school_id,student_id,section_id,academic_year_id,roll_no,is_active) VALUES(NEWID(),@sid,@id,@secId,@ayId,@roll,1)`);
        }
      }

      // 3. Update Guardians (Delete old, Insert new)
      if (guardians && Array.isArray(guardians)) {
        const r3 = tx.request();
        r3.input('id', sql.UniqueIdentifier, id);
        r3.input('sid', sql.UniqueIdentifier, schoolId);
        await r3.query(`UPDATE student_guardians SET deleted_at = GETUTCDATE() WHERE student_id = @id AND school_id = @sid AND deleted_at IS NULL`);
        
        for (const g of guardians) {
          const r4 = tx.request();
          r4.input('sid', sql.UniqueIdentifier, schoolId);
          r4.input('stId', sql.UniqueIdentifier, id);
          r4.input('rel', sql.NVarChar(50), g.relation || 'Parent');
          r4.input('fn', sql.NVarChar(255), g.full_name);
          r4.input('ph', sql.NVarChar(50), g.phone);
          r4.input('em', sql.NVarChar(255), g.email || null);
          r4.input('pri', sql.Bit, g.is_primary ? 1 : 0);
          await r4.query(`INSERT INTO student_guardians (id,school_id,student_id,relation,full_name,phone,email,is_primary) VALUES(NEWID(),@sid,@stId,@rel,@fn,@ph,@em,@pri)`);
        }
      }
    });

    await audit({ req, action: 'UPDATE', tableName: 'students', recordId: id });
    return success(res, null, 'Student updated successfully');
  } catch (err) { next(err); }
};
// ── DELETE /api/students/:id (Deep Soft Delete) ───────────────────────────
exports.remove = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { schoolId } = req.user;

    const student = await queryOne(
      `SELECT id FROM students WHERE id = @id AND school_id = @sid AND deleted_at IS NULL`,
      { id: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    
    if (!student) return notFound(res, 'Student not found');

    // Transaction se teeno tables (Students, Enrolments, Guardians) mein ek sath soft-delete
    await withTransaction(async (tx) => {
      const r1 = tx.request();
      r1.input('id', sql.UniqueIdentifier, id);
      r1.input('sid', sql.UniqueIdentifier, schoolId);
      
      // 1. Delete Student
      await r1.query(`UPDATE students SET deleted_at = GETUTCDATE(), is_active = 0, updated_at = GETUTCDATE() WHERE id = @id AND school_id = @sid`);
      
      // 2. Disable Enrolment
      await r1.query(`UPDATE enrolments SET deleted_at = GETUTCDATE(), is_active = 0, updated_at = GETUTCDATE() WHERE student_id = @id AND school_id = @sid`);
      
      // 3. Disable Guardians
      await r1.query(`UPDATE student_guardians SET deleted_at = GETUTCDATE(), updated_at = GETUTCDATE() WHERE student_id = @id AND school_id = @sid`);
    });

    await audit({ req, action: 'DELETE', tableName: 'students', recordId: id });
    return success(res, null, 'Student record and dependencies deleted successfully');
  } catch (err) { next(err); }
};
