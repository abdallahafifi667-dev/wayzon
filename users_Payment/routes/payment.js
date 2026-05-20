const express = require('express');
const router = express.Router();
const {
    createTopUp,
    createDebtClearance,
    handleWebhook,
    getWalletStatus,
    getTransactionHistory,
} = require('../controllers/payment.controllers');
const { verifyToken } = require('../middlewares/verifytoken');

// Protected routes (require authentication)
router.post('/topup', verifyToken, createTopUp);
router.post('/clear-debt', verifyToken, createDebtClearance);
router.get('/wallet', verifyToken, getWalletStatus);
router.get('/history', verifyToken, getTransactionHistory);

// Webhook route (public, but verified by Stripe signature)
// IMPORTANT: This route must use raw body, not JSON parsed body
router.post('/webhook', express.raw({ type: 'application/json' }), handleWebhook);

module.exports = router;
