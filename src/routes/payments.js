// src/routes/payments.js
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/paymentController');
const { authClient } = require('../middleware/auth');

// ── Public Routes (No Login Required) ──

// Plans dikhane ke liye login ki zaroorat nahi hai
router.get('/plans', ctrl.listPlans);

// Razorpay Webhook: Ye gateway se server-to-server call hota hai
// express.json({ type: '*/*' }) ensures ye har tarah ke JSON content-type ko parse kare
router.post('/webhook/razorpay', express.json({ type: '*/*' }), ctrl.razorpayWebhook);


// ── Protected Routes (Login Mandatory) ──
router.use(authClient);

// Naya payment order generate karna
router.post('/order', ctrl.createOrder);

// Payment success ke baad signature verify karna
router.post('/verify', ctrl.verifyPayment);

// Purane saare payments ki history dekhna
router.get('/history', ctrl.listPayments);

module.exports = router;