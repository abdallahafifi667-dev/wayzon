# Languages & Reviews API Documentation

## Languages API
Base URL: `/api/languages`

### 1. Add Language
- **URL**: `/`
- **Method**: `POST`
- **Access**: Private
- **Description**: Adds a new language to user's profile.

**Request Body**:
```json
{
  "name": "string",
  "proficiency": "beginner | intermediate | advanced | native"
}
```

---

### 2. Update Language
- **URL**: `/:languageName`
- **Method**: `PUT`
- **Access**: Private
- **Description**: Updates proficiency or video URL for a specific language.

---

### 3. Delete Language
- **URL**: `/:languageName`
- **Method**: `DELETE`
- **Access**: Private

---

## Reviews API
Base URL: `/api/reviews`

### 4. Add Review
- **URL**: `/add`
- **Method**: `POST`
- **Access**: Private
- **Description**: Adds a rating and comment for a product/trip.

**Request Body**:
```json
{
  "productId": "string",
  "rating": "number",
  "comment": "string"
}
```

---

### 5. Update/Delete Review
- **Update**: `PUT /update/:id`
- **Delete**: `DELETE /delete/:id`
- **Access**: Private (Own review)
