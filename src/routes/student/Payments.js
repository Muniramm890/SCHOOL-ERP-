//routes/student/Payments.js
const router = require('express').Router();
const paymentsController = require('../../controllers/paymentsController');
const { authenticateStudent } = require('../../middleware/studentAuth');

router.use(authenticateStudent);

const injectStudentAsUser = (req, res, next) => {
  req.user = { schoolId: req.student.schoolId, userId: req.student.studentId, fullName: req.student.fullName };
  req.body.student_id = req.student.studentId; // tampering se bachao — body ka student_id ignore, token se lo
  next();
};

router.post('/razorpay/create-order', injectStudentAsUser, paymentsController.createOrder);
router.post('/razorpay/verify', injectStudentAsUser, paymentsController.verifyAndRecord);

module.exports = router;
