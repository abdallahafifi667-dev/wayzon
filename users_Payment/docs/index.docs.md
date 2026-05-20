# Wayzon Users & Payment Service - API Documentation

Welcome to the official API documentation for the **users_Payment** service. This documentation is organized by module to help you find the information you need quickly.

## Documentation Modules

### 🔐 [Authentication](file:///e:/javascript/wayzon/backEnd/users_Payment/docs/auth.docs.md)
Registration, Login, Email Verification, Location Updates, and Token Refresh.

### 📦 [Orders & Trips](file:///e:/javascript/wayzon/backEnd/users_Payment/docs/order.docs.md)
Trip creation (Tourist), guide discovery, and order management (Guide).

### 👤 [User Profile](file:///e:/javascript/wayzon/backEnd/users_Payment/docs/profile.docs.md)
Profile management, completed order history, and transportation details.

### 💬 [Chat & Socket.IO](file:///e:/javascript/wayzon/backEnd/users_Payment/docs/chat.docs.md)
Real-time messaging, WebRTC video calls, and Socket events.

### 🛡️ [Identity Verification (KYC)](file:///e:/javascript/wayzon/backEnd/users_Payment/docs/documents.docs.md)
AI-based document verification, liveness checks, and verification triggers.

### 🌍 [Languages & Reviews](file:///e:/javascript/wayzon/backEnd/users_Payment/docs/languages_and_reviews.docs.md)
Language proficiency management and product/trip review APIs.

### 🔑 [Password Recovery](file:///e:/javascript/wayzon/backEnd/users_Payment/docs/forgetpassword.docs.md)
Email-based password reset process.

---

## General Information
- **Base URL**: `http://localhost:3000/api`
- **Auth**: Most endpoints require a **Bearer JWT Token** in the `x-auth-token` or `auth-token` header.
- **Language**: APIs handle multiple languages for both tourists and guides.
