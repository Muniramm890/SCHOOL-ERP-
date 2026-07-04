
// src/routes/attendanceRoutes.js
const express = require('express');
const router = express.Router();
const attendanceController = require('../controllers/attendanceController');
const { authenticate, authorize } = require('../middleware/auth');
// const { authenticate } = require('../middleware/auth'); // aap ka existing auth middleware jo bhi ho

// Students
router.get('/students/roster', attendanceController.getSectionRoster);
router.post('/students/mark', attendanceController.markStudentAttendance);
router.get('/students/analysis', attendanceController.getClassAnalysis);
router.get('/students/school-overview', attendanceController.getSchoolOverview);
router.get('/students/:studentId/history', attendanceController.getStudentHistory);

// Staff / Teachers
router.get('/staff/roster', attendanceController.getStaffRoster);
router.post('/staff/mark', attendanceController.markStaffAttendance);
router.get('/staff/analysis', attendanceController.getStaffAnalysis);
router.get('/staff/:userId/history', attendanceController.getStaffHistory);

module.exports = router;
