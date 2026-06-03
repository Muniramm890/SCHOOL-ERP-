// src/routes/auth.js
const router = require('express').Router();
const ctrl   = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');

// Public
router.post('/login',           ctrl.login);
router.post('/refresh',         ctrl.refresh);

// Protected
router.get('/me',               authenticate, ctrl.me);
router.post('/change-password', authenticate, ctrl.changePassword);

module.exports = router;
