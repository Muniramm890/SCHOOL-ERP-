// src/routes/results.js
const router = require('express').Router();
const ctrl   = require('../controllers/resultsController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

router.get('/',                   ctrl.getBySection);       // ?section_id=&exam_id=
router.post('/bulk',              ctrl.saveBulk);           // bulk marks entry
router.get('/leaderboard',        ctrl.getLeaderboard);     // ?section_id=&exam_id=&grade_id=
router.get('/analytics',          ctrl.getSectionAnalytics);// ?section_id=&exam_id=
router.get('/student/:studentId', ctrl.getStudentResult);   // ?exam_id=  (optional)

module.exports = router;
