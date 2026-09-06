// src/routes/results.js
// src/routes/results.js
const router = require('express').Router();
const ctrl   = require('../controllers/resultsController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

// ── Exam selector for the Results Hub ────────────────────────────────────
router.get('/exam-groups',                ctrl.listExamGroups);        // ?academic_year_id=

// ── Compute engine (admin/principal only) ────────────────────────────────
router.post('/compute/:examGroupId',      authorize('school_admin', 'admin', 'principal'), ctrl.computeResults);

// ── Analysis tabs ─────────────────────────────────────────────────────────
router.get('/overview',                   ctrl.getOverview);           // ?exam_group_id=
router.get('/class-wise',                 ctrl.getClassWise);          // ?exam_group_id=
router.get('/section-wise',               ctrl.getSectionWise);        // ?exam_group_id=&grade_id=
router.get('/section-results',            ctrl.getSectionResults);     // ?exam_group_id=&section_id=
router.get('/subject-wise',               ctrl.getSubjectWise);        // ?exam_group_id=
router.get('/teacher-wise',                ctrl.getTeacherWise);        // ?exam_group_id=
router.get('/toppers',                    ctrl.getToppers);            // ?exam_group_id=&grade_id=&limit=

// ── Student-specific views ───────────────────────────────────────────────
router.get('/student/:studentId/trend',       ctrl.getStudentTrend);       // across all exams
router.get('/student/:studentId/report-card', ctrl.getStudentReportCard);  // ?exam_group_id=
router.get('/student/:studentId/report-card/pdf', ctrl.downloadReportCardPdf); // ?exam_group_id=

module.exports = router;
