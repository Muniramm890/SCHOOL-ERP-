// src/routes/students.js
const router = require('express').Router();
const ctrl   = require('../controllers/studentsController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

// List + create
router.get('/',     ctrl.list);
router.post('/',    authorize('admin', 'principal'), ctrl.create);

// Single student
router.get('/:id',    ctrl.getOne);
router.put('/:id',    authorize('admin', 'principal', 'teacher'), ctrl.update);
router.delete('/:id', authorize('admin', 'principal'), ctrl.remove);

module.exports = router;
