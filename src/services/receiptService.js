//src/services/receiptService.js
const PDFDocument = require('pdfkit');
const cloudinary = require('cloudinary').v2;
const { queryOne, query, sql } = require('../config/db');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const money = (paise) => `Rs. ${((paise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

async function fetchImageBuffer(url) {
  try {
    if (!url) return null;
    const res = await fetch(url);
    if (!res.ok) return null;
    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
  } catch { return null; }
}

async function buildReceiptPdf({ school, payment, student, items }) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const buffers = [];
      doc.on('data', (b) => buffers.push(b));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      const brandColor = school.brand_color || '#E8600A';

      // ── HEADER ──
      const logoBuf = await fetchImageBuffer(school.logo_url);
      let headerY = 40;
      if (logoBuf) {
        try { doc.image(logoBuf, 40, headerY, { width: 55, height: 55 }); } catch {}
      }
      doc.fillColor(brandColor).fontSize(20).font('Helvetica-Bold')
        .text(school.name || 'School', logoBuf ? 105 : 40, headerY, { width: 400 });
      doc.fillColor('#555').fontSize(9).font('Helvetica')
        .text(
          [school.address_line1, school.city, school.state, school.pincode].filter(Boolean).join(', '),
          logoBuf ? 105 : 40, headerY + 24, { width: 400 }
        );
      doc.text(
        [school.phone, school.email].filter(Boolean).join('  |  '),
        logoBuf ? 105 : 40, headerY + 38, { width: 400 }
      );

      doc.moveTo(40, 105).lineTo(555, 105).strokeColor(brandColor).lineWidth(1.5).stroke();

      // ── TITLE ──
      doc.fillColor('#111').fontSize(16).font('Helvetica-Bold')
        .text('FEE RECEIPT', 40, 118, { align: 'center', width: 515 });

      // ── META ──
      let y = 150;
      doc.fontSize(10).font('Helvetica');
      doc.fillColor('#333').text(`Receipt No: `, 40, y, { continued: true }).font('Helvetica-Bold').text(payment.receipt_no);
      doc.font('Helvetica').text(`Date: `, 350, y, { continued: true }).font('Helvetica-Bold')
        .text(new Date(payment.payment_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }));

      y += 22;
      doc.font('Helvetica').fillColor('#333').text(`Student Name: `, 40, y, { continued: true }).font('Helvetica-Bold').text(student.student_name);
      y += 16;
      doc.font('Helvetica').text(`Class / Section: `, 40, y, { continued: true }).font('Helvetica-Bold')
        .text(`${student.class_name || '-'} ${student.section_name || ''}`);
      doc.font('Helvetica').text(`Admission No: `, 350, y, { continued: true }).font('Helvetica-Bold').text(student.admission_no || '-');
      y += 16;
      doc.font('Helvetica').text(`Payment Method: `, 40, y, { continued: true }).font('Helvetica-Bold').text(payment.payment_method);
      if (payment.transaction_ref) {
        doc.font('Helvetica').text(`Ref: `, 350, y, { continued: true }).font('Helvetica-Bold').text(payment.transaction_ref);
      }

      // ── TABLE ──
      y += 34;
      doc.rect(40, y, 515, 24).fill(brandColor);
      doc.fillColor('#fff').fontSize(10).font('Helvetica-Bold');
      doc.text('Fee Head', 50, y + 7);
      doc.text('Amount', 480, y + 7, { width: 65, align: 'right' });
      y += 24;

      const rows = items.length > 0 ? items : [{ category_name: 'Fee Payment', amount_paise: payment.amount_paise }];
      doc.fillColor('#222').font('Helvetica').fontSize(10);
      rows.forEach((it, i) => {
        const rowH = 22;
        if (i % 2 === 1) { doc.rect(40, y, 515, rowH).fill('#f7f7f7'); doc.fillColor('#222'); }
        doc.text(it.category_name, 50, y + 6);
        doc.text(money(it.amount_paise), 480, y + 6, { width: 65, align: 'right' });
        y += rowH;
      });

      doc.moveTo(40, y).lineTo(555, y).strokeColor('#ccc').stroke();
      y += 8;
      doc.font('Helvetica-Bold').fontSize(12).fillColor(brandColor)
        .text('Total Paid:', 350, y, { continued: true }).text('  ' + money(payment.amount_paise), { align: 'right' });

      // ── FOOTER ──
      const footerY = 740;
      doc.moveTo(40, footerY).lineTo(555, footerY).strokeColor('#ddd').stroke();
      doc.fontSize(8).fillColor('#888').font('Helvetica')
        .text(`Collected by: ${payment.collected_by_name || 'System'}`, 40, footerY + 8);
      doc.text('This is a computer generated receipt and does not require a signature.', 40, footerY + 20, { align: 'center', width: 515 });
      doc.fillColor(brandColor).font('Helvetica-Bold').text(school.name || '', 40, footerY + 34, { align: 'center', width: 515 });

      doc.end();
    } catch (e) { reject(e); }
  });
}

function uploadPdfBuffer(buffer, publicId) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: 'raw', folder: 'fee_receipts', public_id: publicId, format: 'pdf', overwrite: true },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

// ── MAIN: get existing receipt_url, or generate + upload + save ──
exports.getOrGenerateReceipt = async (schoolId, paymentId) => {
  const payment = await queryOne(
    `SELECT fp.*, u.full_name AS collected_by_name
     FROM fee_payments fp
     LEFT JOIN users u ON u.id = fp.collected_by
     WHERE fp.id=@id AND fp.school_id=@sid AND fp.deleted_at IS NULL`,
    { id: { type: sql.UniqueIdentifier, value: paymentId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
  );
  if (!payment) throw new Error('Payment not found');

  if (payment.receipt_url) return payment.receipt_url;

  const school = await queryOne(
    `SELECT name, logo_url, brand_color, address_line1, city, state, pincode, phone, email
     FROM schools WHERE id=@sid`,
    { sid: { type: sql.UniqueIdentifier, value: schoolId } }
  );

  const student = await queryOne(
    `SELECT s.first_name + ' ' + ISNULL(s.last_name,'') AS student_name, s.admission_no,
            g.name AS class_name, sc.name AS section_name
     FROM students s
     LEFT JOIN enrolments e ON e.student_id = s.id AND e.school_id=@sid AND e.is_active=1
     LEFT JOIN sections sc ON sc.id = e.section_id
     LEFT JOIN grades g ON g.id = sc.grade_id
     WHERE s.id=@uid AND s.school_id=@sid`,
    { uid: { type: sql.UniqueIdentifier, value: payment.student_id }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
  );

  let items = [];
  if (payment.invoice_id) {
    const itemsRes = await query(
      `SELECT fc.name AS category_name, ii.amount_paise
       FROM fee_invoice_items ii
       JOIN fee_categories fc ON fc.id = ii.fee_category_id
       WHERE ii.invoice_id = @iid`,
      { iid: { type: sql.UniqueIdentifier, value: payment.invoice_id } }
    );
    items = itemsRes.recordset;
  }

  const pdfBuffer = await buildReceiptPdf({ school, payment, student, items });
  const uploadResult = await uploadPdfBuffer(pdfBuffer, `receipt_${payment.receipt_no}_${payment.id}`);
  const url = uploadResult.secure_url;

  await query(
    `UPDATE fee_payments SET receipt_url=@url WHERE id=@id`,
    { url: { type: sql.NVarChar(1000), value: url }, id: { type: sql.UniqueIdentifier, value: paymentId } }
  );

  return url;
};
