// src/routes/setup.js
const router = require('express').Router();
const ctrl   = require('../controllers/setupController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

// School
router.get('/school',             ctrl.getSchool);
router.put('/school',             authorize('admin','principal'), ctrl.updateSchool);

// Grades (classes)
router.get('/grades',             ctrl.listGrades);
router.post('/grades',            authorize('admin','principal'), ctrl.createGrade);
router.put('/grades/:id',         authorize('admin','principal'), ctrl.updateGrade);

// Sections
router.get('/sections',           ctrl.listSections);      // ?grade_id=&academic_year_id=
router.post('/sections',          authorize('admin','principal'), ctrl.createSection);

// Subjects
router.get('/subjects',           ctrl.listSubjects);
router.post('/subjects',          authorize('admin','principal'), ctrl.createSubject);

// Academic Years
router.get('/academic-years',     ctrl.listAcademicYears);
router.post('/academic-years',    authorize('admin','principal'), ctrl.createAcademicYear);

module.exports = router;
