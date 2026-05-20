# Password Recovery API Documentation

Base URL: `/api/forgetpassword`

## Endpoints

### 1. Send Reset Email
- **URL**: `/send-reset-password-email`
- **Method**: `POST`
- **Access**: Public
- **Description**: Sends a 6-digit reset code to the user's email.

**Request Body**:
```json
{ "email": "string" }
```

---

### 2. Validate Reset Code
- **URL**: `/validate-reset-password-code`
- **Method**: `POST`
- **Access**: Public
- **Description**: Validates the 6-digit code received by email.

**Request Body**:
```json
{ "email": "string", "code": "string" }
```

---

### 3. Reset Password
- **URL**: `/reset-password`
- **Method**: `POST`
- **Access**: Public
- **Description**: Sets a new password for the account once the code is validated.

**Request Body**:
```json
{ 
  "email": "string", 
  "password": "string (Complexity: min 8, upper, lower, digit, symbol)" 
}
```
