FROM python:3.11-slim

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV FLASK_ENV=production

# Install Chromium headless, WeasyPrint dependencies, and modern fonts
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libcairo2 \
    libgdk-pixbuf-2.0-0 \
    shared-mime-info \
    libpango-1.0-0 \
    libpangoft2-1.0-0 \
    libpangocairo-1.0-0 \
    && rm -rf /var/lib/apt/lists/*

ENV CHROME_BIN=/usr/bin/chromium
ENV CHROMIUM_PATH=/usr/bin/chromium

WORKDIR /app

# Install Python dependencies first for Docker caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source code
COPY . .

# Ensure data and output directories exist with write permissions
RUN mkdir -p backend/data output && chmod -R 777 backend/data output

EXPOSE 5050 10000

# Run production WSGI server (Gunicorn) with 1 worker to conserve RAM for Chromium on 512MB hosts
CMD ["sh", "-c", "gunicorn --bind 0.0.0.0:${PORT:-5050} --workers 1 --threads 4 --timeout 120 app:app"]

