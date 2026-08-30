// src/routes/quickTests.js
// src/routes/quickTests.js
const router = require('express').Router();
const ctrl   = require('../controllers/quickTestsController');
const { authenticate, authorize } = require('../middleware/auth');

// 🔒 Secure all routes with JWT Authentication
router.use(authenticate);

// ── GET & POST ────────────────────────────────────────────────────────
router.get('/',              ctrl.list);                 // Fetch all tests (Supports filters: ?section_id=&subject_id=&status=)
router.post('/',             ctrl.create);               // Create new test (Supports OCR questions_payload)

// ── SINGLE TEST OPERATIONS ────────────────────────────────────────────
router.get('/:id',           ctrl.getOne);               // Get test metadata + full student roster & marks

// ── UPDATES ───────────────────────────────────────────────────────────
router.put('/:id/meta',      ctrl.updateMeta);           // 🟢 NEW: Update Settings (Status, Visibility, Duration, Max Marks)
router.put('/:id/results',   ctrl.saveResults);          // Save or Update student marks

// ── DELETE ────────────────────────────────────────────────────────────
router.delete('/:id',        authorize('admin','principal','teacher'), ctrl.remove); // Permanent Delete

module.exports = router;

