//src/routes/payroll.js
const router = require('express').Router();
const ctrl = require('../controllers/payrollController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate, authorize('admin', 'principal'));

router.get('/leave-types', ctrl.listLeaveTypes);
router.post('/leave-types', ctrl.createLeaveType);
router.delete('/leave-types/:id', ctrl.deleteLeaveType);

router.get('/staff', ctrl.listStaffForPayroll);
router.put('/bank/:staffId', ctrl.upsertBankDetails);
router.put('/structure/:staffId', ctrl.upsertSalaryStructure);

router.get('/attendance-raw', ctrl.getAttendanceRaw);
router.post('/save-run', ctrl.savePayrollRun);
router.post('/runs/:runId/finalize', ctrl.finalizeRun);

router.get('/payslips', ctrl.listPayslips);
router.get('/payslips/:id', ctrl.getPayslip);
router.patch('/payslips/:id/mark-paid', ctrl.markPaid);

module.exports = router;
