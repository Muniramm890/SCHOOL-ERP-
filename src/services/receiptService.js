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

      // ── HEADER (Improved) ──
      const logoBuf = await fetchImageBuffer(school.logo_url);
      let headerY = 40;
      
      // School Logo
      if (logoBuf) {
        try { doc.image(logoBuf, 40, headerY, { width: 65, height: 65, align: 'center', valign: 'center' }); } catch {}
      }

      // School Name & Address
      const textStartX = logoBuf ? 120 : 40;
      doc.fillColor(brandColor).fontSize(22).font('Helvetica-Bold')
        .text(school.name?.toUpperCase() || 'SCHOOL NAME', textStartX, headerY, { width: 430 });
      
      doc.fillColor('#444').fontSize(10).font('Helvetica')
        .text(
          [school.address_line1, school.address_line2, school.city, school.state, school.pincode].filter(Boolean).join(', '),
          textStartX, headerY + 28, { width: 430 }
        );
      
      doc.fontSize(9).fillColor('#666')
        .text(
          `Phone: ${school.phone || 'N/A'}  |  Email: ${school.email || 'N/A'}`,
          textStartX, headerY + 42, { width: 430 }
        );
        
      if (school.website) {
         doc.text(`Website: ${school.website}`, textStartX, headerY + 54, { width: 430 });
      }

      // Divider Line
      doc.moveTo(40, 120).lineTo(555, 120).strokeColor(brandColor).lineWidth(2).stroke();

      // ── TITLE & RECEIPT STATUS ──
      doc.fillColor('#111').fontSize(18).font('Helvetica-Bold')
        .text('FEE RECEIPT', 40, 135, { align: 'center', width: 515 });

      if (payment.is_void) {
         doc.fillColor('red').fontSize(14).font('Helvetica-Bold')
           .text('[ VOID / CANCELLED ]', 40, 155, { align: 'center', width: 515 });
      }

      // ── META INFORMATION (Two Columns) ──
      let y = payment.is_void ? 185 : 170;
      doc.rect(40, y - 5, 515, 90).fillAndStroke('#fafafa', '#e0e0e0');
      
      doc.fontSize(10).fillColor('#333');
      
      // Column 1 (Left) - Receipt Details
      doc.font('Helvetica').text(`Receipt No:`, 50, y).font('Helvetica-Bold').text(payment.receipt_no, 130, y);
      doc.font('Helvetica').text(`Date:`, 50, y + 16).font('Helvetica-Bold')
         .text(new Date(payment.payment_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }), 130, y + 16);
      
      // Payment Method & Transaction ID logic
      doc.font('Helvetica').text(`Payment Mode:`, 50, y + 32).font('Helvetica-Bold').text((payment.payment_method || 'Cash').toUpperCase(), 130, y + 32);
      
      // If payment has transaction_ref OR razorpay_payment_id, print it
      const txnId = payment.razorpay_payment_id || payment.transaction_ref;
      if (txnId) {
          doc.font('Helvetica').text(`Txn ID:`, 50, y + 48).font('Helvetica-Bold').text(txnId, 130, y + 48);
      }
      if (payment.bank_name) {
          doc.font('Helvetica').text(`Bank/Gateway:`, 50, y + 64).font('Helvetica-Bold').text(payment.bank_name, 130, y + 64);
      }

      // Column 2 (Right) - Student Details
      doc.font('Helvetica').text(`Student Name:`, 310, y).font('Helvetica-Bold').text(student.student_name, 390, y);
      doc.font('Helvetica').text(`Admission No:`, 310, y + 16).font('Helvetica-Bold').text(student.admission_no || '-', 390, y + 16);
      doc.font('Helvetica').text(`Class & Sec:`, 310, y + 32).font('Helvetica-Bold').text(`${student.class_name || '-'} ${student.section_name ? '('+student.section_name+')' : ''}`, 390, y + 32);
      if (student.roll_no) {
         doc.font('Helvetica').text(`Roll No:`, 310, y + 48).font('Helvetica-Bold').text(student.roll_no, 390, y + 48);
      }

      // ── TABLE ──
      y += 110;
      doc.rect(40, y, 515, 26).fill(brandColor);
      doc.fillColor('#fff').fontSize(11).font('Helvetica-Bold');
      doc.text('S.No.', 50, y + 8, { width: 40 });
      doc.text('Fee Description', 100, y + 8);
      doc.text('Amount', 480, y + 8, { width: 65, align: 'right' });
      y += 26;

      const rows = items && items.length > 0 ? items : [{ category_name: 'Total Fee Payment (Consolidated)', amount_paise: payment.amount_paise }];
      
      doc.fillColor('#222').font('Helvetica').fontSize(10);
      rows.forEach((it, i) => {
        const rowH = 26;
        if (i % 2 === 1) { doc.rect(40, y, 515, rowH).fill('#f9f9f9'); doc.fillColor('#222'); }
        doc.text((i + 1).toString(), 50, y + 8, { width: 40 });
        doc.text(it.category_name, 100, y + 8);
        doc.text(money(it.amount_paise), 480, y + 8, { width: 65, align: 'right' });
        y += rowH;
      });

      doc.moveTo(40, y).lineTo(555, y).strokeColor('#ccc').lineWidth(1).stroke();
      y += 12;
      
      // Total Box
      doc.rect(340, y - 6, 215, 28).fill('#f2f2f2').stroke('#ddd');
      doc.font('Helvetica-Bold').fontSize(12).fillColor(brandColor)
        .text('Total Paid Amount:', 350, y + 2, { continued: true }).text(money(payment.amount_paise), { align: 'right' });

      // Amount in Words (Optional extra professional touch)
      // doc.fontSize(9).fillColor('#555').font('Helvetica-Oblique').text(`Received sum of ${money(payment.amount_paise)} only.`, 40, y + 40);

      if (payment.remarks) {
          doc.fontSize(9).fillColor('#555').font('Helvetica').text(`Remarks: ${payment.remarks}`, 40, y + 45, { width: 515 });
      }

      // ── FOOTER ──
      const footerY = 730;
      doc.moveTo(40, footerY).lineTo(555, footerY).strokeColor('#ddd').lineWidth(1).stroke();
      doc.fontSize(8).fillColor('#777').font('Helvetica-Oblique')
        .text(`Collected by: ${payment.collected_by_name || 'Online Payment System'}`, 40, footerY + 10);
      doc.font('Helvetica').text('This is a computer-generated receipt and does not require a physical signature.', 40, footerY + 22, { align: 'center', width: 515 });
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

// ── MAIN ──
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
    `SELECT name, logo_url, brand_color, address_line1, address_line2, city, state, pincode, phone, email, website
     FROM schools WHERE id=@sid`,
    { sid: { type: sql.UniqueIdentifier, value: schoolId } }
  );

  const student = await queryOne(
    `SELECT s.first_name + ' ' + ISNULL(s.last_name,'') AS student_name, s.admission_no,
            g.name AS class_name, sc.name AS section_name, e.roll_no
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
