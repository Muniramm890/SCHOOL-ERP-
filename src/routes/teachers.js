// src/routes/teachers.js
const router = require('express').Router();
const ctrl   = require('../controllers/teachersController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

router.get('/',                ctrl.list);
router.post('/',               authorize('admin', 'principal'), ctrl.create);
router.get('/:userId',         ctrl.getOne);
router.put('/:userId',         authorize('admin', 'principal'), ctrl.update);
router.delete('/:userId',      authorize('admin', 'principal'), ctrl.remove);

// Subject assignments
router.post('/assignments',    authorize('admin', 'principal'), ctrl.assignSubject);

module.exports = router;
