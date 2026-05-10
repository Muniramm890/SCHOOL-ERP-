// src/routes/messages.js
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/messageController');
const { authClient, authApiKey } = require('../middleware/auth');
const { apiKeyLimiter } = require('../middleware/rateLimiter');

// Webhook (No Auth)
router.get('/webhook',  ctrl.receiveWebhook);
router.post('/webhook', ctrl.receiveWebhook);

// Meta Onboarding (Dashboard Auth)
router.post('/meta-onboarding', authClient, ctrl.metaOnboarding);

// Templates List (Dashboard Auth)
router.get('/templates', authClient, ctrl.listTemplates);

// Send Message (Hybrid Auth)
router.post('/send',
  (req, res, next) => {
    const hasApiKey = req.headers['x-api-key'] || req.query.api_key;
    return hasApiKey ? authApiKey(req, res, next) : authClient(req, res, next);
  },
  apiKeyLimiter,
  ctrl.sendMessage
);

// History
router.get('/',    authClient, ctrl.listMessages);
router.get('/:id', authClient, ctrl.getMessage);

module.exports = router;
