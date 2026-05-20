# Trip-Monitoring — Dockerfile
# Production-optimized Node.js container

FROM node:22-slim

# Install OS dependencies needed by native modules (sharp, ffmpeg, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ vips-dev ffmpeg curl wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for layer caching
COPY package*.json ./

# Install production dependencies only
RUN npm install --omit=dev

# Copy application source
COPY . .

# Expose HTTP port
EXPOSE 3000

CMD ["node", "./bin/www"]
