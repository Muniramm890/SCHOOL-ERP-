//routes/studentDashboard.js
const router = require('express').Router();
const ctrl = require('../controllers/studentDashboardController');
const activityCtrl = require('../controllers/studentActivityController');
const { authenticateStudent } = require('../middleware/studentAuth');

router.use(authenticateStudent);
router.get('/', ctrl.getDashboard);
router.get('/notifications', ctrl.getNotifications);
router.put('/notifications/:id/read', ctrl.markNotificationRead);
router.get('/activity', activityCtrl.getMyActivity);

module.exports = router;
