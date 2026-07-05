
// src/routes/timetables.js
const express = require('express');
const router = express.Router();
const c = require('../controllers/timetableController');
const { authenticate, authorize } = require('../middleware/auth');

router.get('/periods', c.listPeriods);
router.post('/periods/generate-defaults', c.generateDefaultPeriods);
router.post('/periods', c.createPeriod);
router.delete('/periods/:id', c.deletePeriod);

router.get('/section/:sectionId', c.getSectionTimetable);
router.put('/section', c.saveSectionTimetable);

router.get('/teacher/:teacherId', c.getTeacherTimetable);

module.exports = router;
