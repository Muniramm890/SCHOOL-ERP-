const router = require('express').Router();
const ctrl    = require('../controllers/teachersController');
const { authenticate, authorize } = require('../middleware/auth');
router.use(authenticate);

// ── Literal routes FIRST (order matters in Express!) ────────────────────
router.get('/',                    ctrl.list);
router.get('/lookups',             ctrl.getLookups);
router.get('/section-assignments', ctrl.getSectionAssignments);   // ✅ ab pehle hai

// ── Dynamic :userId routes AFTER all literal ones ───────────────────────
router.get('/:userId',             ctrl.getOne);
router.get('/:userId/subjects',    ctrl.getTeacherSubjects);

// ── Admin Only (Write Operations) ───────────────────────────────────────
router.post('/',              authorize('admin', 'principal'), ctrl.create);
router.put('/:userId',        authorize('admin', 'principal'), ctrl.update);
router.delete('/:userId',     authorize('admin', 'principal'), ctrl.remove);

// ── Academic Assignments & Role Management ──────────────────────────────
router.post('/assignments',                 authorize('admin', 'principal'), ctrl.assignSubject);
router.delete('/assignments/:assignmentId', authorize('admin', 'principal'), ctrl.removeAssignment);
router.put('/assign-class-teacher', authorize('admin', 'principal'), ctrl.assignClassTeacher);

module.exports = router;
