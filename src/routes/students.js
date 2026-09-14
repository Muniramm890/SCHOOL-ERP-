// src/routes/students.js
const router = require('express').Router();
const ctrl   = require('../controllers/studentsController');
const promotionCtrl = require('../controllers/promotionController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

// List + create
router.get('/',     ctrl.list);
router.post('/',    authorize('admin', 'principal'), ctrl.create);

// Single student
router.get('/:id',    ctrl.getOne);
router.put('/:id',    authorize('admin', 'principal', 'teacher'), ctrl.update);
router.delete('/:id', authorize('admin', 'principal'), ctrl.remove);
router.post('/:id/tc', authorize('admin', 'principal', 'school_admin'), promotionCtrl.issueTC);
router.get('/:id/tc',  promotionCtrl.getTC);

module.exports = router;
