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

     // ── WATERMARK ──
      const watermarkUrl = school.watermark_url || school.logo_url;
      const wmBuf = await fetchImageBuffer(watermarkUrl);
      if (wmBuf) {
        try {
          doc.save();
          doc.globalAlpha(0.08); // 8% opacity for pro-level light watermark
          // Placed at center of A4 paper
          doc.image(wmBuf, 147, 271, { fit: [300, 300], align: 'center', valign: 'center' });
          doc.restore();
        } catch (e) {}
      }

      // ── HEADER ──
      const logoBuf = await fetchImageBuffer(school.logo_url);
      let headerY = 40;

      if (logoBuf) {
        // 'fit' prevents API crash and forces correct aspect ratio
        try { doc.image(logoBuf, 40, headerY, { fit: [70, 70] }); } catch {}
      }

     const schoolName = school.name?.toUpperCase() || 'SCHOOL NAME';
      const pageWidth = 515; // Full printable width (A4 595 - 40 left margin - 40 right margin)

      // MATH MAGIC: To keep text 100% centered, it must span the full page width (x: 40).
      // But if a logo exists (max width 70px + margin), the safe text width is smaller so it doesn't overlap the logo.
      // Left limit is x=115. Center is x=297.5. Safe width = (297.5 - 115) * 2 = 365.
      const maxSafeTextWidth = logoBuf ? 365 : 515;

      // Auto-shrink font size to force single line and avoid logo overlap
      let nameFontSize = 24;
      doc.font('Helvetica-Bold');
      while (doc.fontSize(nameFontSize).widthOfString(schoolName) > maxSafeTextWidth && nameFontSize > 9) {
          nameFontSize -= 1;
      }

      // Title (100% centered on paper, lineBreak false ensures 1 line)
      doc.fillColor(brandColor).fontSize(nameFontSize)
        .text(schoolName, 40, headerY, { width: pageWidth, align: 'center', lineBreak: false });

      // Address Setup
      let currentY = doc.y + 4;
      const address = [school.address_line1, school.address_line2, school.city, school.state, school.pincode].filter(Boolean).join(', ');
      
      let addrFontSize = Math.min(10, nameFontSize - 4);
      if (addrFontSize < 8) addrFontSize = 8;

      doc.fillColor('#444').fontSize(addrFontSize).font('Helvetica')
        .text(address, 40, currentY, { width: pageWidth, align: 'center' });

      // Phone & Email 
      currentY = doc.y + 3;
      doc.fontSize(addrFontSize - 1).fillColor('#666')
        .text(`Phone: ${school.phone || 'N/A'}  |  Email: ${school.email || 'N/A'}`, 40, currentY, { width: pageWidth, align: 'center' });
        
      currentY = doc.y + 3;
      if (school.website) {
         doc.text(`Website: ${school.website}`, 40, currentY, { width: pageWidth, align: 'center' });
         currentY = doc.y + 4;
      }

      // Divider Line
      const dividerY = Math.max(115, currentY + 12);
      doc.moveTo(40, dividerY).lineTo(555, dividerY).strokeColor(brandColor).lineWidth(2).stroke();

      // ── TITLE & RECEIPT STATUS ──
      doc.fillColor('#111').fontSize(18).font('Helvetica-Bold')
        .text('FEE RECEIPT', 40, dividerY + 15, { align: 'center', width: 515 });

      if (payment.is_void) {
         doc.fillColor('red').fontSize(14).font('Helvetica-Bold')
           .text('[ VOID / CANCELLED ]', 40, dividerY + 35, { align: 'center', width: 515 });
      }

      // ── META INFORMATION (Two Columns + Photo) ──
      const studentPhotoBuf = await fetchImageBuffer(student.photo_url);
      let y = payment.is_void ? dividerY + 65 : dividerY + 50;
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

      // Column 2 (Right) - Student Details (Shifted slightly left to make room for photo)
      doc.font('Helvetica').text(`Student Name:`, 290, y).font('Helvetica-Bold').text(student.student_name, 365, y, { width: 115, lineBreak: false });
      doc.font('Helvetica').text(`Admission No:`, 290, y + 16).font('Helvetica-Bold').text(student.admission_no || '-', 365, y + 16);
      doc.font('Helvetica').text(`Class & Sec:`, 290, y + 32).font('Helvetica-Bold').text(`${student.class_name || '-'} ${student.section_name ? '('+student.section_name+')' : ''}`, 365, y + 32);
      if (student.roll_no) {
         doc.font('Helvetica').text(`Roll No:`, 290, y + 48).font('Helvetica-Bold').text(student.roll_no, 365, y + 48);
      }

      // Student Profile Photo (Far Right)
      if (studentPhotoBuf) {
         try {
           doc.image(studentPhotoBuf, 490, y, { fit: [50, 50], align: 'center', valign: 'center' });
           doc.rect(490, y, 50, 50).stroke('#ccc'); // Photo Border
         } catch (e) {}
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
        
        // If there's a discount on this item, print it below the category name
        if (it.discount_paise && it.discount_paise > 0) {
            doc.text(it.category_name, 100, y + 4);
            doc.fontSize(8).fillColor('#e63946').text(`Includes Discount: -${money(it.discount_paise)}`, 100, y + 15);
            doc.fontSize(10).fillColor('#222'); // Reset for next items
        } else {
            doc.text(it.category_name, 100, y + 8);
        }

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

function uploadPdfBuffer(buffer, folderPath, publicId) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { 
        resource_type: 'raw', 
        folder: folderPath,     
        public_id: `${publicId}.pdf`, 
        overwrite: true 
      },
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
    `SELECT name, logo_url, watermark_url, brand_color, address_line1, address_line2, city, state, pincode, phone, email, website
     FROM schools WHERE id=@sid`,
    { sid: { type: sql.UniqueIdentifier, value: schoolId } }
  );

  const student = await queryOne(
    `SELECT s.first_name + ' ' + ISNULL(s.last_name,'') AS student_name, s.admission_no, s.photo_url,
            g.name AS class_name, sc.name AS section_name, e.roll_no
     FROM students s
     LEFT JOIN enrolments e ON e.student_id = s.id AND e.school_id=@sid AND e.is_active=1
     LEFT JOIN sections sc ON sc.id = e.section_id
     LEFT JOIN grades g ON g.id = sc.grade_id
     WHERE s.id=@uid AND s.school_id=@sid`,
    { uid: { type: sql.UniqueIdentifier, value: payment.student_id }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
  );

 // Fetch Itemized Breakdown for this specific payment
  let items = [];
  const itemsRes = await query(
    `SELECT fc.name AS category_name, fpi.amount_paise, fpi.discount_paise
     FROM fee_payment_items fpi
     JOIN fee_categories fc ON fc.id = fpi.fee_category_id
     WHERE fpi.payment_id = @pid AND fpi.amount_paise > 0`,
    { pid: { type: sql.UniqueIdentifier, value: paymentId } }
  );
  items = itemsRes.recordset || [];

  const pdfBuffer = await buildReceiptPdf({ school, payment, student, items });
  
  // 🔴 NEW: Generate safe folder name based on School Name
  const safeSchoolName = (school.name || 'Unknown_School')
     .replace(/[^a-zA-Z0-9]/g, '_')
     .replace(/_+/g, '_')
     .toLowerCase();
     
  const folderPath = `${safeSchoolName}/fee_receipts`;
  const fileName = `receipt_${payment.receipt_no}_${payment.id}`;

  // 🔴 FIX: Passing buffer, folderPath, AND fileName
  const uploadResult = await uploadPdfBuffer(pdfBuffer, folderPath, fileName);
  const url = uploadResult.secure_url;

  await query(
    `UPDATE fee_payments SET receipt_url=@url WHERE id=@id`,
    { url: { type: sql.NVarChar(1000), value: url }, id: { type: sql.UniqueIdentifier, value: paymentId } }
  );

  return url;
};

exports.sendPaymentConfirmationWhatsapp = async (schoolId, paymentId) => {
  try {
    const { sendTemplate } = require('./whatsappService');
    const { queryOne, sql } = require('../config/db');

    // 1. Fetch Payment Data
    const payment = await queryOne(
      `SELECT * FROM fee_payments WHERE id=@id AND school_id=@sid`,
      { id: { type: sql.UniqueIdentifier, value: paymentId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    if (!payment) return;

    // 2. Fetch School Data
    const school = await queryOne(
      `SELECT name FROM schools WHERE id=@sid`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );

    // 3. Fetch Student & Parent Phone
        const student = await queryOne(
      `SELECT s.first_name, s.last_name,
        (SELECT TOP 1 phone FROM student_guardians WHERE student_id = s.id AND is_primary = 1) AS guardian_phone
       FROM students s WHERE s.id=@uid`,
      { uid: { type: sql.UniqueIdentifier, value: payment.student_id } }
    );

    if (!student) return;

    const targetPhone = student.guardian_phone;
    if (!targetPhone) {
      console.log("❌ No phone number found for WhatsApp");
      return;
    }

    // 4. Format Variables (Strict limit applied to prevent Meta Error #132005)
    const schoolName = String(school?.name || "School").substring(0, 60);
    const studentName = [student.first_name, student.last_name].filter(Boolean).join(" ").substring(0, 30);
    const amount = (payment.amount_paise / 100).toString();

    // Formatting Date to Month (e.g. "September 2026")
    const dateObj = new Date(payment.payment_date || Date.now());
    const month = dateObj.toLocaleString('en-IN', { month: 'long', year: 'numeric' }).substring(0, 20);
    
    // Transaction ID & Mode
    const trxId = String(payment.razorpay_payment_id || payment.transaction_ref || "CASH").substring(0, 30);
    const mode = String(payment.payment_method || "CASH").substring(0, 20);

    // Time string format: "02 September 2026, 10:25 AM"
    const timeOptions = { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' };
    const timeStr = dateObj.toLocaleString('en-IN', timeOptions).replace(' am', ' AM').replace(' pm', ' PM');

    // 🔴 5. Build EXACT Meta Payload (Matches your GAS Script: 1 Header, 6 Body)
    const components = [
      {
        type: "header",
        parameters: [
          { type: "text", text: schoolName } // Header {{1}}
        ]
      },
      {
        type: "body",
        parameters: [
          { type: "text", text: studentName },  // Body {{1}}
          { type: "text", text: amount },       // Body {{2}}
          { type: "text", text: month },        // Body {{3}}
          { type: "text", text: trxId },        // Body {{4}}
          { type: "text", text: mode },         // Body {{5}}
          { type: "text", text: timeStr }       // Body {{6}}
        ]
      }
    ];

    // 6. Send using Node.js WhatsApp Service
    await sendTemplate(targetPhone, 'fee_submission_confirmation', 'en', components);
    console.log("✅ Fee WhatsApp Sent to: " + targetPhone);

  } catch (error) {
    console.error("❌ WhatsApp Error:", error.message);
  }
};

exports.sendPaymentConfirmationEmail = async (schoolId, paymentId) => {
  try {
    console.log('📧 Email flow started for payment:', paymentId);
    const emailService = require('./emailService');

    const payment = await queryOne(
      `SELECT fp.receipt_no, fp.amount_paise, fp.payment_method, fp.payment_date, fp.student_id
       FROM fee_payments fp WHERE fp.id=@id AND fp.school_id=@sid`,
      { id: { type: sql.UniqueIdentifier, value: paymentId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    if (!payment) return;

    const student = await queryOne(
      `SELECT s.first_name + ' ' + ISNULL(s.last_name,'') AS student_name, s.photo_url,
              g.name AS class_name, sc.name AS section_name
       FROM students s
       LEFT JOIN enrolments e ON e.student_id=s.id AND e.school_id=@sid AND e.is_active=1
       LEFT JOIN sections sc ON sc.id=e.section_id
       LEFT JOIN grades g ON g.id=sc.grade_id
       WHERE s.id=@uid AND s.school_id=@sid`,
      { uid: { type: sql.UniqueIdentifier, value: payment.student_id }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );

    const guardian = await queryOne(
      `SELECT TOP 1 email, full_name FROM student_guardians
       WHERE student_id=@uid AND is_primary=1 AND deleted_at IS NULL AND email IS NOT NULL`,
      { uid: { type: sql.UniqueIdentifier, value: payment.student_id } }
    );
        if (!guardian?.email) { console.log('❌ No guardian email found for student:', payment.student_id); return; }

    const school = await queryOne(
      `SELECT name, logo_url, brand_color, address_line1, city, state, phone, email
       FROM schools WHERE id=@sid`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );

    const brandColor = school.brand_color || '#E8600A';
    const receiptUrl = await exports.getOrGenerateReceipt(schoolId, paymentId);

    const html = `
    <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:600px;margin:0 auto;background:#f4f4f7;padding:24px;">
      <div style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,0.06);">
        <div style="background:${brandColor};padding:24px 28px;display:flex;align-items:center;gap:14px;">
          ${school.logo_url ? `<img src="${school.logo_url}" width="48" height="48" style="border-radius:8px;background:#fff;padding:4px;" />` : ''}
          <div>
            <div style="color:#fff;font-size:18px;font-weight:800;">${school.name}</div>
            <div style="color:#ffffffcc;font-size:11px;">${[school.address_line1, school.city, school.state].filter(Boolean).join(', ')}</div>
          </div>
        </div>

        <div style="padding:28px;">
          <div style="text-align:center;margin-bottom:20px;">
            ${student.photo_url ? `<img src="${student.photo_url}" width="64" height="64" style="border-radius:50%;object-fit:cover;border:3px solid ${brandColor}44;" />` : ''}
            <h2 style="margin:12px 0 2px;color:#111;">${student.student_name}</h2>
            <div style="color:#777;font-size:13px;">${student.class_name || ''} ${student.section_name || ''}</div>
          </div>

          <div style="background:#f9fafb;border-radius:12px;padding:18px 20px;margin-bottom:20px;">
            <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #eee;">
              <span style="color:#666;font-size:13px;">Receipt No.</span>
              <span style="font-weight:700;font-size:13px;">${payment.receipt_no}</span>
            </div>
            <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #eee;">
              <span style="color:#666;font-size:13px;">Payment Date</span>
              <span style="font-weight:700;font-size:13px;">${new Date(payment.payment_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })}</span>
            </div>
            <div style="display:flex;justify-content:space-between;padding:6px 0;">
              <span style="color:#666;font-size:13px;">Payment Method</span>
              <span style="font-weight:700;font-size:13px;">${payment.payment_method}</span>
            </div>
          </div>

          <div style="text-align:center;background:${brandColor}11;border-radius:12px;padding:18px;margin-bottom:22px;">
            <div style="font-size:12px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Amount Paid</div>
            <div style="font-size:28px;font-weight:800;color:${brandColor};margin-top:4px;">₹${(payment.amount_paise / 100).toLocaleString('en-IN')}</div>
          </div>

          <div style="text-align:center;">
            <a href="${receiptUrl}" style="display:inline-block;background:${brandColor};color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;font-size:13px;">
              Download Receipt PDF
            </a>
          </div>
        </div>

        <div style="background:#fafafa;padding:16px 28px;text-align:center;border-top:1px solid #eee;">
          <div style="font-size:10.5px;color:#999;">This is a computer-generated email. Please do not reply.</div>
          <div style="font-size:11px;color:#aaa;margin-top:4px;">${school.name} · ${school.phone || ''} ${school.email ? '· ' + school.email : ''}</div>
        </div>
      </div>
    </div>`;

        await emailService.sendHtmlEmail({
      to: guardian.email,
      from: 'muniramm890@gmail.com',
      fromName: school.name,
      subject: `Fee Payment Confirmation — ${payment.receipt_no}`,
      html,
    });
    console.log('✅ Email sent successfully to:', guardian.email);
  } catch (e) {
    console.error('❌ Payment confirmation email failed:', e.message, e.stack);
  }
};
