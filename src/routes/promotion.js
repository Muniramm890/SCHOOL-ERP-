// src/routes/promotion.js
const router = require('express').Router();
const ctrl = require('../controllers/promotionController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

router.get('/overview', ctrl.overview);
router.get('/section-students', ctrl.getSectionStudents);
router.post('/run', authorize('admin', 'principal', 'school_admin'), ctrl.runPromotion);
router.post('/section-change', ctrl.changeSection);
router.get('/history', ctrl.history);

module.exports = router;