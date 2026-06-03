// src/controllers/setupController.js
const { query, queryOne, sql } = require('../config/db');
const { success, created, notFound, badRequest } = require('../utils/response');
const { audit } = require('../utils/audit');

// ═══════════════ GRADES ═══════════════════════════════════════════════════

exports.listGrades = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const grades = await query(
      `SELECT g.*, COUNT(DISTINCT sc.id) AS section_count,
              COUNT(DISTINCT e.student_id) AS student_count
       FROM grades g
       LEFT JOIN sections sc ON sc.grade_id = g.id AND sc.school_id = @sid AND sc.deleted_at IS NULL
       LEFT JOIN enrolments e ON e.section_id = sc.id AND e.is_active=1 AND e.deleted_at IS NULL
       WHERE g.school_id = @sid AND g.deleted_at IS NULL
       GROUP BY g.id, g.name, g.numeric_order, g.stream, g.description, g.is_active, g.created_at, g.updated_at, g.deleted_at
       ORDER BY g.numeric_order`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    return success(res, grades.recordset);
  } catch (err) { next(err); }
};

exports.createGrade = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { name, numeric_order, stream = 'none', description } = req.body;
    const id = (await query(
      `INSERT INTO grades (id,school_id,name,numeric_order,stream,description) OUTPUT INSERTED.id VALUES(NEWID(),@sid,@name,@order,@stream,@desc)`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId }, name: { type: sql.NVarChar(100), value: name },
        order: { type: sql.SmallInt, value: numeric_order }, stream: { type: sql.VarChar(50), value: stream },
        desc: { type: sql.NVarChar(500), value: description || null } }
    )).recordset[0].id;
    return created(res, { id }, 'Grade created');
  } catch (err) { next(err); }
};

exports.updateGrade = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { schoolId } = req.user;
    const { name, numeric_order, stream, description, is_active } = req.body;
    await query(
      `UPDATE grades SET name=ISNULL(@n,name), numeric_order=ISNULL(@o,numeric_order),
         stream=ISNULL(@s,stream), description=ISNULL(@d,description),
         is_active=ISNULL(@ia,is_active), updated_at=GETUTCDATE()
       WHERE id=@id AND school_id=@sid AND deleted_at IS NULL`,
      {
        id: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId },
        n: { type: sql.NVarChar(100), value: name ?? null }, o: { type: sql.SmallInt, value: numeric_order ?? null },
        s: { type: sql.VarChar(50), value: stream ?? null }, d: { type: sql.NVarChar(500), value: description ?? null },
        ia: { type: sql.Bit, value: is_active != null ? (is_active ? 1 : 0) : null },
      }
    );
    return success(res, null, 'Grade updated');
  } catch (err) { next(err); }
};

// ═══════════════ SECTIONS ═════════════════════════════════════════════════

exports.listSections = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { grade_id, academic_year_id } = req.query;
    let where = `sc.school_id = @sid AND sc.deleted_at IS NULL`;
    const p = { sid: { type: sql.UniqueIdentifier, value: schoolId } };
    if (grade_id) { where += ` AND sc.grade_id = @gid`; p.gid = { type: sql.UniqueIdentifier, value: grade_id }; }
    if (academic_year_id) { where += ` AND sc.academic_year_id = @ayId`; p.ayId = { type: sql.UniqueIdentifier, value: academic_year_id }; }

    const sections = await query(
      `SELECT sc.*, g.name AS grade_name, g.numeric_order,
              u.full_name AS class_teacher_name,
              COUNT(DISTINCT e.student_id) AS student_count
       FROM sections sc
       JOIN grades g ON g.id = sc.grade_id
       LEFT JOIN users u ON u.id = sc.class_teacher_id
       LEFT JOIN enrolments e ON e.section_id = sc.id AND e.is_active=1 AND e.deleted_at IS NULL
       WHERE ${where}
       GROUP BY sc.id, sc.school_id, sc.grade_id, sc.academic_year_id, sc.name, sc.room_number,
                sc.max_strength, sc.class_teacher_id, sc.is_active, sc.created_at, sc.updated_at, sc.deleted_at,
                g.name, g.numeric_order, u.full_name
       ORDER BY g.numeric_order, sc.name`,
      p
    );
    return success(res, sections.recordset);
  } catch (err) { next(err); }
};

exports.createSection = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { grade_id, academic_year_id, name, room_number, max_strength = 40, class_teacher_id } = req.body;
    const res1 = await query(
      `INSERT INTO sections (id,school_id,grade_id,academic_year_id,name,room_number,max_strength,class_teacher_id)
       OUTPUT INSERTED.id VALUES(NEWID(),@sid,@gid,@ayId,@name,@rn,@ms,@ct)`,
      {
        sid: { type: sql.UniqueIdentifier, value: schoolId }, gid: { type: sql.UniqueIdentifier, value: grade_id },
        ayId: { type: sql.UniqueIdentifier, value: academic_year_id }, name: { type: sql.NVarChar(50), value: name },
        rn: { type: sql.NVarChar(50), value: room_number || null }, ms: { type: sql.SmallInt, value: max_strength },
        ct: { type: sql.UniqueIdentifier, value: class_teacher_id || null },
      }
    );
    return created(res, { id: res1.recordset[0].id }, 'Section created');
  } catch (err) { next(err); }
};

// ═══════════════ SUBJECTS ═════════════════════════════════════════════════

exports.listSubjects = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const subjects = await query(
      `SELECT * FROM subjects WHERE school_id=@sid AND deleted_at IS NULL ORDER BY name`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    return success(res, subjects.recordset);
  } catch (err) { next(err); }
};

exports.createSubject = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { name, code, category = 'core', language_medium, is_theory = true, is_practical = false,
            theory_max_marks = 100, practical_max_marks = 0, passing_marks = 33, description } = req.body;
    const r = await query(
      `INSERT INTO subjects (id,school_id,name,code,category,language_medium,is_theory,is_practical,
         theory_max_marks,practical_max_marks,passing_marks,description)
       OUTPUT INSERTED.id VALUES(NEWID(),@sid,@name,@code,@cat,@lang,@isTh,@isPr,@thMax,@prMax,@pass,@desc)`,
      {
        sid: { type: sql.UniqueIdentifier, value: schoolId }, name: { type: sql.NVarChar(200), value: name },
        code: { type: sql.NVarChar(50), value: code || null }, cat: { type: sql.VarChar(50), value: category },
        lang: { type: sql.NVarChar(50), value: language_medium || 'English' },
        isTh: { type: sql.Bit, value: is_theory ? 1 : 0 }, isPr: { type: sql.Bit, value: is_practical ? 1 : 0 },
        thMax: { type: sql.SmallInt, value: theory_max_marks }, prMax: { type: sql.SmallInt, value: practical_max_marks },
        pass: { type: sql.SmallInt, value: passing_marks }, desc: { type: sql.NVarChar(sql.MAX), value: description || null },
      }
    );
    return created(res, { id: r.recordset[0].id }, 'Subject created');
  } catch (err) { next(err); }
};

// ═══════════════ ACADEMIC YEARS ═══════════════════════════════════════════

exports.listAcademicYears = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const years = await query(
      `SELECT * FROM academic_years WHERE school_id=@sid AND deleted_at IS NULL ORDER BY start_date DESC`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    return success(res, years.recordset);
  } catch (err) { next(err); }
};

exports.createAcademicYear = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { name, start_date, end_date, is_current = false } = req.body;
    // If setting as current, unset all others
    if (is_current) {
      await query(`UPDATE academic_years SET is_current=0 WHERE school_id=@sid`, { sid: { type: sql.UniqueIdentifier, value: schoolId } });
    }
    const r = await query(
      `INSERT INTO academic_years (id,school_id,name,start_date,end_date,is_current) OUTPUT INSERTED.id
       VALUES(NEWID(),@sid,@name,@sd,@ed,@ic)`,
      {
        sid: { type: sql.UniqueIdentifier, value: schoolId }, name: { type: sql.NVarChar(100), value: name },
        sd: { type: sql.Date, value: start_date }, ed: { type: sql.Date, value: end_date },
        ic: { type: sql.Bit, value: is_current ? 1 : 0 },
      }
    );
    return created(res, { id: r.recordset[0].id }, 'Academic year created');
  } catch (err) { next(err); }
};

// ═══════════════ SCHOOL SETTINGS ══════════════════════════════════════════

exports.getSchool = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const school = await queryOne(
      `SELECT * FROM schools WHERE id=@sid AND deleted_at IS NULL`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    return success(res, school);
  } catch (err) { next(err); }
};

exports.updateSchool = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const old = await queryOne(`SELECT * FROM schools WHERE id=@sid`, { sid: { type: sql.UniqueIdentifier, value: schoolId } });

    const fields = ['name','tagline','logo_url','brand_color','affiliation_board','affiliation_no',
      'udise_code','address_line1','address_line2','city','state','pincode','phone','email',
      'website','principal_name','established_year','timezone','academic_year_start','academic_year_end',
      'working_days','periods_per_day','period_duration_min','school_start_time','school_end_time'];

    const sets = ['updated_at = GETUTCDATE()'];
    const params = { sid: { type: sql.UniqueIdentifier, value: schoolId } };
    const typeMap = {
      name: sql.NVarChar(255), tagline: sql.NVarChar(500), logo_url: sql.NVarChar(sql.MAX),
      brand_color: sql.VarChar(10), affiliation_board: sql.NVarChar(100), affiliation_no: sql.NVarChar(100),
      udise_code: sql.NVarChar(100), address_line1: sql.NVarChar(500), address_line2: sql.NVarChar(500),
      city: sql.NVarChar(100), state: sql.NVarChar(100), pincode: sql.Char(6), phone: sql.NVarChar(50),
      email: sql.NVarChar(255), website: sql.NVarChar(255), principal_name: sql.NVarChar(255),
      established_year: sql.SmallInt, timezone: sql.NVarChar(100), academic_year_start: sql.SmallInt,
      academic_year_end: sql.SmallInt, working_days: sql.NVarChar(sql.MAX), periods_per_day: sql.SmallInt,
      period_duration_min: sql.SmallInt, school_start_time: sql.Time, school_end_time: sql.Time,
    };
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        sets.push(`${f} = @${f}`);
        params[f] = { type: typeMap[f], value: req.body[f] };
      }
    }
    await query(`UPDATE schools SET ${sets.join(',')} WHERE id=@sid`, params);
    await audit({ req, action: 'UPDATE', tableName: 'schools', recordId: schoolId, oldValues: old, newValues: req.body });
    return success(res, null, 'School settings saved');
  } catch (err) { next(err); }
};
