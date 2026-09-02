// src/controllers/paymentController.js
const Razorpay = require('razorpay');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { withTransaction, queryOne, sql } = require('../config/db');
const { success, badRequest, notFound } = require('../utils/response');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ── POST /api/payments/razorpay/create-order ──────────────────────────────
// Only KEY_ID (public/publishable) ever goes back to frontend. KEY_SECRET never leaves server.
exports.createOrder = async (req, res, next) => {
  try {
    const { schoolId } = req.user;
    const { student_id, amount_paise } = req.body;

    if (!student_id || !amount_paise || amount_paise <= 0) {
      return badRequest(res, 'Valid student_id and positive amount_paise are required');
    }

       const student = await queryOne(
      `SELECT s.id, s.first_name + ' ' + ISNULL(s.last_name,'') AS student_name,
              sg.phone AS guardian_phone, sg.email AS guardian_email
       FROM students s
       LEFT JOIN student_guardians sg ON sg.student_id = s.id AND sg.is_primary=1 AND sg.deleted_at IS NULL
       WHERE s.id=@uid AND s.school_id=@sid AND s.deleted_at IS NULL`,
      { uid: { type: sql.UniqueIdentifier, value: student_id },
        sid: { type: sql.UniqueIdentifier, value: schoolId } }
    );
    if (!student) return notFound(res, 'Student not found');

    const receipt = `rcpt_${Date.now()}`;
    const order = await razorpay.orders.create({
      amount: amount_paise, // razorpay expects smallest currency unit = paise, matches our schema exactly
      currency: 'INR',
      receipt,
      notes: { student_id, school_id: schoolId, student_name: student.student_name },
    });

    return success(res, {
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RAZORPAY_KEY_ID, // safe to expose — this is the publishable key
      student_name: student.student_name,
    }, 'Order created');
  } catch (err) { next(err); }
};

// ── POST /api/payments/razorpay/verify ─────────────────────────────────────
exports.verifyAndRecord = async (req, res, next) => {
  try {
    const { schoolId, userId, fullName: userName } = req.user;
    const {
      razorpay_order_id, razorpay_payment_id, razorpay_signature,
      student_id, amount_paise, invoice_id, remarks,
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return badRequest(res, 'Missing Razorpay verification fields');
    }

    // ── CRITICAL SECURITY STEP: verify signature server-side using KEY_SECRET ──
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return badRequest(res, 'Payment signature verification failed — possible tampering');
    }

    // Double-check payment status directly with Razorpay (defense in depth)
    const rpPayment = await razorpay.payments.fetch(razorpay_payment_id);
    if (rpPayment.status !== 'captured' && rpPayment.status !== 'authorized') {
      return badRequest(res, `Payment not completed. Status: ${rpPayment.status}`);
    }
    if (rpPayment.order_id !== razorpay_order_id) {
      return badRequest(res, 'Order mismatch');
    }

    const paymentId = uuidv4();
    let generatedReceipt = '';

    await withTransaction(async (tx) => {
      const sReq = tx.request();
      sReq.input('sid', sql.UniqueIdentifier, schoolId);
      sReq.input('uid', sql.UniqueIdentifier, student_id);
      const sRes = await sReq.query(`
        SELECT sfa.id AS account_id
        FROM students s
        LEFT JOIN student_fee_accounts sfa ON sfa.student_id = s.id AND sfa.school_id = @sid
        WHERE s.id = @uid AND s.school_id = @sid
      `);
      let accountId = sRes.recordset[0]?.account_id;
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

      const rcptReq = tx.request();
      rcptReq.input('sid', sql.UniqueIdentifier, schoolId);
      const rcptRes = await rcptReq.query(`
        SELECT 'RCP-' + FORMAT(GETUTCDATE(), 'yyyyMM') + '-' + RIGHT('0000' + CAST(COUNT(*)+1 AS VARCHAR), 4) AS receipt_no
        FROM fee_payments WHERE school_id = @sid AND FORMAT(created_at, 'yyyyMM') = FORMAT(GETUTCDATE(), 'yyyyMM')
      `);
      generatedReceipt = rcptRes.recordset[0].receipt_no;

      const amt = Number(amount_paise) || rpPayment.amount;

      const pReq = tx.request();
      pReq.input('id', sql.UniqueIdentifier, paymentId);
      pReq.input('sid', sql.UniqueIdentifier, schoolId);
      pReq.input('invId', sql.UniqueIdentifier, invoice_id || null);
      pReq.input('aid', sql.UniqueIdentifier, accountId);
      pReq.input('uid', sql.UniqueIdentifier, student_id);
      pReq.input('rcpt', sql.NVarChar(100), generatedReceipt);
      pReq.input('amt', sql.BigInt, amt);
      pReq.input('mth', sql.VarChar(50), rpPayment.method === 'upi' ? 'UPI' : rpPayment.method === 'card' ? 'Card' : 'Online');
      pReq.input('ref', sql.NVarChar(255), razorpay_payment_id);
      pReq.input('cby', sql.UniqueIdentifier, userId);
      pReq.input('rmk', sql.NVarChar(sql.MAX), remarks || null);
      pReq.input('roid', sql.NVarChar(200), razorpay_order_id);
      pReq.input('rpid', sql.NVarChar(200), razorpay_payment_id);
      pReq.input('rsig', sql.NVarChar(500), razorpay_signature);
      await pReq.query(`
        INSERT INTO fee_payments (id, school_id, invoice_id, fee_account_id, student_id, receipt_no, payment_date, amount_paise, payment_method, transaction_ref, collected_by, remarks, gateway, razorpay_order_id, razorpay_payment_id, razorpay_signature)
        VALUES (@id, @sid, @invId, @aid, @uid, @rcpt, CONVERT(date, GETUTCDATE()), @amt, @mth, @ref, @cby, @rmk, 'razorpay', @roid, @rpid, @rsig)
      `);

      const accReq = tx.request();
      accReq.input('aid', sql.UniqueIdentifier, accountId);
      accReq.input('amt', sql.BigInt, amt);
      await accReq.query(`
        UPDATE student_fee_accounts
        SET paid_paise = paid_paise + @amt,
            pending_paise = CASE WHEN pending_paise - @amt < 0 THEN 0 ELSE pending_paise - @amt END,
            status = CASE WHEN pending_paise - @amt <= 0 THEN 'paid' ELSE 'partial' END,
            updated_at = GETUTCDATE()
        WHERE id = @aid
      `);

     if (invoice_id) {
        const invReq = tx.request();
        invReq.input('invId', sql.UniqueIdentifier, invoice_id);
        invReq.input('amt', sql.BigInt, amt);
        await invReq.query(`
          UPDATE fee_invoices
          SET paid_paise = paid_paise + @amt,
              balance_paise = CASE WHEN total_paise - discount_paise - paid_paise - @amt < 0 THEN 0 ELSE total_paise - discount_paise - paid_paise - @amt END,
              status = CASE WHEN total_paise - discount_paise <= paid_paise + @amt THEN 'paid' ELSE 'partial' END,
              updated_at = GETUTCDATE()
          WHERE id = @invId
        `);
      }
      
      // 🔴 NEW: Add Razorpay payment to Dashboard Recent Activity
      try {
        const logReq = tx.request();
        logReq.input('lid', sql.UniqueIdentifier, uuidv4());
        logReq.input('sid', sql.UniqueIdentifier, schoolId);
        logReq.input('uid', sql.UniqueIdentifier, userId);
        logReq.input('unm', sql.NVarChar(200), userName || 'Accountant');
        logReq.input('act', sql.NVarChar(50), 'FEE_PAID');
        logReq.input('det', sql.NVarChar(sql.MAX), JSON.stringify({
          studentName: "Student", // You can fetch real name if needed
          amount: (amt / 100).toFixed(0),
          receiptNo: generatedReceipt,
          paymentMethod: rpPayment.method === 'upi' ? 'UPI' : rpPayment.method === 'card' ? 'Card' : 'Razorpay Online'
        }));
        await logReq.query(`
          INSERT INTO audit_logs (id, school_id, user_id, user_name, action_type, details, created_at)
          VALUES (@lid, @sid, @uid, @unm, @act, @det, GETUTCDATE())
        `);
     } catch (logErr) {
        console.warn('Audit Logging Warning (Razorpay):', logErr.message);
      }
      
    });
    
       require('../services/receiptService').sendPaymentConfirmationWhatsapp(schoolId, paymentId); // fire & forget

       return success(res, { id: paymentId, receipt_no: generatedReceipt }, `Payment of ₹${(amount_paise/100).toFixed(2)} verified & recorded`);
  } catch (err) { next(err); }
};
