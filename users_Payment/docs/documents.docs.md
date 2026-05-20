# Document Verification (KYC) API Documentation

Base URL: `/api/users`

## Endpoints

### 1. Trigger Manual Verification
- **URL**: `/verifyDocuments/trigger`
- **Method**: `POST`
- **Access**: Private
- **Description**: Manually starts the AI-based verification process once all required documents (selfie, ID) are uploaded via GCS.

**Response (Success 200)**:
```json
{
  "success": true,
  "message": "Verification started/completed",
  "documentation": "boolean"
}
```

---

### 2. Get Verification Status
- **URL**: `/verifyDocuments/status`
- **Method**: `GET`
- **Access**: Private
- **Description**: Checks the user's email and document verification status.

**Response (Success 200)**:
```json
{
  "emailVerified": "boolean",
  "documentationComplete": "boolean",
  "pendingDocuments": {
    "selfie": "boolean",
    "idCard": "boolean",
    "status": "pending | processing | completed | failed"
  }
}
```

---

## Webhooks (Internal)

### 3. GCS Document Webhook
- **URL**: `/verifyDocuments/webhook`
- **Method**: `POST`
- **Access**: Public (GCS Auth)
- **Description**: Receives notifications from GCS when documents are uploaded. Automatically triggers verification if all required files are present.
