// src/routes/exams.js
const router = require('express').Router();
const ctrl   = require('../controllers/examsController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

router.get('/',                  ctrl.list);                 // ?academic_year_id=
router.post('/',                 authorize('admin','principal'), ctrl.create);
router.get('/:id',               ctrl.getOne);               // exam + schedules
router.put('/:id',               authorize('admin','principal'), ctrl.update);
router.delete('/:id',            authorize('admin','principal'), ctrl.remove);
router.post('/:id/schedule',     authorize('admin','principal'), ctrl.addSchedule);

module.exports = router;
