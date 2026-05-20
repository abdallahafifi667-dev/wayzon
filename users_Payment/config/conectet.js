const mongoose = require("mongoose");

let userDB, orderDB, auditDB;
let isConnected = false;

const connect = async () => {
  try {
    if (
      !process.env.MONGO_URL_USERS ||
      !process.env.MONGO_URL_ORDERS ||
      !process.env.MONGO_URL_AUDIT
    ) {
      throw new Error("Missing MongoDB connection strings");
    }

    // استخدم الطريقة الحديثة للاتصال بدون options deprecated
    userDB = mongoose.createConnection(process.env.MONGO_URL_USERS);
    orderDB = mongoose.createConnection(process.env.MONGO_URL_ORDERS);
    auditDB = mongoose.createConnection(process.env.MONGO_URL_AUDIT);

    // انتظر اكتمال الاتصال
    await Promise.all([
      userDB.asPromise(),
      orderDB.asPromise(),
      auditDB.asPromise(),
    ]);

    isConnected = true;
    console.log("✅✅✅ Connected to both MongoDB databases 💖");
    // Post-connect: verify geo indexes for users collection and fix common mis-indexes
    try {
      // lazy-load the model to access the collection
      const { getUserModel } = require("../models/users.models");
      const User = getUserModel();

      const indexes = await User.collection.indexes();
      // Find any 2dsphere indexes that are NOT on the `location` key
      for (const idx of indexes) {
        // idx.key is an object of the index keys
        const keys = idx.key || {};
        for (const k of Object.keys(keys)) {
          if (
            String(keys[k]).toLowerCase() === "2dsphere" &&
            k !== "location"
          ) {
            console.warn(
              `⚠️ Dropping invalid 2dsphere index on '${k}' (index name: ${idx.name})`,
            );
            try {
              await User.collection.dropIndex(idx.name);
              console.log(`✅ Dropped index ${idx.name}`);
            } catch (dropErr) {
              console.error(
                `Failed to drop index ${idx.name}:`,
                dropErr && dropErr.message,
              );
            }
          }
        }
      }

      // Ensure correct location 2dsphere index exists
      const hasLocationIndex = indexes.some(
        (i) => i.key && i.key.location === "2dsphere",
      );
      if (!hasLocationIndex) {
        try {
          await User.collection.createIndex({ location: "2dsphere" });
          console.log("✅ Created missing 2dsphere index on `location`");
        } catch (createErr) {
          console.error(
            "Failed to create 2dsphere index on `location`:",
            createErr && createErr.message,
          );
        }
      }
    } catch (indexErr) {
      console.warn(
        "Could not validate/drop geo indexes for users collection:",
        indexErr && indexErr.message,
      );
    }
    // Also validate orders DB geo indexes
    try {
      const { getOrderModel } = require("../models/order.models");
      const Order = getOrderModel();

      const orderIndexes = await Order.collection.indexes();
      // Drop any 2dsphere index that is not on allowed keys
      const allowedOrderGeoKeys = new Set([
        "locations.coordinates",
        "meetingPoint.coordinates",
      ]);
      for (const idx of orderIndexes) {
        const keys = idx.key || {};
        for (const k of Object.keys(keys)) {
          if (
            String(keys[k]).toLowerCase() === "2dsphere" &&
            !allowedOrderGeoKeys.has(k)
          ) {
            console.warn(
              `⚠️ Dropping invalid 2dsphere index on orders collection key '${k}' (index name: ${idx.name})`,
            );
            try {
              await Order.collection.dropIndex(idx.name);
              console.log(`✅ Dropped order index ${idx.name}`);
            } catch (dropErr) {
              console.error(
                `Failed to drop order index ${idx.name}:`,
                dropErr && dropErr.message,
              );
            }
          }
        }
      }

      // Ensure required 2dsphere indexes exist
      const hasLocationsIndex = orderIndexes.some(
        (i) => i.key && i.key.locations === "2dsphere",
      );
      const hasMeetingIndex = orderIndexes.some(
        (i) => i.key && i.key.meetingPoint === "2dsphere",
      );
      if (!hasLocationsIndex) {
        try {
          await Order.collection.createIndex({
            "locations.coordinates": "2dsphere",
          });
          console.log(
            "✅ Created missing 2dsphere index on `orders.locations.coordinates`",
          );
        } catch (createErr) {
          console.error(
            "Failed to create 2dsphere index on `orders.locations.coordinates`:",
            createErr && createErr.message,
          );
        }
      }
      if (!hasMeetingIndex) {
        try {
          await Order.collection.createIndex({
            "meetingPoint.coordinates": "2dsphere",
          });
          console.log(
            "✅ Created missing 2dsphere index on `orders.meetingPoint.coordinates`",
          );
        } catch (createErr) {
          console.error(
            "Failed to create 2dsphere index on `orders.meetingPoint.coordinates`:",
            createErr && createErr.message,
          );
        }
      }
    } catch (orderIndexErr) {
      console.warn(
        "Could not validate/drop geo indexes for orders collection:",
        orderIndexErr && orderIndexErr.message,
      );
    }

    return { userDB, orderDB, auditDB };
  } catch (error) {
    console.log("❌❌ Error connecting to MongoDB 💔: ", error.message);
    throw error;
  }
};

const getUserDB = () => {
  if (!isConnected) {
    throw new Error("Database connection not established yet");
  }
  return userDB;
};

const getOrderDB = () => {
  if (!isConnected) {
    throw new Error("Database connection not established yet");
  }
  return orderDB;
};
const getAuditDB = () => {
  if (!isConnected) {
    throw new Error("Database connection not established yet");
  }
  return auditDB;
};

process.on("SIGINT", async () => {
  if (userDB) await userDB.close();
  if (orderDB) await orderDB.close();
  if (auditDB) await auditDB.close();
  console.log("🔌 MongoDB connections closed");
  process.exit(0);
});

module.exports = {
  connect,
  getUserDB,
  getOrderDB,
  getAuditDB,
};
