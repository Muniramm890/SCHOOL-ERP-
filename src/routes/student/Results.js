//routes/student/Results.js
const router = require('express').Router();
const { query, sql } = require('../config/db');
const { success } = require('../utils/response');
const resultsController = require('../controllers/resultsController'); // ⚠️ apna actual filename confirm kar dena
const { authenticateStudent } = require('../middleware/studentAuth');

router.use(authenticateStudent);

router.get('/exam-groups', async (req, res, next) => {
  try {
    const { schoolId, sectionId } = req.student;
    const rows = await query(
      `SELECT DISTINCT eg.id, eg.name, eg.exam_type, eg.start_date, eg.end_date
       FROM exam_groups eg
       JOIN exam_sections es ON es.exam_group_id = eg.id AND es.section_id=@secId
       WHERE eg.school_id=@sid AND eg.status='published' AND eg.deleted_at IS NULL
       ORDER BY eg.start_date DESC`,
      { sid: { type: sql.UniqueIdentifier, value: schoolId }, secId: { type: sql.UniqueIdentifier, value: sectionId } }
    );
    return success(res, rows.recordset);
  } catch (err) { next(err); }
});

router.get('/report-card', (req, res, next) => {
  req.params.studentId = req.student.studentId;
  return resultsController.getStudentReportCard(req, res, next);
});

router.get('/trend', (req, res, next) => {
  req.params.studentId = req.student.studentId;
  return resultsController.getStudentTrend(req, res, next);
});

router.get('/report-card/pdf', (req, res, next) => {
  req.params.studentId = req.student.studentId;
  return resultsController.downloadReportCardPdf(req, res, next);
});

module.exports = router;
