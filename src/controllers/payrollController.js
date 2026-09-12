//src/controllers/payrollController.js
const { query, queryOne, sql } = require('../config/db');
const { success, created, notFound, badRequest } = require('../utils/response');
const { v4: uuidv4 } = require('uuid');

// ── Ownership guard: staff_id must be an active member of this school ──
async function assertStaffBelongsToSchool(schoolId, staffId) {
  const row = await queryOne(
    `SELECT id FROM school_members WHERE school_id=@sid AND user_id=@uid AND is_active=1 AND deleted_at IS NULL`,
    { sid: { type: sql.UniqueIdentifier, value: schoolId }, uid: { type: sql.UniqueIdentifier, value: staffId } }
  );
  return !!row;
}

// ══════════════════════════════════════════════════
// LEAVE TYPES
// ══════════════════════════════════════════════════
exports.listLeaveTypes = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const rows = await query(
      `SELECT * FROM leave_types WHERE school_id=@sid AND deleted_at IS NULL ORDER BY created_at`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    return success(res, rows.recordset);
  } catch (err) { next(err); }
};

exports.createLeaveType = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { code, label, is_paid = true, color_hex } = req.body;
    if (!code || !label) return badRequest(res, 'Code and label are required.');
    const id = uuidv4();
    await query(
      `INSERT INTO leave_types (id, school_id, code, label, is_paid, color_hex, created_at)
       VALUES (@id, @sid, @code, @label, @paid, @color, @now)`,
      { id: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId },
        code: { type: sql.NVarChar(10), value: code.toUpperCase() }, label: { type: sql.NVarChar(50), value: label },
        paid: { type: sql.Bit, value: is_paid ? 1 : 0 }, color: { type: sql.NVarChar(10), value: color_hex || null },
        now: { type: sql.DateTime2, value: new Date() } }
    );
    return created(res, { id }, 'Leave type created');
  } catch (err) { next(err); }
};

exports.deleteLeaveType = async (req, res, next) => {
  try {
    const { id } = req.params; const { schoolId } = req.user;
    await query(`UPDATE leave_types SET deleted_at=@now WHERE id=@id AND school_id=@sid`,
      { id: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId }, now: { type: sql.DateTime2, value: new Date() } });
    return success(res, null, 'Leave type removed');
  } catch (err) { next(err); }
};

// ══════════════════════════════════════════════════
// STAFF LIST FOR PAYROLL (via school_members — SaaS-safe)
// ══════════════════════════════════════════════════
exports.listStaffForPayroll = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const rows = await query(
      `SELECT sm.user_id AS staff_id, u.full_name, u.email, u.phone, u.avatar_url,
              sm.role, sm.employee_code, sm.join_date,
              sp.department, sp.designation,
              ss.basic, ss.hra, ss.da, ss.special_allowance, ss.other_allowance,
              ss.pf_deduction, ss.pt_deduction, ss.other_deduction, ss.effective_from,
              bd.account_number, bd.ifsc_code, bd.bank_name, bd.upi_id, bd.account_holder,
              CASE WHEN bd.id IS NULL THEN 0 ELSE 1 END AS has_bank_details,
              CASE WHEN ss.id IS NULL THEN 0 ELSE 1 END AS has_salary_structure
       FROM school_members sm
       JOIN users u ON u.id = sm.user_id
       LEFT JOIN staff_profiles sp ON sp.user_id = sm.user_id AND sp.school_id = sm.school_id
       LEFT JOIN salary_structures ss ON ss.staff_id = sm.user_id AND ss.school_id = sm.school_id
       LEFT JOIN staff_bank_details bd ON bd.staff_id = sm.user_id AND bd.school_id = sm.school_id
       WHERE sm.school_id = @sid AND sm.is_active = 1 AND sm.deleted_at IS NULL
         AND sm.role NOT IN ('student')
       ORDER BY u.full_name`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    return success(res, rows.recordset);
  } catch (err) { next(err); }
};

// ══════════════════════════════════════════════════
// BANK DETAILS (with ownership guard)
// ══════════════════════════════════════════════════
exports.upsertBankDetails = async (req, res, next) => {
  try {
    const { staffId } = req.params; const { schoolId } = req.user;
    if (!(await assertStaffBelongsToSchool(schoolId, staffId))) return badRequest(res, 'Staff member not found in this school.');

    const { account_holder, account_number, ifsc_code, bank_name, branch_name, upi_id, pan_number } = req.body;
    const existing = await queryOne(`SELECT id FROM staff_bank_details WHERE staff_id=@sid AND school_id=@schoolId`,
      { sid: { type: sql.UniqueIdentifier, value: staffId }, schoolId: { type: sql.UniqueIdentifier, value: schoolId } });

    const p = {
      sid: { type: sql.UniqueIdentifier, value: staffId }, schoolId: { type: sql.UniqueIdentifier, value: schoolId },
      holder: { type: sql.NVarChar(150), value: account_holder || null }, acc: { type: sql.NVarChar(50), value: account_number || null },
      ifsc: { type: sql.NVarChar(20), value: ifsc_code || null }, bank: { type: sql.NVarChar(150), value: bank_name || null },
      branch: { type: sql.NVarChar(150), value: branch_name || null }, upi: { type: sql.NVarChar(100), value: upi_id || null },
      pan: { type: sql.NVarChar(20), value: pan_number || null }, now: { type: sql.DateTime2, value: new Date() },
    };

    if (existing) {
      await query(`UPDATE staff_bank_details SET account_holder=@holder, account_number=@acc, ifsc_code=@ifsc, bank_name=@bank,
                     branch_name=@branch, upi_id=@upi, pan_number=@pan, updated_at=@now WHERE staff_id=@sid AND school_id=@schoolId`, p);
    } else {
      await query(`INSERT INTO staff_bank_details (id, school_id, staff_id, account_holder, account_number, ifsc_code, bank_name, branch_name, upi_id, pan_number, created_at, updated_at)
                   VALUES (@id, @schoolId, @sid, @holder, @acc, @ifsc, @bank, @branch, @upi, @pan, @now, @now)`,
        { ...p, id: { type: sql.UniqueIdentifier, value: uuidv4() } });
    }
    return success(res, null, 'Bank details saved');
  } catch (err) { next(err); }
};

// ══════════════════════════════════════════════════
// SALARY STRUCTURE (with ownership guard)
// ══════════════════════════════════════════════════
exports.upsertSalaryStructure = async (req, res, next) => {
  try {
    const { staffId } = req.params; const { schoolId } = req.user;
    if (!(await assertStaffBelongsToSchool(schoolId, staffId))) return badRequest(res, 'Staff member not found in this school.');

    const { basic = 0, hra = 0, da = 0, special_allowance = 0, other_allowance = 0,
            pf_deduction = 0, pt_deduction = 0, other_deduction = 0, effective_from } = req.body;

    const existing = await queryOne(`SELECT id FROM salary_structures WHERE staff_id=@sid AND school_id=@schoolId`,
      { sid: { type: sql.UniqueIdentifier, value: staffId }, schoolId: { type: sql.UniqueIdentifier, value: schoolId } });

    const p = {
      sid: { type: sql.UniqueIdentifier, value: staffId }, schoolId: { type: sql.UniqueIdentifier, value: schoolId },
      basic: { type: sql.Decimal(10,2), value: basic }, hra: { type: sql.Decimal(10,2), value: hra },
      da: { type: sql.Decimal(10,2), value: da }, spl: { type: sql.Decimal(10,2), value: special_allowance },
      oa: { type: sql.Decimal(10,2), value: other_allowance }, pf: { type: sql.Decimal(10,2), value: pf_deduction },
      pt: { type: sql.Decimal(10,2), value: pt_deduction }, od: { type: sql.Decimal(10,2), value: other_deduction },
      eff: { type: sql.Date, value: effective_from || new Date() }, now: { type: sql.DateTime2, value: new Date() },
    };

    if (existing) {
      await query(`UPDATE salary_structures SET basic=@basic, hra=@hra, da=@da, special_allowance=@spl, other_allowance=@oa,
                     pf_deduction=@pf, pt_deduction=@pt, other_deduction=@od, effective_from=@eff, updated_at=@now
                   WHERE staff_id=@sid AND school_id=@schoolId`, p);
    } else {
      await query(`INSERT INTO salary_structures (id, school_id, staff_id, basic, hra, da, special_allowance, other_allowance,
                     pf_deduction, pt_deduction, other_deduction, effective_from, created_at, updated_at)
                   VALUES (@id, @schoolId, @sid, @basic, @hra, @da, @spl, @oa, @pf, @pt, @od, @eff, @now, @now)`,
        { ...p, id: { type: sql.UniqueIdentifier, value: uuidv4() } });
    }
    return success(res, null, 'Salary structure saved');
  } catch (err) { next(err); }
};

// ══════════════════════════════════════════════════
// RAW ATTENDANCE FOR A MONTH — frontend computes payroll from this
// ══════════════════════════════════════════════════
exports.getAttendanceRaw = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { month_year } = req.query; // 'YYYY-MM'
    if (!month_year) return badRequest(res, 'month_year is required (YYYY-MM)');
    const [year, month] = month_year.split('-');

    const rows = await query(
      `SELECT user_id AS staff_id, attendance_date, status
       FROM staff_attendance
       WHERE school_id=@sid AND YEAR(attendance_date)=@yr AND MONTH(attendance_date)=@mo AND deleted_at IS NULL`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId }, yr: { type: sql.Int, value: +year }, mo: { type: sql.Int, value: +month } }
    );
    return success(res, rows.recordset);
  } catch (err) { next(err); }
};

// ══════════════════════════════════════════════════
// SAVE COMPUTED PAYROLL RUN (frontend sends final numbers)
// ══════════════════════════════════════════════════
exports.savePayrollRun = async (req, res, next) => {
  try {
    const { schoolId, userId } = req.user;
    const { month_year, entries } = req.body; // entries = [{staff_id, total_days, present_days, paid_leave_days, lop_days, basic, hra, da, special_allowance, other_allowance, gross_salary, lop_deduction, pf_deduction, pt_deduction, other_deduction, total_deduction, net_pay}]
    if (!month_year || !Array.isArray(entries) || entries.length === 0) return badRequest(res, 'month_year and entries[] are required.');

    const existingRun = await queryOne(`SELECT id, status FROM payroll_runs WHERE school_id=@sid AND month_year=@my`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId }, my: { type: sql.NVarChar(7), value: month_year } });
    if (existingRun && existingRun.status === 'FINALIZED') return badRequest(res, 'This month is already finalized and locked.');

    const runId = existingRun ? existingRun.id : uuidv4();
    if (!existingRun) {
      await query(`INSERT INTO payroll_runs (id, school_id, month_year, status, generated_by, generated_at) VALUES (@id, @sid, @my, 'DRAFT', @by, @now)`,
        { id: { type: sql.UniqueIdentifier, value: runId }, sid: { type: sql.UniqueIdentifier, value: schoolId },
          my: { type: sql.NVarChar(7), value: month_year }, by: { type: sql.UniqueIdentifier, value: userId }, now: { type: sql.DateTime2, value: new Date() } });
    }

    let savedCount = 0;
    for (const e of entries) {
      if (!(await assertStaffBelongsToSchool(schoolId, e.staff_id))) continue; // silently skip foreign staff_id — SaaS safety

      const existingSlip = await queryOne(`SELECT id FROM payslips WHERE school_id=@sid AND staff_id=@staffId AND month_year=@my AND deleted_at IS NULL`,
        { sid: { type: sql.UniqueIdentifier, value: schoolId }, staffId: { type: sql.UniqueIdentifier, value: e.staff_id }, my: { type: sql.NVarChar(7), value: month_year } });

      const p = {
        sid: { type: sql.UniqueIdentifier, value: schoolId }, runId: { type: sql.UniqueIdentifier, value: runId },
        staffId: { type: sql.UniqueIdentifier, value: e.staff_id }, my: { type: sql.NVarChar(7), value: month_year },
        totalDays: { type: sql.Int, value: e.total_days }, present: { type: sql.Decimal(5,1), value: e.present_days },
        paidLeave: { type: sql.Decimal(5,1), value: e.paid_leave_days }, lop: { type: sql.Decimal(5,1), value: e.lop_days },
        basic: { type: sql.Decimal(10,2), value: e.basic }, hra: { type: sql.Decimal(10,2), value: e.hra },
        da: { type: sql.Decimal(10,2), value: e.da }, spl: { type: sql.Decimal(10,2), value: e.special_allowance },
        oa: { type: sql.Decimal(10,2), value: e.other_allowance }, gross: { type: sql.Decimal(10,2), value: e.gross_salary },
        lopDed: { type: sql.Decimal(10,2), value: e.lop_deduction }, pf: { type: sql.Decimal(10,2), value: e.pf_deduction },
        pt: { type: sql.Decimal(10,2), value: e.pt_deduction }, od: { type: sql.Decimal(10,2), value: e.other_deduction },
        totalDed: { type: sql.Decimal(10,2), value: e.total_deduction }, net: { type: sql.Decimal(10,2), value: e.net_pay },
        now: { type: sql.DateTime2, value: new Date() },
      };

      if (existingSlip) {
        await query(`UPDATE payslips SET total_days=@totalDays, present_days=@present, paid_leave_days=@paidLeave, lop_days=@lop,
                       basic=@basic, hra=@hra, da=@da, special_allowance=@spl, other_allowance=@oa, gross_salary=@gross,
                       lop_deduction=@lopDed, pf_deduction=@pf, pt_deduction=@pt, other_deduction=@od,
                       total_deduction=@totalDed, net_pay=@net WHERE id=@id`,
          { ...p, id: { type: sql.UniqueIdentifier, value: existingSlip.id } });
      } else {
        await query(`INSERT INTO payslips (id, school_id, payroll_run_id, staff_id, month_year, total_days, present_days,
                       paid_leave_days, lop_days, basic, hra, da, special_allowance, other_allowance, gross_salary,
                       lop_deduction, pf_deduction, pt_deduction, other_deduction, total_deduction, net_pay, payment_status, created_at)
                     VALUES (@id, @sid, @runId, @staffId, @my, @totalDays, @present, @paidLeave, @lop, @basic, @hra, @da, @spl, @oa,
                       @gross, @lopDed, @pf, @pt, @od, @totalDed, @net, 'PENDING', @now)`,
          { ...p, id: { type: sql.UniqueIdentifier, value: uuidv4() } });
      }
      savedCount++;
    }

    return success(res, { run_id: runId, saved: savedCount }, 'Payroll saved successfully');
  } catch (err) { next(err); }
};

exports.finalizeRun = async (req, res, next) => {
  try {
    const { runId } = req.params; const { schoolId } = req.user;
    await query(`UPDATE payroll_runs SET status='FINALIZED', finalized_at=@now WHERE id=@id AND school_id=@sid`,
      { id: { type: sql.UniqueIdentifier, value: runId }, sid: { type: sql.UniqueIdentifier, value: schoolId }, now: { type: sql.DateTime2, value: new Date() } });
    return success(res, null, 'Payroll finalized and locked.');
  } catch (err) { next(err); }
};

// ══════════════════════════════════════════════════
// PAYSLIPS
// ══════════════════════════════════════════════════
exports.listPayslips = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { month_year, staff_id } = req.query;
    let where = `p.school_id=@sid AND p.deleted_at IS NULL`;
    const params = { sid: { type: sql.UniqueIdentifier, value: schoolId } };
    if (month_year) { where += ` AND p.month_year=@my`; params.my = { type: sql.NVarChar(7), value: month_year }; }
    if (staff_id) { where += ` AND p.staff_id=@staffId`; params.staffId = { type: sql.UniqueIdentifier, value: staff_id }; }

    const rows = await query(
      `SELECT p.*, u.full_name AS staff_name, sp.designation, sp.department
       FROM payslips p
       JOIN users u ON u.id = p.staff_id
       LEFT JOIN staff_profiles sp ON sp.user_id = p.staff_id AND sp.school_id = p.school_id
       WHERE ${where} ORDER BY p.month_year DESC, u.full_name`, params);
    return success(res, rows.recordset);
  } catch (err) { next(err); }
};

exports.markPaid = async (req, res, next) => {
  try {
    const { id } = req.params; const { schoolId } = req.user;
    const { payment_mode, trx_id } = req.body;
    await query(`UPDATE payslips SET payment_status='PAID', payment_mode=@mode, trx_id=@trx, paid_at=@now WHERE id=@id AND school_id=@sid`,
      { id: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId },
        mode: { type: sql.NVarChar(30), value: payment_mode }, trx: { type: sql.NVarChar(100), value: trx_id || null }, now: { type: sql.DateTime2, value: new Date() } });
    return success(res, null, 'Marked as paid');
  } catch (err) { next(err); }
};

exports.getPayslip = async (req, res, next) => {
  try {
    const { id } = req.params; const { schoolId } = req.user;
    const slip = await queryOne(
      `SELECT p.*, u.full_name AS staff_name, u.phone, u.email, sp.designation, sp.department
       FROM payslips p JOIN users u ON u.id = p.staff_id
       LEFT JOIN staff_profiles sp ON sp.user_id = p.staff_id AND sp.school_id = p.school_id
       WHERE p.id=@id AND p.school_id=@sid`,
      { id: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId } });
    if (!slip) return notFound(res, 'Payslip not found');

    const bank = await queryOne(`SELECT * FROM staff_bank_details WHERE staff_id=@sid AND school_id=@schoolId`,
      { sid: { type: sql.UniqueIdentifier, value: slip.staff_id }, schoolId: { type: sql.UniqueIdentifier, value: schoolId } });
    return success(res, { ...slip, bank_details: bank || null });
  } catch (err) { next(err); }
};
