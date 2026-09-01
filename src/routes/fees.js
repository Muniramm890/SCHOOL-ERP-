// src/routes/fees.js
const router = require('express').Router();
const ctrl = require('../controllers/feesController');
const { authenticate, authorize } = require('../middleware/auth');

// 🔒 Sabhi routes ke liye mandatory authentication
router.use(authenticate);

// ── GET ROUTES (Reports, Lists & Student Financial Passbook) ──────────────
// Dashboard fee overview metrics & 6-month collection trend
router.get('/overview', ctrl.getOverview);

// Filterable & paginated student accounts list with real-time dues
router.get('/accounts', ctrl.listAccounts);

// Individual student passbook (Profile, Invoices list & Receipt history)
router.get('/accounts/:studentId', ctrl.getStudentAccount);

router.get('/structures', feesController.getFeeStructures);
router.put('/structures/bulk', feesController.bulkSaveFeeStructures);
router.get('/categories', feesController.listCategories);
router.post('/categories', feesController.createCategory);
router.post('/generate-invoices', feesController.generateInvoices);

// ── TRANSACTION & WRITE ROUTES (Role-Restricted & Audited) ────────────────
// Record new fee collection and auto-generate instant receipt
router.post(
  '/payments',
  authorize('admin', 'principal', 'accountant'),
  ctrl.recordPayment
);

// Void / Cancel a payment receipt & restore student balance (Restricted to Admin & Principal)
router.delete(
  '/payments/:id',
  authorize('admin', 'principal'),
  ctrl.voidPayment
);

// Configure / Update class-wise fee heads (Tuition, Transport, Exam, etc.)
router.post(
  '/structures',
  authorize('admin', 'principal'),
  ctrl.saveFeeStructure
);

module.exports = router;
