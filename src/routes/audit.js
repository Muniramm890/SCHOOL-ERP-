// src/routes/audit.js
const router = require('express').Router();
const ctrl = require('../controllers/auditController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

// Dashboard "Recent Activities" widget — any logged-in staff member can see this
router.get('/recent-activity', ctrl.getRecentActivity);

// Full audit trail — Super Admin only
router.get('/', authorize(), ctrl.getAuditLogs);
router.get('/stats', authorize(), ctrl.getStats);
router.delete('/cleanup', authorize(), ctrl.cleanupOldLogs);

module.exports = router;
