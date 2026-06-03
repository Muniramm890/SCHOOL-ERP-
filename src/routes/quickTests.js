// src/routes/quickTests.js
const router = require('express').Router();
const ctrl   = require('../controllers/quickTestsController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

router.get('/',              ctrl.list);                 // ?section_id=&subject_id=
router.post('/',             ctrl.create);               // create test + optional results
router.get('/:id',           ctrl.getOne);               // test detail + all results
router.put('/:id/results',   ctrl.saveResults);          // save/update marks
router.delete('/:id',        authorize('admin','principal','teacher'), ctrl.remove);

module.exports = router;
