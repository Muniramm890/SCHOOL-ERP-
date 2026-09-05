// src/routes/exams.js
const router = require('express').Router();
const ctrl = require('../controllers/examController'); // Verify exact casing/pluralization of your controller file
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

// Exam Group Management
router.get('/', ctrl.listExams);
router.post('/', authorize('admin', 'principal'), ctrl.createExam);
router.get('/:id', ctrl.getExam);
router.put('/:id', authorize('admin', 'principal'), ctrl.updateExam);
router.delete('/:id', authorize('admin', 'principal'), ctrl.deleteExam);
router.put('/:id/classes', authorize('admin', 'principal'), ctrl.setExamClasses);

// Date Sheet Management
router.get('/:id/datesheet', ctrl.getDatesheet);
router.put('/:id/datesheet', authorize('admin', 'principal'), ctrl.saveDatesheet);
router.delete('/:id/datesheet/:rowId', authorize('admin', 'principal'), ctrl.deleteDatesheetRow);

// Marks Entry
router.get('/:id/marks-roster', ctrl.getMarksRoster);
router.post('/:id/marks', authorize('admin', 'principal', 'teacher'), ctrl.saveMarks);

// Results Processing & Publishing
router.get('/:id/results', ctrl.getResults);
router.put('/:id/publish', authorize('admin', 'principal'), ctrl.publishExam);
router.put('/:id/unpublish', authorize('admin', 'principal'), ctrl.unpublishExam);
router.delete('/:id/results/:studentId', authorize('admin', 'principal'), ctrl.deleteStudentResult);

module.exports = router;
