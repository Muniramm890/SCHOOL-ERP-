// src/routes/apiKeys.js
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/apiKeyController');
const { authClient } = require('../middleware/auth');

// Saare API Key operations ke liye login zaroori hai
router.use(authClient);

// Get all keys of the client
router.get('/', ctrl.listKeys);

// Create a new API key
router.post('/', ctrl.createKey);

// Revoke/Delete an API key
router.delete('/:id', ctrl.revokeKey);

module.exports = router;