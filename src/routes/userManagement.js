// src/routes/userManagement.js
const router = require('express').Router();
const ctrl = require('../controllers/userManagementController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);
router.use(authorize()); // no args → sirf 'school_admin' (Super Admin) pass hoga

router.get('/staff', ctrl.listStaff);
router.get('/students-overview', ctrl.getStudentsOverview);

router.put('/:memberId/status', ctrl.updateStatus);
router.put('/:memberId/role', ctrl.updateRole);
router.put('/:memberId/permissions', ctrl.updatePermissions);
router.post('/:memberId/reset-password', ctrl.resetPassword);

router.get('/students', ctrl.listStudentsForAuth);
router.post('/students/:studentId/authorize', ctrl.authorizeStudent);
router.put('/students/:studentId/status', ctrl.updateStudentLoginStatus);
router.post('/students/:studentId/reset-password', ctrl.resetStudentPassword);

module.exports = router;
