const nodemailer = require("nodemailer");
const { logUserAction } = require("./auditLogger");
const { logger } = require("../monitoring/metrics");

class EmailService {
  constructor() {
    this.transporter = null;
    this.maxRetries = 3;
    this.retryDelay = 1000;
    this.timeout = 10000;
    this.initializeTransporter();
  }

  initializeTransporter() {
    this.transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL,
        pass: process.env.PASSWORD,
      },
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
      rateDelta: 1000,
      rateLimit: 5,
    });

    this.transporter.verify((error) => {
      if (error) {
        logger.error("Email transporter verification failed:", error.message);
      }
    });
  }

  async sendMail({ to, subject, text, html, attachments = [] }) {
    const mailOptions = {
      from: {
        name: process.env.EMAIL_NAME || "appsligo",
        address: process.env.EMAIL,
      },
      to: Array.isArray(to) ? to : [to],
      subject: subject,
      text: text,
      html: html,
      attachments: attachments,
      headers: {
        "X-Priority": "1",
        "X-MSMail-Priority": "High",
        Importance: "high",
      },
    };

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const info = await Promise.race([
          this.transporter.sendMail(mailOptions),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Email sending timeout")),
              this.timeout,
            ),
          ),
        ]);
        return {
          success: true,
          info,
          attempt: attempt,
        };
      } catch (error) {
        logger.error(`Email sending attempt ${attempt} failed:`, error.message);

        if (attempt === this.maxRetries) {
          await this.handleFailure({ to, subject, error });
          return {
            success: false,
            error: error.message,
            attempts: attempt,
          };
        }

        await this.delay(this.retryDelay * attempt);

        if (error.code === "EAUTH" || error.code === "EENVELOPE") {
          this.initializeTransporter();
        }
      }
    }
  }

  async sendOrderConfirmation({ to, orderDetails, username }) {
    const subject = `Order Confirmed - ${orderDetails.title}`;
    const html = this.generateOrderConfirmationTemplate(orderDetails, username);

    return await this.sendMail({
      to,
      subject,
      html,
    });
  }

  generateOrderConfirmationTemplate(orderDetails, username) {
    // Determine the type of service for the title/icon
    const isGuideService = orderDetails.serviceType === "guide";
    const mainTitle = isGuideService
      ? "Trip Confirmed! 🗺️"
      : "Booking Confirmed! ✈️";
    const confirmationMessage = isGuideService
      ? "Your guided trip with appsilgohas been successfully confirmed. Find your guide at the meeting point!"
      : "Your booking has been successfully confirmed. Details are below.";

    return `
        <!DOCTYPE html>
        <html>
        <head>
            <title>appsilgo- ${mainTitle}</title>
            <style>
                .container { max-width: 650px; margin: 20px auto; padding: 0; font-family: 'Helvetica Neue', Arial, sans-serif; background-color: #ffffff; border-radius: 10px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05); }
                .header { background: #059669; /* appsilgoPrimary Green */ color: white; padding: 30px 20px; text-align: center; border-radius: 10px 10px 0 0; }
                .header h1 { margin: 0; font-size: 28px; font-weight: 600; }
                .content { padding: 40px; }
                .content p { line-height: 1.6; color: #334155; }
                .order-details-box { background: #f0fdf4; /* Light Green Background */ padding: 25px; border: 1px solid #dcfce7; border-radius: 8px; margin-top: 25px; }
                .order-details-box h3 { color: #059669; margin-top: 0; font-size: 20px; border-bottom: 2px solid #a7f3d0; padding-bottom: 10px; margin-bottom: 20px; }
                .detail-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px dotted #e2e8f0; }
                .detail-row:last-child { border-bottom: none; }
                .detail-row strong { color: #1e293b; font-weight: 600; }
                .detail-row span { color: #475569; }
                .footer { margin-top: 40px; padding: 20px 40px; background: #f8fafc; text-align: center; color: #64748b; border-radius: 0 0 10px 10px; border-top: 1px solid #e2e8f0; }
                .logo-text { font-size: 14px; font-weight: 700; color: #0f172a; margin-bottom: 15px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>${mainTitle}</h1>
                </div>
                <div class="content">
                    <p>Dear **${username}**,</p>
                    <p>${confirmationMessage}</p>

                    <div class="order-details-box">
                        <h3>Booking Summary</h3>
                        
                        <div class="detail-row">
                            <strong>Service Title:</strong>
                            <span>${orderDetails.title || "N/A"}</span>
                        </div>
                        
                        <div class="detail-row">
                            <strong>Type:</strong>
                            <span>${isGuideService ? "Guided Tour" : "External Booking"}</span>
                        </div>

                        <div class="detail-row">
                            <strong>Date:</strong>
                            <span>${new Date(orderDetails.TripDate).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</span>
                        </div>
                        
                        <div class="detail-row">
                            <strong>Time:</strong>
                            <span>${new Date(orderDetails.TripDate).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true })}</span>
                        </div>
                        
                        ${
                          orderDetails.duration
                            ? `
                        <div class="detail-row">
                            <strong>Duration:</strong>
                            <span>${orderDetails.duration} hours</span>
                        </div>
                        `
                            : ""
                        }
                        
                        <div class="detail-row">
                            <strong>Meeting Point:</strong>
                            <span>${orderDetails.meetingPoint || "See App Details"}</span>
                        </div>
                        
                        <div class="detail-row" style="background-color: #e0f2f1; font-weight: bold;">
                            <strong>Total Price:</strong>
                            <span style="color: #047857;">$${orderDetails.price || "N/A"}</span>
                        </div>
                        
                    </div>

                    <p style="margin-top: 30px;">
                        You can manage your booking and view guide/driver details in the appsilgomobile application.
                    </p>
                </div>
                <div class="footer">
                    <p class="logo-text">Thank you for choosing Wayzon.</p>
                    <p>&copy; ${new Date().getFullYear()} Wayzon. All rights reserved.</p>
                </div>
            </div>
        </body>
        </html>
    `;
  }

  async handleFailure({ to, subject, error }) {
    await logUserAction({
      action: "email_failure",
      user: to,
      subject,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  getStats() {
    return {
      maxRetries: this.maxRetries,
      timeout: this.timeout,
      retryDelay: this.retryDelay,
      pool: this.transporter ? true : false,
    };
  }

  async close() {
    if (this.transporter) {
      this.transporter.close();
    }
  }
}

// Singleton instance
const emailService = new EmailService();

// Cleanup on process exit
process.on("SIGTERM", async () => {
  await emailService.close();
});

process.on("SIGINT", async () => {
  await emailService.close();
});

module.exports = emailService;
