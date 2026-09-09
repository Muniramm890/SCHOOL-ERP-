//routes/student/Fees.js
const router = require('express').Router();
const feesController = require('../controllers/feesController');
const { authenticateStudent } = require('../middleware/studentAuth');

router.use(authenticateStudent);

router.get('/me', (req, res, next) => {
  req.params.studentId = req.student.studentId;
  return feesController.getStudentAccount(req, res, next);
});

router.get('/me/receipt/:paymentId', (req, res, next) => {
  req.params.id = req.params.paymentId;
  return feesController.getReceipt(req, res, next);
});

module.exports = router;
