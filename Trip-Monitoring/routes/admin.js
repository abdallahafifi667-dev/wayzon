/**
 * ADMIN ROUTES - لوحة تحكم الإدارة
 * التحكم الديناميكي بالتكاليف والحدود والأسعار
 */

const express = require("express");
const router = express.Router();
const costOptimizer = require("../util/costOptimizer");
const { logger } = require("../monitoring/metrics");

/**
 * 🔐 Middleware - التحقق من صلاحيات Admin
 */
const requireAdmin = (req, res, next) => {
  const adminKey = req.headers["x-admin-key"] || req.body.adminKey;
  const validKey = process.env.ADMIN_KEY || "admin-secret-key";

  if (adminKey !== validKey) {
    return res.status(403).json({ error: "Unauthorized - Invalid Admin Key" });
  }
  next();
};

// ============================================
// 📊 GET - Status و Reports
// ============================================

/**
 * GET /admin/status - عرض حالة النظام الحالية
 */
router.get("/status", requireAdmin, async (req, res) => {
  try {
    const status = await costOptimizer.getAdminStatus();
    res.json(status);
  } catch (err) {
    logger.error("Failed to get admin status:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /admin/cost-report - تقرير التكاليف اليومي
 */
router.get("/cost-report", requireAdmin, async (req, res) => {
  try {
    const report = await costOptimizer.generateDailyCostReport();
    res.json(report);
  } catch (err) {
    logger.error("Failed to get cost report:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /admin/quotas - عرض النسب المئوية للحدود
 */
router.get("/quotas", requireAdmin, async (req, res) => {
  try {
    const report = await costOptimizer.generateDailyCostReport();
    const quotas = {
      googleMaps: {
        used: parseInt(report.efficiency.quotaUsage.googleMaps),
        limit: costOptimizer.limits.googleMapsPerDay,
        status:
          parseInt(report.efficiency.quotaUsage.googleMaps) > 80
            ? "🔴 عالي"
            : "🟢 جيد",
      },
      gemini: {
        used: parseInt(report.efficiency.quotaUsage.gemini),
        limit: costOptimizer.limits.geminiPerDay,
        status:
          parseInt(report.efficiency.quotaUsage.gemini) > 80
            ? "🔴 عالي"
            : "🟢 جيد",
      },
      cacheHitRate: report.efficiency.cacheHitRate,
      estimatedDailyCost: report.estimatedCost.total,
      estimatedSavings: report.estimatedCost.savedByCaching,
    };
    res.json(quotas);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// ⚙️ POST - تعديل الإعدادات
// ============================================

/**
 * POST /admin/limits - تحديث الحدود ديناميكياً
 * {
 *   "googleMapsPerDay": 3000,
 *   "geminiPerDay": 1500,
 *   "batchProcessingEnabled": true,
 *   "mlPredictionEnabled": true
 * }
 */
router.post("/limits", requireAdmin, async (req, res) => {
  try {
    const {
      googleMapsPerDay,
      geminiPerDay,
      batchProcessingEnabled,
      mlPredictionEnabled,
    } = req.body;

    const newLimits = {};
    if (googleMapsPerDay !== undefined)
      newLimits.googleMapsPerDay = googleMapsPerDay;
    if (geminiPerDay !== undefined) newLimits.geminiPerDay = geminiPerDay;
    if (batchProcessingEnabled !== undefined)
      newLimits.batchProcessingEnabled = batchProcessingEnabled;
    if (mlPredictionEnabled !== undefined)
      newLimits.mlPredictionEnabled = mlPredictionEnabled;

    const result = await costOptimizer.updateLimits(newLimits);
    if (!result) {
      return res.status(400).json({ error: "Failed to update limits" });
    }

    logger.info(`🔄 Admin updated limits:`, newLimits);
    res.json({
      success: true,
      message: "تم تحديث الحدود بنجاح",
      updatedLimits: newLimits,
      currentLimits: costOptimizer.limits,
    });
  } catch (err) {
    logger.error("Failed to update limits:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /admin/reset-daily-limits - إعادة تعيين العدادات اليومية
 */
router.post("/reset-daily-limits", requireAdmin, async (req, res) => {
  try {
    const success = await costOptimizer.resetDailyLimits();

    if (success) {
      logger.info("🔄 Admin reset daily limits");
      res.json({
        success: true,
        message: "تم إعادة تعيين العدادات اليومية",
      });
    } else {
      res.status(400).json({
        success: false,
        message: "فشل إعادة التعيين",
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /admin/set-premium-user - ترقية مستخدم إلى Premium يدويّاً
 * {
 *   "userId": "user123",
 *   "userType": "tourist",
 *   "durationDays": 30
 * }
 */
router.post("/set-premium-user", requireAdmin, async (req, res) => {
  try {
    const { userId, userType = "tourist", durationDays = 30 } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "userId مطلوب" });
    }

    const upgraded = await costOptimizer.upgradeUserToPremium(
      userId,
      userType,
      durationDays,
    );

    if (upgraded) {
      logger.info(
        `🎁 Admin upgraded ${userId} to Premium for ${durationDays} days`,
      );
      res.json({
        success: true,
        message: `تم ترقية ${userId} إلى Premium`,
        userId,
        userType,
        expiresIn: `${durationDays} أيام`,
      });
    } else {
      res.status(400).json({
        success: false,
        message: "فشلت الترقية",
      });
    }
  } catch (err) {
    logger.error("Failed to upgrade user:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /admin/revoke-premium - إلغاء اشتراك Premium
 * {
 *   "userId": "user123",
 *   "userType": "tourist"
 * }
 */
router.post("/revoke-premium", requireAdmin, async (req, res) => {
  try {
    const { userId, userType = "tourist" } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "userId مطلوب" });
    }

    // حذف من Redis
    const tierKey = `tier:${userType}:${userId}`;
    const expireKey = `tier:${userType}:${userId}:expires`;

    if (costOptimizer.redis && costOptimizer.redis.isOpen) {
      await costOptimizer.redis.del(tierKey);
      await costOptimizer.redis.del(expireKey);
    }

    logger.info(`❌ Admin revoked Premium for ${userId}`);
    res.json({
      success: true,
      message: `تم إلغاء Premium للمستخدم ${userId}`,
      userId,
    });
  } catch (err) {
    logger.error("Failed to revoke premium:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /admin/payment - معالجة الدفع يدويّاً
 * {
 *   "userId": "user123",
 *   "amount": 2.50,
 *   "currency": "USD",
 *   "description": "Premium Trip #1"
 * }
 */
router.post("/payment", requireAdmin, async (req, res) => {
  try {
    const { userId, amount, currency = "USD", description } = req.body;

    if (!userId || !amount) {
      return res.status(400).json({ error: "userId و amount مطلوبان" });
    }

    // حفظ السجل
    if (costOptimizer.redis && costOptimizer.redis.isOpen) {
      const payment = {
        timestamp: new Date().toISOString(),
        userId,
        amount,
        currency,
        description,
        processedBy: "admin_manual",
      };

      await costOptimizer.redis.lPush("payments:log", JSON.stringify(payment));
    }

    logger.info(
      `💰 Admin recorded payment: ${userId} - $${amount} ${currency}`,
    );
    res.json({
      success: true,
      message: "تم تسجيل الدفع",
      payment: {
        userId,
        amount,
        currency,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err) {
    logger.error("Failed to record payment:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// 🔍 MONITORING
// ============================================

/**
 * GET /admin/circuit-breaker - حالة Circuit Breaker
 */
router.get("/circuit-breaker", requireAdmin, (req, res) => {
  const cb = costOptimizer.circuitBreaker;
  res.json({
    state: cb.state,
    failures: cb.failures,
    failureThreshold: cb.failureThreshold,
    lastFailureTime: cb.lastFailureTime,
    nextResetTime: cb.lastFailureTime
      ? new Date(cb.lastFailureTime + cb.resetTimeout).toISOString()
      : null,
  });
});

/**
 * GET /admin/batch-queue - حالة البطاريات المعلقة
 */
router.get("/batch-queue", requireAdmin, (req, res) => {
  const batches = Array.from(costOptimizer.batchQueue.entries()).map(
    ([key, locations]) => ({
      key,
      count: locations.length,
    }),
  );

  res.json({
    totalBatches: costOptimizer.batchQueue.size,
    totalLocations: batches.reduce((a, b) => a + b.count, 0),
    batches,
    batchSize: costOptimizer.batchSize,
    enabled: costOptimizer.limits.batchProcessingEnabled,
  });
});

/**
 * GET /admin/user-behaviors - تتبع السلوك
 */
router.get("/user-behaviors", requireAdmin, (req, res) => {
  const behaviors = Array.from(costOptimizer.userBehaviors.entries()).map(
    ([userId, behavior]) => ({
      userId,
      patternCount: behavior.patterns.length,
      lastPattern: behavior.patterns[behavior.patterns.length - 1]?.timestamp,
    }),
  );

  res.json({
    totalTrackedUsers: costOptimizer.userBehaviors.size,
    users: behaviors.slice(0, 50), // أول 50 مستخدم
    mlEnabled: costOptimizer.limits.mlPredictionEnabled,
  });
});

module.exports = router;
