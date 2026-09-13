//src/routes/arrangement.js 
const router = require('express').Router();
const ctrl = require('../controllers/arrangementController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate, authorize('admin', 'principal'));

router.get('/draft', ctrl.getDraft);
router.post('/confirm', ctrl.confirmArrangement);
router.delete('/:id', ctrl.cancelEntry);
router.get('/history', ctrl.listHistory);
router.post('/notify', ctrl.notifySubstitutes);

module.exports = router;