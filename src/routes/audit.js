//src/routes/audit.js
const router = require('express').Router();
const ctrl = require('../controllers/auditController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);
router.get('/', authorize('school_admin', 'admin', 'principal'), ctrl.getAuditLogs);
router.get('/recent-activity', ctrl.getRecentActivity);

module.exports = router;
