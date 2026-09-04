FROM python:3.12-slim

# System deps for pypdf
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies first (cached layer)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY app/ ./app/

# Corpus is mounted or copied at runtime via HELIOS_CORPUS_PATH
# Data directory for SQLite + index cache
RUN mkdir -p /data

ENV HELIOS_DATABASE_PATH=/data/helios.db
ENV HELIOS_CORPUS_PATH=/corpus

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
