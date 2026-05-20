"use strict";

const createError = require("http-errors");
const { logSecurityEvent } = require("../util/auditLogger");

const errorNotFound = (req, res, next) => {
  const error = createError(
    404,
    `Route not found: ${req.method} ${req.originalUrl}`,
  );
  logSecurityEvent({
    ip: req.ip,
    action: "ROUTE_NOT_FOUND",
    details: {
      method: req.method,
      url: req.originalUrl,
      userAgent: req.get("User-Agent"),
    },
  });
  next(error);
};

const errorHandler = (err, req, res, next) => {
  const statusCode = err.status || err.statusCode || 500;
  const errorId = require("crypto").randomBytes(8).toString("hex");
  const isDevelopment = process.env.NODE_ENV !== "production";
  const correlationId = req.correlationId || "unknown";

  const errorDetails = {
    errorId,
    correlationId,
    timestamp: new Date().toISOString(),
    method: req.method,
    url: req.url,
    ip: req.ip,
    userAgent: req.get("User-Agent"),
    statusCode,
    message: err.message,
    stack: err.stack,
  };

  if (statusCode >= 500) {
    logSecurityEvent({
      ip: req.ip,
      action: "SERVER_ERROR",
      details: {
        errorId,
        correlationId,
        statusCode,
        url: req.url,
        method: req.method,
      },
    });
  } else if (statusCode >= 400) {
    logSecurityEvent({
      ip: req.ip,
      action: "CLIENT_ERROR",
      details: {
        errorId,
        correlationId,
        statusCode,
        url: req.url,
        method: req.method,
      },
    });

    if (isDevelopment) {
      console.warn("⚠️ Client Error:", {
        errorId,
        correlationId,
        message: err.message,
        statusCode,
        url: req.url,
        ip: req.ip,
      });
    }
  }

  res.format({
    json: () => {
      const response = {
        error:
          statusCode >= 500
            ? "Internal server error"
            : err.message || "An error occurred",
        code: err.code || "UNKNOWN_ERROR",
        errorId,
        correlationId,
        timestamp: errorDetails.timestamp,
      };

      if (isDevelopment && statusCode >= 400) {
        response.debug = {
          message: err.message,
          ...(statusCode >= 500 && { stack: err.stack }),
        };
      }

      res.status(statusCode).json(response);
    },
    html: () => {
      res.status(statusCode).send(`
                <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>${statusCode} Error</title>
                    <style>
                        body { 
                            font-family: Arial, sans-serif; 
                            max-width: 800px; 
                            margin: 0 auto; 
                            padding: 20px; 
                            background-color: #f5f5f5;
                        }
                        .error-container { 
                            background: white; 
                            padding: 30px; 
                            border-radius: 8px; 
                            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                        }
                        .error-code { 
                            color: #d32f2f; 
                            font-size: 2em; 
                            margin-bottom: 10px;
                        }
                        .error-message { 
                            color: #333; 
                            font-size: 1.2em; 
                            margin-bottom: 20px;
                        }
                        .error-id { 
                            background: #f0f0f0; 
                            padding: 10px; 
                            border-radius: 4px; 
                            font-family: monospace; 
                            margin-bottom: 20px;
                            font-size: 0.9em;
                        }
                        .stack-trace { 
                            background: #f8f8f8; 
                            padding: 15px; 
                            border-radius: 4px; 
                            overflow-x: auto; 
                            white-space: pre-wrap; 
                            font-family: monospace; 
                            font-size: 0.9em;
                            border-left: 3px solid #d32f2f;
                        }
                        .message { 
                            color: #666; 
                            margin-top: 20px; 
                            padding: 15px; 
                            background: #fafafa; 
                            border-radius: 4px;
                        }
                    </style>
                </head>
                <body>
                    <div class="error-container">
                        <div class="error-code">${statusCode}</div>
                        <div class="error-message">${isDevelopment ? err.message : "An error occurred"}</div>
                        <div class="error-id">Error ID: ${errorId}</div>
                        <div class="message">
                            ${
                              isDevelopment
                                ? `For support, provide Error ID: <strong>${errorId}</strong>`
                                : "Our team has been notified. Please try again later."
                            }
                        </div>
                        ${
                          isDevelopment && statusCode >= 500
                            ? `
                            <details>
                                <summary>Debug Information (Development Only)</summary>
                                <div class="stack-trace">${err.stack}</div>
                            </details>
                        `
                            : ""
                        }
                    </div>
                </body>
                </html>
            `);
    },
    default: () => {
      res.status(406).json({
        error: "Unsupported Media Type",
        code: "UNSUPPORTED_MEDIA_TYPE",
        errorId,
        correlationId,
      });
    },
  });
};

const asyncErrorHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

const validationErrorHandler = (err, req, res, next) => {
  if (err.name === "ValidationError") {
    const messages = Object.values(err.errors).map((error) => error.message);
    const validationError = createError(422, "Validation Failed", {
      details: messages,
      code: "VALIDATION_ERROR",
    });
    return next(validationError);
  }
  next(err);
};

const databaseErrorHandler = (err, req, res, next) => {
  if (err.name === "MongoError" || err.name === "MongoServerError") {
    let statusCode = 500;
    let message = "Database error occurred";

    if (err.code === 11000) {
      statusCode = 409;
      message = "Duplicate entry found";
    }

    const dbError = createError(statusCode, message, {
      originalError:
        process.env.NODE_ENV === "production" ? undefined : err.message,
      code: "DATABASE_ERROR",
    });
    return next(dbError);
  }
  next(err);
};

const authenticationErrorHandler = (err, req, res, next) => {
  if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
    const authError = createError(401, "Authentication failed", {
      code: "AUTHENTICATION_ERROR",
    });
    return next(authError);
  }
  next(err);
};

module.exports = {
  errorNotFound,
  errorHandler,
  asyncErrorHandler,
  validationErrorHandler,
  databaseErrorHandler,
  authenticationErrorHandler,
};
