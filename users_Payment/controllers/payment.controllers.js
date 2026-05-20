const asyncHandler = require('express-async-handler');
const { getUserModel, getUserWalletModel } = require('../models/users.models');
const { logUserAction } = require('../util/auditLogger');
const { logger } = require('../monitoring/metrics');
const {
    createTopUpSession,
    createDebtClearanceSession,
    verifyWebhookSignature,
    STRIPE_MIN_TOPUP_AMOUNT,
} = require('../util/stripeService');
const { clearCommissionDebt } = require('../util/paymentUtils');
const { getPaymentTransactionModel } = require('../models/PaymentTransaction.models');
const PaymentTransaction = getPaymentTransactionModel();

/**
 * @desc    Create Stripe session for credit top-up
 * @route   POST /api/payment/topup
 * @access  Private (authenticated users)
 */
exports.createTopUp = asyncHandler(async (req, res) => {
    try {
        const { amount } = req.body;
        const userId = req.user._id;

        if (!amount || amount < STRIPE_MIN_TOPUP_AMOUNT) {
            return res.status(400).json({
                error: `Minimum top-up amount is $${STRIPE_MIN_TOPUP_AMOUNT}`,
            });
        }

        const User = getUserModel();
        const user = await User.findById(userId).select('email.address').lean();

        if (!user || !user.email || !user.email.address) {
            return res.status(400).json({ error: 'User email not found' });
        }

        const session = await createTopUpSession(
            userId,
            amount,
            user.email.address
        );

        logUserAction({
            user: userId,
            ip: req.ip,
            action: 'payment',
            details: {
                action: 'createTopUpSession',
                amount,
                sessionId: session.id,
            },
        });

        res.status(200).json({
            message: 'Top-up session created successfully',
            sessionId: session.id,
            url: session.url,
        });
    } catch (err) {
        logger && logger.error && logger.error('Error creating top-up session', {
            error: err.message,
            userId: req.user?._id,
        });

        res.status(500).json({
            error: 'Failed to create payment session',
            details: err.message,
        });
    }
});

/**
 * @desc    Create Stripe session for debt clearance
 * @route   POST /api/payment/clear-debt
 * @access  Private (authenticated users)
 */
exports.createDebtClearance = asyncHandler(async (req, res) => {
    try {
        const userId = req.user._id;

        const UserWallet = getUserWalletModel();
        const wallet = await UserWallet.findOne({ userId }).lean();

        if (!wallet || !wallet.commissionDebt || wallet.commissionDebt <= 0) {
            return res.status(400).json({
                error: 'No commission debt to clear',
                currentDebt: wallet?.commissionDebt || 0,
            });
        }

        const User = getUserModel();
        const user = await User.findById(userId).select('email.address').lean();

        if (!user || !user.email || !user.email.address) {
            return res.status(400).json({ error: 'User email not found' });
        }

        const session = await createDebtClearanceSession(
            userId,
            wallet.commissionDebt,
            user.email.address
        );

        logUserAction({
            user: userId,
            ip: req.ip,
            action: 'payment',
            details: {
                action: 'createDebtClearanceSession',
                debtAmount: wallet.commissionDebt,
                sessionId: session.id,
            },
        });

        res.status(200).json({
            message: 'Debt clearance session created successfully',
            debtAmount: wallet.commissionDebt,
            sessionId: session.id,
            url: session.url,
        });
    } catch (err) {
        logger && logger.error && logger.error('Error creating debt clearance session', {
            error: err.message,
            userId: req.user?._id,
        });

        res.status(500).json({
            error: 'Failed to create payment session',
            details: err.message,
        });
    }
});

/**
 * @desc    Handle Stripe webhook events
 * @route   POST /api/payment/webhook
 * @access  Public (Stripe only)
 */
exports.handleWebhook = asyncHandler(async (req, res) => {
    const signature = req.headers['stripe-signature'];

    try {
        // Verify webhook signature
        const event = verifyWebhookSignature(req.body, signature);

        // Handle the event
        switch (event.type) {
            case 'checkout.session.completed': {
                const session = event.data.object;
                const { userId, type, credits, debtAmount } = session.metadata;

                if (type === 'credit_topup') {
                    // Add credits to user wallet
                    const UserWallet = getUserWalletModel();
                    await UserWallet.findOneAndUpdate(
                        { userId },
                        { $inc: { credits: parseFloat(credits) } },
                        { upsert: true }
                    );

                    // Record Payment Transaction
                    await PaymentTransaction.create({
                        userId,
                        stripeSessionId: session.id,
                        amount: session.amount_total / 100,
                        currency: session.currency,
                        transactionType: 'credit_topup',
                        status: 'completed',
                        description: `Top-up of ${credits} credits`,
                        metadata: session.metadata,
                    });

                    logger && logger.info && logger.info('Credits added via Stripe', {
                        userId,
                        credits: parseFloat(credits),
                        sessionId: session.id,
                    });

                    logUserAction({
                        user: userId,
                        ip: 'stripe-webhook',
                        action: 'payment',
                        details: {
                            action: 'creditTopUpCompleted',
                            credits: parseFloat(credits),
                            sessionId: session.id,
                        },
                    });
                } else if (type === 'debt_clearance') {
                    // Clear commission debt
                    await clearCommissionDebt(userId);

                    // Record Payment Transaction
                    await PaymentTransaction.create({
                        userId,
                        stripeSessionId: session.id,
                        amount: session.amount_total / 100,
                        currency: session.currency,
                        transactionType: 'debt_clearance',
                        status: 'completed',
                        description: `Cleared commission debt of $${debtAmount}`,
                        metadata: session.metadata,
                    });

                    logger && logger.info && logger.info('Debt cleared via Stripe', {
                        userId,
                        debtAmount: parseFloat(debtAmount),
                        sessionId: session.id,
                    });

                    logUserAction({
                        user: userId,
                        ip: 'stripe-webhook',
                        action: 'payment',
                        details: {
                            action: 'debtClearanceCompleted',
                            debtAmount: parseFloat(debtAmount),
                            sessionId: session.id,
                        },
                    });
                }
                break;
            }

            case 'checkout.session.expired':
            case 'checkout.session.async_payment_failed': {
                const session = event.data.object;
                logger && logger.warn && logger.warn('Payment session failed or expired', {
                    sessionId: session.id,
                    type: event.type,
                });
                break;
            }

            default:
                logger && logger.debug && logger.debug('Unhandled webhook event type', {
                    type: event.type,
                });
        }

        res.status(200).json({ received: true });
    } catch (err) {
        logger && logger.error && logger.error('Webhook processing error', {
            error: err.message,
        });

        res.status(400).json({
            error: 'Webhook processing failed',
            details: err.message,
        });
    }
});

/**
 * @desc    Get user's wallet status
 * @route   GET /api/payment/wallet
 * @access  Private
 */
exports.getWalletStatus = asyncHandler(async (req, res) => {
    try {
        const userId = req.user._id;
        const UserWallet = getUserWalletModel();
        const wallet = await UserWallet.findOne({ userId }).lean();

        if (!wallet) {
            return res.status(404).json({ error: 'Wallet not found' });
        }

        res.status(200).json({
            credits: wallet.credits || 0,
            commissionDebt: wallet.commissionDebt || 0,
            commissionOperationCount: wallet.commissionOperationCount || 0,
            balance: wallet.balance || 0,
            canBookTrip: wallet.commissionDebt < 10 && wallet.commissionOperationCount < 10,
        });
    } catch (err) {
        logger && logger.error && logger.error('Error fetching wallet status', {
            error: err.message,
            userId: req.user?._id,
        });

        res.status(500).json({
            error: 'Failed to fetch wallet status',
            details: err.message,
        });
    }
});

/**
 * @desc    Get user's transaction history
 * @route   GET /api/payment/transactions
 * @access  Private
 */
exports.getTransactionHistory = asyncHandler(async (req, res) => {
    try {
        const userId = req.user._id;
        const { page = 1, limit = 10 } = req.query;
        const skip = (page - 1) * limit;

        const [transactions, total] = await Promise.all([
            PaymentTransaction.find({ userId })
                .sort({ paymentDate: -1 })
                .skip(skip)
                .limit(Number(limit))
                .lean(),
            PaymentTransaction.countDocuments({ userId }),
        ]);

        res.status(200).json({
            data: transactions,
            pagination: {
                total,
                page: Number(page),
                limit: Number(limit),
                totalPages: Math.ceil(total / limit),
            },
        });
    } catch (err) {
        logger && logger.error && logger.error('Error fetching transaction history', {
            error: err.message,
            userId: req.user?._id,
        });

        res.status(500).json({
            error: 'Failed to fetch transaction history',
            details: err.message,
        });
    }
});
