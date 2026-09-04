# Helios backend

FastAPI service for the Helios Sales & Service Copilot.

## Capabilities

- Parses PDF, JSON, and EML documents from `helios_rag_corpus`
- Builds a cached local TF-IDF vector index with metadata-aware ranking
- Filters archived documents and role-restricted sources
- Produces grounded answers and customer drafts with citations
- Runs a persistent inquiry-to-approved-response workflow
- Stores redacted operational telemetry in SQLite
- Works offline, with optional OpenAI generation through `OPENAI_API_KEY`

## API

- `GET /api/health`
- `POST /api/knowledge/query`
- `POST /api/drafts`
- `POST /api/workflows`
- `GET /api/workflows/{id}`
- `POST /api/workflows/{id}/approve`
- `POST /api/workflows/{id}/revise`
- `POST /api/workflows/{id}/decline`
- `GET /api/activity`
- `POST /api/feedback`

Interactive API documentation is available at `http://127.0.0.1:8000/docs`.
