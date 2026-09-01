//src/routes/payments.js
const express = require('express');
const router = express.Router();
const paymentsController = require('../controllers/paymentsController');
const { authenticate, requireSchool } = require('../middleware/auth');

router.use(authenticate, requireSchool);

router.post('/razorpay/create-order', paymentsController.createOrder);
router.post('/razorpay/verify', paymentsController.verifyAndRecord);

module.exports = router;
