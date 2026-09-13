//src/services/payslipPdfService.js
const PDFDocument = require('pdfkit');

const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function monthLabel(my) { const [y, m] = my.split('-'); return `${MONTH_NAMES[+m - 1]} ${y}`; }
function inrPdf(n) { return `Rs. ${(Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`; }

// Fetch a remote image (logo/watermark) as a Buffer — pdfkit needs a buffer, not a URL
async function fetchImageBuffer(url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  } catch (e) {
    console.error('PDF image fetch failed:', url, e.message);
    return null;
  }
}

// hex "#RRGGBB" -> pdfkit accepts hex strings directly, but guard against missing '#'
const hex = (c, fallback = '#1a1a2e') => (c && /^#?[0-9A-Fa-f]{6}$/.test(c) ? (c.startsWith('#') ? c : `#${c}`) : fallback);

const generatePayslipPdfBuffer = async (slip, school) => {
  const [logoBuf, watermarkBuf] = await Promise.all([
    fetchImageBuffer(school?.logo_url),
    fetchImageBuffer(school?.watermark_url || school?.logo_url), // fall back to logo as watermark source
  ]);
  const brand = hex(school?.brand_color);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const PAGE_W = 595.28, PAGE_H = 841.89; // A4 pt

    // ── WATERMARK — centered, rotated, low opacity, drawn FIRST (behind everything) ──
    if (watermarkBuf) {
      doc.save();
      doc.opacity(0.06);
      const wSize = 320;
      doc.image(watermarkBuf, (PAGE_W - wSize) / 2, (PAGE_H - wSize) / 2, {
        fit: [wSize, wSize], align: 'center', valign: 'center',
      });
      doc.opacity(1);
      doc.restore();
    }

    // ── HEADER — logo left, compact name block, accent rule ──
    let cursorY = 36;
    if (logoBuf) {
      try { doc.image(logoBuf, 36, cursorY, { fit: [46, 46] }); } catch (e) { /* corrupt image, skip */ }
    }
    const textX = logoBuf ? 92 : 36;
    doc.fillColor('#111').font('Helvetica-Bold').fontSize(13.5).text(school?.name || 'School', textX, cursorY, { width: 340 });
    if (school?.tagline) {
      doc.font('Helvetica-Oblique').fontSize(7.5).fillColor('#666').text(school.tagline, textX, doc.y + 1, { width: 340 });
    }
    doc.font('Helvetica').fontSize(7.5).fillColor('#666').text(
      [school?.address_line1, school?.city, school?.state, school?.pincode].filter(Boolean).join(', '),
      textX, doc.y + 1, { width: 340 }
    );

    // Right-aligned "SALARY SLIP" badge
    doc.font('Helvetica-Bold').fontSize(9).fillColor(brand)
      .text('SALARY SLIP', 400, cursorY + 4, { width: 159, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111')
      .text(monthLabel(slip.month_year), 400, cursorY + 16, { width: 159, align: 'right' });

    cursorY = Math.max(doc.y, cursorY + 46) + 8;
    doc.strokeColor(brand).lineWidth(1.6).moveTo(36, cursorY).lineTo(559, cursorY).stroke();
    cursorY += 12;

    // ── EMPLOYEE INFO — compact 2-column grid ──
    doc.fontSize(8.5).fillColor('#333').font('Helvetica');
    const rowH = 13;
    const infoLeft = [
      ['Employee', slip.staff_name], ['Department', slip.department || '—'], ['Present Days', `${slip.present_days} / ${slip.total_days}`],
    ];
    const infoRight = [
      ['Designation', slip.designation || '—'], ['Status', slip.payment_status], ['Paid Leave / LOP', `${slip.paid_leave_days} / ${slip.lop_days}`],
    ];
    infoLeft.forEach(([label, val], i) => {
      doc.font('Helvetica-Bold').text(`${label}:`, 36, cursorY + i * rowH, { continued: true, width: 260 });
      doc.font('Helvetica').text(` ${val}`);
    });
    infoRight.forEach(([label, val], i) => {
      doc.font('Helvetica-Bold').text(`${label}:`, 300, cursorY + i * rowH, { continued: true, width: 260 });
      doc.font('Helvetica').text(` ${val}`);
    });
    cursorY += infoLeft.length * rowH + 10;

    // ── EARNINGS / DEDUCTIONS TABLE — compact rows ──
    const rows = [
      ['Basic Pay', slip.basic, 'LOP Deduction', slip.lop_deduction],
      ['HRA', slip.hra, 'PF', slip.pf_deduction],
      ['DA', slip.da, 'PT', slip.pt_deduction],
      ['Special Allowance', slip.special_allowance, 'Other', slip.other_deduction],
      ['Other Allowance', slip.other_allowance, '', ''],
    ];
    const tRowH = 16;

    doc.rect(36, cursorY, 523, tRowH + 2).fill(brand);
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8);
    doc.text('EARNINGS', 42, cursorY + 4, { width: 180 });
    doc.text('AMOUNT', 190, cursorY + 4, { width: 75, align: 'right' });
    doc.text('DEDUCTIONS', 300, cursorY + 4, { width: 160 });
    doc.text('AMOUNT', 480, cursorY + 4, { width: 75, align: 'right' });
    cursorY += tRowH + 2;

    doc.font('Helvetica').fontSize(8.5).fillColor('#222');
    rows.forEach(([el, ea, dl, da], i) => {
      if (i % 2 === 0) doc.rect(36, cursorY, 523, tRowH).fillOpacity(0.4).fill('#f5f5f7').fillOpacity(1);
      doc.fillColor('#222');
      doc.text(el, 42, cursorY + 4, { width: 180 });
      doc.text(inrPdf(ea), 190, cursorY + 4, { width: 75, align: 'right' });
      if (dl) { doc.text(dl, 300, cursorY + 4, { width: 160 }); doc.text(inrPdf(da), 480, cursorY + 4, { width: 75, align: 'right' }); }
      cursorY += tRowH;
    });

    doc.rect(36, cursorY, 523, tRowH + 2).fillOpacity(0.12).fill(brand).fillOpacity(1);
    doc.fillColor('#111').font('Helvetica-Bold').fontSize(8.5);
    doc.text('GROSS TOTAL', 42, cursorY + 5, { width: 180 });
    doc.text(inrPdf(slip.gross_salary), 190, cursorY + 5, { width: 75, align: 'right' });
    doc.text('TOTAL DEDUCTIONS', 300, cursorY + 5, { width: 160 });
    doc.text(inrPdf(slip.total_deduction), 480, cursorY + 5, { width: 75, align: 'right' });
    cursorY += tRowH + 14;

    // ── Adjustment note (if any) ──
    if (slip.is_manually_adjusted) {
      doc.rect(36, cursorY, 523, 26).fillOpacity(0.5).fill('#FFF8E1').fillOpacity(1);
      doc.fillColor('#8a6d00').font('Helvetica-Oblique').fontSize(7.5)
        .text(`Note: Manually adjusted.${slip.bonus_amount > 0 ? ` Bonus: ${inrPdf(slip.bonus_amount)}.` : ''} Reason: ${slip.adjustment_note || '—'}`,
          42, cursorY + 6, { width: 511 });
      cursorY += 32;
    }

    // ── NET PAY box — right aligned, brand accent border ──
    doc.roundedRect(400, cursorY, 159, 42, 4).lineWidth(1.4).strokeColor(brand).stroke();
    doc.fillColor('#666').font('Helvetica-Bold').fontSize(7.5).text('NET PAY', 400, cursorY + 6, { width: 159, align: 'center' });
    doc.fillColor('#111').font('Helvetica-Bold').fontSize(16).text(inrPdf(slip.net_pay), 400, cursorY + 18, { width: 159, align: 'center' });
    cursorY += 56;

    // ── Bank details — small print ──
    if (slip.bank_details) {
      doc.font('Helvetica').fontSize(7.5).fillColor('#666').text(
        `Paid to: ${slip.bank_details.bank_name || '—'}  •  A/C: ${slip.bank_details.account_number ? '••••' + String(slip.bank_details.account_number).slice(-4) : '—'}` +
        (slip.bank_details.upi_id ? `  •  UPI: ${slip.bank_details.upi_id}` : '') +
        (slip.trx_id ? `  •  Txn: ${slip.trx_id}` : ''),
        36, cursorY, { width: 523 }
      );
    }

    doc.fontSize(7).fillColor('#999').text(
      'This is a system-generated payslip and does not require a signature.',
      36, 800, { width: 523, align: 'center' }
    );

    doc.end();
  });
};

module.exports = { generatePayslipPdfBuffer };