// src/routes/index.js
const express = require('express');
const router  = express.Router();

// ── Import route modules ──────────────────────────────────────
const authRoutes     = require('./auth');
const apiKeyRoutes   = require('./apiKeys');
const instanceRoutes = require('./instances');
const messageRoutes  = require('./messages');
const paymentRoutes  = require('./payments');
const webhookRoutes  = require('./webhooks');
const usageRoutes    = require('./usage');
const adminRoutes    = require('./admin');

// ── Mount routes ──────────────────────────────────────────────
// Ye prefixes server.js mein mount kiye gaye /api prefix ke baad aayenge
router.use('/auth',      authRoutes);
router.use('/keys',      apiKeyRoutes);
router.use('/instances', instanceRoutes);
router.use('/messages',  messageRoutes);
router.use('/payments',  paymentRoutes);
router.use('/webhooks',  webhookRoutes);
router.use('/usage',     usageRoutes);
router.use('/admin',     adminRoutes);

module.exports = router;