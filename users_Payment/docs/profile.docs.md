# Profile API Documentation

Base URL: `/api/profileUser`

## Endpoints

### 1. Get User Profile
- **URL**: `/profile/:id`
- **Method**: `GET`
- **Access**: Private
- **Description**: Returns public profile information for any user (excludes email and password).

---

### 2. Update Own Profile
- **URL**: `/profile/put/:id`
- **Method**: `PUT`
- **Access**: Private (Own profile or Admin)
- **Description**: Updates profile details like phone, description, and gender.

**Request Body**:
```json
{
  "phone": "string",
  "description": "string",
  "gender": "male | female"
}
```

---

### 3. Get User Orders
- **URL**: `/profile/orders/:id`
- **Method**: `GET`
- **Access**: Private
- **Description**: Returns paginated completed order history for a user.

**Query Params**:
- `page`: `number` (default 1)
- `limit`: `number` (default 10)
- `status`: `string` (default 'completed')

---

### 4. Get Order Details
- **URL**: `/profile/order/:id`
- **Method**: `GET`
- **Access**: Private
- **Description**: Returns full details of a specific order if the user is a participant.

---

### 5. Get Transportation Info
- **URL**: `/transportation/:id`
- **Method**: `GET`
- **Access**: Private
- **Description**: Returns the guide's transportation/vehicle details.

---

### 6. Update Transportation Info
- **URL**: `/transportation/:id`
- **Method**: `PUT`
- **Access**: Private (Own profile)
- **Description**: Updates vehicle type and description.

---

### 7. Get GCS Upload Signature
- **URL**: `/gcs/sign-upload`
- **Method**: `POST`
- **Access**: Private
- **Description**: Generates a signed URL for uploading files (avatars, language videos) directly to Google Cloud Storage.

**Request Body**:
```json
{
  "userId": "string",
  "folder": "avatars | documents",
  "uploadType": "avatar | document | language-video",
  "fileExtension": "string"
}
```
