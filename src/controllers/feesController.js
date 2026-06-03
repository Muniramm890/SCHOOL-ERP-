// src/controllers/feesController.js
const { query, queryOne, withTransaction, sql } = require('../config/db');
const { success, created, notFound, badRequest, paginated } = require('../utils/response');
const { audit } = require('../utils/audit');
const { v4: uuidv4 } = require('uuid');

// ── GET /api/fees/overview ────────────────────────────────────────────────
exports.getOverview = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const sid = { type: sql.UniqueIdentifier, value: schoolId };

    const [summary, byClass, monthly] = await Promise.all([
      queryOne(
        `SELECT
           SUM(paid_paise)                              AS total_paid_paise,
           SUM(pending_paise)                           AS total_pending_paise,
           SUM(total_fee_paise)                         AS total_fee_paise,
           COUNT(CASE WHEN status='paid'    THEN 1 END) AS paid_count,
           COUNT(CASE WHEN status='pending' THEN 1 END) AS pending_count,
           COUNT(CASE WHEN status='partial' THEN 1 END) AS partial_count
         FROM student_fee_accounts WHERE school_id=@sid AND deleted_at IS NULL`,
        { sid }
      ),
      query(
        `SELECT g.name AS class_name, g.numeric_order,
                SUM(sfa.paid_paise)    AS paid_paise,
                SUM(sfa.pending_paise) AS pending_paise,
                COUNT(*)               AS student_count
         FROM student_fee_accounts sfa
         JOIN enrolments e  ON e.student_id = sfa.student_id AND e.school_id = @sid AND e.is_active = 1
         JOIN sections sc   ON sc.id = e.section_id
         JOIN grades g      ON g.id = sc.grade_id AND g.school_id = @sid
         WHERE sfa.school_id = @sid AND sfa.deleted_at IS NULL
         GROUP BY g.name, g.numeric_order ORDER BY g.numeric_order`,
        { sid }
      ),
      query(
        `SELECT YEAR(payment_date) AS yr, MONTH(payment_date) AS mo,
                SUM(amount_paise) AS collected_paise, COUNT(*) AS txn_count
         FROM fee_payments
         WHERE school_id = @sid AND is_void = 0 AND deleted_at IS NULL
           AND payment_date >= DATEADD(MONTH,-6,GETUTCDATE())
         GROUP BY YEAR(payment_date), MONTH(payment_date)
         ORDER BY yr, mo`,
        { sid }
      ),
    ]);

    return success(res, { summary, byClass: byClass.recordset, monthly: monthly.recordset });
  } catch (err) { next(err); }
};

// ── GET /api/fees/accounts ────────────────────────────────────────────────
// All student fee accounts with filters
exports.listAccounts = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { page = 1, limit = 25, grade_id, status, search } = req.query;
    const offset = (page - 1) * limit;

    let where = `sfa.school_id = @sid AND sfa.deleted_at IS NULL`;
    const params = { sid: { type: sql.UniqueIdentifier, value: schoolId } };

    if (status)   { where += ` AND sfa.status = @status`;   params.status = { type: sql.VarChar(50), value: status }; }
    if (grade_id) { where += ` AND g.id = @gradeId`;        params.gradeId = { type: sql.UniqueIdentifier, value: grade_id }; }
    if (search)   { where += ` AND (s.first_name + ' ' + s.last_name LIKE @search OR s.admission_no LIKE @search)`;
                    params.search = { type: sql.NVarChar(255), value: `%${search}%` }; }

    const count = await queryOne(
      `SELECT COUNT(*) AS total FROM student_fee_accounts sfa
       JOIN students s ON s.id = sfa.student_id
       LEFT JOIN enrolments e ON e.student_id = s.id AND e.school_id = @sid AND e.is_active=1
       LEFT JOIN sections sc  ON sc.id = e.section_id
       LEFT JOIN grades g     ON g.id = sc.grade_id
       WHERE ${where}`, params);

    const accounts = await query(
      `SELECT sfa.id, sfa.student_id, sfa.total_fee_paise, sfa.discount_paise,
              sfa.scholarship_paise, sfa.net_fee_paise, sfa.paid_paise,
              sfa.waived_paise, sfa.pending_paise, sfa.status, sfa.last_payment_date,
              s.first_name + ' ' + s.last_name AS student_name,
              s.admission_no, s.photo_url,
              g.name AS class_name, g.id AS grade_id,
              sc.name AS section_name, e.roll_no
       FROM student_fee_accounts sfa
       JOIN students s ON s.id = sfa.student_id
       LEFT JOIN enrolments e ON e.student_id = s.id AND e.school_id = @sid AND e.is_active=1
       LEFT JOIN sections sc  ON sc.id = e.section_id
       LEFT JOIN grades g     ON g.id = sc.grade_id
       WHERE ${where}
       ORDER BY sfa.pending_paise DESC, s.first_name
       OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
      { ...params, offset: { type: sql.Int, value: +offset }, limit: { type: sql.Int, value: +limit } }
    );

    return paginated(res, accounts.recordset, count.total, page, limit);
  } catch (err) { next(err); }
};

// ── GET /api/fees/accounts/:studentId ─────────────────────────────────────
exports.getStudentAccount = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { studentId } = req.params;

    const account = await queryOne(
      `SELECT sfa.*, s.first_name + ' ' + s.last_name AS student_name, s.admission_no
       FROM student_fee_accounts sfa
       JOIN students s ON s.id = sfa.student_id
       WHERE sfa.student_id = @studentId AND sfa.school_id = @sid AND sfa.deleted_at IS NULL`,
      { studentId: { type: sql.UniqueIdentifier, value: studentId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    if (!account) return notFound(res, 'Fee account not found');

    const invoices = await query(
      `SELECT fi.*, u.full_name AS created_by_name FROM fee_invoices fi
       LEFT JOIN users u ON u.id = fi.created_by
       WHERE fi.student_id = @studentId AND fi.school_id = @sid AND fi.deleted_at IS NULL
       ORDER BY fi.invoice_date DESC`,
      { studentId: { type: sql.UniqueIdentifier, value: studentId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );

    const payments = await query(
      `SELECT fp.*, u.full_name AS collected_by_name FROM fee_payments fp
       JOIN users u ON u.id = fp.collected_by
       WHERE fp.student_id = @studentId AND fp.school_id = @sid AND fp.deleted_at IS NULL
       ORDER BY fp.payment_date DESC`,
      { studentId: { type: sql.UniqueIdentifier, value: studentId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );

    return success(res, { account, invoices: invoices.recordset, payments: payments.recordset });
  } catch (err) { next(err); }
};

// ── POST /api/fees/payments ───────────────────────────────────────────────
// Record a fee payment
exports.recordPayment = async (req, res, next) => {
  try {
    const { schoolId, userId } = req.user;
    const {
      invoice_id, fee_account_id, student_id,
      amount_paise, payment_method, transaction_ref,
      bank_name, payment_date, remarks,
    } = req.body;

    if (!invoice_id || !fee_account_id || !student_id || !amount_paise)
      return badRequest(res, 'invoice_id, fee_account_id, student_id, amount_paise required');

    const paymentId = uuidv4();

    await withTransaction(async (tx) => {
      // Generate receipt number
      const rcptReq = tx.request();
      rcptReq.input('sid', sql.UniqueIdentifier, schoolId);
      const rcptResult = await rcptReq.query(
        `SELECT 'RCP-' + FORMAT(GETUTCDATE(),'yyyyMM') + '-' + RIGHT('0000' + CAST(COUNT(*)+1 AS VARCHAR),4) AS receipt_no
         FROM fee_payments WHERE school_id=@sid AND FORMAT(created_at,'yyyyMM') = FORMAT(GETUTCDATE(),'yyyyMM')`
      );
      const receipt_no = rcptResult.recordset[0].receipt_no;

      // Insert payment
      const p = tx.request();
      p.input('id',         sql.UniqueIdentifier, paymentId);
      p.input('sid',        sql.UniqueIdentifier, schoolId);
      p.input('invoiceId',  sql.UniqueIdentifier, invoice_id);
      p.input('feeAccId',   sql.UniqueIdentifier, fee_account_id);
      p.input('studentId',  sql.UniqueIdentifier, student_id);
      p.input('receiptNo',  sql.NVarChar(100),    receipt_no);
      p.input('payDate',    sql.Date,             payment_date || new Date());
      p.input('amount',     sql.BigInt,           amount_paise);
      p.input('method',     sql.VarChar(50),      payment_method);
      p.input('txRef',      sql.NVarChar(255),    transaction_ref || null);
      p.input('bank',       sql.NVarChar(255),    bank_name || null);
      p.input('collectedBy',sql.UniqueIdentifier, userId);
      p.input('remarks',    sql.NVarChar(sql.MAX), remarks || null);
      await p.query(
        `INSERT INTO fee_payments (id,school_id,invoice_id,fee_account_id,student_id,
           receipt_no,payment_date,amount_paise,payment_method,transaction_ref,
           bank_name,collected_by,remarks)
         VALUES(@id,@sid,@invoiceId,@feeAccId,@studentId,@receiptNo,@payDate,
           @amount,@method,@txRef,@bank,@collectedBy,@remarks)`
      );

      // Update invoice paid_paise + status
      const inv = tx.request();
      inv.input('amount', sql.BigInt, amount_paise);
      inv.input('invoiceId', sql.UniqueIdentifier, invoice_id);
      await inv.query(
        `UPDATE fee_invoices
         SET paid_paise = paid_paise + @amount,
             balance_paise = total_paise - paid_paise - @amount,
             status = CASE
               WHEN total_paise <= paid_paise + @amount THEN 'paid'
               ELSE 'partial' END,
             updated_at = GETUTCDATE()
         WHERE id = @invoiceId`
      );

      // Update fee account
      const acc = tx.request();
      acc.input('amount',   sql.BigInt, amount_paise);
      acc.input('accId',    sql.UniqueIdentifier, fee_account_id);
      acc.input('payDate',  sql.Date, payment_date || new Date());
      await acc.query(
        `UPDATE student_fee_accounts
         SET paid_paise    = paid_paise + @amount,
             pending_paise = CASE WHEN pending_paise - @amount < 0 THEN 0 ELSE pending_paise - @amount END,
             status        = CASE WHEN pending_paise - @amount <= 0 THEN 'paid' ELSE 'partial' END,
             last_payment_date = @payDate,
             updated_at    = GETUTCDATE()
         WHERE id = @accId`
      );
    });

    await audit({ req, action: 'PAYMENT', tableName: 'fee_payments', recordId: paymentId, newValues: req.body });
    return created(res, { id: paymentId }, 'Payment recorded successfully');
  } catch (err) { next(err); }
};

// ── DELETE /api/fees/payments/:id (void) ─────────────────────────────────
exports.voidPayment = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { schoolId, userId } = req.user;
    const { void_reason } = req.body;

    const payment = await queryOne(
      `SELECT * FROM fee_payments WHERE id=@id AND school_id=@sid AND is_void=0 AND deleted_at IS NULL`,
      { id: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    if (!payment) return notFound(res, 'Payment not found or already voided');

    await withTransaction(async (tx) => {
      const r1 = tx.request();
      r1.input('id', sql.UniqueIdentifier, id);
      r1.input('voidedBy', sql.UniqueIdentifier, userId);
      r1.input('reason', sql.NVarChar(sql.MAX), void_reason || null);
      await r1.query(
        `UPDATE fee_payments SET is_void=1, voided_by=@voidedBy, voided_at=GETUTCDATE(),
           void_reason=@reason WHERE id=@id`
      );
      // Reverse amounts
      const r2 = tx.request();
      r2.input('amount', sql.BigInt, payment.amount_paise);
      r2.input('invoiceId', sql.UniqueIdentifier, payment.invoice_id);
      await r2.query(
        `UPDATE fee_invoices SET paid_paise=paid_paise-@amount,
           balance_paise=balance_paise+@amount, status='partial', updated_at=GETUTCDATE()
         WHERE id=@invoiceId`
      );
      const r3 = tx.request();
      r3.input('amount', sql.BigInt, payment.amount_paise);
      r3.input('accId', sql.UniqueIdentifier, payment.fee_account_id);
      await r3.query(
        `UPDATE student_fee_accounts SET paid_paise=paid_paise-@amount,
           pending_paise=pending_paise+@amount, status='partial', updated_at=GETUTCDATE()
         WHERE id=@accId`
      );
    });

    await audit({ req, action: 'VOID_PAYMENT', tableName: 'fee_payments', recordId: id });
    return success(res, null, 'Payment voided');
  } catch (err) { next(err); }
};
