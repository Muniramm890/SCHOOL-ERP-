// src/controllers/feesController.js
const { query, queryOne, withTransaction, sql } = require('../config/db');
const { success, created, notFound, badRequest, paginated } = require('../utils/response');
const { v4: uuidv4 } = require('uuid');

// ── AUDIT LOGGER HELPER ───────────────────────────────────────────────────
const logAudit = async (tx, { schoolId, userId, userName, actionType, details }) => {
  try {
    const req = tx.request();
    req.input('lid', sql.UniqueIdentifier, uuidv4());
    req.input('sid', sql.UniqueIdentifier, schoolId);
    req.input('uid', sql.UniqueIdentifier, userId);
    req.input('unm', sql.NVarChar(200), userName || 'Accountant');
    req.input('act', sql.NVarChar(50), actionType);
    req.input('det', sql.NVarChar(sql.MAX), JSON.stringify(details));
    await req.query(`
      INSERT INTO audit_logs (id, school_id, user_id, user_name, action_type, details, created_at)
      VALUES (@lid, @sid, @uid, @unm, @act, @det, GETUTCDATE())
    `);
  } catch (e) {
    console.warn('Audit Logging Warning:', e.message);
  }
};

// ── 1. GET /api/fees/overview ─────────────────────────────────────────────
exports.getOverview = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const sid = { type: sql.UniqueIdentifier, value: schoolId };

    const [summary, byClass, monthly] = await Promise.all([
      queryOne(
        `SELECT
           ISNULL(SUM(paid_paise), 0)                                AS total_paid_paise,
           ISNULL(SUM(pending_paise), 0)                             AS total_pending_paise,
           ISNULL(SUM(total_fee_paise), 0)                           AS total_fee_paise,
           COUNT(CASE WHEN status='paid'    THEN 1 END)              AS paid_count,
           COUNT(CASE WHEN status='pending' THEN 1 END)              AS pending_count,
           COUNT(CASE WHEN status='partial' THEN 1 END)              AS partial_count,
           COUNT(DISTINCT student_id)                                AS total_students
         FROM student_fee_accounts WHERE school_id=@sid AND deleted_at IS NULL`,
        { sid }
      ),
      query(
        `SELECT g.name AS class_name, ISNULL(g.numeric_order, 99) AS numeric_order,
                ISNULL(SUM(sfa.paid_paise), 0)    AS paid_paise,
                ISNULL(SUM(sfa.pending_paise), 0) AS pending_paise,
                COUNT(sfa.student_id)             AS student_count
         FROM grades g
         JOIN sections sc   ON sc.grade_id = g.id AND sc.school_id = @sid AND sc.deleted_at IS NULL
         JOIN enrolments e  ON e.section_id = sc.id AND e.school_id = @sid AND e.is_active = 1 AND e.deleted_at IS NULL
         LEFT JOIN student_fee_accounts sfa ON sfa.student_id = e.student_id AND sfa.school_id = @sid AND sfa.deleted_at IS NULL
         WHERE g.school_id = @sid AND g.deleted_at IS NULL
         GROUP BY g.name, g.numeric_order
         ORDER BY numeric_order`,
        { sid }
      ),
      query(
        `SELECT YEAR(payment_date) AS yr, MONTH(payment_date) AS mo,
                ISNULL(SUM(amount_paise), 0) AS collected_paise, COUNT(*) AS txn_count
         FROM fee_payments
         WHERE school_id = @sid AND is_void = 0 AND deleted_at IS NULL
           AND payment_date >= DATEADD(MONTH, -6, GETUTCDATE())
         GROUP BY YEAR(payment_date), MONTH(payment_date)
         ORDER BY yr, mo`,
        { sid }
      ),
    ]);

    return success(res, {
      summary: summary || { total_paid_paise: 0, total_pending_paise: 0, total_fee_paise: 0 },
      byClass: byClass?.recordset || [],
      monthly: monthly?.recordset || []
    }, 'Fee overview calculated');
  } catch (err) { next(err); }
};

// ── 2. GET /api/fees/accounts ─────────────────────────────────────────────
exports.listAccounts = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 25;
    const offset = (page - 1) * limit;
    const { grade_id, status, search } = req.query;

    let where = `s.school_id = @sid AND s.deleted_at IS NULL`;
    const params = { sid: { type: sql.UniqueIdentifier, value: schoolId } };

    if (status) {
      where += ` AND ISNULL(sfa.status, 'pending') = @status`;
      params.status = { type: sql.VarChar(50), value: status.toLowerCase() };
    }
    if (grade_id) {
      where += ` AND g.id = @gradeId`;
      params.gradeId = { type: sql.UniqueIdentifier, value: grade_id };
    }
    if (search) {
      where += ` AND (s.first_name + ' ' + ISNULL(s.last_name, '') LIKE @search OR s.admission_no LIKE @search)`;
      params.search = { type: sql.NVarChar(255), value: `%${search.trim()}%` };
    }

    const count = await queryOne(
      `SELECT COUNT(DISTINCT s.id) AS total
       FROM students s
       LEFT JOIN enrolments e ON e.student_id = s.id AND e.school_id = @sid AND e.is_active = 1 AND e.deleted_at IS NULL
       LEFT JOIN sections sc  ON sc.id = e.section_id AND sc.school_id = @sid
       LEFT JOIN grades g     ON g.id = sc.grade_id AND g.school_id = @sid
       LEFT JOIN student_fee_accounts sfa ON sfa.student_id = s.id AND sfa.school_id = @sid AND sfa.deleted_at IS NULL
       WHERE ${where}`, params
    );

    const accounts = await query(
      `SELECT s.id AS student_id,
              s.first_name + ' ' + ISNULL(s.last_name, '') AS student_name,
              s.admission_no, s.photo_url,
              g.name AS class_name, g.id AS grade_id,
              sc.name AS section_name, e.roll_no,
              ISNULL(sfa.id, NEWID()) AS fee_account_id,
              ISNULL(sfa.total_fee_paise, 0) AS total_fee_paise,
              ISNULL(sfa.paid_paise, 0)      AS paid_paise,
              ISNULL(sfa.pending_paise, 0)   AS pending_paise,
              ISNULL(sfa.status, 'pending')  AS status
       FROM students s
       LEFT JOIN enrolments e ON e.student_id = s.id AND e.school_id = @sid AND e.is_active = 1 AND e.deleted_at IS NULL
       LEFT JOIN sections sc  ON sc.id = e.section_id AND sc.school_id = @sid
       LEFT JOIN grades g     ON g.id = sc.grade_id AND g.school_id = @sid
       LEFT JOIN student_fee_accounts sfa ON sfa.student_id = s.id AND sfa.school_id = @sid AND sfa.deleted_at IS NULL
       WHERE ${where}
       ORDER BY ISNULL(sfa.pending_paise, 0) DESC, s.first_name ASC
       OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
      { ...params, offset: { type: sql.Int, value: offset }, limit: { type: sql.Int, value: limit } }
    );

    return paginated(res, accounts.recordset, count?.total || 0, page, limit);
  } catch (err) { next(err); }
};

// ── 3. GET /api/fees/accounts/:studentId ──────────────────────────────────
exports.getStudentAccount = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { studentId } = req.params;

    const student = await queryOne(
      `SELECT s.id, s.first_name + ' ' + ISNULL(s.last_name, '') AS student_name,
              s.admission_no, s.photo_url, g.name AS class_name, sc.name AS section_name,
              sfa.id AS fee_account_id,
              ISNULL(sfa.total_fee_paise, 0) AS total_fee_paise,
              ISNULL(sfa.paid_paise, 0) AS paid_paise,
              ISNULL(sfa.pending_paise, 0) AS pending_paise,
              ISNULL(sfa.status, 'pending') AS status
       FROM students s
       LEFT JOIN enrolments e ON e.student_id = s.id AND e.school_id = @sid AND e.is_active = 1
       LEFT JOIN sections sc  ON sc.id = e.section_id
       LEFT JOIN grades g     ON g.id = sc.grade_id
       LEFT JOIN student_fee_accounts sfa ON sfa.student_id = s.id AND sfa.school_id = @sid
       WHERE s.id = @uid AND s.school_id = @sid AND s.deleted_at IS NULL`,
      { uid: { type: sql.UniqueIdentifier, value: studentId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    if (!student) return notFound(res, 'Student not found');

    const [invoices, payments] = await Promise.all([
      query(
        `SELECT fi.* FROM fee_invoices fi
         WHERE fi.student_id = @uid AND fi.school_id = @sid AND fi.deleted_at IS NULL
         ORDER BY fi.due_date DESC`,
        { uid: { type: sql.UniqueIdentifier, value: studentId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
      ),
      query(
        `SELECT fp.*, u.full_name AS collected_by_name FROM fee_payments fp
         LEFT JOIN users u ON u.id = fp.collected_by
         WHERE fp.student_id = @uid AND fp.school_id = @sid AND fp.deleted_at IS NULL
         ORDER BY fp.payment_date DESC`,
        { uid: { type: sql.UniqueIdentifier, value: studentId }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
      )
    ]);

    return success(res, {
      account: student,
      invoices: invoices?.recordset || [],
      payments: payments?.recordset || []
    }, 'Student financial records fetched');
  } catch (err) { next(err); }
};

// ── 4. POST /api/fees/payments ────────────────────────────────────────────
exports.recordPayment = async (req, res, next) => {
  try {
    const { schoolId, id: userId, name: userName } = req.user;
    const {
      student_id, amount_paise, payment_method,
      transaction_ref, bank_name, payment_date, remarks,
      invoice_id
    } = req.body;

    if (!student_id || !amount_paise || amount_paise <= 0) {
      return badRequest(res, 'Valid student_id and positive amount_paise are required');
    }

    const paymentId = uuidv4();
    let generatedReceipt = '';
    let studentName = '';

    await withTransaction(async (tx) => {
      // 1. Fetch Student Details
      const sReq = tx.request();
      sReq.input('sid', sql.UniqueIdentifier, schoolId);
      sReq.input('uid', sql.UniqueIdentifier, student_id);
      const sRes = await sReq.query(`
        SELECT s.first_name + ' ' + ISNULL(s.last_name, '') AS student_name, sfa.id AS account_id,
               ISNULL(sfa.pending_paise, 0) AS pending_paise,
               ISNULL(sfa.paid_paise, 0) AS paid_paise
        FROM students s
        LEFT JOIN student_fee_accounts sfa ON sfa.student_id = s.id AND sfa.school_id = @sid
        WHERE s.id = @uid AND s.school_id = @sid
      `);
      if (!sRes.recordset.length) throw new Error('Student record not found');
      
      studentName = sRes.recordset[0].student_name;
      let accountId = sRes.recordset[0].account_id;

      // Ensure Fee Account exists
      if (!accountId) {
        accountId = uuidv4();
        const crAcc = tx.request();
        crAcc.input('aid', sql.UniqueIdentifier, accountId);
        crAcc.input('sid', sql.UniqueIdentifier, schoolId);
        crAcc.input('uid', sql.UniqueIdentifier, student_id);
        await crAcc.query(`
          INSERT INTO student_fee_accounts (id, school_id, student_id, total_fee_paise, paid_paise, pending_paise, status)
          VALUES (@aid, @sid, @uid, 0, 0, 0, 'pending')
        `);
      }

      // 2. Atomic Receipt Generation
      const rcptReq = tx.request();
      rcptReq.input('sid', sql.UniqueIdentifier, schoolId);
      const rcptRes = await rcptReq.query(`
        SELECT 'RCP-' + FORMAT(GETUTCDATE(), 'yyyyMM') + '-' + RIGHT('0000' + CAST(COUNT(*)+1 AS VARCHAR), 4) AS receipt_no
        FROM fee_payments WHERE school_id = @sid AND FORMAT(created_at, 'yyyyMM') = FORMAT(GETUTCDATE(), 'yyyyMM')
      `);
      generatedReceipt = rcptRes.recordset[0].receipt_no;

      // 3. Insert Payment
      const pReq = tx.request();
      pReq.input('id', sql.UniqueIdentifier, paymentId);
      pReq.input('sid', sql.UniqueIdentifier, schoolId);
      pReq.input('invId', sql.UniqueIdentifier, invoice_id || null);
      pReq.input('aid', sql.UniqueIdentifier, accountId);
      pReq.input('uid', sql.UniqueIdentifier, student_id);
      pReq.input('rcpt', sql.NVarChar(100), generatedReceipt);
      pReq.input('dt', sql.Date, payment_date || new Date());
      pReq.input('amt', sql.BigInt, amount_paise);
      pReq.input('mth', sql.VarChar(50), payment_method || 'Cash');
      pReq.input('ref', sql.NVarChar(255), transaction_ref || null);
      pReq.input('bnk', sql.NVarChar(255), bank_name || null);
      pReq.input('cby', sql.UniqueIdentifier, userId);
      pReq.input('rmk', sql.NVarChar(sql.MAX), remarks || null);
      await pReq.query(`
        INSERT INTO fee_payments (id, school_id, invoice_id, fee_account_id, student_id, receipt_no, payment_date, amount_paise, payment_method, transaction_ref, bank_name, collected_by, remarks)
        VALUES (@id, @sid, @invId, @aid, @uid, @rcpt, @dt, @amt, @mth, @ref, @bnk, @cby, @rmk)
      `);

      // 4. Update Student Fee Account
      const accReq = tx.request();
      accReq.input('aid', sql.UniqueIdentifier, accountId);
      accReq.input('amt', sql.BigInt, amount_paise);
      await accReq.query(`
        UPDATE student_fee_accounts
        SET paid_paise = paid_paise + @amt,
            pending_paise = CASE WHEN pending_paise - @amt < 0 THEN 0 ELSE pending_paise - @amt END,
            status = CASE WHEN pending_paise - @amt <= 0 THEN 'paid' ELSE 'partial' END,
            updated_at = GETUTCDATE()
        WHERE id = @aid
      `);

      // 5. Update Invoice if linked
      if (invoice_id) {
        const invReq = tx.request();
        invReq.input('invId', sql.UniqueIdentifier, invoice_id);
        invReq.input('amt', sql.BigInt, amount_paise);
        await invReq.query(`
          UPDATE fee_invoices
          SET paid_paise = paid_paise + @amt,
              balance_paise = CASE WHEN total_paise - discount_paise - paid_paise - @amt < 0 THEN 0 ELSE total_paise - discount_paise - paid_paise - @amt END,
              status = CASE WHEN total_paise - discount_paise <= paid_paise + @amt THEN 'paid' ELSE 'partial' END,
              updated_at = GETUTCDATE()
          WHERE id = @invId
        `);
      }

      // 6. Log to Dashboard Recent Activity
      await logAudit(tx, {
        schoolId,
        userId,
        userName,
        actionType: 'FEE_PAID',
        details: {
          studentName,
          amount: (amount_paise / 100).toFixed(0),
          receiptNo: generatedReceipt,
          paymentMethod: payment_method || 'Cash'
        }
      });
    });

    return created(res, { id: paymentId, receipt_no: generatedReceipt }, `Payment of ₹${(amount_paise/100).toFixed(2)} recorded successfully`);
  } catch (err) { next(err); }
};

// ── 5. DELETE /api/fees/payments/:id (Void Transaction) ───────────────────
exports.voidPayment = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { schoolId, id: userId, name: userName } = req.user;
    const { void_reason } = req.body;

    if (!void_reason) return badRequest(res, 'A valid reason is required to void this receipt');

    const payment = await queryOne(
      `SELECT * FROM fee_payments WHERE id = @id AND school_id = @sid AND is_void = 0 AND deleted_at IS NULL`,
      { id: { type: sql.UniqueIdentifier, value: id }, sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    if (!payment) return notFound(res, 'Payment transaction not found or already voided');

    await withTransaction(async (tx) => {
      // 1. Mark Void
      const vReq = tx.request();
      vReq.input('id', sql.UniqueIdentifier, id);
      vReq.input('vby', sql.UniqueIdentifier, userId);
      vReq.input('rsn', sql.NVarChar(sql.MAX), void_reason);
      await vReq.query(`
        UPDATE fee_payments 
        SET is_void = 1, voided_by = @vby, voided_at = GETUTCDATE(), void_reason = @rsn, updated_at = GETUTCDATE()
        WHERE id = @id
      `);

      // 2. Reverse Student Fee Account
      const accReq = tx.request();
      accReq.input('aid', sql.UniqueIdentifier, payment.fee_account_id);
      accReq.input('amt', sql.BigInt, payment.amount_paise);
      await accReq.query(`
        UPDATE student_fee_accounts
        SET paid_paise = CASE WHEN paid_paise - @amt < 0 THEN 0 ELSE paid_paise - @amt END,
            pending_paise = pending_paise + @amt,
            status = 'partial',
            updated_at = GETUTCDATE()
        WHERE id = @aid
      `);

      // 3. Reverse Invoice if linked
      if (payment.invoice_id) {
        const invReq = tx.request();
        invReq.input('invId', sql.UniqueIdentifier, payment.invoice_id);
        invReq.input('amt', sql.BigInt, payment.amount_paise);
        await invReq.query(`
          UPDATE fee_invoices
          SET paid_paise = CASE WHEN paid_paise - @amt < 0 THEN 0 ELSE paid_paise - @amt END,
              balance_paise = balance_paise + @amt,
              status = 'partial',
              updated_at = GETUTCDATE()
          WHERE id = @invId
        `);
      }
    });

    return success(res, null, 'Payment receipt voided and balances restored');
  } catch (err) { next(err); }
};

// ── 6. POST /api/fees/structures (Class-wise Fee Head Configuration) ───────
exports.saveFeeStructure = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { grade_id, academic_year_id, category_name, amount_paise, frequency } = req.body;

    if (!grade_id || !academic_year_id || !category_name || !amount_paise) {
      return badRequest(res, 'grade_id, academic_year_id, category_name, and amount_paise are required');
    }

    await withTransaction(async (tx) => {
      // Find or create Category Head
      let cat = await queryOne(
        `SELECT id FROM fee_categories WHERE school_id = @sid AND name = @name AND deleted_at IS NULL`,
        { sid: { type: sql.UniqueIdentifier, value: schoolId }, name: { type: sql.NVarChar(100), value: category_name.trim() } }
      );
      let catId = cat ? cat.id : uuidv4();

      if (!cat) {
        const cReq = tx.request();
        cReq.input('cid', sql.UniqueIdentifier, catId);
        cReq.input('sid', sql.UniqueIdentifier, schoolId);
        cReq.input('name', sql.NVarChar(100), category_name.trim());
        await cReq.query(`INSERT INTO fee_categories (id, school_id, name) VALUES (@cid, @sid, @name)`);
      }

      // Upsert Fee Structure
      const sReq = tx.request();
      sReq.input('sid', sql.UniqueIdentifier, schoolId);
      sReq.input('gid', sql.UniqueIdentifier, grade_id);
      sReq.input('cid', sql.UniqueIdentifier, catId);
      sReq.input('ayid', sql.UniqueIdentifier, academic_year_id);
      sReq.input('amt', sql.BigInt, amount_paise);
      sReq.input('freq', sql.VarChar(20), frequency || 'monthly');

      await sReq.query(`
        MERGE fee_structures AS target
        USING (SELECT @sid AS school_id, @gid AS grade_id, @cid AS fee_category_id, @ayid AS academic_year_id) AS source
        ON (target.school_id = source.school_id AND target.grade_id = source.grade_id AND target.fee_category_id = source.fee_category_id AND target.academic_year_id = source.academic_year_id)
        WHEN MATCHED THEN
          UPDATE SET amount_paise = @amt, frequency = @freq, updated_at = GETUTCDATE()
        WHEN NOT MATCHED THEN
          INSERT (id, school_id, grade_id, fee_category_id, academic_year_id, amount_paise, frequency)
          VALUES (NEWID(), @sid, @gid, @cid, @ayid, @amt, @freq);
      `);
    });

    return success(res, null, 'Fee structure configured successfully');
  } catch (err) { next(err); }
};

// GET /api/fees/structures?academic_year_id=
exports.getFeeStructures = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { academic_year_id } = req.query;
    const rows = await query(`
      SELECT fs.id, fs.grade_id, g.name AS grade_name, g.numeric_order,
             fs.fee_category_id, fc.name AS category_name,
             fs.amount_paise, fs.frequency, fs.due_day_of_month,
             fs.late_fee_paise, fs.grace_days
      FROM fee_structures fs
      JOIN grades g ON g.id = fs.grade_id
      JOIN fee_categories fc ON fc.id = fs.fee_category_id
      WHERE fs.school_id=@sid AND fs.academic_year_id=@ayid AND fs.deleted_at IS NULL
      ORDER BY g.numeric_order, fc.name`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId },
        ayid: { type: sql.UniqueIdentifier, value: academic_year_id } });
    return success(res, rows.recordset);
  } catch (err) { next(err); }
};

// GET /api/fees/categories
exports.listCategories = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const rows = await query(
      `SELECT id, name, is_recurring FROM fee_categories WHERE school_id=@sid AND is_active=1 AND deleted_at IS NULL ORDER BY name`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId } });
    return success(res, rows.recordset);
  } catch (err) { next(err); }
};

// POST /api/fees/categories
exports.createCategory = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { name, is_recurring } = req.body;
    if (!name) return badRequest(res, 'name is required');
    const id = uuidv4();
    await query(
      `INSERT INTO fee_categories (id, school_id, name, is_recurring) VALUES (@id,@sid,@name,@rec)`,
      { id: { type: sql.UniqueIdentifier, value: id },
        sid: { type: sql.UniqueIdentifier, value: schoolId },
        name: { type: sql.NVarChar(200), value: name.trim() },
        rec: { type: sql.Bit, value: is_recurring !== false } });
    return created(res, { id }, 'Category created');
  } catch (err) { next(err); }
};

// PUT /api/fees/structures/bulk
exports.bulkSaveFeeStructures = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { academic_year_id, entries } = req.body; // [{grade_id, fee_category_id, amount_paise, frequency, due_day_of_month, late_fee_paise, grace_days}]
    if (!academic_year_id || !Array.isArray(entries)) return badRequest(res, 'academic_year_id and entries[] required');

    await withTransaction(async (tx) => {
      for (const e of entries) {
        const r = tx.request();
        r.input('sid', sql.UniqueIdentifier, schoolId);
        r.input('gid', sql.UniqueIdentifier, e.grade_id);
        r.input('cid', sql.UniqueIdentifier, e.fee_category_id);
        r.input('ayid', sql.UniqueIdentifier, academic_year_id);
        r.input('amt', sql.BigInt, e.amount_paise);
        r.input('freq', sql.VarChar(20), e.frequency || 'monthly');
        r.input('due', sql.SmallInt, e.due_day_of_month || 10);
        r.input('late', sql.BigInt, e.late_fee_paise || 0);
        r.input('grace', sql.SmallInt, e.grace_days || 0);
        await r.query(`
          MERGE fee_structures AS t
          USING (SELECT @sid sid,@gid gid,@cid cid,@ayid ayid) s
          ON (t.school_id=s.sid AND t.grade_id=s.gid AND t.fee_category_id=s.cid AND t.academic_year_id=s.ayid)
          WHEN MATCHED THEN UPDATE SET amount_paise=@amt, frequency=@freq, due_day_of_month=@due,
            late_fee_paise=@late, grace_days=@grace, updated_at=GETUTCDATE()
          WHEN NOT MATCHED THEN INSERT (id, school_id, grade_id, fee_category_id, academic_year_id, amount_paise, frequency, due_day_of_month, late_fee_paise, grace_days)
            VALUES (NEWID(),@sid,@gid,@cid,@ayid,@amt,@freq,@due,@late,@grace);
        `);
      }
    });
    return success(res, null, 'Fee structures saved');
  } catch (err) { next(err); }
};

// POST /api/fees/generate-invoices  { grade_id?, academic_year_id, month_index, title, due_date }
exports.generateInvoices = async (req, res, next) => {
  try {
    const { schoolId, id: userId, name: userName } = req.user;
    const { grade_id, academic_year_id, month_index, title, due_date } = req.body;
    if (!academic_year_id || !title || !due_date) return badRequest(res, 'academic_year_id, title, due_date required');

    let genCount = 0;
    await withTransaction(async (tx) => {
      const sReq = tx.request();
      sReq.input('sid', sql.UniqueIdentifier, schoolId);
      sReq.input('ayid', sql.UniqueIdentifier, academic_year_id);
      if (grade_id) sReq.input('gid', sql.UniqueIdentifier, grade_id);
      const students = await sReq.query(`
        SELECT s.id AS student_id, g.id AS grade_id
        FROM students s
        JOIN enrolments e ON e.student_id=s.id AND e.school_id=@sid AND e.academic_year_id=@ayid AND e.is_active=1 AND e.deleted_at IS NULL
        JOIN sections sc ON sc.id=e.section_id
        JOIN grades g ON g.id=sc.grade_id ${grade_id ? 'AND g.id=@gid' : ''}
        WHERE s.school_id=@sid AND s.deleted_at IS NULL AND s.is_active=1
      `);

      for (const stu of students.recordset) {
        const fReq = tx.request();
        fReq.input('sid', sql.UniqueIdentifier, schoolId);
        fReq.input('gid', sql.UniqueIdentifier, stu.grade_id);
        fReq.input('ayid', sql.UniqueIdentifier, academic_year_id);
        const structs = await fReq.query(`
          SELECT fee_category_id, amount_paise FROM fee_structures
          WHERE school_id=@sid AND grade_id=@gid AND academic_year_id=@ayid AND is_active=1 AND deleted_at IS NULL
        `);
        if (!structs.recordset.length) continue;
        const total = structs.recordset.reduce((s, r) => s + r.amount_paise, 0);

        const invId = uuidv4();
        const numReq = tx.request();
        numReq.input('sid', sql.UniqueIdentifier, schoolId);
        const numRes = await numReq.query(`
          SELECT 'INV-' + FORMAT(GETUTCDATE(),'yyyyMM') + '-' + RIGHT('0000'+CAST(COUNT(*)+1 AS VARCHAR),4) AS invoice_no
          FROM fee_invoices WHERE school_id=@sid AND FORMAT(created_at,'yyyyMM')=FORMAT(GETUTCDATE(),'yyyyMM')`);
        const invoiceNo = numRes.recordset[0].invoice_no;

        const iReq = tx.request();
        iReq.input('id', sql.UniqueIdentifier, invId);
        iReq.input('sid', sql.UniqueIdentifier, schoolId);
        iReq.input('uid', sql.UniqueIdentifier, stu.student_id);
        iReq.input('ayid', sql.UniqueIdentifier, academic_year_id);
        iReq.input('no', sql.NVarChar(200), invoiceNo);
        iReq.input('title', sql.NVarChar(510), title);
        iReq.input('mo', sql.SmallInt, month_index || null);
        iReq.input('due', sql.Date, due_date);
        iReq.input('total', sql.BigInt, total);
        iReq.input('cby', sql.UniqueIdentifier, userId);
        await iReq.query(`
          INSERT INTO fee_invoices (id, school_id, student_id, academic_year_id, invoice_no, title, month_index, due_date, total_paise, balance_paise, created_by)
          VALUES (@id,@sid,@uid,@ayid,@no,@title,@mo,@due,@total,@total,@cby)
        `);

        for (const item of structs.recordset) {
          const itReq = tx.request();
          itReq.input('iid', sql.UniqueIdentifier, invId);
          itReq.input('cid', sql.UniqueIdentifier, item.fee_category_id);
          itReq.input('amt', sql.BigInt, item.amount_paise);
          await itReq.query(`INSERT INTO fee_invoice_items (id, invoice_id, fee_category_id, amount_paise) VALUES (NEWID(),@iid,@cid,@amt)`);
        }

        const accReq = tx.request();
        accReq.input('sid', sql.UniqueIdentifier, schoolId);
        accReq.input('uid', sql.UniqueIdentifier, stu.student_id);
        accReq.input('amt', sql.BigInt, total);
        await accReq.query(`
          MERGE student_fee_accounts AS t
          USING (SELECT @sid sid,@uid uid) s ON (t.school_id=s.sid AND t.student_id=s.uid)
          WHEN MATCHED THEN UPDATE SET total_fee_paise=total_fee_paise+@amt, pending_paise=pending_paise+@amt, status='pending', updated_at=GETUTCDATE()
          WHEN NOT MATCHED THEN INSERT (id, school_id, student_id, total_fee_paise, pending_paise, status)
            VALUES (NEWID(),@sid,@uid,@amt,@amt,'pending');
        `);
        genCount++;
      }
      await logAudit(tx, { schoolId, userId, userName, actionType: 'INVOICES_GENERATED', details: { title, count: genCount } });
    });

    return success(res, { generated: genCount }, `${genCount} invoices generated`);
  } catch (err) { next(err); }
};
