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
            tls: {
                rejectUnauthorized: false,
            },
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
                name: process.env.EMAIL_NAME || "Wayzon",
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

    async sendVerificationEmail({ to, verificationCode, username }) {
        const subject = "Verify Your Email - Wayzon";
        const text = `Your verification code is: ${verificationCode}`;
        const html = this.generateVerificationTemplate(verificationCode, username);

        return await this.sendMail({
            to,
            subject,
            text,
            html,
        });
    }

    async sendPasswordResetEmail({ to, resetToken, username }) {
        const subject = "Password Reset Request - Wayzon";
        const resetLink = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;
        const html = this.generatePasswordResetTemplate(resetLink, username);

        return await this.sendMail({
            to,
            subject,
            html,
            text: `Click here to reset your password: ${resetLink}`,
        });
    }

    generateVerificationTemplate(code, username) {
        return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Verify Your Email - Wayzon</title>
    <style>
        body { margin: 0; padding: 0; font-family: 'Inter', -apple-system, BlinkMacSystemFont, Arial, sans-serif; background-color: #0B0C10; color: #E5E4E2; -webkit-font-smoothing: antialiased; }
        .container { max-width: 600px; margin: 40px auto; background: linear-gradient(145deg, #1A1A2E 0%, #0B0C10 100%); border-radius: 24px; overflow: hidden; border: 1px solid rgba(212, 175, 55, 0.2); box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4); }
        .header { padding: 40px 0; text-align: center; background: rgba(212, 175, 55, 0.05); border-bottom: 1px solid rgba(212, 175, 55, 0.1); }
        .logo-text { font-size: 32px; font-weight: 800; color: #D4AF37; letter-spacing: 2px; text-transform: uppercase; margin: 0; }
        .content { padding: 48px 40px; }
        h2 { font-size: 24px; font-weight: 700; color: #FFFFFF; margin-top: 0; margin-bottom: 24px; text-align: center; }
        p { font-size: 16px; line-height: 1.6; color: rgba(229, 228, 226, 0.8); margin-bottom: 24px; text-align: center; }
        .otp-container { background: rgba(212, 175, 55, 0.1); padding: 32px; border-radius: 16px; border: 1px dashed #D4AF37; margin: 32px 0; text-align: center; }
        .otp-code { font-size: 40px; font-weight: 800; color: #D4AF37; letter-spacing: 8px; margin: 0; }
        .footer { padding: 32px 40px; text-align: center; font-size: 13px; color: rgba(229, 228, 226, 0.5); background: rgba(0, 0, 0, 0.2); border-top: 1px solid rgba(255, 255, 255, 0.05); }
        .footer b { color: #D4AF37; }
        .security-hint { font-size: 12px; color: rgba(255, 69, 58, 0.8); margin-top: 24px; padding: 12px; background: rgba(255, 69, 58, 0.05); border-radius: 8px; border-left: 3px solid #FF453A; display: inline-block; width: 100%; box-sizing: border-box; }
        @media only screen and (max-width: 600px) { .container { margin: 0; border-radius: 0; width: 100% !important; } .content { padding: 32px 20px; } }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo-text">Wayzon</div>
        </div>
        <div class="content">
            <h2>Email Verification</h2>
            <p>Hello <b>${username}</b>,<br>Thank you for choosing the premium Wayzon experience. To verify your identity and activate your account, please use the secure code below:</p>
            
            <div class="otp-container">
                <div class="otp-code">${code}</div>
            </div>

            <p>This code will expire in 10 minutes. For your security, never share this code with anyone.</p>
            
            <div class="security-hint">
                If you did not request this verification, please ignore this email and secure your account if necessary.
            </div>
        </div>
        <div class="footer">
            &copy; ${new Date().getFullYear()} <b>Wayzon</b> Platform. All Rights Reserved.<br>
            <i>Modern Fintech & Safety Infrastructure</i>
        </div>
    </div>
</body>
</html>
        `;
    }

    generatePasswordResetTemplate(resetLink, username) {
        return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Reset Your Password - Wayzon</title>
    <style>
        body { margin: 0; padding: 0; font-family: 'Inter', -apple-system, BlinkMacSystemFont, Arial, sans-serif; background-color: #0B0C10; color: #E5E4E2; -webkit-font-smoothing: antialiased; }
        .container { max-width: 600px; margin: 40px auto; background: linear-gradient(145deg, #1A1A2E 0%, #0B0C10 100%); border-radius: 24px; overflow: hidden; border: 1px solid rgba(212, 175, 55, 0.2); box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4); }
        .header { padding: 40px 0; text-align: center; background: rgba(212, 175, 55, 0.05); border-bottom: 1px solid rgba(212, 175, 55, 0.1); }
        .logo-text { font-size: 32px; font-weight: 800; color: #D4AF37; letter-spacing: 2px; text-transform: uppercase; margin: 0; }
        .content { padding: 48px 40px; }
        h2 { font-size: 24px; font-weight: 700; color: #FFFFFF; margin-top: 0; margin-bottom: 24px; text-align: center; }
        p { font-size: 16px; line-height: 1.6; color: rgba(229, 228, 226, 0.8); margin-bottom: 32px; text-align: center; }
        .btn-container { text-align: center; margin: 40px 0; }
        .button { background: linear-gradient(135deg, #D4AF37 0%, #C5A059 100%); color: #0B0C10 !important; padding: 18px 48px; text-decoration: none; border-radius: 12px; font-weight: 800; font-size: 16px; display: inline-block; box-shadow: 0 10px 20px rgba(212, 175, 55, 0.2); transition: all 0.3s ease; }
        .link-text { font-size: 13px; color: rgba(229, 228, 226, 0.4); word-break: break-all; margin-top: 24px; text-align: center; }
        .footer { padding: 32px 40px; text-align: center; font-size: 13px; color: rgba(229, 228, 226, 0.5); background: rgba(0, 0, 0, 0.2); border-top: 1px solid rgba(255, 255, 255, 0.05); }
        .footer b { color: #D4AF37; }
        .security-hint { font-size: 12px; color: rgba(255, 69, 58, 0.8); margin-top: 32px; padding: 16px; background: rgba(255, 69, 58, 0.05); border-radius: 12px; border-left: 3px solid #FF453A; text-align: left; }
        @media only screen and (max-width: 600px) { .container { margin: 0; border-radius: 0; width: 100% !important; } .content { padding: 32px 20px; } .button { width: 100%; box-sizing: border-box; } }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo-text">Wayzon</div>
        </div>
        <div class="content">
            <h2>Password Recovery</h2>
            <p>Hello <b>${username}</b>,<br>We received a request to reset your Wayzon account password. Click the secure button below to choose a new one:</p>
            
            <div class="btn-container">
                <a href="${resetLink}" class="button">RESET PASSWORD</a>
            </div>

            <div class="security-hint">
                <b>Security Notice:</b> This link is valid for 1 hour. If you didn't request this, your account is still safe—simply delete this email.
            </div>

            <div class="link-text">
                If the button doesn't work, copy this link: <br>
                ${resetLink}
            </div>
        </div>
        <div class="footer">
            &copy; ${new Date().getFullYear()} <b>Wayzon</b> Platform. All Rights Reserved.<br>
            <i>Modern Fintech & Safety Infrastructure</i>
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
