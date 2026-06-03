// src/routes/fees.js
const router = require('express').Router();
const ctrl   = require('../controllers/feesController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

router.get('/overview',                ctrl.getOverview);          // dashboard fee charts
router.get('/accounts',                ctrl.listAccounts);         // all students fee list
router.get('/accounts/:studentId',     ctrl.getStudentAccount);    // invoices + payment history

router.post('/payments',               authorize('admin','principal','accountant'), ctrl.recordPayment);
router.delete('/payments/:id',         authorize('admin','principal'), ctrl.voidPayment);

module.exports = router;
