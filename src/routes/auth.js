// src/routes/auth.js
const router = require('express').Router();
const ctrl   = require('../controllers/authController');
const signupCtrl = require('../controllers/signupController'); 
const { authenticate } = require('../middleware/auth');
const rateLimit = require('express-rate-limit'); // 

// ── Security: OTP Rate Limiter ─────────────────────────────────────────
// 10 मिनट के अंदर एक IP से अधिकतम 3 बार OTP मंगाया जा सकता है (Spam रोकने के लिए)
const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, 
  max: 3, 
  message: { success: false, message: 'Too many OTP requests. Please try again later.' }
});

// ── Public Routes (Login) ──────────────────────────────────────────────
router.post('/login',           ctrl.login);
router.post('/refresh',         ctrl.refresh);

//==========================================
router.post('/logout', authenticate, ctrl.logout);

// ── Public Routes (School Registration / Signup) ───────────────────────
// 🔴 ये 3 नए राउट्स आपके 3-स्टेप फॉर्म के लिए हैं
router.post('/signup/send-otp',   otpLimiter, signupCtrl.sendOtp);
router.post('/signup/verify-otp', signupCtrl.verifyOtp);
router.post('/signup/register',   signupCtrl.registerSchool);

// ── Protected Routes ───────────────────────────────────────────────────
router.get('/me',               authenticate, ctrl.me);
router.post('/change-password', authenticate, ctrl.changePassword);

module.exports = router;
