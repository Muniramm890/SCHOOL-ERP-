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
async function buildReportCardPdf({ school, student, guardian, examName, overall, subjects, gradingScale }) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 30 });
      const buffers = [];
      doc.on('data', (b) => buffers.push(b));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      const pageWidth = 535; // 595 - 30*2
      const brandColor = school.brand_color || '#E8600A';

      // ── OUTER BORDER (double-line "board" style) ──
      doc.rect(20, 20, 555, 802).lineWidth(3).stroke('#000');
      doc.rect(25, 25, 545, 792).lineWidth(1).stroke('#000');

      // ── WATERMARK ──
      const wmBuf = await fetchImageBuffer(school.watermark_url || school.logo_url);
      if (wmBuf) {
        try {
          doc.save();
          doc.globalAlpha(0.06);
          doc.image(wmBuf, 147, 300, { fit: [300, 300] });
          doc.restore();
        } catch (e) {}
      }

      // ── HEADER ──
      let y = 40;
      const logoBuf = await fetchImageBuffer(school.logo_url);
      const photoBuf = await fetchImageBuffer(student.photo_url);

      if (logoBuf) { try { doc.image(logoBuf, 40, y, { fit: [65, 65] }); } catch {} }
      if (photoBuf) {
        try {
          doc.image(photoBuf, 490, y, { fit: [65, 65] });
          doc.rect(490, y, 65, 65).stroke('#000');
        } catch {}
      } else {
        doc.rect(490, y, 65, 65).stroke('#000');
        doc.fontSize(24).fillColor('#999').text((student.student_name?.[0] || '?').toUpperCase(), 490, y + 20, { width: 65, align: 'center' });
      }

      const schoolName = (school.name || 'SCHOOL NAME').toUpperCase();
      let nameFontSize = 22;
      doc.font('Helvetica-Bold');
      while (doc.fontSize(nameFontSize).widthOfString(schoolName) > 380 && nameFontSize > 10) nameFontSize -= 1;
      doc.fillColor(brandColor).fontSize(nameFontSize).text(schoolName, 115, y + 4, { width: 365, align: 'center', lineBreak: false });

      let cy = doc.y + 4;
      doc.fillColor('#333').fontSize(9).font('Helvetica-Bold')
        .text(school.tagline || 'Education For Excellence', 115, cy, { width: 365, align: 'center' });
      cy = doc.y + 3;

      const address = [school.address_line1, school.city, school.state, school.pincode].filter(Boolean).join(', ');
      if (address) {
        doc.fillColor('#555').fontSize(8).font('Helvetica').text(address, 115, cy, { width: 365, align: 'center' });
        cy = doc.y + 2;
      }
      const contact = [school.website, school.email, school.phone].filter(Boolean).join('   |   ');
      if (contact) {
        doc.fillColor('#555').fontSize(8).text(contact, 115, cy, { width: 365, align: 'center' });
        cy = doc.y + 2;
      }
      if (school.affiliation_board || school.affiliation_no) {
        doc.fillColor('#777').fontSize(7).font('Helvetica-Bold')
          .text([school.affiliation_board, school.affiliation_no].filter(Boolean).join(' · '), 115, cy, { width: 365, align: 'center' });
      }

      y = Math.max(y + 75, doc.y + 10);
      doc.moveTo(40, y).lineTo(555, y).lineWidth(2).strokeColor('#000').stroke();

      // ── TITLE ──
      y += 12;
      doc.rect(40, y, 515, 26).fillAndStroke('#f1f5f9', '#000');
      doc.fillColor('#111').fontSize(14).font('Helvetica-Bold')
        .text(`REPORT CARD${examName ? ' — ' + examName.toUpperCase() : ''}`, 40, y + 7, { width: 515, align: 'center' });
      y += 40;

      // ── STUDENT DETAILS GRID ──
      const boxH = 95;
      doc.rect(40, y, 515, boxH).lineWidth(1).stroke('#000');
      doc.fontSize(9).fillColor('#222');

      const rowsLeft = [
        ['Name:', student.student_name],
        ['Roll No:', student.roll_no || '-'],
        ['Admission No:', student.admission_no || '-'],
        ['Date of Birth:', student.date_of_birth ? new Date(student.date_of_birth).toLocaleDateString('en-IN') : '-'],
      ];
      const rowsRight = [
        ['Class:', `${student.class_name || '-'} ${student.section_name || ''}`],
        ['Gender:', student.gender || '-'],
        ['Class Rank:', `#${overall.class_rank ?? '-'}`],
        ['School Rank:', `#${overall.school_rank ?? '-'}`],
      ];
      rowsLeft.forEach((r, i) => {
        doc.font('Helvetica').text(r[0], 50, y + 8 + i * 20, { continued: true }).font('Helvetica-Bold').text(' ' + r[1]);
      });
      rowsRight.forEach((r, i) => {
        doc.font('Helvetica').text(r[0], 300, y + 8 + i * 20, { continued: true }).font('Helvetica-Bold').text(' ' + r[1]);
      });
      if (guardian) {
        doc.font('Helvetica').text('Guardian:', 50, y + 8 + 80 > y + boxH - 12 ? y + boxH - 12 : y + 8 + 80, { continued: true })
          .font('Helvetica-Bold').text(` ${guardian.full_name} (${guardian.relation}) — ${guardian.phone}`);
      }
      y += boxH + 15;

      // ── SUBJECTS TABLE (Scholastic) ──
      const scholastic = subjects.filter((s) => !s.is_grade_only);
      const coScholastic = subjects.filter((s) => s.is_grade_only);

      const drawTableHeader = (headers, widths, yy) => {
        doc.rect(40, yy, 515, 22).fill(brandColor);
        doc.fillColor('#fff').fontSize(9).font('Helvetica-Bold');
        let x = 45;
        headers.forEach((h, i) => { doc.text(h, x, yy + 6, { width: widths[i] }); x += widths[i]; });
        return yy + 22;
      };

      if (scholastic.length) {
        doc.fontSize(10).fillColor('#111').font('Helvetica-Bold').text('ACADEMIC SUBJECTS', 40, y);
        y += 16;
        y = drawTableHeader(['Subject', 'Marks Obtained', 'Max Marks', 'Result'], [220, 110, 90, 90], y);
        doc.font('Helvetica').fontSize(9);
        scholastic.forEach((s, i) => {
          const rowH = 22;
          if (i % 2 === 1) doc.rect(40, y, 515, rowH).fill('#f8fafc');
          const isFail = s.status !== 'absent' && Number(s.marks_obtained) < Number(s.passing_marks);
          doc.fillColor('#222').text(s.subject_name, 45, y + 6, { width: 220 });
          doc.font('Helvetica-Bold').text(s.status === 'absent' ? 'AB' : (s.marks_obtained ?? '-'), 265, y + 6, { width: 110 });
          doc.font('Helvetica').text(String(s.max_marks), 375, y + 6, { width: 90 });
          doc.fillColor(s.status === 'absent' || isFail ? '#dc2626' : '#16a34a').font('Helvetica-Bold')
            .text(s.status === 'absent' ? 'Absent' : isFail ? 'Fail' : 'Pass', 465, y + 6, { width: 90 });
          doc.fillColor('#222').font('Helvetica');
          y += rowH;
        });
        y += 12;
      }

      if (coScholastic.length) {
        doc.fontSize(10).fillColor('#111').font('Helvetica-Bold').text('CO-SCHOLASTIC / GRADED AREAS', 40, y);
        y += 16;
        y = drawTableHeader(['Area', 'Grade Obtained'], [350, 160], y);
        doc.font('Helvetica').fontSize(9);
        coScholastic.forEach((s, i) => {
          const rowH = 22;
          if (i % 2 === 1) doc.rect(40, y, 515, rowH).fill('#f8fafc');
          doc.fillColor('#222').text(s.subject_name, 45, y + 6, { width: 350 });
          doc.font('Helvetica-Bold').fillColor(gradeColor(s.grade_obtained))
            .text(s.status === 'absent' ? 'AB' : (s.grade_obtained || '-'), 395, y + 6, { width: 160 });
          doc.fillColor('#222').font('Helvetica');
          y += rowH;
        });
        y += 12;
      }

      // ── RESULT SUMMARY ──
      doc.rect(40, y, 515, 55).lineWidth(2).stroke('#000');
      const colW = 515 / 3;
      const summary = [
        ['OVERALL GRADE', overall.grade || '-', gradeColor(overall.grade)],
        ['PERCENTAGE', `${overall.percentage}%`, '#111'],
        ['RESULT', (overall.status || '-').toUpperCase(), overall.status === 'pass' ? '#16a34a' : '#dc2626'],
      ];
      summary.forEach((s, i) => {
        doc.fontSize(8).fillColor('#666').font('Helvetica-Bold').text(s[0], 40 + i * colW, y + 10, { width: colW, align: 'center' });
        doc.fontSize(18).fillColor(s[2]).text(s[1], 40 + i * colW, y + 24, { width: colW, align: 'center' });
      });
      y += 70;

      // ── GRADING SCALE LEGEND ──
      if (gradingScale.length && y < 740) {
        const legend = gradingScale.map((g) => `${g.grade_label}: ${g.min_percent}-${g.max_percent}%`).join('   |   ');
        doc.fontSize(6.5).fillColor('#888').font('Helvetica')
          .text(`Grading Scale:  ${legend}`, 40, y, { width: 515, align: 'center' });
        y += 20;
      }

      // ── SIGNATURES ──
      const sigY = 780;
      const sigLabels = ['Class Teacher', 'Examination In-Charge', 'Principal'];
      const sigW = 515 / 3;
      sigLabels.forEach((label, i) => {
        const x = 40 + i * sigW + 20;
        doc.moveTo(x, sigY).lineTo(x + sigW - 40, sigY).strokeColor('#000').lineWidth(1).stroke();
        doc.fontSize(9).fillColor('#333').font('Helvetica-Bold')
          .text(label, x, sigY + 4, { width: sigW - 40, align: 'center' });
      });

      doc.end();
    } catch (e) { reject(e); }
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
