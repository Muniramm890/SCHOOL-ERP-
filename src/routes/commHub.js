//src/routes/commHub.js
const router = require('express').Router();
const ctrl = require('../controllers/commHubController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

router.post('/preview', ctrl.previewTargets);
router.get('/whatsapp-templates', ctrl.listWhatsappTemplates);
router.post('/whatsapp-templates', authorize('admin', 'principal'), ctrl.createWhatsappTemplate);
router.get('/messages', ctrl.listMessages);
router.get('/messages/:id', ctrl.getMessage);
router.post('/messages', authorize('admin', 'principal', 'teacher'), ctrl.createAndSend);

module.exports = router;