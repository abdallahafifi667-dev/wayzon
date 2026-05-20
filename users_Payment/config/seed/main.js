const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../../.env") });
const { connect } = require("../conectet");

// Import Seeders
const seedUsers = require("./1-users.seed.js");
const seedOrders = require("./2-orders.seed.js");
const seedChats = require("./3-chats.seed.js");
const seedReviews = require("./4-reviews.seed.js");
const seedPayments = require("./5-payments.seed.js");

const log = (msg) => {
    console.log(`[SEEDER] ${msg}`);
};

async function runMainSeed() {
    let dbs;
    try {
        log("🚀 Starting Modular Database Seeding Process...");
        
        // 1. Connect to Database
        dbs = await connect();
        log("✅ Connected to MongoDB.");

        // 2. Run Users Seeder
        const users = await seedUsers(log);
        log(`✅ User Seeding Finished. (${users.length} users created)`);

        // 3. Run Orders Seeder
        const orders = await seedOrders(log, users);
        log(`✅ Order Seeding Finished. (${orders.length} orders created)`);

        // 4. Run Chats Seeder
        await seedChats(log, users, orders);
        log("✅ Chat Seeding Finished.");

        // 5. Run Reviews Seeder
        await seedReviews(log, users, orders);
        log("✅ Review Seeding Finished.");

        // 6. Run Payments Seeder
        await seedPayments(log, users);
        log("✅ Payment Seeding Finished.");

        log("🎉 ALL SEEDING TASKS COMPLETED SUCCESSFULLY!");
        
        // Close connections
        if (dbs.userDB) await dbs.userDB.close();
        if (dbs.orderDB) await dbs.orderDB.close();
        if (dbs.auditDB) await dbs.auditDB.close();
        
        process.exit(0);
    } catch (error) {
        log(`❌ CRITICAL ERROR DURING SEEDING: ${error.message}`);
        console.error(error);
        
        if (dbs) {
            if (dbs.userDB) await dbs.userDB.close();
            if (dbs.orderDB) await dbs.orderDB.close();
            if (dbs.auditDB) await dbs.auditDB.close();
        }
        
        process.exit(1);
    }
}

runMainSeed();
