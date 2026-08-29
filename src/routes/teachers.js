const router = require('express').Router();
const ctrl    = require('../controllers/teachersController');
const { authenticate, authorize } = require('../middleware/auth');
router.use(authenticate);

// ═══════════════════════════════════════════════════════════════
// GET — literal routes FIRST, dynamic :userId routes LAST
// ═══════════════════════════════════════════════════════════════
router.get('/',                    ctrl.list);
router.get('/lookups',             ctrl.getLookups);
router.get('/section-assignments', ctrl.getSectionAssignments);
router.get('/:userId',             ctrl.getOne);
router.get('/:userId/subjects',    ctrl.getTeacherSubjects);

// ═══════════════════════════════════════════════════════════════
// POST — literal routes FIRST, dynamic routes LAST
// ═══════════════════════════════════════════════════════════════
router.post('/',            authorize('admin', 'principal'), ctrl.create);
router.post('/assignments', authorize('admin', 'principal'), ctrl.assignSubject);

// ═══════════════════════════════════════════════════════════════
// PUT — literal routes FIRST, dynamic :userId route LAST
// (assign-class-teacher was clashing with :userId before this fix)
// ═══════════════════════════════════════════════════════════════
router.put('/assign-class-teacher', authorize('admin', 'principal'), ctrl.assignClassTeacher);
router.put('/:userId',              authorize('admin', 'principal'), ctrl.update);

// ═══════════════════════════════════════════════════════════════
// DELETE — literal routes FIRST, dynamic :userId route LAST
// ═══════════════════════════════════════════════════════════════
router.delete('/assignments/:assignmentId', authorize('admin', 'principal'), ctrl.removeAssignment);
router.delete('/:userId',                   authorize('admin', 'principal'), ctrl.remove);
router.get('/for-subject', ctrl.getTeachersForSubject);

module.exports = router;
