const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { logger } = require('../monitoring/metrics');

const STRIPE_MIN_TOPUP_AMOUNT = parseFloat(process.env.STRIPE_MIN_TOPUP_AMOUNT) || 10;

/**
 * Create a Stripe Checkout Session for Credit Top-up
 * @param {string} userId - User ID
 * @param {number} amount - Amount in USD (minimum $10)
 * @param {string} userEmail - User email for receipt
 * @returns {Promise<Object>} - Stripe session object
 */
async function createTopUpSession(userId, amount, userEmail) {
    try {
        if (amount < STRIPE_MIN_TOPUP_AMOUNT) {
            throw new Error(`Minimum top-up amount is $${STRIPE_MIN_TOPUP_AMOUNT}`);
        }

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [
                {
                    price_data: {
                        currency: 'usd',
                        product_data: {
                            name: 'Wayzon Credits Top-up',
                            description: `Add ${amount} credits to your account`,
                        },
                        unit_amount: Math.round(amount * 100), // Convert to cents
                    },
                    quantity: 1,
                },
            ],
            mode: 'payment',
            success_url: `${process.env.STRIPE_SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: process.env.STRIPE_CANCEL_URL,
            customer_email: userEmail,
            metadata: {
                userId: userId.toString(),
                type: 'credit_topup',
                credits: amount.toString(),
            },
        });

        logger && logger.info && logger.info('Stripe top-up session created', {
            userId,
            amount,
            sessionId: session.id,
        });

        return session;
    } catch (err) {
        logger && logger.error && logger.error('Failed to create top-up session', {
            userId,
            amount,
            error: err.message,
        });
        throw err;
    }
}

/**
 * Create a Stripe Checkout Session for Debt Clearance
 * @param {string} userId - User ID
 * @param {number} debtAmount - Commission debt amount to clear
 * @param {string} userEmail - User email for receipt
 * @returns {Promise<Object>} - Stripe session object
 */
async function createDebtClearanceSession(userId, debtAmount, userEmail) {
    try {
        if (debtAmount <= 0) {
            throw new Error('Debt amount must be greater than 0');
        }

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [
                {
                    price_data: {
                        currency: 'usd',
                        product_data: {
                            name: 'Wayzon Commission Payment',
                            description: `Clear commission debt of $${debtAmount.toFixed(2)}`,
                        },
                        unit_amount: Math.round(debtAmount * 100), // Convert to cents
                    },
                    quantity: 1,
                },
            ],
            mode: 'payment',
            success_url: `${process.env.STRIPE_SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: process.env.STRIPE_CANCEL_URL,
            customer_email: userEmail,
            metadata: {
                userId: userId.toString(),
                type: 'debt_clearance',
                debtAmount: debtAmount.toString(),
            },
        });

        logger && logger.info && logger.info('Stripe debt clearance session created', {
            userId,
            debtAmount,
            sessionId: session.id,
        });

        return session;
    } catch (err) {
        logger && logger.error && logger.error('Failed to create debt clearance session', {
            userId,
            debtAmount,
            error: err.message,
        });
        throw err;
    }
}

/**
 * Verify Stripe webhook signature
 * @param {string} payload - Raw request body
 * @param {string} signature - Stripe signature header
 * @returns {Object} - Verified event object
 */
function verifyWebhookSignature(payload, signature) {
    try {
        const event = stripe.webhooks.constructEvent(
            payload,
            signature,
            process.env.STRIPE_WEBHOOK_SECRET
        );
        return event;
    } catch (err) {
        logger && logger.error && logger.error('Webhook signature verification failed', {
            error: err.message,
        });
        throw new Error('Invalid webhook signature');
    }
}

/**
 * Retrieve a Stripe session by ID
 * @param {string} sessionId - Stripe session ID
 * @returns {Promise<Object>} - Session object
 */
async function retrieveSession(sessionId) {
    try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        return session;
    } catch (err) {
        logger && logger.error && logger.error('Failed to retrieve session', {
            sessionId,
            error: err.message,
        });
        throw err;
    }
}

module.exports = {
    createTopUpSession,
    createDebtClearanceSession,
    verifyWebhookSignature,
    retrieveSession,
    STRIPE_MIN_TOPUP_AMOUNT,
};
