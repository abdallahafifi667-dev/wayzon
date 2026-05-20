# users_Payment — Dockerfile
# Production-optimized Node.js container

FROM node:22-alpine

# Install OS dependencies needed by native modules (bcrypt, sharp, etc.)
RUN apk add --no-cache python3 make g++ vips-dev curl wget

WORKDIR /app

# Copy package files first for layer caching
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy application source
COPY . .

# Expose HTTP port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD wget -qO- http://localhost:8000/health || exit 1

CMD ["node", "./bin/www"]
