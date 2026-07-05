const router = require('express').Router();
const ctrl    = require('../controllers/teachersController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

// ── Read Only / General Access ──────────────────────────────────────────
router.get('/',               ctrl.list);
router.get('/lookups',        ctrl.getLookups); // ✅ Naya: Dynamic Dropdowns
router.get('/:userId',        ctrl.getOne);

// 🔥 Fix: teachersController ki jagah 'ctrl' use karna hai
router.get('/:userId/subjects', ctrl.getTeacherSubjects);
router.get('/section-assignments', ctrl.getSectionAssignments);

// ── Admin Only (Write Operations) ───────────────────────────────────────
router.post('/',              authorize('admin', 'principal'), ctrl.create);
router.put('/:userId',        authorize('admin', 'principal'), ctrl.update);
router.delete('/:userId',     authorize('admin', 'principal'), ctrl.remove);

// ── Academic Assignments & Role Management ──────────────────────────────
// Subject Assignment (🔥 Fix: Upar se duplicates hata diye)
router.post('/assignments',                 authorize('admin', 'principal'), ctrl.assignSubject);
router.delete('/assignments/:assignmentId', authorize('admin', 'principal'), ctrl.removeAssignment);

// Class Teacher Assignment
router.put('/assign-class-teacher', authorize('admin', 'principal'), ctrl.assignClassTeacher);

module.exports = router;
