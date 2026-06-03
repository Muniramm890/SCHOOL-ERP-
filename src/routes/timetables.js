// src/routes/timetables.js
const router = require('express').Router();
const ctrl   = require('../controllers/timetableController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

router.get('/',                     ctrl.getBySection);       // ?section_id=&academic_year_id=
router.post('/',                    authorize('admin','principal'), ctrl.create);
router.post('/:id/slots',           authorize('admin','principal'), ctrl.saveSlots);

router.get('/today-absent',         ctrl.getTodayAbsent);     // for dashboard absent card
router.post('/substitute',          authorize('admin','principal','teacher'), ctrl.createSubstitution);

module.exports = router;
