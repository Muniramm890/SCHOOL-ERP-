///src/routes/student/Auth.js
const router = require('express').Router();
const ctrl = require('../../controllers/studentAuthController');
const forgotCtrl = require('../../controllers/studentForgotPasswordController');
const { authenticateStudent } = require('../../middleware/studentAuth');
const rateLimit = require('express-rate-limit');

const otpLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 3, message: { success: false, message: 'Too many OTP requests.' } });

router.post('/login', ctrl.login);
router.post('/forgot-password/send-otp', otpLimiter, forgotCtrl.sendResetOtp);
router.post('/forgot-password/verify-otp', forgotCtrl.verifyResetOtp);
router.post('/forgot-password/reset', forgotCtrl.resetPassword);

router.get('/me', authenticateStudent, ctrl.me);
router.put('/me', authenticateStudent, ctrl.updateProfile);
router.post('/change-password', authenticateStudent, ctrl.changePassword);
router.post('/logout', authenticateStudent, ctrl.logout);

module.exports = router;
