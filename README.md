# Helios Sales & Service Copilot

The repository is separated into two application layers:

- `frontend/` — React and Vite user interface
- `backend/` — reserved for the future API, RAG, workflows, and telemetry services

## Run the frontend

First-time setup:

```bash
npm run setup
```

Run the complete application:

```bash
npm run dev
```

Then open:

- Application: http://127.0.0.1:5173/
- Backend API docs: http://127.0.0.1:8000/docs

Helios works immediately in local grounded mode. To enable model-generated prose, copy
`backend/.env.example` to `backend/.env`, add `OPENAI_API_KEY`, and export those
variables before starting the application.

## Architecture

The backend ingests the 40 synthetic PDF, JSON, and EML sources in
`helios_rag_corpus/`, applies version and role metadata, creates section-aware chunks,
and builds a cached hybrid semantic + lexical index. LangChain manages chat prompt
composition, OpenAI invocation, and validated structured outputs. Answers and drafts
include structured citations. The explicit agent workflow persists state in SQLite
and stops at a human approval checkpoint.

Build the frontend for production:

```bash
npm run build
```
