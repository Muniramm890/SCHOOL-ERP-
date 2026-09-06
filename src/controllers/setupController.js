// src/controllers/setupController.js
const { query, queryOne, withTransaction, sql } = require('../config/db');
const { success, created, notFound, badRequest } = require('../utils/response');
const { audit } = require('../utils/audit');

// ═══════════════ GRADES / CLASSES ═════════════════════════════════════════

// ═══════════════ GRADES / CLASSES ═════════════════════════════════════════

exports.listGrades = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const grades = await query(
      `SELECT g.id, g.name, g.numeric_order, g.stream, g.is_active, g.created_at, g.updated_at, 
              COUNT(DISTINCT sc.id) AS section_count,
              COUNT(DISTINCT e.student_id) AS student_count
       FROM grades g
       LEFT JOIN sections sc ON sc.grade_id = g.id AND sc.school_id = @sid AND sc.deleted_at IS NULL
       LEFT JOIN enrolments e ON e.section_id = sc.id AND e.school_id = @sid AND e.is_active=1 AND e.deleted_at IS NULL
       WHERE g.school_id = @sid AND g.deleted_at IS NULL
       GROUP BY g.id, g.name, g.numeric_order, g.stream, g.is_active, g.created_at, g.updated_at
       ORDER BY g.numeric_order`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    return success(res, grades.recordset);
  } catch (err) { next(err); }
};

exports.createGrade = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { name, numeric_order, stream = 'none' } = req.body;
    
    const id = (await query(
      `INSERT INTO grades (id, school_id, name, numeric_order, stream) 
       OUTPUT INSERTED.id 
       VALUES(NEWID(), @sid, @name, @order, @stream)`,
      { 
        sid: { type: sql.UniqueIdentifier, value: schoolId }, 
        name: { type: sql.NVarChar(100), value: name },
        order: { type: sql.SmallInt, value: Number(numeric_order) || 0 }, 
        stream: { type: sql.VarChar(50), value: stream }
      }
    )).recordset[0].id;
    
    return created(res, { id }, 'Class/Grade created successfully');
  } catch (err) { next(err); }
};

exports.updateGrade = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { schoolId } = req.user;
    const { name, numeric_order, stream, is_active } = req.body;
    
    await query(
      `UPDATE grades 
       SET name=ISNULL(@n,name), 
           numeric_order=ISNULL(@o,numeric_order),
           stream=ISNULL(@s,stream), 
           is_active=ISNULL(@ia,is_active), 
           updated_at=GETUTCDATE()
       WHERE id=@id AND school_id=@sid AND deleted_at IS NULL`,
      {
        id: { type: sql.UniqueIdentifier, value: id }, 
        sid: { type: sql.UniqueIdentifier, value: schoolId },
        n: { type: sql.NVarChar(100), value: name || null }, 
        o: { type: sql.SmallInt, value: numeric_order ? Number(numeric_order) : null },
        s: { type: sql.VarChar(50), value: stream || null }, 
        ia: { type: sql.Bit, value: is_active != null ? (is_active ? 1 : 0) : null },
      }
    );
    return success(res, null, 'Grade updated successfully');
  } catch (err) { next(err); }
};


// ═══════════════ SECTIONS ═════════════════════════════════════════════════

// ═══════════════ SECTIONS ═════════════════════════════════════════════════

exports.listSections = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { grade_id, academic_year_id } = req.query;
    
    let where = `sc.school_id = @sid AND sc.deleted_at IS NULL`;
    const p = { sid: { type: sql.UniqueIdentifier, value: schoolId } };
    
    if (grade_id) { 
      where += ` AND sc.grade_id = @gid`; 
      p.gid = { type: sql.UniqueIdentifier, value: grade_id }; 
    }
    if (academic_year_id) { 
      where += ` AND sc.academic_year_id = @ayId`; 
      p.ayId = { type: sql.UniqueIdentifier, value: academic_year_id }; 
    }

    const sections = await query(
      `SELECT sc.id, sc.school_id, sc.grade_id, sc.academic_year_id, sc.name, sc.max_strength, sc.class_teacher_id, sc.is_active,
              g.name AS grade_name, g.numeric_order,
              u.full_name AS class_teacher_name,
              COUNT(DISTINCT e.student_id) AS student_count
       FROM sections sc
       JOIN grades g ON g.id = sc.grade_id
       LEFT JOIN users u ON u.id = sc.class_teacher_id
       LEFT JOIN enrolments e ON e.section_id = sc.id AND e.school_id = @sid AND e.is_active=1 AND e.deleted_at IS NULL
       WHERE ${where}
       GROUP BY sc.id, sc.school_id, sc.grade_id, sc.academic_year_id, sc.name, sc.max_strength, sc.class_teacher_id, sc.is_active,
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
    const { grade_id, academic_year_id, name, max_strength = 40, class_teacher_id } = req.body;
    
    const res1 = await query(
      `INSERT INTO sections (id, school_id, grade_id, academic_year_id, name, max_strength, class_teacher_id)
       OUTPUT INSERTED.id 
       VALUES(NEWID(), @sid, @gid, @ayId, @name, @ms, @ct)`,
      {
        sid: { type: sql.UniqueIdentifier, value: schoolId }, 
        gid: { type: sql.UniqueIdentifier, value: grade_id },
        ayId: { type: sql.UniqueIdentifier, value: academic_year_id }, 
        name: { type: sql.NVarChar(50), value: name },
        ms: { type: sql.SmallInt, value: Number(max_strength) },
        ct: { type: sql.UniqueIdentifier, value: class_teacher_id || null },
      }
    );
    return created(res, { id: res1.recordset[0].id }, 'Section deployed successfully');
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
    // Sirf wahi fields accept karein jo DB mein hain
    const { name, category = 'core' } = req.body;
    
    const r = await query(
      `INSERT INTO subjects (id, school_id, name, category)
       OUTPUT INSERTED.id 
       VALUES(NEWID(), @sid, @name, @cat)`,
      {
        sid: { type: sql.UniqueIdentifier, value: schoolId }, 
        name: { type: sql.NVarChar(200), value: name },
        cat: { type: sql.VarChar(50), value: category }
      }
    );
    return created(res, { id: r.recordset[0].id }, 'Subject mapped successfully');
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
    
    if (is_current) {
      await query(`UPDATE academic_years SET is_current=0 WHERE school_id=@sid`, { sid: { type: sql.UniqueIdentifier, value: schoolId } });
    }
    
    const r = await query(
      `INSERT INTO academic_years (id, school_id, name, start_date, end_date, is_current) OUTPUT INSERTED.id
       VALUES(NEWID(), @sid, @name, @sd, @ed, @ic)`,
      {
        sid: { type: sql.UniqueIdentifier, value: schoolId }, 
        name: { type: sql.NVarChar(100), value: name },
        sd: { type: sql.Date, value: start_date }, 
        ed: { type: sql.Date, value: end_date },
        ic: { type: sql.Bit, value: is_current ? 1 : 0 },
      }
    );
    return created(res, { id: r.recordset[0].id }, 'Academic year created');
  } catch (err) { next(err); }
};

// ═══════════════ SCHOOL SETTINGS (DEEP CONFIG) ════════════════════════════

exports.getSchool = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    
    // SQL SERVER में TIME को HH:mm (जैसे "08:30") में भेजने के लिए CONVERT का इस्तेमाल
    const school = await queryOne(
      `SELECT *, 
              LEFT(CONVERT(varchar, school_start_time, 108), 5) AS school_start_time,
              LEFT(CONVERT(varchar, school_end_time, 108), 5) AS school_end_time
       FROM schools 
       WHERE id=@sid AND deleted_at IS NULL`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    
    return success(res, school);
  } catch (err) { next(err); }
};


// ═══════════════ SCHOOL SETTINGS & BULK SETUP ════════════════════════════

exports.updateSchool = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const old = await queryOne(`SELECT * FROM schools WHERE id=@sid`, { sid: { type: sql.UniqueIdentifier, value: schoolId } });

        const fields = [
      'name','tagline','logo_url','watermark_url','brand_color','affiliation_board','affiliation_no',
      'udise_code','address_line1','address_line2','city','state','pincode','phone','email',
      'website','principal_name','established_year','timezone','academic_year_start','academic_year_end',
      'working_days','periods_per_day','period_duration_min','school_start_time','school_end_time'
    ];

    const sets = ['updated_at = GETUTCDATE()'];
    const params = { sid: { type: sql.UniqueIdentifier, value: schoolId } };
    
    const typeMap = {
      name: sql.NVarChar(255), tagline: sql.NVarChar(500), logo_url: sql.NVarChar(sql.MAX),
      watermark_url: sql.NVarChar(sql.MAX),
      brand_color: sql.VarChar(10), affiliation_board: sql.NVarChar(100), affiliation_no: sql.NVarChar(100),
      udise_code: sql.NVarChar(100), address_line1: sql.NVarChar(500), address_line2: sql.NVarChar(500),
      city: sql.NVarChar(100), state: sql.NVarChar(100), pincode: sql.VarChar(6),, phone: sql.NVarChar(50),
      email: sql.NVarChar(255), website: sql.NVarChar(255), principal_name: sql.NVarChar(255),
      established_year: sql.SmallInt, timezone: sql.NVarChar(100), academic_year_start: sql.SmallInt,
      academic_year_end: sql.SmallInt, working_days: sql.NVarChar(sql.MAX), periods_per_day: sql.SmallInt,
      period_duration_min: sql.SmallInt, 
    };

    for (const f of fields) {
      if (req.body[f] !== undefined) {
        let val = req.body[f] === '' ? null : req.body[f];
        
        // 🔥 FIX: Securely casting React's Time String to SQL TIME
      
        if (val !== null && (f === 'school_start_time' || f === 'school_end_time')) {
          val = String(val).trim();
          if (!/^\d{2}:\d{2}(:\d{2})?$/.test(val)) {
            continue; // skip invalid/garbage time values instead of crashing
          }
          if (val.length === 5) val = `${val}:00`;
          sets.push(`${f} = CAST(@${f} AS TIME)`);
          params[f] = { type: sql.VarChar(15), value: val };
        } else {
          sets.push(`${f} = @${f}`);
          params[f] = { type: typeMap[f], value: val };
        }
      }
    }

    await query(`UPDATE schools SET ${sets.join(', ')} WHERE id=@sid`, params);
    return success(res, null, 'School configuration synchronized successfully');
  } catch (err) { next(err); }
};



// ═══════════════ 🔴 GRADE-SUBJECTS (Class-level subject mapping) ═══════════

// GET /api/setup/grade-subjects?grade_id=xxx
exports.listGradeSubjects = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { grade_id } = req.query;

    if (!grade_id) return notFound(res, 'grade_id query param is required');

    const result = await query(
      `SELECT s.id, s.name, s.category
       FROM grade_subjects gs
       JOIN subjects s ON s.id = gs.subject_id AND s.deleted_at IS NULL
       WHERE gs.school_id = @sid AND gs.grade_id = @gid
       ORDER BY s.name`,
      {
        sid: { type: sql.UniqueIdentifier, value: schoolId },
        gid: { type: sql.UniqueIdentifier, value: grade_id },
      }
    );

    return success(res, result.recordset, 'Grade subjects fetched');
  } catch (err) { next(err); }
};

// PUT /api/setup/grade-subjects
exports.saveGradeSubjects = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { grade_id, subject_ids } = req.body;

    if (!grade_id) return badRequest(res, 'grade_id is required');
    if (!Array.isArray(subject_ids)) return badRequest(res, 'subject_ids must be an array');

    // 1. डेटाबेस से मौजूदा (Current) सब्जेक्ट्स निकालें
    const currentRes = await query(
      `SELECT subject_id FROM grade_subjects WHERE grade_id=@gid AND school_id=@sid`,
      { gid: { type: sql.UniqueIdentifier, value: grade_id }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    const currentSubjects = currentRes.recordset.map(r => r.subject_id.toUpperCase());
    const newSubjects = subject_ids.map(id => id.toUpperCase());

    // 2. पता लगाएँ कि कौन से सब्जेक्ट्स हटे हैं और कौन से नए जुड़े हैं
    const removedSubjects = currentSubjects.filter(id => !newSubjects.includes(id));
    const addedSubjects = newSubjects.filter(id => !currentSubjects.includes(id));

    await withTransaction(async (tx) => {
      // 3. जो सब्जेक्ट्स हटाए गए हैं, उनका कैस्केड (Cascade) क्लीनअप करें
      for (const subId of removedSubjects) {
        
        // A. इस क्लास के सभी सेक्शन्स से टीचर असाइनमेंट हटाएँ
        const r1 = tx.request();
        r1.input('sid', sql.UniqueIdentifier, schoolId);
        r1.input('gid', sql.UniqueIdentifier, grade_id);
        r1.input('subid', sql.UniqueIdentifier, subId);
        await r1.query(`
          UPDATE teacher_subjects 
          SET is_active=0, deleted_at=GETUTCDATE()
          WHERE school_id=@sid AND subject_id=@subid 
            AND section_id IN (SELECT id FROM sections WHERE grade_id=@gid AND school_id=@sid)
        `);

        // B. इस क्लास के टाइमटेबल से इस सब्जेक्ट के डिब्बे खाली (Delete) करें
        const r2 = tx.request();
        r2.input('sid', sql.UniqueIdentifier, schoolId);
        r2.input('gid', sql.UniqueIdentifier, grade_id);
        r2.input('subid', sql.UniqueIdentifier, subId);
        await r2.query(`
          DELETE FROM timetable_entries
          WHERE school_id=@sid AND subject_id=@subid 
            AND section_id IN (SELECT id FROM sections WHERE grade_id=@gid AND school_id=@sid)
        `);

        // C. अंत में जंक्शन टेबल से सब्जेक्ट हटाएँ
        const r3 = tx.request();
        r3.input('sid', sql.UniqueIdentifier, schoolId);
        r3.input('gid', sql.UniqueIdentifier, grade_id);
        r3.input('subid', sql.UniqueIdentifier, subId);
        await r3.query(`
          DELETE FROM grade_subjects 
          WHERE school_id=@sid AND grade_id=@gid AND subject_id=@subid
        `);
      }

      // 4. जो नए सब्जेक्ट्स टिक किए गए हैं, उन्हें जोड़ें
      for (const subId of addedSubjects) {
        const r4 = tx.request();
        r4.input('sid', sql.UniqueIdentifier, schoolId);
        r4.input('gid', sql.UniqueIdentifier, grade_id);
        r4.input('subid', sql.UniqueIdentifier, subId);
        await r4.query(`
          INSERT INTO grade_subjects (school_id, grade_id, subject_id) 
          VALUES (@sid, @gid, @subid)
        `);
      }
    });

    return success(res, null, 'Subjects and dependencies synced successfully');
  } catch (err) { next(err); }
};

// 🔥 NEW: Premium Bulk Matrix Setup API
exports.bulkAcademicSetup = async (req, res, next) => {
  const { classes } = req.body; // Array of { name, numeric, stream, sections: [], subjects: [] }
  const { schoolId } = req.user;

  try {
    // 🔴 THE FIX: Get the Current Active Academic Year for this School
    const activeYear = await queryOne(
      `SELECT id FROM academic_years WHERE school_id=@sid AND is_current=1 AND deleted_at IS NULL`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    
    // Fallback if no active year is explicitly set (grab the latest one)
    let academicYearId = activeYear ? activeYear.id : null;
    if (!academicYearId) {
       const latestYear = await queryOne(
         `SELECT TOP 1 id FROM academic_years WHERE school_id=@sid AND deleted_at IS NULL ORDER BY created_at DESC`,
         { sid: { type: sql.UniqueIdentifier, value: schoolId } }
       );
       academicYearId = latestYear ? latestYear.id : null;
    }

    for (const cls of classes) {
      // 1. Create Grade
      const gRes = await query(
        `INSERT INTO grades (id, school_id, name, numeric_order, stream) OUTPUT INSERTED.id VALUES (NEWID(), @sid, @n, @no, @s)`,
        { sid: { type: sql.UniqueIdentifier, value: schoolId }, n: { type: sql.NVarChar(100), value: cls.name }, no: { type: sql.SmallInt, value: cls.numeric }, s: { type: sql.VarChar(50), value: cls.stream || 'none' } }
      );
      const gradeId = gRes.recordset[0].id;

      // 2. Create Sections (Now strictly mapped to Academic Year)
      for (const sec of cls.sections) {
        await query(
          `INSERT INTO sections (id, school_id, grade_id, academic_year_id, name) VALUES (NEWID(), @sid, @gid, @ayid, @n)`,
          { 
            sid: { type: sql.UniqueIdentifier, value: schoolId }, 
            gid: { type: sql.UniqueIdentifier, value: gradeId }, 
            ayid: { type: sql.UniqueIdentifier, value: academicYearId }, // ✅ FIXED
            n: { type: sql.NVarChar(50), value: sec } 
          }
        );
      }

      // 3. Create & Map Subjects
      for (const sub of cls.subjects) {
        // Check if subject exists in school
        let subId;
        const exist = await queryOne(`SELECT id FROM subjects WHERE school_id=@sid AND name=@n`, { sid: { type: sql.UniqueIdentifier, value: schoolId }, n: { type: sql.NVarChar(200), value: sub } });
        
        if (exist) {
          subId = exist.id;
        } else {
          const sRes = await query(
            `INSERT INTO subjects (id, school_id, name) OUTPUT INSERTED.id VALUES (NEWID(), @sid, @n)`,
            { sid: { type: sql.UniqueIdentifier, value: schoolId }, n: { type: sql.NVarChar(200), value: sub } }
          );
          subId = sRes.recordset[0].id;
        }

        // Link Subject to Grade
        await query(
          `INSERT INTO grade_subjects (grade_id, subject_id, school_id) VALUES (@gid, @subid, @sid)`,
          { gid: { type: sql.UniqueIdentifier, value: gradeId }, subid: { type: sql.UniqueIdentifier, value: subId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
        );
      }
    }
    return success(res, null, 'Academic matrix built successfully');
  } catch (err) { next(err); }
};


// ═══════════════ HARD DELETE OPERATIONS (ADMIN / PRINCIPAL ONLY) ═══════════

// DELETE /api/setup/grades/:id/hard
exports.hardDeleteGrade = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { id } = req.params;

    // चेक करें कि क्या इस क्लास के अंदर सेक्शन्स या स्टूडेंट्स मौजूद हैं
    const activeSections = await queryOne(
      `SELECT COUNT(*) AS total FROM sections WHERE grade_id=@gid AND school_id=@sid`,
      { gid: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );

    if (activeSections && activeSections.total > 0) {
      return badRequest(res, 'Cannot delete grade: please delete its sections first');
    }

    await withTransaction(async (tx) => {
      // 1. Grade-Subject mappings साफ़ करें
      const rGS = tx.request();
      rGS.input('gid', sql.UniqueIdentifier, id);
      rGS.input('sid', sql.UniqueIdentifier, schoolId);
      await rGS.query(`DELETE FROM grade_subjects WHERE grade_id=@gid AND school_id=@sid`);

      // 2. Grade को स्थायी रूप से हटाएँ
      const rG = tx.request();
      rG.input('gid', sql.UniqueIdentifier, id);
      rG.input('sid', sql.UniqueIdentifier, schoolId);
      await rG.query(`DELETE FROM grades WHERE id=@gid AND school_id=@sid`);
    });

    return success(res, null, 'Grade permanently deleted');
  } catch (err) { next(err); }
};

// DELETE /api/setup/sections/:id/hard
exports.hardDeleteSection = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { id } = req.params;

    // चेक करें कि क्या इस सेक्शन में स्टूडेंट्स एनरोल हैं
    const studentCount = await queryOne(
      `SELECT COUNT(*) AS total FROM enrolments WHERE section_id=@secid AND school_id=@sid`,
      { secid: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );

    if (studentCount && studentCount.total > 0) {
      return badRequest(res, 'Cannot delete section: active student enrolments exist in this section');
    }

    await withTransaction(async (tx) => {
      // संबंधित टाइमटेबल और असाइनमेंट्स साफ़ करें
      const rTT = tx.request();
      rTT.input('secid', sql.UniqueIdentifier, id);
      rTT.input('sid', sql.UniqueIdentifier, schoolId);
      await rTT.query(`DELETE FROM timetable_entries WHERE section_id=@secid AND school_id=@sid`);

      const rTS = tx.request();
      rTS.input('secid', sql.UniqueIdentifier, id);
      rTS.input('sid', sql.UniqueIdentifier, schoolId);
      await rTS.query(`DELETE FROM teacher_subjects WHERE section_id=@secid AND school_id=@sid`);

      const rSec = tx.request();
      rSec.input('secid', sql.UniqueIdentifier, id);
      rSec.input('sid', sql.UniqueIdentifier, schoolId);
      await rSec.query(`DELETE FROM sections WHERE id=@secid AND school_id=@sid`);
    });

    return success(res, null, 'Section permanently deleted');
  } catch (err) { next(err); }
};

// DELETE /api/setup/subjects/:id/hard
exports.hardDeleteSubject = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { id } = req.params;

    await withTransaction(async (tx) => {
      // 1. क्लास मैपिंग से हटाएँ
      const rGS = tx.request();
      rGS.input('subid', sql.UniqueIdentifier, id);
      rGS.input('sid', sql.UniqueIdentifier, schoolId);
      await rGS.query(`DELETE FROM grade_subjects WHERE subject_id=@subid AND school_id=@sid`);

      // 2. टीचर असाइनमेंट और टाइमटेबल से हटाएँ
      const rTS = tx.request();
      rTS.input('subid', sql.UniqueIdentifier, id);
      rTS.input('sid', sql.UniqueIdentifier, schoolId);
      await rTS.query(`DELETE FROM teacher_subjects WHERE subject_id=@subid AND school_id=@sid`);

      const rTT = tx.request();
      rTT.input('subid', sql.UniqueIdentifier, id);
      rTT.input('sid', sql.UniqueIdentifier, schoolId);
      await rTT.query(`DELETE FROM timetable_entries WHERE subject_id=@subid AND school_id=@sid`);

      // 3. मास्टर सब्जेक्ट टेबल से स्थायी रूप से हटाएँ
      const rSub = tx.request();
      rSub.input('subid', sql.UniqueIdentifier, id);
      rSub.input('sid', sql.UniqueIdentifier, schoolId);
      await rSub.query(`DELETE FROM subjects WHERE id=@subid AND school_id=@sid`);
    });

    return success(res, null, 'Subject permanently deleted');
  } catch (err) { next(err); }
};

// DELETE /api/setup/grade-subjects?grade_id=xxx&subject_id=xxx
exports.removeGradeSubject = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { grade_id, subject_id } = req.query;

    if (!grade_id || !subject_id) {
      return badRequest(res, 'Both grade_id and subject_id are required');
    }

    await query(
      `DELETE FROM grade_subjects 
       WHERE school_id=@sid AND grade_id=@gid AND subject_id=@subid`,
      {
        sid: { type: sql.UniqueIdentifier, value: schoolId },
        gid: { type: sql.UniqueIdentifier, value: grade_id },
        subid: { type: sql.UniqueIdentifier, value: subject_id }
      }
    );

    return success(res, null, 'Subject unlinked from class successfully');
  } catch (err) { next(err); }
};

// ═══════════════ SCHOOL ASSET UPLOAD (logo / watermark) ═══════════════════
exports.uploadSchoolAsset = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { type } = req.body; // 'logo' | 'watermark'
    if (!['logo', 'watermark'].includes(type)) return badRequest(res, 'type must be "logo" or "watermark"');
    if (!req.file) return badRequest(res, 'No file uploaded');

    const school = await queryOne(`SELECT name FROM schools WHERE id=@sid`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId } });

    const { uploadImageBuffer } = require('../services/uploadService');
    const result = await uploadImageBuffer(req.file.buffer, {
      schoolName: school.name,
      subfolder: type, // 'logo' or 'watermark'
      fileName: type,
    });

    const column = type === 'logo' ? 'logo_url' : 'watermark_url';
    await query(
      `UPDATE schools SET ${column}=@url, updated_at=GETUTCDATE() WHERE id=@sid`,
      { url: { type: sql.NVarChar(sql.MAX), value: result.secure_url }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );

    return success(res, { url: result.secure_url }, `${type} uploaded successfully`);
  } catch (err) { next(err); }
};

