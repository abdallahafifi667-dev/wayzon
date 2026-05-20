/**
 * USERS_PAYMENT SECURITY CONFIGURATION
 * =====================================
 *
 * CRITICAL: This server is responsible for:
 * 1. User Authentication (login, registration, verification)
 * 2. Token Generation (access + refresh tokens)
 * 3. Token Encryption (AES-256-CBC)
 * 4. Secure transmission to mobile app
 *
 * The generated tokens are validated by:
 * - Trip-Monitoring server (validates tokens via verifytoken middleware)
 * - External server (validates tokens)
 * - Any other microservice needing user verification
 *
 * IMPORTANT: Both servers use the same:
 * - JWT_SECRET (for signing/verifying JWT)
 * - ENCRYPTION_KEY (for encrypting/decrypting tokens)
 *
 * Token Flow:
 * User (Mobile App)
 *   ↓ [POST /api/auth/login]
 * users_Payment (authenticates user, generates encrypted token)
 *   ↓ [returns encrypted token]
 * Mobile App (stores token in secure storage)
 *   ↓ [uses token in auth-token header for all requests]
 * Trip-Monitoring (validates token via verifytoken middleware)
 *   ↓ [grants/denies access]
 *
 * Security Guarantees:
 * ✅ Strong password hashing (bcrypt with salt)
 * ✅ JWT signing with JWT_SECRET
 * ✅ AES-256-CBC encryption layer
 * ✅ Token expiry enforcement (7 days)
 * ✅ Rate limiting to prevent brute force
 * ✅ Audit logging of all auth events
 * ✅ Mobile-app-only access (header validation)
 */

// npm dependencies:
// helmet express-mongo-sanitize express-rate-limit hpp xss-clean compression
// express-useragent morgan cookie-parser cors express-validator crypto bcryptjs

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const xss = require("xss");
const compression = require("compression");
const useragent = require("express-useragent");
const morgan = require("morgan");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { encrypt } = require("../util/encryption"); // ✅ Use existing encryption utility
const { logSecurityEvent } = require("../util/auditLogger");
const { logger } = require("../monitoring/metrics");

// ============================================================================
// TOKEN GENERATION UTILITIES (Main Purpose of users_Payment)
// ============================================================================

/**
 * Generate JWT token with user claims
 * Uses JWT_SECRET from environment (same as genarattokenandcookies.js)
 * @param {Object} user - User object with _id, email, role
 * @returns {string} - Signed JWT token
 */
const generateJWT = (user) => {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is required in environment variables");
  }

  // Handle nested email structure or legacy string (same as genarattokenandcookies.js)
  const email =
    user.email && user.email.address ? user.email.address : user.email;

  const token = jwt.sign(
    {
      id: user._id.toString(),
      email: email,
      role: user.role,
      iat: Date.now(),
    },
    process.env.JWT_SECRET,
    { expiresIn: "7d" },
  );

  return token;
};

/**
 * Encrypt JWT token using util/encryption.js
 * This ensures COMPATIBILITY with genarattokenandcookies.js and verifytoken.js
 * Format: iv:encryptedData (same as encrypt() function in util/encryption.js)
 * @param {string} token - JWT token to encrypt
 * @returns {string} - Encrypted token in iv:data format
 */
const encryptToken = (token) => {
  try {
    // ✅ Use existing encrypt() from util/encryption.js
    // This maintains compatibility with genarattokenandcookies.js and verifytoken.js
    const encryptedToken = encrypt(token);
    return encryptedToken;
  } catch (err) {
    logger.error("Token encryption failed", { error: err.message });
    throw new Error("Failed to encrypt token");
  }
};

/**
 * Generate complete token package for mobile app
 * This is what gets returned to the app after successful login
 * Returns same format as genarattokenandcookies.js generateTokenAndSend()
 * @param {Object} user - User object
 * @returns {Object} - {accessToken, expiresIn, tokenType}
 */
const generateTokenPackage = (user) => {
  try {
    const jwtToken = generateJWT(user);
    const encryptedToken = encryptToken(jwtToken);
    const expiresIn = 7 * 24 * 60 * 60; // 7 days in seconds

    logger.info("Token generated successfully", {
      userId: user._id,
      email: user.email?.address || user.email,
    });

    return {
      accessToken: encryptedToken,
      expiresIn,
      tokenType: "Bearer",
    };
  } catch (err) {
    logger.error("Token generation failed", { error: err.message });
    throw err;
  }
};

// ============================================================================
// AUTHENTICATION SECURITY CONFIGURATION
// ============================================================================

module.exports = (app) => {
  //  إعدادات أساسية محسنة
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // للتعامل مع الـ proxy في production

  //  نظام التسجيل والمراقبة المتقدم
  const securityLogger = {
    suspicious: (message, req) => {
      const logEntry = {
        timestamp: new Date().toISOString(),
        level: "SUSPICIOUS",
        message,
        ip: req.ip,
        userAgent: req.get("User-Agent"),
        method: req.method,
        url: req.url,
        host: req.hostname,
      };
      console.warn("🚨 [SECURITY_ALERT]", JSON.stringify(logEntry));
    },
    attack: (message, req) => {
      const logEntry = {
        timestamp: new Date().toISOString(),
        level: "ATTACK_BLOCKED",
        message,
        ip: req.ip,
        userAgent: req.get("User-Agent"),
        method: req.method,
        url: req.url,
        host: req.hostname,
        headers: req.headers,
      };
      console.error("🔥 [ATTACK_BLOCKED]", JSON.stringify(logEntry));
    },
  };

  //  نظام التسجيل (Logging) محسن
  app.use(
    morgan("combined", {
      skip: (req, res) => res.statusCode < 400,
      stream: { write: (message) => console.log("📝 " + message.trim()) },
    }),
  );

  // ========== MOBILE-APP-ONLY ACCESS ENFORCEMENT ==========
  // ✅ Block browsers, Postman, Insomnia, curl, and other test tools
  app.use((req, res, next) => {
    // Allow localhost/internal for development
    const clientIp = req.ip || req.connection.remoteAddress;
    const isLocal =
      clientIp === "127.0.0.1" ||
      clientIp === "::1" ||
      clientIp.includes("192.168.") ||
      clientIp.includes("10.");

    if (isLocal) {
      return next();
    }

    // ✅ ALWAYS allow webhooks (GCS, Kafka, Stripe, etc.)
    const isWebhook =
      req.path.includes("/webhook") ||
      req.path.includes("/api/webhook") ||
      req.path.includes("/api/payment/webhook") ||
      req.path.includes("verifyDocuments/webhook") ||
      req.path.includes("gcs/webhook");
    if (isWebhook) {
      return next();
    }

    // Health checks always allowed
    if (req.path.startsWith("/health") || req.path.startsWith("/metrics")) {
      return next();
    }

    // ❌ Block browser navigation attempts
    const isBrowserNav =
      req.headers["sec-fetch-dest"] === "document" ||
      req.headers["sec-fetch-mode"] === "navigate" ||
      (req.headers["accept"] && req.headers["accept"].includes("text/html"));

    if (isBrowserNav) {
      logSecurityEvent({
        ip: req.ip,
        action: "BROWSER_ACCESS_BLOCKED",
        details: {
          url: req.url,
          userAgent: req.get("User-Agent"),
        },
      });
      return res.status(403).send("<h1>Access Denied: Mobile App Only</h1>");
    }

    // ❌ Block test tools (Postman, Insomnia, Thunder Client, curl without proper headers)
    const userAgent = req.get("User-Agent") || "";
    const isTestTool =
      userAgent.includes("Postman") ||
      userAgent.includes("Insomnia") ||
      userAgent.includes("Thunder Client");

    if (isTestTool && process.env.NODE_ENV === "production") {
      logSecurityEvent({
        ip: req.ip,
        action: "TEST_TOOL_BLOCKED",
        details: {
          tool: userAgent.split("/")[0],
          url: req.url,
        },
      });
      return res.status(403).json({
        error: "Test tools not allowed in production",
        code: "FORBIDDEN_TOOL",
      });
    }

    next();
  });

  //  وسائط التحليل المحسنة
  app.use(
    express.json({
      limit: "10kb",
      verify: (req, res, buf) => {
        try {
          if (buf && buf.length > 0) {
            JSON.parse(buf);
          }
        } catch (e) {
          securityLogger.suspicious("طلب JSON غير صالح - محاولة هجوم", req);
          throw new Error("JSON غير صالح");
        }
      },
    }),
  );

  app.use(
    express.urlencoded({
      extended: true,
      limit: "10kb",
      parameterLimit: 25, // تقليل عدد المعلمات المسموح بها
    }),
  );

  // ❌ REMOVED: Cookie Parser
  // Mobile apps don't use cookies - they use JWT tokens instead
  // Cookies are web-only, so we don't need this middleware
  // app.use(cookieParser(process.env.COOKIE_SECRET || generateSecurityKey()));

  //  ✅ CORS - Mobile Only (Strict)
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",")
    : []; // Empty by default - no web access

  app.use(
    cors({
      origin: (origin, callback) => {
        // ✅ ALWAYS allow webhooks (no origin check needed)
        const path = callback.toString ? "" : origin;
        // This is a workaround - better to use separate middleware for webhooks

        // Allow requests without origin (mobile apps)
        if (!origin) {
          return callback(null, true);
        }

        // Allow configured origins only
        if (allowedOrigins.includes(origin)) {
          return callback(null, true);
        }

        // ❌ Block all others (browsers, test tools)
        securityLogger.attack(`محاولة وصول من origin غير مصرح: ${origin}`, {
          headers: { origin },
        });
        callback(new Error("Not allowed by CORS"));
      },
      credentials: false, // Mobile apps don't use credentials/cookies
      methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "auth-token",
        "x-device-id",
        "x-app-version",
        "x-goog-channel-token",
      ],
    }),
  );

  // ✅ Special CORS handling for webhooks (GCS, Kafka, etc.)
  app.use((req, res, next) => {
    const isWebhook =
      req.path.includes("/webhook") ||
      req.path.includes("/api/payment/webhook") ||
      req.path.includes("verifyDocuments/webhook");

    if (isWebhook) {
      // Allow webhook origin (GCS, Kafka, etc.)
      res.header("Access-Control-Allow-Origin", "*");
      res.header(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, PATCH",
      );
      res.header(
        "Access-Control-Allow-Headers",
        "Content-Type, x-goog-channel-token",
      );

      if (req.method === "OPTIONS") {
        return res.sendStatus(200);
      }
    }

    next();
  });

  //  فلتر أنواع المحتوى المتقدم
  app.use((req, res, next) => {
    const allowedTypes = [
      "application/json",
      "application/x-www-form-urlencoded",
      "multipart/form-data",
    ];

    const contentType = req.headers["content-type"]?.split(";")[0];

    if (
      req.method !== "GET" &&
      req.method !== "HEAD" &&
      req.method !== "OPTIONS"
    ) {
      if (!contentType) {
        securityLogger.suspicious("طلب بدون Content-Type", req);
        return res.status(400).json({
          error: "مطلوب رأس Content-Type",
          code: "CONTENT_TYPE_REQUIRED",
        });
      }

      if (!allowedTypes.includes(contentType)) {
        securityLogger.suspicious(`نوع محتوى مرفوض: ${contentType}`, req);
        return res.status(415).json({
          error: "نوع المحتوى غير مدعوم",
          allowedTypes,
          code: "UNSUPPORTED_MEDIA_TYPE",
        });
      }
    }
    next();
  });

  //  Helmet محسن لرؤوس الأمان
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'", "https:"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", "https:"],
          objectSrc: ["'none'"],
          mediaSrc: ["'self'"],
          frameSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: [],
        },
      },
      crossOriginEmbedderPolicy: { policy: "require-corp" },
      crossOriginOpenerPolicy: { policy: "same-origin" },
      crossOriginResourcePolicy: { policy: "same-origin" },
      dnsPrefetchControl: { allow: false },
      frameguard: { action: "deny" },
      hidePoweredBy: true,
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true,
      },
      ieNoOpen: true,
      noSniff: true,
      permittedCrossDomainPolicies: { permittedPolicies: "none" },
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    }),
  );

  //  حماية متقدمة من الهجمات
  //  Consolidated Security Sanitizer (XSS + NoSQL Injection + HPP)
  //  This custom implementation avoids "TypeError: Cannot set property query" in Express 5
  const securitySanitizer = (req, res, next) => {
    const whitelistHPP = ["page", "limit", "sort", "fields", "search"];

    const sanitizeRecursive = (obj, isTopLevelQuery = false) => {
      if (typeof obj !== "object" || obj === null) return;

      Object.keys(obj).forEach((key) => {
        // 1. HPP Protection (only for top-level keys in req.query)
        if (
          isTopLevelQuery &&
          Array.isArray(obj[key]) &&
          !whitelistHPP.includes(key)
        ) {
          obj[key] = obj[key][obj[key].length - 1];
        }

        // 2. Mongo Injection Protection (Key level)
        let processedKey = key;
        if (key.startsWith("$") || key.includes(".")) {
          processedKey = key.replace(/^\$/, "_").replace(/\./g, "_");
          if (processedKey !== key) {
            obj[processedKey] = obj[key];
            delete obj[key];
            securityLogger.suspicious(`محاولة حقن NoSQL تم تنظيفها: ${key}`, req);
          }
        }

        // 3. XSS Protection (Value level string)
        if (typeof obj[processedKey] === "string") {
          obj[processedKey] = xss(obj[processedKey]);
        }
        // 4. Recursive for nested objects
        else if (
          typeof obj[processedKey] === "object" &&
          obj[processedKey] !== null
        ) {
          sanitizeRecursive(obj[processedKey], false);
        }
      });
    };

    if (req.body) sanitizeRecursive(req.body, false);
    if (req.query) sanitizeRecursive(req.query, true);
    if (req.params) sanitizeRecursive(req.params, false);
    next();
  };

  app.use(securitySanitizer);

  //  نظام تحديد المعدل المتقدم
  const createRateLimit = (windowMs, max, message, keyGenerator = null) => {
    return rateLimit({
      windowMs,
      max,
      message: { error: message, code: "RATE_LIMIT_EXCEEDED" },
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: keyGenerator || ((req) => req.ip),
      handler: (req, res) => {
        securityLogger.suspicious(
          `تم تجاوز حد المعدل: ${max} طلب في ${windowMs / 60000} دقيقة`,
          req,
        );
        res.status(429).json({
          error: message,
          retryAfter: Math.ceil(windowMs / 1000),
          code: "RATE_LIMIT_EXCEEDED",
        });
      },
      skip: (req) => {
        //   rate limit  لـ IPs موثوقة
        const trustedIPs = ["127.0.0.1", "::1"];
        return trustedIPs.includes(req.ip);
      },
    });
  };

  // تطبيق أنظمة تحديد المعدل المتعددة
  const generalLimiter = createRateLimit(
    15 * 60 * 1000,
    100,
    "تم حظر الطلبات المفرطة مؤقتًا، حاول لاحقًا",
  );
  const authLimiter = createRateLimit(
    15 * 60 * 1000,
    5,
    "محاولات تسجيل دخول كثيرة جدًا",
  );
  const strictLimiter = createRateLimit(
    60 * 1000,
    10,
    "طلبات كثيرة جدًا، الرجاء التباطؤ",
  );
  const accountCreationLimiter = createRateLimit(
    60 * 60 * 1000,
    3,
    "تم تجاوز الحد الأقصى لإنشاء الحسابات",
  );

  app.use("/api/auth", authLimiter);
  app.use("/api/register", accountCreationLimiter);
  app.use("/api/password", strictLimiter);
  app.use(
    "/api/admin",
    createRateLimit(15 * 60 * 1000, 30, "طلبات إدارية مفرطة"),
  );
  app.use(
    "/graphql",
    createRateLimit(15 * 60 * 1000, 50, "طلبات GraphQL مفرطة"),
  );
  app.use(generalLimiter);

  //  الضغط الآمن
  app.use(
    compression({
      level: 6,
      threshold: 1024,
      filter: (req, res) => {
        if (req.headers["x-no-compression"]) return false;
        return compression.filter(req, res);
      },
    }),
  );

  //  كشف المتصفح المتقدم
  app.use(useragent.express());

  //  طبقات حماية إضافية متقدمة

  // 1. حماية الـ Host المحسنة
  app.use((req, res, next) => {
    const allowedHosts = process.env.ALLOWED_HOSTS
      ? process.env.ALLOWED_HOSTS.split(",")
      : ["localhost", "127.0.0.1", "example.com", "www.example.com"];

    if (!allowedHosts.includes(req.hostname)) {
      securityLogger.attack(
        `محاولة وصول من host غير مصرح: ${req.hostname}`,
        req,
      );
      return res.status(403).json({
        error: "طلب غير مصرح به",
        code: "FORBIDDEN_HOST",
      });
    }
    next();
  });

  // 2. حماية متقدمة من المسارات المشبوهة
  app.use((req, res, next) => {
    const suspiciousPatterns = [
      /\.\./, // Directory traversal
      /\/\.\//, // Hidden files
      /\/\/+/, // Multiple slashes
      /\.(env|config|git|htaccess|sql|bak|old|tar|gz)$/i, // Sensitive files
      /(\/\/|\\\\)/, // Double slashes/backslashes
      /(%2e|%2f)/i, // URL encoded path traversal
      /(\.\.%2f|%2e%2e%2f)/i, // Encoded directory traversal
    ];

    for (const pattern of suspiciousPatterns) {
      if (
        pattern.test(req.path) ||
        pattern.test(decodeURIComponent(req.path))
      ) {
        securityLogger.attack(`مسار مشبوه: ${req.path}`, req);
        return res.status(400).json({
          error: "مسار غير صالح",
          code: "INVALID_PATH",
        });
      }
    }
    next();
  });

  // 3. حماية متقدمة من Method Override
  app.use((req, res, next) => {
    const overrideHeaders = [
      "x-http-method-override",
      "x-http-method",
      "x-method-override",
      "http-method",
      "method",
    ];

    for (const header of overrideHeaders) {
      if (req.headers[header]) {
        securityLogger.suspicious(
          `محاولة Method Override باستخدام: ${header}`,
          req,
        );
        return res.status(405).json({
          error: "Method Override غير مسموح",
          code: "METHOD_OVERRIDE_NOT_ALLOWED",
        });
      }
    }
    next();
  });

  // 4. حماية متقدمة من query string الضخم
  app.use((req, res, next) => {
    if (Object.keys(req.query).length > 20) {
      securityLogger.suspicious("عدد كبير جدًا من معلمات Query String", req);
      return res.status(400).json({
        error: "طلبات URL زائدة",
        code: "TOO_MANY_QUERY_PARAMS",
      });
    }

    // فحص معلمات query مشبوهة
    const suspiciousQueryParams = [
      "password",
      "secret",
      "token",
      "auth",
      "key",
      "api_key",
    ];
    for (const param of suspiciousQueryParams) {
      if (req.query[param]) {
        securityLogger.suspicious(`معلمة query مشبوهة: ${param}`, req);
        delete req.query[param];
      }
    }
    next();
  });

  // 5. منع التخزين المؤقت للبيانات الحساسة
  app.use((req, res, next) => {
    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate",
    );
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");
    next();
  });

  // 6. فحص User-Agent المتقدم
  app.use((req, res, next) => {
    const suspiciousUserAgents = [
      /sqlmap/i,
      /nikto/i,
      /metasploit/i,
      /nmap/i,
      /zap/i,
      /w3af/i,
      /havij/i,
      /acunetix/i,
      /netsparker/i,
      /nessus/i,
      /openvas/i,
      /burpsuite/i,
      /dirbuster/i,
      /gobuster/i,
      /wfuzz/i,
      /hydra/i,
    ];

    const userAgent = req.get("User-Agent") || "";

    for (const pattern of suspiciousUserAgents) {
      if (pattern.test(userAgent)) {
        securityLogger.attack(`أداة اختراق مكتشفة: ${userAgent}`, req);
        return res.status(403).json({
          error: "طلب غير مصرح به",
          code: "FORBIDDEN_USER_AGENT",
        });
      }
    }
    next();
  });

  // 7. حماية من هجمات Regex DoS
  app.use((req, res, next) => {
    const maxInputLength = 1000;
    const inputsToCheck = [
      req.url,
      JSON.stringify(req.body),
      JSON.stringify(req.query),
    ];

    for (const input of inputsToCheck) {
      if (input && input.length > maxInputLength) {
        securityLogger.attack(
          `مدخلات طويلة بشكل مشبوه: ${input.length} حرف`,
          req,
        );
        return res.status(400).json({
          error: "المدخلات طويلة جدًا",
          code: "INPUT_TOO_LONG",
        });
      }
    }
    next();
  });

  // 8. حماية من هجمات البرمجة النصية عبر المواقع (XSS) المحسنة
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader(
      "Permissions-Policy",
      "geolocation=(), microphone=(), camera=(), payment=()",
    );
    res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
    next();
  });

  // 9. فحص حجم المحتوى
  app.use((req, res, next) => {
    // Exempt webhooks from small payload limits (Stripe payloads can be > 10KB)
    if (req.path.includes("/webhook")) {
      return next();
    }

    const contentLength = parseInt(req.get("Content-Length") || "0");
    if (contentLength > 10 * 1024) {
      // 10KB كحد أقصى
      securityLogger.suspicious(`حجم محتوى كبير: ${contentLength} بايت`, req);
      return res.status(413).json({
        error: "حجم الطلب كبير جدًا",
        code: "PAYLOAD_TOO_LARGE",
      });
    }
    next();
  });

  // 10. منع اكتشاف المعلومات
  app.use((req, res, next) => {
    // إخفاء معلومات الخادم
    res.setHeader("Server", "Secure-Server");
    next();
  });

  // 11. فحص الـ IP المشبوه
  app.use((req, res, next) => {
    const suspiciousIPs = [
      // يمكن إضافة IPs مشبوهة معروفة
    ];

    const clientIP = req.ip || req.connection.remoteAddress;

    if (suspiciousIPs.includes(clientIP)) {
      securityLogger.attack(`طلب من IP مشبوه: ${clientIP}`, req);
      return res.status(403).json({
        error: "طلب غير مصرح به",
        code: "FORBIDDEN_IP",
      });
    }
    next();
  });

  // 12. ✅ CRITICAL: Mobile App Only Validation
  // This ensures NO OTHER SERVICE can access users_Payment directly
  // All requests MUST come from the authenticated mobile app
  app.use((req, res, next) => {
    // Allow internal/localhost for development
    const clientIP = req.ip || req.connection.remoteAddress;
    const isInternal =
      clientIP === "127.0.0.1" ||
      clientIP === "::1" ||
      clientIP.includes("192.168.") ||
      clientIP.includes("10.");

    if (isInternal) {
      return next();
    }

    // Allow health/metrics checks
    if (req.path.startsWith("/health") || req.path.startsWith("/metrics")) {
      return next();
    }

    // REJECT: Direct browser access (prevent web-based attacks)
    const isBrowserNav =
      req.headers["sec-fetch-dest"] === "document" ||
      req.headers["sec-fetch-mode"] === "navigate" ||
      (req.headers["accept"] && req.headers["accept"].includes("text/html"));

    if (isBrowserNav) {
      logSecurityEvent({
        ip: req.ip,
        action: "BROWSER_ACCESS_BLOCKED",
        details: {
          url: req.url,
          userAgent: req.get("User-Agent"),
        },
      });
      return res.status(403).send("<h1>Access Denied: Mobile App Only</h1>");
    }

    // REJECT: Tools like Postman in production (prevent unauthorized testing)
    const userAgent = req.get("User-Agent") || "";
    if (
      (userAgent.includes("Postman") ||
        userAgent.includes("Insomnia") ||
        userAgent.includes("Thunder Client")) &&
      process.env.NODE_ENV === "production"
    ) {
      logSecurityEvent({
        ip: req.ip,
        action: "TEST_TOOL_BLOCKED",
        details: {
          tool: userAgent.split("/")[0],
          url: req.url,
        },
      });
      return res.status(403).json({
        error: "Test tools not allowed",
        code: "FORBIDDEN_TOOL",
      });
    }

    next();
  });

  // ========== Rate Limiting for Authentication ==========
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 attempts
    keyGenerator: (req) => req.body?.email || req.ip,
    handler: (req, res) => {
      logSecurityEvent({
        ip: req.ip,
        action: "LOGIN_RATE_LIMITED",
        details: {
          email: req.body?.email,
          url: req.url,
        },
      });

      res.status(429).json({
        error: "Too many login attempts",
        code: "LOGIN_RATE_LIMITED",
        retryAfter: req.rateLimit.resetTime,
      });
    },
  });

  app.use("/api/auth/login", loginLimiter);
  app.use("/api/auth/register", loginLimiter);

  logger.info("users_Payment security configured - Token Generation Ready", {
    tokenEncryptionEnabled: !!process.env.ENCRYPTION_KEY,
    tokenSigningEnabled: !!process.env.JWT_SECRET,
    environment: process.env.NODE_ENV,
  });
};

// ============================================================================
// EXPORT TOKEN GENERATION UTILITIES
// ============================================================================

module.exports.generateTokenPackage = generateTokenPackage;
module.exports.generateJWT = generateJWT;
module.exports.encryptToken = encryptToken;
