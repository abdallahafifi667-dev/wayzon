const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../../.env") });

const { connect } = require("../conectet");
const { getUserModel, getUserKYCModel, getUserWalletModel } = require("../../models/users.models");
const { getOrderModel } = require("../../models/order.models");
const { getChatModel } = require("../../models/Chat.models");
const { getPaymentTransactionModel } = require("../../models/PaymentTransaction.models");
const { getUserReview } = require("../../models/Review.models");
const { getAuditModel } = require("../../models/Audit.models");

const fs = require("fs");
const logFilePath = path.join(__dirname, "seed_full_log.txt");

const log = (message) => {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    console.log(message);
    try {
        fs.appendFileSync(logFilePath, logMessage);
    } catch (err) {}
};

const seedDatabase = async () => {
    let userDB, orderDB, auditDB;
    try {
        if (fs.existsSync(logFilePath)) fs.unlinkSync(logFilePath);
        log("Starting Comprehensive Seed script...");
        log("Connecting to databases...");
        const dbs = await connect();
        userDB = dbs.userDB;
        orderDB = dbs.orderDB;
        auditDB = dbs.auditDB;

        const User = getUserModel();
        const UserKYC = getUserKYCModel();
        const UserWallet = getUserWalletModel();
        const Order = getOrderModel();
        const Chat = getChatModel();
        const Payment = getPaymentTransactionModel();
        const Review = getUserReview();
        const Audit = getAuditModel();

        log("Clearing existing data (DB Reset) ...");
        await Promise.all([
            User.deleteMany({}),
            UserKYC.deleteMany({}),
            UserWallet.deleteMany({}),
            Order.deleteMany({}),
            Chat.deleteMany({}),
            Payment.deleteMany({}),
            Review.deleteMany({}),
            Audit.deleteMany({})
        ]);
        log("Old data cleared successfully.");

        // 1. Users
        log("Seeding Users...");
        
        const usersToSeed = [
            {
                username: "AdminUser",
                email: { address: "admin@wayzon.com", verified: true },
                password: "Admin123!",
                role: "admin",
                phone: "+201111111111",
                country: "Egypt",
                Address: "Cairo, Egypt",
                gender: "male",
                isPremium: true
            },
            {
                username: "LuxuryGuide",
                email: { address: "guide@wayzon.com", verified: true },
                password: "Guide123!",
                role: "guide",
                phone: "+202222222222",
                country: "Egypt",
                Address: "Luxor, Egypt",
                gender: "male",
                isPremium: true,
                languages: [{ name: "English", proficiency: "advanced" }, { name: "Arabic", proficiency: "native" }]
            },
            {
                username: "ExplorerTourist",
                email: { address: "normal@wayzon.com", verified: true },
                password: "Normal123!",
                role: "normal",
                phone: "+203333333333",
                country: "Egypt",
                Address: "Alexandria, Egypt",
                gender: "female",
                isPremium: false
            },
            {
                username: "SpanishExpert",
                email: { address: "spanish@wayzon.com", verified: true },
                password: "Guide123!",
                role: "guide",
                phone: "+34600000000",
                country: "Spain",
                Address: "Madrid, Spain",
                gender: "female",
                isPremium: true,
                languages: [{ name: "Spanish", proficiency: "native" }, { name: "English", proficiency: "advanced" }]
            },
            {
                username: "FrenchTraveler",
                email: { address: "french@wayzon.com", verified: true },
                password: "Normal123!",
                role: "normal",
                phone: "+33600000000",
                country: "France",
                Address: "Paris, France",
                gender: "male",
                isPremium: true
            }
        ];

        const seededUsers = [];
        for (const userData of usersToSeed) {
            const salt = await bcrypt.genSalt(10);
            const hashedPassword = await bcrypt.hash(userData.password, salt);

            const user = await User.findOneAndUpdate(
                { "email.address": userData.email.address },
                { 
                    ...userData, 
                    password: hashedPassword 
                },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );
            
            // Explicitly sync KYC & Wallet
            await UserKYC.findOneAndUpdate(
                { userId: user._id },
                { 
                    documentation: true, 
                    identityNumber: `ID-${user._id.toString().slice(-6)}`, 
                    identityType: "national_id" 
                },
                { upsert: true }
            );

            await UserWallet.findOneAndUpdate(
                { userId: user._id },
                { balance: 5000 },
                { upsert: true }
            );

            seededUsers.push(user);
            log(`Processed user: ${user.username} (${user.role})`);
        }

        const [adminUser, guideUser, normalUser, spanishGuide, frenchTourist] = seededUsers;
        log("Users seeding completed.");

        // 2. Orders
        log("Seeding Orders...");
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);

        const nextWeek = new Date();
        nextWeek.setDate(nextWeek.getDate() + 7);

        // Active Order (In Progress)
        const activeOrder = await Order.create({
            serviceType: "with_guide",
            destinationStatus: "defined",
            normal: normalUser._id,
            guide: guideUser._id,
            tripMode: "guided",
            safetyConfig: { plan: "premium" },
            title: "Private Nile Cruise Tour",
            description: "Exclusive tour exploring the deepest secrets of the river.",
            TripDate: tomorrow,
            duration: 5,
            meetingPoint: { type: "Point", coordinates: [32.64, 25.69] },
            locations: [
                { name: "Starting Dock", type: "Point", coordinates: [32.64, 25.69], visited: false }
            ],
            status: "in_progress",
            price: 1500,
            safetyFee: 50,
            destinationCountry: "Egypt",
            isSolo: false,
        });

        // Pending Order (Open in schema)
        const pendingOrder = await Order.create({
            serviceType: "with_guide",
            destinationStatus: "defined",
            normal: frenchTourist._id,
            tripMode: "guided",
            title: "Barcelona Art & Culture",
            TripDate: nextWeek,
            duration: 3,
            meetingPoint: { type: "Point", coordinates: [2.17, 41.38] },
            status: "open",
            price: 600,
            destinationCountry: "Spain",
            isSolo: false,
        });

        // Cancelled Order
        await Order.create({
            serviceType: "solo_system",
            destinationStatus: "undefined",
            normal: normalUser._id,
            tripMode: "solo_system",
            title: "Solo Backpacking Cairo",
            TripDate: new Date(Date.now() - 86400000 * 10),
            duration: 1,
            status: "cancelled",
            price: 0,
            destinationCountry: "Egypt",
            isSolo: true,
            cancellation: {
                cancelledBy: "tourist",
                cancelledAt: new Date(),
                reason: "Change of plans"
            }
        });

        log(`Created Orders: Active(${activeOrder._id}), Open(${pendingOrder._id})`);
        const activeOrderId = activeOrder._id;

        // 3. Payments
        log("Seeding Payments...");
        await Payment.create([
            {
                userId: normalUser._id,
                stripeSessionId: "cs_test_mock123_topup",
                amount: 2500,
                currency: "usd",
                transactionType: "credit_topup",
                status: "completed",
                description: "Wallet Funding for Nile Cruise"
            },
            {
                userId: guideUser._id,
                stripeSessionId: "cs_test_mock456_payout",
                amount: 1400,
                currency: "usd",
                transactionType: "debt_clearance",
                status: "completed",
                description: "Platform clearance"
            },
            {
                userId: frenchTourist._id,
                stripeSessionId: "cs_test_mock789_initial",
                amount: 5000,
                currency: "usd",
                transactionType: "credit_topup",
                status: "completed",
                description: "Initial Deposit"
            }
        ]);
        log("Payments created.");

        // 4. Chats
        log("Seeding Chats...");
        await Chat.create([
            {
                from: normalUser._id,
                to: guideUser._id,
                message: "Hello! I am excited for our cruise tomorrow.",
                orderId: activeOrderId,
                isRead: true
            },
            {
                from: guideUser._id,
                to: normalUser._id,
                message: "Greetings! The boat is prepped and ready with your complimentary drinks.",
                orderId: activeOrderId,
                isRead: true
            },
            {
                from: normalUser._id,
                to: guideUser._id,
                message: "Should I bring my own towels?",
                orderId: activeOrderId,
                isRead: true
            },
            {
                from: guideUser._id,
                to: normalUser._id,
                message: "No need, everything is provided. Just bring your camera!",
                orderId: activeOrderId,
                isRead: false
            }
        ]);
        log("Chats created.");

        // 5. Reviews
        log("Seeding Reviews...");
        const completedOrder = await Order.create({
             serviceType: "with_guide",
             destinationStatus: "defined",
             normal: normalUser._id,
             guide: guideUser._id,
             tripMode: "guided",
             title: "Pyramids VIP Access",
             TripDate: new Date(Date.now() - 86400000 * 5),
             duration: 4,
             locations: [{ name: "Giza", type: "Point", coordinates: [31.13, 29.98], visited: true }],
             meetingPoint: { type: "Point", coordinates: [31.13, 29.98] },
             status: "completed",
             price: 900,
             destinationCountry: "Egypt",
             isSolo: false,
        });

        await Review.create([
            {
                user: normalUser._id,
                product: completedOrder._id,
                rating: 5,
                comment: "Absolutely breathtaking! The guide had so much historical knowledge."
            },
            {
                user: frenchTourist._id,
                product: completedOrder._id, // Just to have another review
                rating: 4,
                comment: "Very professional and safe. Highly recommended."
            }
        ]);
        log("Reviews created.");

        // 6. Audits
        log("Seeding Audits...");
        await Audit.create([
            { userId: adminUser._id, ip: "127.0.0.1", action: "SYSTEM_MONITORING_START", details: ["Verified system logs"] },
            { userId: normalUser._id, ip: "192.168.1.5", action: "ORDER_CREATED", details: [activeOrderId] },
            { userId: frenchTourist._id, ip: "192.168.1.10", action: "WALLET_TOPUP", details: ["5000 USD"] }
        ]);
        log("Audits created.");

        log("🎉 Full Database Seed Completed Successfully!");
        
        await userDB.close();
        await orderDB.close();
        await auditDB.close();
        process.exit(0);
    } catch (error) {
        log(`❌ Error seeding database: ${error.message}`);
        if (error.stack) log(error.stack);
        if (userDB) await userDB.close();
        if (orderDB) await orderDB.close();
        if (auditDB) await auditDB.close();
        process.exit(1);
    }
};

seedDatabase();
