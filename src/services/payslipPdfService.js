//src/services/payslipPdfService.js
const PDFDocument = require('pdfkit');

const generatePayslipPdfBuffer = (slip, school) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header
    doc.fontSize(16).font('Helvetica-Bold').text(school?.name || 'School', { align: 'left' });
    doc.fontSize(9).font('Helvetica').fillColor('#555')
      .text([school?.address_line1, school?.city, school?.state].filter(Boolean).join(', '));
    doc.moveDown(0.5);
    doc.strokeColor('#000').lineWidth(1.2).moveTo(40, doc.y).lineTo(555, doc.y).stroke();
    doc.moveDown(0.8);

    doc.fillColor('#000').fontSize(13).font('Helvetica-Bold')
      .text(`SALARY SLIP — ${monthLabel(slip.month_year)}`, { align: 'center' });
    doc.moveDown(1);

    // Employee info
    doc.fontSize(10).font('Helvetica');
    const infoY = doc.y;
    doc.text(`Employee: ${slip.staff_name}`, 40, infoY);
    doc.text(`Designation: ${slip.designation || '—'}`, 300, infoY);
    doc.text(`Department: ${slip.department || '—'}`, 40, infoY + 16);
    doc.text(`Payment Status: ${slip.payment_status}`, 300, infoY + 16);
    doc.text(`Present Days: ${slip.present_days} / ${slip.total_days}`, 40, infoY + 32);
    doc.text(`Paid Leave: ${slip.paid_leave_days}   LOP: ${slip.lop_days}`, 300, infoY + 32);
    doc.moveDown(3);

    // Earnings/Deductions table
    const rows = [
      ['Basic Pay', slip.basic, 'LOP Deduction', slip.lop_deduction],
      ['HRA', slip.hra, 'PF', slip.pf_deduction],
      ['DA', slip.da, 'PT', slip.pt_deduction],
      ['Special Allowance', slip.special_allowance, 'Other', slip.other_deduction],
      ['Other Allowance', slip.other_allowance, '', ''],
    ];
    let y = doc.y;
    const rowH = 20;
    doc.font('Helvetica-Bold').fontSize(9.5);
    doc.text('Earnings', 40, y); doc.text('Amount', 190, y, { width: 80, align: 'right' });
    doc.text('Deductions', 300, y); doc.text('Amount', 450, y, { width: 100, align: 'right' });
    y += rowH;
    doc.font('Helvetica').fontSize(9.5);
    rows.forEach(([el, ea, dl, da]) => {
      doc.text(el, 40, y); doc.text(inrPdf(ea), 190, y, { width: 80, align: 'right' });
      if (dl) { doc.text(dl, 300, y); doc.text(inrPdf(da), 450, y, { width: 100, align: 'right' }); }
      y += rowH;
    });
    doc.font('Helvetica-Bold');
    doc.text('Gross Total', 40, y); doc.text(inrPdf(slip.gross_salary), 190, y, { width: 80, align: 'right' });
    doc.text('Total Deductions', 300, y); doc.text(inrPdf(slip.total_deduction), 450, y, { width: 100, align: 'right' });
    y += rowH + 10;

    if (slip.is_manually_adjusted) {
      doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#8a6d00')
        .text(`Note: Manually adjusted. ${slip.bonus_amount > 0 ? `Bonus: ${inrPdf(slip.bonus_amount)}. ` : ''}Reason: ${slip.adjustment_note || '—'}`, 40, y, { width: 515 });
      y += 24;
      doc.fillColor('#000');
    }

    // Net pay box
    doc.rect(400, y, 155, 40).stroke();
    doc.font('Helvetica-Bold').fontSize(9).text('NET PAY', 400, y + 6, { width: 155, align: 'center' });
    doc.fontSize(15).text(inrPdf(slip.net_pay), 400, y + 20, { width: 155, align: 'center' });

    y += 60;
    if (slip.bank_details) {
      doc.font('Helvetica').fontSize(8.5).fillColor('#555').text(
        `Paid to: ${slip.bank_details.bank_name || '—'} • A/C: ${slip.bank_details.account_number ? '••••' + String(slip.bank_details.account_number).slice(-4) : '—'}` +
        (slip.bank_details.upi_id ? ` • UPI: ${slip.bank_details.upi_id}` : '') +
        (slip.trx_id ? ` • Txn: ${slip.trx_id}` : ''), 40, y
      );
    }

    doc.fontSize(8).fillColor('#999').text('This is a system-generated payslip and does not require a signature.', 40, 780, { align: 'center', width: 515 });

    doc.end();
  });
};

const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function monthLabel(my) { const [y, m] = my.split('-'); return `${MONTH_NAMES[+m - 1]} ${y}`; }
function inrPdf(n) { return `Rs. ${(Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`; }

module.exports = { generatePayslipPdfBuffer };