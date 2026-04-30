// src/routes/instances.js
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/instanceController');
const { authClient } = require('../middleware/auth');

// Har instance operation ke liye client authentication (Login) mandatory hai
router.use(authClient);

// ── Endpoints ──

// Sabhi instances ki list lena
router.get('/', ctrl.listInstances);

// Nayi instance (WABA/Cloud API) create karna
router.post('/', ctrl.createInstance);

// Ek specific instance ki detail dekhna
router.get('/:id', ctrl.getInstance);

// Instance ki settings (webhook, name, token) update karna
router.put('/:id', ctrl.updateInstance);

// Instance ko delete karna
router.delete('/:id', ctrl.deleteInstance);

// Instance ka status (connected/disconnected) manually ya webhook se update karna
router.patch('/:id/status', ctrl.updateStatus);

module.exports = router;