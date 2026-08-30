// src/routes/quickTests.js
const router = require('express').Router();
const ctrl   = require('../controllers/quickTestsController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

// ── AZURE PROXY ROUTE ─────────────────────────────────────────────────
router.post('/gas-sync',     ctrl.gasSync);             

// ── GET & POST ────────────────────────────────────────────────────────
router.get('/',              ctrl.list);                 
router.post('/',             ctrl.create);               

// ── SINGLE TEST OPERATIONS ────────────────────────────────────────────
router.get('/:id',           ctrl.getOne);               

// ── UPDATES ───────────────────────────────────────────────────────────
router.put('/:id/meta',      ctrl.updateMeta);           
router.put('/:id/results',   ctrl.saveResults);          

// ── DELETE ────────────────────────────────────────────────────────────
router.delete('/:id',        authorize('admin','principal','teacher'), ctrl.remove); 

module.exports = router;
