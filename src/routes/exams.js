// src/routes/exams.js
const router = require('express').Router();
const ctrl   = require('../controllers/examController'); // फ़ाइल का नाम चेक कर लें (examController है या examsController)
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

router.get('/',                  ctrl.listExams);                 // ?academic_year_id=
router.post('/',                 authorize('admin','principal'), ctrl.createExam);
router.get('/:id',               ctrl.getExam);               // exam + schedules
router.put('/:id',               authorize('admin','principal'), ctrl.updateExam);
router.delete('/:id',            authorize('admin','principal'), ctrl.deleteExam);
// अगर addSchedule अभी controller में नहीं है, तो उसे controller में लिखें या फिलहाल इस line को हटा दें
// router.post('/:id/schedule',     authorize('admin','principal'), ctrl.addSchedule);

module.exports = router;

