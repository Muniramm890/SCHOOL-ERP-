// src/services/resultCardService.js
const PDFDocument = require('pdfkit');
const cloudinary = require('cloudinary').v2;
const sql = require('mssql');
const { query, queryOne } = require('../config/db');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// This code written by muniram meena 

async function fetchImageBuffer(url) {
  try {
    if (!url) return null;
    const res = await fetch(url);
    if (!res.ok) return null;
    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
  } catch { return null; }
}

function uploadPdfBuffer(buffer, folderPath, publicId) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: 'raw', folder: folderPath, public_id: `${publicId}.pdf`, overwrite: true },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

const gradeColor = (g) => {
  if (['A+', 'A'].includes(g)) return '#16a34a';
  if (['B+', 'B'].includes(g)) return '#2563eb';
  if (g === 'C') return '#ca8a04';
  return '#dc2626';
};

// ── MAIN PDF BUILDER ──
async function buildReportCardPdf(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 30 });
    const buffers = [];
    doc.on('data', (b) => buffers.push(b));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);
    drawReportCardPage(doc, data).then(() => doc.end()).catch(reject);
  });
}


// ── DRAWS ONE REPORT CARD PAGE ONTO AN EXISTING DOC (reused for bulk) ──
async function drawReportCardPage(doc, { school, student, guardian, examName, overall, subjects, gradingScale }) {
  const brandColor = school.brand_color || '#E8600A';
  const PAGE_W = 555; // 595 - margin*2 (approx usable)
  const LEFT = 30;

  // ── Outer rounded border ──
  doc.roundedRect(20, 20, 555, 802, 10).lineWidth(1.5).stroke('#1e293b');

  // ── Watermark (only if uploaded) ──
  const wmBuf = await fetchImageBuffer(school.watermark_url || school.logo_url);
  if (wmBuf) {
    try { doc.save(); doc.globalAlpha(0.05); doc.image(wmBuf, 147, 320, { fit: [300, 300] }); doc.restore(); } catch (e) {}
  }

  let y = 34;

  // ── HEADER: Logo (left) — School Name/Details (center) — Photo (right) ──
  const logoBuf = await fetchImageBuffer(school.logo_url);
  const photoBuf = await fetchImageBuffer(student.photo_url);
  const headerTop = y;
  const LOGO_SIZE = 58;

  if (logoBuf) {
    try { doc.image(logoBuf, LEFT + 4, headerTop, { fit: [LOGO_SIZE, LOGO_SIZE] }); } catch {}
  } else {
    doc.roundedRect(LEFT + 4, headerTop, LOGO_SIZE, LOGO_SIZE, 8).stroke('#cbd5e1');
  }

  if (photoBuf) {
    try {
      doc.image(photoBuf, 555 - LOGO_SIZE, headerTop, { fit: [LOGO_SIZE, LOGO_SIZE] });
      doc.roundedRect(555 - LOGO_SIZE, headerTop, LOGO_SIZE, LOGO_SIZE, 8).stroke(brandColor);
    } catch {}
  } else {
    doc.roundedRect(555 - LOGO_SIZE, headerTop, LOGO_SIZE, LOGO_SIZE, 8).stroke(brandColor);
    doc.fontSize(18).fillColor('#94a3b8').font('Helvetica-Bold')
      .text((student.student_name?.[0] || '?').toUpperCase(), 555 - LOGO_SIZE, headerTop + 18, { width: LOGO_SIZE, align: 'center' });
  }

  // ── Dynamic single-line school name (auto-shrink to fit center width) ──
  const centerX = LEFT + LOGO_SIZE + 14;
  const centerW = 555 - LOGO_SIZE * 2 - 28;
  const schoolName = (school.name || 'SCHOOL NAME').toUpperCase();
  let nameFontSize = 17;
  doc.font('Helvetica-Bold');
  while (doc.fontSize(nameFontSize).widthOfString(schoolName) > centerW && nameFontSize > 7) nameFontSize -= 0.5;
  doc.fillColor(brandColor).fontSize(nameFontSize)
    .text(schoolName, centerX, headerTop, { width: centerW, align: 'center', lineBreak: false });

  let cy = doc.y + 2;
  doc.fillColor('#334155').fontSize(7.5).font('Helvetica-Bold')
    .text(school.tagline || 'Education For Excellence', centerX, cy, { width: centerW, align: 'center' });
  cy = doc.y + 1;

  const address = [school.address_line1, school.city, school.state, school.pincode].filter(Boolean).join(', ');
  if (address) {
    doc.fillColor('#64748b').fontSize(6.5).font('Helvetica').text(address, centerX, cy, { width: centerW, align: 'center' });
    cy = doc.y + 1;
  }
  const contact = [school.website, school.email, school.phone].filter(Boolean).join('  |  ');
  if (contact) {
    doc.fillColor('#64748b').fontSize(6.5).text(contact, centerX, cy, { width: centerW, align: 'center' });
    cy = doc.y + 1;
  }
  if (school.affiliation_board || school.affiliation_no) {
    doc.fillColor('#94a3b8').fontSize(6).font('Helvetica-Bold')
      .text([school.affiliation_board, school.affiliation_no].filter(Boolean).join(' · '), centerX, cy, { width: centerW, align: 'center' });
  }

  y = headerTop + LOGO_SIZE + 10;
  doc.moveTo(LEFT, y).lineTo(LEFT + PAGE_W, y).lineWidth(1.5).strokeColor(brandColor).stroke();
  y += 8;

  // ── TITLE BAR ──
  doc.roundedRect(LEFT, y, PAGE_W, 20, 5).fill('#0f172a');
  doc.fillColor('#fff').fontSize(11).font('Helvetica-Bold')
    .text(`REPORT CARD${examName ? '  •  ' + examName.toUpperCase() : ''}`, LEFT, y + 5.5, { width: PAGE_W, align: 'center' });
  y += 30;

  // ── STUDENT DETAILS (compact 2-col grid, rounded card) ──
  const boxH = 68;
  doc.roundedRect(LEFT, y, PAGE_W, boxH, 6).fillAndStroke('#f8fafc', '#e2e8f0');
  doc.fontSize(8).fillColor('#1e293b');

  const rowsLeft = [
    ['Name', student.student_name],
    ['Roll No', student.roll_no || '-'],
    ['Admission No', student.admission_no || '-'],
  ];
  const rowsRight = [
    ['Class', `${student.class_name || '-'} ${student.section_name || ''}`],
    ['Class Rank', `#${overall.class_rank ?? '-'}`],
    ['School Rank', `#${overall.school_rank ?? '-'}`],
  ];
  rowsLeft.forEach((r, i) => {
    doc.font('Helvetica').fontSize(7.5).fillColor('#64748b').text(r[0].toUpperCase(), LEFT + 12, y + 8 + i * 18, { continued: false, width: 100 });
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#0f172a').text(r[1], LEFT + 12, y + 8 + i * 18 + 8, { width: 240 });
  });
  rowsRight.forEach((r, i) => {
    doc.font('Helvetica').fontSize(7.5).fillColor('#64748b').text(r[0].toUpperCase(), LEFT + 290, y + 8 + i * 18, { width: 100 });
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#0f172a').text(r[1], LEFT + 290, y + 8 + i * 18 + 8, { width: 240 });
  });
  y += boxH + 10;

  if (guardian) {
    doc.roundedRect(LEFT, y, PAGE_W, 20, 5).fillAndStroke('#eff6ff', '#dbeafe');
    doc.font('Helvetica').fontSize(8).fillColor('#1e40af')
      .text(`Guardian:  ${guardian.full_name} (${guardian.relation})  —  ${guardian.phone}`, LEFT + 12, y + 6, { width: PAGE_W - 24 });
    y += 28;
  }

  // ── SUBJECTS TABLES ──
  const scholastic = subjects.filter((s) => !s.is_grade_only);
  const coScholastic = subjects.filter((s) => s.is_grade_only);

  const drawTableHeader = (headers, widths, yy) => {
    doc.roundedRect(LEFT, yy, PAGE_W, 18, 4).fill(brandColor);
    doc.fillColor('#fff').fontSize(7.5).font('Helvetica-Bold');
    let x = LEFT + 8;
    headers.forEach((h, i) => { doc.text(h, x, yy + 5, { width: widths[i] }); x += widths[i]; });
    return yy + 18;
  };

  if (scholastic.length) {
    doc.fontSize(8.5).fillColor('#0f172a').font('Helvetica-Bold').text('ACADEMIC SUBJECTS', LEFT, y);
    y += 12;
    y = drawTableHeader(['Subject', 'Marks', 'Max', 'Result'], [230, 110, 90, 90], y);
    doc.font('Helvetica').fontSize(8);
    scholastic.forEach((s, i) => {
      const rowH = 17;
      if (i % 2 === 1) doc.rect(LEFT, y, PAGE_W, rowH).fill('#f8fafc');
      const isFail = s.status !== 'absent' && Number(s.marks_obtained) < Number(s.passing_marks);
      doc.fillColor('#1e293b').text(s.subject_name, LEFT + 8, y + 4, { width: 230 });
      doc.font('Helvetica-Bold').text(s.status === 'absent' ? 'AB' : (s.marks_obtained ?? '-'), LEFT + 238, y + 4, { width: 110 });
      doc.font('Helvetica').text(String(s.max_marks), LEFT + 348, y + 4, { width: 90 });
      doc.fillColor(s.status === 'absent' || isFail ? '#dc2626' : '#16a34a').font('Helvetica-Bold')
        .text(s.status === 'absent' ? 'Absent' : isFail ? 'Fail' : 'Pass', LEFT + 438, y + 4, { width: 90 });
      doc.fillColor('#1e293b').font('Helvetica');
      y += rowH;
    });
    y += 10;
  }

  if (coScholastic.length) {
    doc.fontSize(8.5).fillColor('#0f172a').font('Helvetica-Bold').text('CO-SCHOLASTIC / GRADED AREAS', LEFT, y);
    y += 12;
    y = drawTableHeader(['Area', 'Grade'], [370, 150], y);
    doc.font('Helvetica').fontSize(8);
    coScholastic.forEach((s, i) => {
      const rowH = 17;
      if (i % 2 === 1) doc.rect(LEFT, y, PAGE_W, rowH).fill('#f8fafc');
      doc.fillColor('#1e293b').text(s.subject_name, LEFT + 8, y + 4, { width: 370 });
      doc.font('Helvetica-Bold').fillColor(gradeColor(s.grade_obtained))
        .text(s.status === 'absent' ? 'AB' : (s.grade_obtained || '-'), LEFT + 378, y + 4, { width: 150 });
      doc.fillColor('#1e293b').font('Helvetica');
      y += rowH;
    });
    y += 10;
  }

  // ── RESULT SUMMARY (compact 3-box card) ──
  doc.roundedRect(LEFT, y, PAGE_W, 46, 6).fillAndStroke('#0f172a', '#0f172a');
  const colW = PAGE_W / 3;
  const summary = [
    ['GRADE', overall.grade || '-', gradeColor(overall.grade)],
    ['PERCENTAGE', `${overall.percentage}%`, '#38bdf8'],
    ['RESULT', (overall.status || '-').toUpperCase(), overall.status === 'pass' ? '#4ade80' : '#f87171'],
  ];
  summary.forEach((s, i) => {
    doc.fontSize(6.5).fillColor('#94a3b8').font('Helvetica-Bold').text(s[0], LEFT + i * colW, y + 8, { width: colW, align: 'center' });
    doc.fontSize(15).fillColor(s[2]).text(s[1], LEFT + i * colW, y + 20, { width: colW, align: 'center' });
  });
  y += 56;

  // ── GRADING SCALE LEGEND ──
  if (gradingScale.length && y < 745) {
    const legend = gradingScale.map((g) => `${g.grade_label}: ${g.min_percent}-${g.max_percent}%`).join('   |   ');
    doc.fontSize(6).fillColor('#94a3b8').font('Helvetica').text(`Grading Scale:  ${legend}`, LEFT, y, { width: PAGE_W, align: 'center' });
    y += 16;
  }

  // ── SIGNATURES (fixed near bottom of page) ──
  const sigY = 790;
  const sigLabels = ['Class Teacher', 'Examination In-Charge', 'Principal'];
  const sigW = PAGE_W / 3;
  sigLabels.forEach((label, i) => {
    const x = LEFT + i * sigW + 25;
    doc.moveTo(x, sigY).lineTo(x + sigW - 50, sigY).strokeColor('#334155').lineWidth(0.75).stroke();
    doc.fontSize(7.5).fillColor('#475569').font('Helvetica-Bold')
      .text(label, x, sigY + 3, { width: sigW - 50, align: 'center' });
  });
}

// ═══════════════════════════════════════════════════════════════
// MAIN EXPORT — call this from the controller
// ═══════════════════════════════════════════════════════════════
exports.generateStudentReportCardPdf = async (schoolId, studentId, examGroupId) => {
  const school = await queryOne(
    `SELECT name, logo_url, watermark_url, brand_color, tagline, address_line1, city, state, pincode,
            phone, email, website, affiliation_board, affiliation_no
     FROM schools WHERE id=@sid`,
    { sid: { type: sql.UniqueIdentifier, value: schoolId } }
  );
  if (!school) throw new Error('School not found');

  const examGroup = await queryOne(
    `SELECT name FROM exam_groups WHERE id=@id AND school_id=@sid`,
    { id: { type: sql.UniqueIdentifier, value: examGroupId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
  );

  const overall = await queryOne(
    `SELECT total_marks, max_total, percentage, grade, class_rank, school_rank, status
     FROM exam_results WHERE exam_group_id=@egId AND student_id=@stuId AND school_id=@sid`,
    { egId: { type: sql.UniqueIdentifier, value: examGroupId }, stuId: { type: sql.UniqueIdentifier, value: studentId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
  );
  if (!overall) throw new Error('Result not computed for this student yet');

  const studentRow = await queryOne(
    `SELECT s.first_name + ' ' + ISNULL(s.last_name,'') AS student_name, s.admission_no, s.photo_url,
            s.date_of_birth, s.gender, g.name AS class_name, sec.name AS section_name, e.roll_no
     FROM students s
     LEFT JOIN enrolments e ON e.student_id = s.id AND e.school_id=@sid AND e.is_active=1
     LEFT JOIN sections sec ON sec.id = e.section_id
     LEFT JOIN grades g ON g.id = sec.grade_id
     WHERE s.id=@uid AND s.school_id=@sid`,
    { uid: { type: sql.UniqueIdentifier, value: studentId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
  );

  const guardian = await queryOne(
    `SELECT TOP 1 relation, full_name, phone FROM student_guardians
     WHERE student_id=@uid AND is_primary=1 AND deleted_at IS NULL`,
    { uid: { type: sql.UniqueIdentifier, value: studentId } }
  );

  const subjectsRes = await query(
    `SELECT sub.name AS subject_name, em.marks_obtained, em.grade_obtained, em.status,
            es.max_marks, es.passing_marks, es.is_grade_only
     FROM exam_marks em
     JOIN exam_subjects es ON es.id = em.exam_subject_id
     JOIN subjects sub ON sub.id = es.subject_id
     WHERE es.exam_group_id=@egId AND em.student_id=@stuId AND em.school_id=@sid
     ORDER BY sub.name`,
    { egId: { type: sql.UniqueIdentifier, value: examGroupId }, stuId: { type: sql.UniqueIdentifier, value: studentId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
  );

  const scaleRes = await query(
    `SELECT grade_label, min_percent, max_percent FROM grading_scale WHERE school_id=@sid ORDER BY sort_order`,
    { sid: { type: sql.UniqueIdentifier, value: schoolId } }
  );

  const pdfBuffer = await buildReportCardPdf({
    school,
    student: studentRow,
    guardian,
    examName: examGroup?.name,
    overall,
    subjects: subjectsRes.recordset,
    gradingScale: scaleRes.recordset,
  });

  const safeSchoolName = (school.name || 'Unknown_School').replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').toLowerCase();
  const folderPath = `${safeSchoolName}/report_cards`;
  const fileName = `report_${studentId}_${examGroupId}`;

  const uploadResult = await uploadPdfBuffer(pdfBuffer, folderPath, fileName);
  return uploadResult.secure_url;
};

// ═══════════════════════════════════════════════════════════════
// BULK: generate ONE PDF with all students' report cards (section-wise)
// ═══════════════════════════════════════════════════════════════
exports.generateBulkReportCardsPdf = async (schoolId, sectionId, examGroupId) => {
  const school = await queryOne(
    `SELECT name, logo_url, watermark_url, brand_color, tagline, address_line1, city, state, pincode,
            phone, email, website, affiliation_board, affiliation_no
     FROM schools WHERE id=@sid`,
    { sid: { type: sql.UniqueIdentifier, value: schoolId } }
  );
  const examGroup = await queryOne(
    `SELECT name FROM exam_groups WHERE id=@id AND school_id=@sid`,
    { id: { type: sql.UniqueIdentifier, value: examGroupId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
  );
  const scaleRes = await query(
    `SELECT grade_label, min_percent, max_percent FROM grading_scale WHERE school_id=@sid ORDER BY sort_order`,
    { sid: { type: sql.UniqueIdentifier, value: schoolId } }
  );

  // Sab students jinka result compute ho chuka hai us section mein
  const resultsRes = await query(
    `SELECT er.student_id, er.total_marks, er.max_total, er.percentage, er.grade, er.class_rank, er.school_rank, er.status
     FROM exam_results er
     WHERE er.exam_group_id=@egId AND er.section_id=@secId AND er.school_id=@sid
     ORDER BY ISNULL(er.class_rank, 999999) ASC`,
    { egId: { type: sql.UniqueIdentifier, value: examGroupId }, secId: { type: sql.UniqueIdentifier, value: sectionId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
  );
  const students = resultsRes.recordset;
  if (!students.length) throw new Error('No computed results found for this section');

  const doc = new PDFDocument({ size: 'A4', margin: 30 });
  const buffers = [];
  doc.on('data', (b) => buffers.push(b));

  const finished = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);
  });

  for (let i = 0; i < students.length; i++) {
    const overall = students[i];

    const studentRow = await queryOne(
      `SELECT s.first_name + ' ' + ISNULL(s.last_name,'') AS student_name, s.admission_no, s.photo_url,
              s.date_of_birth, s.gender, g.name AS class_name, sec.name AS section_name, e.roll_no
       FROM students s
       LEFT JOIN enrolments e ON e.student_id = s.id AND e.school_id=@sid AND e.is_active=1
       LEFT JOIN sections sec ON sec.id = e.section_id
       LEFT JOIN grades g ON g.id = sec.grade_id
       WHERE s.id=@uid AND s.school_id=@sid`,
      { uid: { type: sql.UniqueIdentifier, value: overall.student_id }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );

    const guardian = await queryOne(
      `SELECT TOP 1 relation, full_name, phone FROM student_guardians
       WHERE student_id=@uid AND is_primary=1 AND deleted_at IS NULL`,
      { uid: { type: sql.UniqueIdentifier, value: overall.student_id } }
    );

    const subjectsRes = await query(
      `SELECT sub.name AS subject_name, em.marks_obtained, em.grade_obtained, em.status,
              es.max_marks, es.passing_marks, es.is_grade_only
       FROM exam_marks em
       JOIN exam_subjects es ON es.id = em.exam_subject_id
       JOIN subjects sub ON sub.id = es.subject_id
       WHERE es.exam_group_id=@egId AND em.student_id=@stuId AND em.school_id=@sid
       ORDER BY sub.name`,
      { egId: { type: sql.UniqueIdentifier, value: examGroupId }, stuId: { type: sql.UniqueIdentifier, value: overall.student_id }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );

    if (i > 0) doc.addPage();
    await drawReportCardPage(doc, {
      school,
      student: studentRow,
      guardian,
      examName: examGroup?.name,
      overall,
      subjects: subjectsRes.recordset,
      gradingScale: scaleRes.recordset,
    });
  }

  doc.end();
  const pdfBuffer = await finished;

  const safeSchoolName = (school.name || 'Unknown_School').replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').toLowerCase();
  const folderPath = `${safeSchoolName}/report_cards/bulk`;
  const fileName = `bulk_${sectionId}_${examGroupId}_${Date.now()}`;

  const uploadResult = await uploadPdfBuffer(pdfBuffer, folderPath, fileName);
  return { url: uploadResult.secure_url, count: students.length };
};
