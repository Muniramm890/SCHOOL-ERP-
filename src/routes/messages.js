// src/routes/messages.js
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/messageController');
const { authClient, authApiKey } = require('../middleware/auth');
const { apiKeyLimiter } = require('../middleware/rateLimiter');

// ── Webhook Endpoint ──
// Meta (Facebook) isi URL par messages bhejega. 
// Ismein auth nahi lagta kyunki verify_token validation controller ke andar hota hai.
router.get('/webhook',  ctrl.receiveWebhook);
router.post('/webhook', ctrl.receiveWebhook);

// ── Send Message ──
// Ye endpoint Hybrid hai: Dashboard se bhi chalega aur External API Key se bhi.
router.post('/send',
  (req, res, next) => {
    const hasApiKey = req.headers['x-api-key'] || req.query.api_key;
    // Agar API Key hai toh authApiKey use karo, warna Dashboard session check karo
    return hasApiKey ? authApiKey(req, res, next) : authClient(req, res, next);
  },
  apiKeyLimiter,
  ctrl.sendMessage
);

// ── Message History ──
// Sirf Dashboard users ke liye (Login required)
router.get('/',    authClient, ctrl.listMessages);
router.get('/:id', authClient, ctrl.getMessage);

module.exports = router;