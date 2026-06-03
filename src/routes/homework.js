// src/routes/homework.js
const router = require('express').Router();
const ctrl   = require('../controllers/homeworkController');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

router.get('/',                                  ctrl.list);
router.post('/',                                 ctrl.create);
router.delete('/:id',                            ctrl.remove);
router.get('/:id/submissions',                   ctrl.listSubmissions);
router.put('/:id/submissions/:studentId',        ctrl.gradeSubmission);

module.exports = router;
