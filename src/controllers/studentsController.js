// src/controllers/studentsController.js
const { query, queryOne, withTransaction, sql } = require('../config/db');
const { success, created, notFound, badRequest, paginated } = require('../utils/response');
const { audit } = require('../utils/audit');
const { v4: uuidv4 } = require('uuid');

// ── GET /api/students  (list + filter + paginate + STRICT MAPPING) ──────────
exports.list = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const pageNum = parseInt(req.query.page, 10) || 1;
    const limitNum = parseInt(req.query.limit, 10) || 20;
    const offset = (pageNum - 1) * limitNum;
    
    const { search, class: gradeId, section, gender, fee_status, is_active = '1' } = req.query;

    let where = `s.school_id = @sid AND s.deleted_at IS NULL`;
    const params = { sid: { type: sql.UniqueIdentifier, value: schoolId } };

    if (search) {
      where += ` AND (s.first_name + ' ' + s.last_name LIKE @search OR s.admission_no LIKE @search)`;
      params.search = { type: sql.NVarChar(255), value: `%${search}%` };
    }
    if (gradeId) {
      where += ` AND g.id = @gradeId`;
      params.gradeId = { type: sql.UniqueIdentifier, value: gradeId };
    }
    if (section) {
      where += ` AND sc.name = @section`;
      params.section = { type: sql.NVarChar(50), value: section };
    }
    if (gender) {
      where += ` AND s.gender = @gender`;
      params.gender = { type: sql.VarChar(20), value: gender };
    }
    if (is_active !== undefined) {
      where += ` AND s.is_active = @isActive`;
      params.isActive = { type: sql.Bit, value: is_active === '1' ? 1 : 0 };
    }

    // 1. COUNT QUERY
    const countResult = await queryOne(
      `SELECT COUNT(DISTINCT s.id) AS total
       FROM students s
       LEFT JOIN enrolments e   ON e.student_id = s.id AND e.school_id = @sid AND e.is_active = 1 AND e.deleted_at IS NULL
       LEFT JOIN sections sc    ON sc.id = e.section_id AND sc.school_id = @sid AND sc.deleted_at IS NULL
       LEFT JOIN grades g       ON g.id = sc.grade_id AND g.school_id = @sid AND g.deleted_at IS NULL
       WHERE ${where}`,
      params
    );

    // 2. DATA QUERY (Totally cleaned of s.phone, fetching ONLY sg.phone)
    const students = await query(
      `SELECT s.id, s.admission_no, s.first_name, s.middle_name, s.last_name,
              s.gender, s.date_of_birth, s.blood_group,
              sg.phone AS primary_phone, -- 🔥 Correct alias for frontend
              s.photo_url, s.is_active, s.admission_date, s.created_at,
              g.id AS grade_id, g.name AS class_name,
              sc.id AS section_id, sc.name AS section_name,
              e.roll_no,
              sfa.status AS fee_status, sfa.paid_paise, sfa.pending_paise
       FROM students s
       LEFT JOIN student_guardians sg ON sg.student_id = s.id AND sg.school_id = @sid AND sg.is_primary = 1 AND sg.deleted_at IS NULL
       LEFT JOIN enrolments e   ON e.student_id = s.id AND e.school_id = @sid AND e.is_active = 1 AND e.deleted_at IS NULL
       LEFT JOIN sections sc    ON sc.id = e.section_id AND sc.school_id = @sid AND sc.deleted_at IS NULL
       LEFT JOIN grades g       ON g.id = sc.grade_id AND g.school_id = @sid AND g.deleted_at IS NULL
       LEFT JOIN student_fee_accounts sfa ON sfa.student_id = s.id AND sfa.school_id = @sid
       WHERE ${where}
       ORDER BY g.numeric_order, sc.name, e.roll_no, s.first_name
       OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
      { ...params, offset: { type: sql.Int, value: +offset }, limit: { type: sql.Int, value: +limit } }
    );

   return paginated(res, students.recordset, countResult.total, pageNum, limitNum);
  } catch (err) { next(err); }
};

// ── GET /api/students/:id (Strict Mapping) ────────────────────────────────
exports.getOne = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { schoolId } = req.user;

    const student = await queryOne(
      `SELECT s.*,
              g.name AS class_name, g.id AS grade_id,
              sc.name AS section_name, sc.id AS section_id,
              e.id AS enrolment_id, e.roll_no, e.is_active AS enrolment_active,
              sfa.total_fee_paise, sfa.paid_paise, sfa.pending_paise, sfa.status AS fee_status
       FROM students s
       LEFT JOIN enrolments e ON e.student_id = s.id AND e.school_id = @sid AND e.is_active = 1 AND e.deleted_at IS NULL
       LEFT JOIN sections sc  ON sc.id = e.section_id AND sc.school_id = @sid AND sc.deleted_at IS NULL
       LEFT JOIN grades g     ON g.id = sc.grade_id AND g.school_id = @sid AND g.deleted_at IS NULL
       LEFT JOIN student_fee_accounts sfa ON sfa.student_id = s.id AND sfa.school_id = @sid
       WHERE s.id = @id AND s.school_id = @sid AND s.deleted_at IS NULL`,
      { id: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    if (!student) return notFound(res, 'Student not found');

    const guardians = await query(
      `SELECT * FROM student_guardians WHERE student_id = @id AND school_id = @sid AND deleted_at IS NULL`,
      { id: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );

    return success(res, { ...student, guardians: guardians.recordset });
  } catch (err) { next(err); }
};

// ── POST /api/students ────────────────────────────────────────────────────
exports.create = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const {
      first_name, middle_name, last_name, gender, date_of_birth, blood_group,
      nationality, religion, caste, sub_caste, is_ews, aadhaar_no,
      previous_school, tc_no, admission_date, address_permanent, address_current,
      city, state, pincode, photo_url, medical_conditions, disabilities,
      extra_curricular, admission_no, section_id, academic_year_id, roll_no,
      guardians = [],
    } = req.body;

    const newId = uuidv4();

    await withTransaction(async (tx) => {
      const req1 = tx.request();
      req1.input('id', sql.UniqueIdentifier, newId);
      req1.input('schoolId', sql.UniqueIdentifier, schoolId);
      req1.input('admissionNo', sql.NVarChar(100), admission_no);
      req1.input('firstName', sql.NVarChar(100), first_name);
      req1.input('middleName', sql.NVarChar(100), middle_name || null);
      req1.input('lastName', sql.NVarChar(100), last_name);
      req1.input('gender', sql.VarChar(20), gender);
      req1.input('dob', sql.Date, date_of_birth);
      req1.input('bloodGroup', sql.VarChar(10), blood_group || null);
      req1.input('nationality', sql.NVarChar(100), nationality || 'Indian');
      req1.input('religion', sql.NVarChar(100), religion || null);
      req1.input('caste', sql.NVarChar(100), caste || null);
      req1.input('subCaste', sql.NVarChar(100), sub_caste || null);
      req1.input('isEws', sql.Bit, is_ews ? 1 : 0);
      req1.input('aadhaarNo', sql.NVarChar(20), aadhaar_no || null);
      req1.input('prevSchool', sql.NVarChar(255), previous_school || null);
      req1.input('tcNo', sql.NVarChar(100), tc_no || null);
      req1.input('admissionDate', sql.Date, admission_date);
      req1.input('addrPerm', sql.NVarChar(sql.MAX), address_permanent || null);
      req1.input('addrCurr', sql.NVarChar(sql.MAX), address_current || null);
      req1.input('city', sql.NVarChar(100), city || null);
      req1.input('state', sql.NVarChar(100), state || null);
      req1.input('pincode', sql.Char(6), pincode || null);
      req1.input('photoUrl', sql.NVarChar(sql.MAX), photo_url || null);
      req1.input('medical', sql.NVarChar(sql.MAX), medical_conditions || null);
      req1.input('disabilities', sql.NVarChar(sql.MAX), disabilities || null);
      req1.input('extraCurr', sql.NVarChar(sql.MAX), extra_curricular || null);
      
      await req1.query(
        `INSERT INTO students (id,school_id,admission_no,first_name,middle_name,last_name,gender,
           date_of_birth,blood_group,nationality,religion,caste,sub_caste,is_ews,aadhaar_no,
           previous_school,tc_no,admission_date,address_permanent,address_current,city,state,pincode,
           photo_url,medical_conditions,disabilities,extra_curricular)
         VALUES(@id,@schoolId,@admissionNo,@firstName,@middleName,@lastName,@gender,
           @dob,@bloodGroup,@nationality,@religion,@caste,@subCaste,@isEws,@aadhaarNo,
           @prevSchool,@tcNo,@admissionDate,@addrPerm,@addrCurr,@city,@state,@pincode,
           @photoUrl,@medical,@disabilities,@extraCurr)`
      );

      if (section_id && academic_year_id) {
        const req2 = tx.request();
        req2.input('enrolId', sql.UniqueIdentifier, uuidv4());
        req2.input('schoolId', sql.UniqueIdentifier, schoolId);
        req2.input('studentId', sql.UniqueIdentifier, newId);
        req2.input('sectionId', sql.UniqueIdentifier, section_id);
        req2.input('ayId', sql.UniqueIdentifier, academic_year_id);
        req2.input('rollNo', sql.NVarChar(50), roll_no || null);
        await req2.query(
          `INSERT INTO enrolments (id,school_id,student_id,section_id,academic_year_id,roll_no)
           VALUES(@enrolId,@schoolId,@studentId,@sectionId,@ayId,@rollNo)`
        );
      }

      for (const g of guardians) {
        const req3 = tx.request();
        req3.input('gId', sql.UniqueIdentifier, uuidv4());
        req3.input('schoolId', sql.UniqueIdentifier, schoolId);
        req3.input('studentId', sql.UniqueIdentifier, newId);
        req3.input('relation', sql.NVarChar(50), g.relation);
        req3.input('fullName', sql.NVarChar(255), g.full_name);
        req3.input('phone', sql.NVarChar(50), g.phone);
        req3.input('email', sql.NVarChar(255), g.email || null);
        req3.input('isPrimary', sql.Bit, g.is_primary ? 1 : 0);
        await req3.query(
          `INSERT INTO student_guardians (id,school_id,student_id,relation,full_name,phone,email,is_primary)
           VALUES(@gId,@schoolId,@studentId,@relation,@fullName,@phone,@email,@isPrimary)`
        );
      }
    });

    await audit({ req, action: 'CREATE', tableName: 'students', recordId: newId, newValues: req.body });
    const student = await exports.getOne({ params: { id: newId }, user: req.user }, res, next);
  } catch (err) { next(err); }
};

// ── PUT /api/students/:id ─────────────────────────────────────────────────
exports.update = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { schoolId } = req.user;
    const old = await queryOne(
      `SELECT * FROM students WHERE id = @id AND school_id = @sid AND deleted_at IS NULL`,
      { id: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    if (!old) return notFound(res, 'Student not found');

    const fields = ['first_name','middle_name','last_name','gender','date_of_birth','blood_group',
      'nationality','religion','caste','sub_caste','is_ews','aadhaar_no','previous_school',
      'tc_no','address_permanent','address_current','city','state','pincode','photo_url',
      'medical_conditions','disabilities','extra_curricular','is_active'];

    const sets = []; const params = {
      id: { type: sql.UniqueIdentifier, value: id },
      sid: { type: sql.UniqueIdentifier, value: schoolId },
    };

    const colMap = {
      first_name: sql.NVarChar(100), middle_name: sql.NVarChar(100), last_name: sql.NVarChar(100),
      gender: sql.VarChar(20), date_of_birth: sql.Date, blood_group: sql.VarChar(10),
      nationality: sql.NVarChar(100), religion: sql.NVarChar(100), caste: sql.NVarChar(100),
      sub_caste: sql.NVarChar(100), is_ews: sql.Bit, aadhaar_no: sql.NVarChar(20),
      previous_school: sql.NVarChar(255), tc_no: sql.NVarChar(100),
      address_permanent: sql.NVarChar(sql.MAX), address_current: sql.NVarChar(sql.MAX),
      city: sql.NVarChar(100), state: sql.NVarChar(100), pincode: sql.Char(6),
      photo_url: sql.NVarChar(sql.MAX), medical_conditions: sql.NVarChar(sql.MAX),
      disabilities: sql.NVarChar(sql.MAX), extra_curricular: sql.NVarChar(sql.MAX),
      is_active: sql.Bit,
    };

    for (const f of fields) {
      if (req.body[f] !== undefined) {
        sets.push(`${f} = @${f}`);
        params[f] = { type: colMap[f], value: req.body[f] };
      }
    }
    sets.push('updated_at = GETUTCDATE()');

    await query(
      `UPDATE students SET ${sets.join(', ')} WHERE id = @id AND school_id = @sid`,
      params
    );

    await audit({ req, action: 'UPDATE', tableName: 'students', recordId: id, oldValues: old, newValues: req.body });
    const updated = await queryOne(
      `SELECT * FROM students WHERE id = @id`,
      { id: { type: sql.UniqueIdentifier, value: id } }
    );
    return success(res, updated, 'Student updated');
  } catch (err) { next(err); }
};

// ── DELETE /api/students/:id  (soft delete) ───────────────────────────────
exports.remove = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { schoolId } = req.user;
    await query(
      `UPDATE students SET deleted_at = GETUTCDATE(), is_active = 0, updated_at = GETUTCDATE()
       WHERE id = @id AND school_id = @sid AND deleted_at IS NULL`,
      { id: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    await audit({ req, action: 'DELETE', tableName: 'students', recordId: id });
    return success(res, null, 'Student deleted');
  } catch (err) { next(err); }
};
