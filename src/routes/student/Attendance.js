//routes/student/Attendance.js
const router = require('express').Router();
const attendanceController = require('../controllers/attendanceController');
const { authenticateStudent } = require('../middleware/studentAuth');

router.use(authenticateStudent);

router.get('/me/history', (req, res, next) => {
  req.params.studentId = req.student.studentId;
  return attendanceController.getStudentHistory(req, res, next);
});

module.exports = router;
