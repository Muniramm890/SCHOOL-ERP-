// src/routes/setup.js
const router = require('express').Router();
const ctrl = require('../controllers/setupController');
const { authenticate, authorize } = require('../middleware/auth');

// Saare routes authenticated hone chahiye
router.use(authenticate);

// ── School Profile Routes ────────────────────────────────────────────────
router.get('/school', ctrl.getSchool);
router.put('/school', authorize('school_admin'), ctrl.updateSchool);

// ── Grades (Classes) Routes ──────────────────────────────────────────────
router.get('/grades', ctrl.listGrades);
router.post('/grades', authorize('school_admin'), ctrl.createGrade);
router.put('/grades/:id', authorize('school_admin'), ctrl.updateGrade);

// ── Sections Routes ──────────────────────────────────────────────────────
router.get('/sections', ctrl.listSections); // Optional query: ?grade_id=&academic_year_id=
router.post('/sections', authorize('school_admin'), ctrl.createSection);

// ── Subjects Routes ──────────────────────────────────────────────────────
router.get('/subjects', ctrl.listSubjects);
router.post('/subjects', authorize('school_admin'), ctrl.createSubject);


router.get('/grade-subjects', ctrl.listGradeSubjects);
router.put('/grade-subjects', authorize('school_admin'), ctrl.saveGradeSubjects);


//-------------bulk entry___________________
router.post('/bulk-academic', authorize('school_admin'), ctrl.bulkAcademicSetup);

// ── Academic Years Routes ────────────────────────────────────────────────
router.get('/academic-years', ctrl.listAcademicYears);
router.post('/academic-years', authorize('school_admin'), ctrl.createAcademicYear);

module.exports = router;
