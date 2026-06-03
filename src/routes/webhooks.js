// src/routes/attendance.js
const router = require('express').Router();
const ctrl   = require('../controllers/attendanceController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

// Student attendance
router.get('/',                       ctrl.getBySection);         // ?section_id=&date=
router.post('/bulk',                  ctrl.markBulk);             // bulk mark
router.get('/class-summary',          ctrl.getClassSummary);      // dashboard chart
router.get('/analysis',               ctrl.getSectionAnalysis);   // ?section_id=&month=&year=
router.get('/student/:studentId',     ctrl.getStudentAttendance); // individual calendar ?from=&to=

// Staff attendance
router.post('/staff/mark',            authorize('admin','principal','teacher'), ctrl.markStaff);

module.exports = router;
