const bcrypt = require("bcrypt");
const { getUserModel, getUserKYCModel, getUserWalletModel } = require("../../models/users.models");

async function seedUsers(log) {
    const User = getUserModel();
    const UserKYC = getUserKYCModel();
    const UserWallet = getUserWalletModel();

    log("Clearing existing users, KYC, and Wallets...");
    await Promise.all([
        User.deleteMany({}),
        UserKYC.deleteMany({}),
        UserWallet.deleteMany({})
    ]);

    const usersToSeed = [
        {
            username: "WayzonAdmin",
            email: { address: "admin@wayzon.com", verified: true },
            password: "Admin123Password!",
            role: "admin",
            phone: "+201111111111",
            country: "Egypt",
            Address: "Main Office, Cairo",
            gender: "male",
            isPremium: true
        },
        {
            username: "AhmedGuide",
            email: { address: "ahmed@wayzon.com", verified: true },
            password: "Guide123Ahmed!",
            role: "guide",
            phone: "+201222222222",
            country: "Egypt",
            Address: "Downtown, Cairo",
            gender: "male",
            isPremium: true,
            description: "Professional tour guide with 10 years experience in Egyptian history.",
            languages: [
                { name: "Arabic", proficiency: "native" },
                { name: "English", proficiency: "advanced" }
            ],
            transportation: { hasVehicle: true, vehicleType: "car", description: "Toyota Corolla 2023" }
        },
        {
            username: "SaraGuide",
            email: { address: "sara@wayzon.com", verified: true },
            password: "Guide123Sara!",
            role: "guide",
            phone: "+201555555555",
            country: "Egypt",
            Address: "Giza, Egypt",
            gender: "female",
            isPremium: true,
            description: "Expert in Giza Plateau and Saqqara tours.",
            languages: [
                { name: "Arabic", proficiency: "native" },
                { name: "French", proficiency: "advanced" }
            ]
        },
        {
            username: "JohnTourist",
            email: { address: "john@travel.com", verified: true },
            password: "Tourist123John!",
            role: "normal",
            phone: "+12025550123",
            country: "United States",
            Address: "New York, USA",
            gender: "male",
            isPremium: false
        },
        {
            username: "MariaTraveler",
            email: { address: "maria@euro.com", verified: true },
            password: "Tourist123Maria!",
            role: "normal",
            phone: "+34600123456",
            country: "Spain",
            Address: "Madrid, Spain",
            gender: "female",
            isPremium: true
        }
    ];

    const seededUsers = [];
    const salt = await bcrypt.genSalt(10);

    for (const userData of usersToSeed) {
        const hashedPassword = await bcrypt.hash(userData.password, salt);
        const user = await User.create({
            ...userData,
            password: hashedPassword
        });

        // KYC - Use findOneAndUpdate because model post-save hook auto-creates it
        await UserKYC.findOneAndUpdate(
            { userId: user._id },
            {
                documentation: true,
                identityNumber: `ID-${user._id.toString().slice(-6).toUpperCase()}`,
                identityType: "passport"
            },
            { upsert: true }
        );

        // Wallet - Use findOneAndUpdate because model post-save hook auto-creates it
        await UserWallet.findOneAndUpdate(
            { userId: user._id },
            {
                balance: user.role === 'guide' ? 0 : 1000,
                wallet: user.role === 'normal' ? 500 : 0
            },
            { upsert: true }
        );

        seededUsers.push(user);
        log(`Seeded User: ${user.username} (${user.role})`);
    }

    return seededUsers;
}

module.exports = seedUsers;
