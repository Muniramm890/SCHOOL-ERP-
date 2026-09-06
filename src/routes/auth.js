// src/routes/auth.js
const router = require('express').Router();
const ctrl   = require('../controllers/authController');
const signupCtrl = require('../controllers/signupController'); 
const { authenticate } = require('../middleware/auth');
const rateLimit = require('express-rate-limit'); // 
const forgotPasswordCtrl = require('../controllers/forgotPasswordController');

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
router.post('/signup/send-otp',   otpLimiter, signupCtrl.sendOtp);
router.post('/signup/verify-otp', signupCtrl.verifyOtp);
router.post('/signup/register',   signupCtrl.registerSchool);

// ── Forgot Password (WhatsApp or Email OTP) ─────────────────────────────

router.post('/forgot-password/send-otp',   otpLimiter, forgotPasswordCtrl.sendResetOtp);
router.post('/forgot-password/verify-otp', forgotPasswordCtrl.verifyResetOtp);
router.post('/forgot-password/reset',      forgotPasswordCtrl.resetPassword);

// ── Protected Routes ───────────────────────────────────────────────────
router.get('/me',               authenticate, ctrl.me);
router.put('/me',                authenticate, ctrl.updateProfile);
router.post('/change-password', authenticate, ctrl.changePassword);

module.exports = router;
