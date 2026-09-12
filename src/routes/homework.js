// src/routes/homework.js
const router = require('express').Router();
const ctrl   = require('../controllers/homeworkController');
const upload = require('../middleware/upload');
const { authorize } = require('../middleware/auth');

router.get('/',  ctrl.list);
router.post('/', authorize('admin','principal','teacher'), upload.array('files', 10), ctrl.create);
router.patch('/:id/visibility', authorize('admin','principal','teacher'), ctrl.toggleVisibility);
router.delete('/:id', authorize('admin','principal','teacher'), ctrl.remove);

module.exports = router;
