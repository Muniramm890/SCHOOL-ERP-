const router = require('express').Router();
const ctrl   = require('../../controllers/quickTestsController');
const { authenticateStudent } = require('../../middleware/studentAuth');

router.post('/gas-sync', authenticateStudent, ctrl.gasSync);

module.exports = router;
