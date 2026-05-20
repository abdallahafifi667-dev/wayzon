# Authentication API Documentation

Base URL: `/api/users`

## Endpoints

### 1. Register User
- **URL**: `/register`
- **Method**: `POST`
- **Access**: Public
- **Description**: Registers a new user (tourist or guide) and sends a verification email.

**Request Body**:
```json
{
  "role": "tourist | guide",
  "username": "string",
  "email": "string",
  "password": "string",
  "phone": "string",
  "country": "string",
  "Address": "string",
  "identityNumber": "string",
  "gender": "male | female",
  "longitude": "number",
  "latitude": "number",
  "languages": [
    { "name": "string", "proficiency": "beginner | intermediate | advanced | native" }
  ]
}
```

**Response (Success 201)**:
```json
{
  "message": "Verification email sent successfully",
  "userId": "string",
  "token": "string"
}
```

---

### 2. Login
- **URL**: `/login`
- **Method**: `POST`
- **Access**: Public
- **Description**: Authenticates a user using email or phone and returns a JWT token.

**Request Body**:
```json
{
  "email": "string (optional if phone provided)",
  "phone": "string (optional if email provided)",
  "password": "string",
  "fcmToken": "string (optional)"
}
```

**Response (Success 200)**:
```json
{
  "id": "string",
  "avatar": "string",
  "token": "string"
}
```

---

### 3. Verify Email
- **URL**: `/verifyEmail`
- **Method**: `POST`
- **Access**: Private (Requires token from registration)
- **Description**: Verifies the user's email address using a 6-digit code.

**Request Body**:
```json
{
  "code": "string"
}
```

---

### 4. Logout
- **URL**: `/logout`
- **Method**: `POST`
- **Access**: Private
- **Description**: Logs out the user and optionally removes the FCM token.

**Request Body**:
```json
{
  "fcmToken": "string (optional)"
}
```

---

### 5. Update Location
- **URL**: `/updateLocation`
- **Method**: `PATCH`
- **Access**: Private
- **Description**: Updates the user's current coordinates.

**Request Body**:
```json
{
  "longitude": "number",
  "latitude": "number"
}
```

---

### 6. Refresh Token
- **URL**: `/auth/refresh`
- **Method**: `POST`
- **Access**: Public
- **Description**: Refreshes the access token using a valid refresh token.

**Request Body**:
```json
{
  "refreshToken": "string"
}
```

**Response (Success 200)**:
```json
{
  "success": true,
  "accessToken": "string",
  "refreshToken": "string",
  "accessTokenExpiry": "number"
}
```
