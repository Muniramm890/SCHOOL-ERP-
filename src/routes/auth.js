// src/routes/auth.js
const express = require('express');
const router  = express.Router();
const { body } = require('express-validator');
const ctrl    = require('../controllers/authController');
const { authClient } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');
const validate = require('../middleware/validate');

// ── Signup Route ──
router.post('/signup',
  authLimiter,
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  ],
  validate,
  ctrl.signup
);

// ── Email Verification ──
router.get('/verify-email/:token', ctrl.verifyEmail);

// ── Login Route ──
router.post('/login',
  authLimiter,
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  validate,
  ctrl.login
);

// ── Profile & Session ──
router.post('/logout',          authClient, ctrl.logout);
router.get('/profile',          authClient, ctrl.getProfile);

// ── Password Recovery ──
router.post('/forgot-password', 
  authLimiter, 
  [body('email').isEmail().normalizeEmail()], 
  validate, 
  ctrl.forgotPassword
);

router.post('/reset-password',  
  authLimiter,
  [
    body('token').notEmpty().withMessage('Token is required'),
    body('password').isLength({ min: 8 }).withMessage('New password must be at least 8 characters'),
  ],
  validate,
  ctrl.resetPassword
);

module.exports = router;
