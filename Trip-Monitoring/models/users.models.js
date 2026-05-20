const { getUserDB } = require("../config/conectet");
const mongoose = require("mongoose");
const countryData = require("./countries.json");

const countryEnum = Object.keys(countryData);
const { Schema } = mongoose;

const GeoPointSchema = new Schema(
  {
    type: {
      type: String,
      enum: ["Point"],
      default: "Point",
    },
    coordinates: {
      type: [Number], // [longitude, latitude]
      required: true,
    },
  },
  { _id: false },
);

// ✅ 1. USER WALLET SCHEMA (Finance & Balance)
const UserWalletSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },

    RemainingAccount: {
      type: Number,
      min: 0,
      default: 0,
    },
    targetAccount: {
      type: Number,
      min: 0,
      default: 0,
    },

    // ✅ Commission debt tracking (accumulated 5% fees)
    commissionDebt: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ✅ Total commission operations count (for threshold-based enforcement)
    commissionOperationCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ✅ Last payment date for commission
    lastCommissionPaymentDate: Date,

    // ✅ Wallet/balance for pending payments
    wallet: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ✅ Guide earnings from completed trips
    balance: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ✅ Virtual currency/credits for premium features
    credits: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ✅ Track usage in free mode for ad-logic
    freeUsageCount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true },
);

// ✅ 2. USER KYC SCHEMA (Identity & Risk)
const UserKYCSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },

    // ✅ KYC Verified Status
    documentation: {
      type: Boolean,
      default: false,
    },

    // ✅ International identity number (passport, national ID, etc.)
    identityNumber: {
      type: String,
      unique: true,
      trim: true,
      sparse: true, // Allow nulls if not provided initially
    },

    // ✅ Identity document type
    identityType: {
      type: String,
      enum: ["national_id", "passport", "driver_license", "other", null],
      default: null,
    },

    // ✅ Date of birth (extracted from ID during KYC)
    dateOfBirth: {
      type: Date,
      default: null,
    },

    // ✅ Age (calculated from dateOfBirth)
    age: {
      type: Number,
      default: null,
      min: 0,
    },
    gender: {
      type: String,
      enum: ["male", "female", "other", null],
      default: null,
    },

    // ✅ Document verification fields
    documentPhoto: {
      type: String, // ID card/passport photo URL
      default: null,
    },
    guideDocument: {
      type: String, // Tour guide certification document URL
      default: null,
    },
    idVerificationData: {
      extractedText: String,
      extractedId: String, // The ID number extracted from document
      extractedDateOfBirth: Date, // DOB extracted from document
      idType: String, // Type of ID detected
      ageAtVerification: Number, // Age when verified
      duplicateCheckPassed: Boolean, // Passed duplicate check
      verifiedAt: Date,
      faceSimilarity: Number,
      // Liveness detection
      livenessScore: Number,
      livenessConfidence: Number,
      spoofingDetected: Boolean,
      // Image manipulation detection
      selfieManipulationScore: Number,
      selfieManipulationIndicators: [String],
      idCardManipulationScore: Number,
      idCardManipulationIndicators: [String],
    },

    // ✅ KYC retry tracking (fraud prevention)
    kycAttempts: {
      count: { type: Number, default: 0 },
      lastAttempt: { type: Date, default: null },
      lockedUntil: { type: Date, default: null },
    },

    // ✅ Risk score from KYC verification
    riskScore: {
      score: { type: Number, default: 0, min: 0, max: 100 },
      level: {
        type: String,
        enum: ["low", "medium", "high", null],
        default: null,
      },
      factors: [String],
      calculatedAt: { type: Date, default: null },
    },

    // ✅ Pending documents for KYC verification (temporary storage during upload)
    pendingDocuments: {
      selfie: {
        url: { type: String, default: null },
        fileName: { type: String, default: null },
        uploadedAt: { type: Date, default: null },
      },
      idCard: {
        url: { type: String, default: null },
        fileName: { type: String, default: null },
        uploadedAt: { type: Date, default: null },
      },
      guideDocument: {
        url: { type: String, default: null },
        fileName: { type: String, default: null },
        uploadedAt: { type: Date, default: null },
      },
      sessionId: { type: String, default: null },
      createdAt: { type: Date, default: null },
      expiresAt: { type: Date, default: null }, // Auto-cleanup after 30 mins
      verificationStatus: {
        type: String,
        enum: ["pending", "processing", "completed", "failed"],
        default: "pending",
      },
    },
  },
  { timestamps: true },
);

// ✅ 3. USER CORE SCHEMA (Auth, Profile, Location)
const UserSchema = new Schema(
  {
    role: {
      type: String,
      enum: ["guide", "normal", "admin"],
      required: true,
    },
    username: {
      type: String,
      required: true,
    },
    // ✅ Refactored Email Structure
    email: {
      address: {
        type: String,
        required: true,
        unique: true,
        index: true,
        trim: true,
        match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
      },
      verified: {
        type: Boolean,
        default: false,
      },
      verificationCode: {
        // formerly RealEmail for verification code storage
        type: String,
        default: null,
      },
    },

    phone: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      // match: /^[0-9]{12}$/,
    },

    password: {
      type: String,
      required: true,
    },
    resetPasswordCode: {
      type: String,
      default: null,
    },

    avatar: {
      type: String,
      default:
        "https://icon-library.com/images/avatar-icon-images/avatar-icon-images-4.jpg",
    },
    Address: {
      type: String,
      required: true,
      trim: true,
    },
    country: {
      type: String,
      enum: countryEnum,
      required: true,
    },

    // ✅ Kept but acknowledged as non-core (Media)
    PersonalPhoto: [
      {
        type: String,
      },
    ],

    description: {
      type: String,
    },
    gender: {
      type: String,
      enum: ["male", "female", "other", null],
      default: null,
    },

    // ✅ Location - Made Optional
    location: {
      type: GeoPointSchema,
      required: false, // Changed from true
      // default: undefined - Removed as per instruction
    },

    // ✅ Premium status
    isPremium: {
      type: Boolean,
      default: false,
    },
    premiumExpiresAt: {
      type: Date,
      default: null,
    },

    fcmTokens: [
      {
        type: String,
        default: [],
      },
    ],
    notificationSettings: {
      newOrders: { type: Boolean, default: true },
      orderUpdates: { type: Boolean, default: true },
      messages: { type: Boolean, default: true },
    },

    // ✅ Languages spoken by user (tourist/guide)
    languages: [
      {
        name: {
          type: String,
          required: true,
        },
        proficiency: {
          type: String,
          enum: ["beginner", "intermediate", "advanced", "native"],
          required: true,
        },
        video: {
          type: String,
          default: null,
        },
      },
    ],
    // ✅ Guide Assets / Capabilities
    transportation: {
      hasVehicle: { type: Boolean, default: false },
      vehicleType: {
        type: String,
        enum: ["car", "bus", "none"],
        default: "none",
      },
      description: { type: String, trim: true, maxlength: 500 },
    },
  },
  { timestamps: true },
);

UserSchema.pre("save", function (next) {
  if (this.fcmTokens && this.fcmTokens.length > 5) {
    this.fcmTokens = this.fcmTokens.slice(-5);
  }
  next();
});

// ✅ Auto-create Wallet & KYC on User creation
UserSchema.post("save", async function (doc) {
  // Check if wallet/kyc already exist to prevent duplicates on updates
  // Note: 'this' refers to the query or doc depending on hook type, but post-save 'doc' is reliable
  try {
    const UserWallet = getUserWalletModel();
    const UserKYC = getUserKYCModel();

    const walletExists = await UserWallet.exists({ userId: doc._id });
    if (!walletExists) {
      await UserWallet.create({ userId: doc._id });
    }

    const kycExists = await UserKYC.exists({ userId: doc._id });
    if (!kycExists) {
      await UserKYC.create({ userId: doc._id });
    }
  } catch (err) {
    console.error("Error auto-creating Wallet/KYC for user:", doc._id, err);
    // Non-blocking error logging - we don't want to crash the user save, but it is critical to know
  }
});

UserSchema.index({ location: "2dsphere" });

let UserModel;
let UserWalletModel;
let UserKYCModel;

const getUserModel = () => {
  if (UserModel) return UserModel;

  const db = getUserDB();
  UserModel = db.model("User", UserSchema);
  return UserModel;
};

const getUserWalletModel = () => {
  if (UserWalletModel) return UserWalletModel;

  const db = getUserDB();
  UserWalletModel = db.model("UserWallet", UserWalletSchema);
  return UserWalletModel;
};

const getUserKYCModel = () => {
  if (UserKYCModel) return UserKYCModel;

  const db = getUserDB();
  UserKYCModel = db.model("UserKYC", UserKYCSchema);
  return UserKYCModel;
};

module.exports = { getUserModel, getUserWalletModel, getUserKYCModel };
