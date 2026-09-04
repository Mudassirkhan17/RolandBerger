FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HELIOS_CORPUS_PATH=/app/helios_rag_corpus \
    HELIOS_DATABASE_PATH=/data/helios.db \
    PORT=8000

WORKDIR /app

# Install dependencies before copying source for better layer caching.
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

# Railway builds from the repository root, so include both the API and corpus.
COPY backend/app ./backend/app
COPY helios_rag_corpus ./helios_rag_corpus

RUN mkdir -p /data /app/backend/data

EXPOSE 8000

# The shell expands Railway's PORT, with 8000 as a local fallback.
CMD ["sh", "-c", "uvicorn backend.app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
