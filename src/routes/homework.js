// src/routes/homework.js
const router = require('express').Router();
const ctrl   = require('../controllers/homeworkController');
const upload = require('../middleware/upload');
const { authenticate, authorize } = require('../middleware/auth');
const { authenticateStudent } = require('../middleware/studentAuth');

// ── STUDENT ROUTE (same file, same controller — before '/' so it never clashes) ──
router.get('/mine', authenticateStudent, ctrl.listForStudent);

// ── ADMIN / TEACHER ROUTES ─────────────────────────────────────────────
router.get('/',  authenticate, ctrl.list);
router.post('/', authenticate, authorize('admin','principal','teacher'), upload.array('files', 10), ctrl.create);
router.patch('/:id/visibility', authenticate, authorize('admin','principal','teacher'), ctrl.toggleVisibility);
router.delete('/:id', authenticate, authorize('admin','principal','teacher'), ctrl.remove);

module.exports = router;
