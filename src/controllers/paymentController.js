// src/controllers/paymentController.js
const crypto = require('crypto');
const { sql, poolPromise } = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');
const logger = require('../config/logger');

const sch = process.env.DB_SCHEMA || 'whatsapp';

// Razorpay instance (lazy init)
let razorpay;
const getRazorpay = () => {
  if (!razorpay) {
    const Razorpay = require('razorpay');
    razorpay = new Razorpay({
      key_id:     process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return razorpay;
};

// ── LIST PLANS ────────────────────────────────────────────────
const listPlans = async (req, res, next) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .query(`SELECT * FROM ${sch}.plans WHERE is_active = 1 ORDER BY price ASC`);
    
    return sendSuccess(res, result.recordset);
  } catch (err) {
    next(err);
  }
};

// ── CREATE RAZORPAY ORDER ─────────────────────────────────────
const createOrder = async (req, res, next) => {
  try {
    const { plan_id } = req.body;
    const pool = await poolPromise;

    const planRes = await pool.request()
      .input('id', sql.Int, plan_id)
      .query(`SELECT * FROM ${sch}.plans WHERE id = @id AND is_active = 1`);

    if (!planRes.recordset.length) return sendError(res, 404, 'Plan not found');
    const plan = planRes.recordset[0];

    const order = await getRazorpay().orders.create({
      amount:   Math.round(plan.price * 100), // in paise
      currency: plan.currency,
      receipt:  `receipt_${req.clientId}_${Date.now()}`,
      notes:    { client_id: req.clientId, plan_id }
    });

    // Insert payment record using OUTPUT inserted.id for MSSQL
    const result = await pool.request()
      .input('clientId', sql.Int, req.clientId)
      .input('planId', sql.Int, plan_id)
      .input('amount', sql.Decimal(10, 2), plan.price)
      .input('curr', sql.Char(3), plan.currency)
      .input('orderId', sql.VarChar, order.id)
      .query(`
        INSERT INTO ${sch}.payments (client_id, plan_id, amount, currency, gateway, gateway_order_id, status)
        OUTPUT inserted.id
        VALUES (@clientId, @planId, @amount, @curr, 'razorpay', @orderId, 'created')
      `);

    return sendSuccess(res, {
      payment_id:   result.recordset[0].id,
      order_id:     order.id,
      amount:       order.amount,
      currency:     order.currency,
      key_id:       process.env.RAZORPAY_KEY_ID,
      plan:         plan,
    }, 'Order created');
  } catch (err) {
    next(err);
  }
};

// ── VERIFY PAYMENT ───────────────────────────────────────────
const verifyPayment = async (req, res, next) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, payment_db_id } = req.body;
    const pool = await poolPromise;

    // Verify signature
    const expectedSig = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSig !== razorpay_signature)
      return sendError(res, 400, 'Invalid payment signature');

    // Fetch payment from DB
    const payRes = await pool.request()
      .input('id', sql.Int, payment_db_id)
      .input('clientId', sql.Int, req.clientId)
      .query(`SELECT * FROM ${sch}.payments WHERE id = @id AND client_id = @clientId`);

    if (!payRes.recordset.length) return sendError(res, 404, 'Payment not found');
    const payment = payRes.recordset[0];

    const invoiceNum = `INV-${Date.now()}-${req.clientId}`;

    // Use Transaction for multiple updates
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      // 1. Update Payment
      await transaction.request()
        .input('pid', sql.VarChar, razorpay_payment_id)
        .input('sig', sql.VarChar, razorpay_signature)
        .input('inv', sql.VarChar, invoiceNum)
        .input('id', sql.Int, payment_db_id)
        .query(`
          UPDATE ${sch}.payments SET
            status = 'success', gateway_payment_id = @pid, gateway_signature = @sig,
            invoice_number = @inv, paid_at = GETDATE()
          WHERE id = @id
        `);

      // 2. Update Client Plan
      await transaction.request()
        .input('planId', sql.Int, payment.plan_id)
        .input('clientId', sql.Int, req.clientId)
        .query(`UPDATE ${sch}.clients SET plan_id = @planId WHERE id = @clientId`);

      // 3. Upsert Subscription (MSSQL MERGE)
      const billingDays = 30;
      await transaction.request()
        .input('clientId', sql.Int, req.clientId)
        .input('planId', sql.Int, payment.plan_id)
        .input('payId', sql.Int, payment_db_id)
        .input('days', sql.Int, billingDays)
        .query(`
          MERGE ${sch}.subscriptions AS target
          USING (SELECT @clientId as c) AS source
          ON (target.client_id = source.c)
          WHEN MATCHED THEN
            UPDATE SET plan_id = @planId, payment_id = @payId, status = 'active', 
                       starts_at = GETDATE(), ends_at = DATEADD(day, @days, GETDATE())
          WHEN NOT MATCHED THEN
            INSERT (client_id, plan_id, payment_id, status, starts_at, ends_at)
            VALUES (@clientId, @planId, @payId, 'active', GETDATE(), DATEADD(day, @days, GETDATE()));
        `);

      // 4. Create Notification
      const notifyBody = `Your plan has been activated. Invoice: ${invoiceNum}`;
      await transaction.request()
        .input('clientId', sql.Int, req.clientId)
        .input('body', sql.NVarChar, notifyBody)
        .query(`INSERT INTO ${sch}.notifications (client_id, type, title, body) VALUES (@clientId, 'payment_success', 'Payment Successful', @body)`);

      await transaction.commit();
    } catch (e) {
      await transaction.rollback();
      throw e;
    }

    logger.info(`Payment verified: ${razorpay_payment_id} for client ${req.clientId}`);
    return sendSuccess(res, { invoice_number: invoiceNum }, 'Payment verified and plan activated');
  } catch (err) {
    next(err);
  }
};

// ── PAYMENT HISTORY ───────────────────────────────────────────
const listPayments = async (req, res, next) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('clientId', sql.Int, req.clientId)
      .query(`
        SELECT p.id, p.amount, p.currency, p.gateway, p.status,
               p.invoice_number, p.paid_at, p.created_at,
               pl.name AS plan_name
        FROM ${sch}.payments p
        LEFT JOIN ${sch}.plans pl ON pl.id = p.plan_id
        WHERE p.client_id = @clientId ORDER BY p.created_at DESC
      `);
    return sendSuccess(res, result.recordset);
  } catch (err) {
    next(err);
  }
};

// ── RAZORPAY WEBHOOK ──────────────────────────────────────────
const razorpayWebhook = async (req, res, next) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const secret    = process.env.RAZORPAY_KEY_SECRET;

    const expected = crypto
      .createHmac('sha256', secret)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (expected !== signature) return res.sendStatus(400);

    const event   = req.body.event;
    const payload = req.body.payload?.payment?.entity;

    if (event === 'payment.failed' && payload) {
      const pool = await poolPromise;
      await pool.request()
        .input('orderId', sql.VarChar, payload.order_id)
        .query(`UPDATE ${sch}.payments SET status = 'failed' WHERE gateway_order_id = @orderId`);
    }

    return res.sendStatus(200);
  } catch (err) {
    next(err);
  }
};

module.exports = { listPlans, createOrder, verifyPayment, listPayments, razorpayWebhook };