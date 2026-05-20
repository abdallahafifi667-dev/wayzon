# ML Brain Python - Dockerfile
# Production-optimized container for ML inference and training

FROM python:3.11-slim-bookworm

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app \
    ML_BRAIN_PRODUCTION=true \
    ML_BRAIN_ENABLED=true

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Set PYTHONPATH to include the parent of the package
ENV PYTHONPATH=/app

# Copy requirements first for layer caching
COPY requirements.txt ./mlBrainpy/

# Install Python dependencies using CPU-only index where needed
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r ./mlBrainpy/requirements.txt

# Copy application code
COPY . ./mlBrainpy/

# Create model directories
RUN mkdir -p mlBrainpy/models/mlBrain/checkpoints mlBrainpy/logs/mlBrain

# Expose API port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# Run the FastAPI server
CMD ["uvicorn", "mlBrainpy.api:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
