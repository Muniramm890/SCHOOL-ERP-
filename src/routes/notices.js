// src/routes/notices.js
const router = require('express').Router();
const ctrl   = require('../controllers/noticesController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

router.get('/',        ctrl.list);
router.post('/',       authorize('admin','principal','teacher'), ctrl.create);
router.put('/:id',     authorize('admin','principal','teacher'), ctrl.update);
router.delete('/:id',  authorize('admin','principal'), ctrl.remove);

module.exports = router;
