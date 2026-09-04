# Helios Sales & Service Copilot — Technical Note

A grounded RAG + agentic-workflow prototype for Helios Industrials' Sales & Service teams. Live demo: **[roland-berger-git-main-mudassirnedian-6723.vercel.app](https://roland-berger-git-main-mudassirnedian-6723.vercel.app/)** (frontend on Vercel, API on Railway).

## 1. Architecture and technology choices

| Layer | Choice | Why |
|---|---|---|
| Frontend | React + TypeScript + Vite | Fast SPA, single-file component tree, no server rendering needed for an internal tool |
| Backend | FastAPI (Python) | Async, typed (Pydantic) request/response models, auto-generated `/docs`, low ceremony |
| Data | SQLite | Zero-ops embedded DB; sufficient for activity logs, workflow state, users, feedback at prototype scale |
| LLM adapter | LangChain (`langchain-core` + `langchain-openai`) | Prompt templates, ChatOpenAI, and Pydantic-validated structured output for routing/classification |
| Retrieval | scikit-learn TF-IDF + OpenAI embeddings, hand-rolled hybrid scorer | No vector DB needed at this corpus size (40 docs / ~1.4k chunks); keeps the whole stack dependency-light |
| Auth | JWT (python-jose) + bcrypt | Stateless, simple to deploy across two hosts (Railway API, Vercel static site) |
| Deployment | Docker → Railway (API) + Vercel (static frontend) | No cloud account required for grading; same Dockerfile also runs locally via `docker-compose` |

The UI is a single React SPA over one FastAPI backend.

**Home** is the front door. One chat (`POST /api/chat`) classifies intent as `knowledge`, `draft`, `workflow`, or `clarify`. Knowledge answers stay on Home with citations. Draft and Workflow open their pages and auto-run with the same text. Unclear asks get one clarifying question. KPIs and recent activity stay visible below the thread. Dedicated Knowledge / Draft / Workflow pages exist if someone prefers to skip the router.

| Surface | Role |
|---|---|
| Home | Front door. Classifies the ask: Knowledge answers inline; Draft and Workflow open and run automatically; unclear asks stay here for one follow-up. KPIs and recent activity remain below the chat. |
| Knowledge | Grounded Q&A with citations and in-session conversation memory. |
| Draft | Customer email / technical reply, editable, cited. No send — copy only. |
| Workflows | Agentic pipeline: classify → retrieve → compose → verify → **human approval**. |
| Library | Telemetry/audit: prompts, sources, groundedness, latency, errors, feedback. |
| Admin | User list and per-feature permission toggles (admin only). |
| Feedback | Public issue / idea / praise board. |
| Capture, Onboard, Atelier | UI-only mocks (nameplate intake, training paths, ops dashboard). Not live RAG. |

## 2. Model provider and agent framework

- **Provider:** OpenAI. `gpt-4.1-mini` handles chat, routing, classification and drafting; `text-embedding-3-small` produces retrieval embeddings (configurable through environment variables).
- **Framework:** LangChain (`langchain-core` + `langchain-openai`) provides reusable chat prompt templates, OpenAI model integration and Pydantic-validated structured output for routing and inquiry classification. All LangChain calls pass through the application's explicit retry policy.
- **Orchestration:** the workflow remains an explicit state machine (`workflows.py`) rather than LangGraph/CrewAI. Its fixed, auditable shape (classify → retrieve → compose → verify → approve), persisted state and human checkpoint are clearer as application code at this scope. LangGraph would become useful if future workflows add dynamic branching, parallel tools or multi-agent hand-offs.

## 3. RAG implementation

**Ingestion & chunking** (`corpus.py`): the 40 synthetic PDF/JSON/EML sources are parsed per type (PDF page text, flattened JSON, parsed email bodies), cleaned of boilerplate, then split with a **sliding-window word chunker** (190 words/chunk, 40-word overlap) so technical facts near a chunk boundary aren't lost. Each chunk keeps rich metadata: `source_id`, `title`, `page`, `section`, `product`, `customer`, `status` (approved/archived), `version`, `access` role. The whole index is fingerprinted (file mtimes + size + "has API key") and cached to disk (`pickle`) so re-embedding only happens when the corpus or key changes.

**Embeddings**: when `OPENAI_API_KEY` is set, every chunk is embedded with `text-embedding-3-small` in batches of 96 and cached alongside a TF-IDF matrix that is *always* built (cheap, offline, deterministic). Without a key, the system runs in **lexical-only mode** — degraded but fully functional.

**Retrieval**: hybrid scoring — `0.55 × cosine(semantic) + 0.45 × TF-IDF`, plus small deterministic boosts (metadata term overlap, approved-status preference, category-vs-intent alignment, e.g. down-ranking correspondence unless the user asked for email/precedent). Role-based access (`chunk.access` vs. requesting role) and archived-document exclusion (unless the user explicitly asks for history) are enforced before scoring, not after. Results are de-duplicated to one chunk per source document and cut off by a minimum-score floor (relaxed when semantic scores are available, since semantic similarity handles paraphrase better than TF-IDF alone).

**Citations**: every answer/draft carries `[1] [2] …` markers tied to a `Citation` object (source id, title, file, page, section, status, score). Clicking a citation opens a formatted **source viewer** (`/api/sources`) that renders the original PDF/email/ticket with structure (headings, metadata rows, highlighted page) instead of a raw-text dump.

**Grounding & evaluation approach**: Knowledge answers are marked `grounded=True` when retrieval returned evidence and the message was not chit-chat. Drafts additionally require the top result score ≥ `0.07`. Domain-specific answer functions (`_product_answer`, `_selection_answer`, `_service_answer`, `_precedent_answer`, `_policy_answer`) encode known-correct facts from the corpus (e.g., pump-body vs. seal temperature limits) as a deterministic ceiling on what the LLM is allowed to assert; otherwise, the LLM composes strictly from retrieved evidence. `backend/evaluate.py` runs 10 golden questions and reports required-source recall@5, answer token-F1 and grounded-response count (`npm run evaluate`). This is a **precision-over-recall** approach because a wrong technical claim is worse than an "insufficient evidence" answer.

## 4. Agentic workflow

The **Workflow** surface runs a persisted 5-step pipeline per inquiry, stored as one JSON payload row in SQLite (`workflows` table) so it survives restarts and polling from multiple tabs:

1. **Classify** — LangChain structured output extracts `intent` (email/proposal/service), `product`, `temperature`, `pressure`, `flow`, `customer`, and a `missing` list of gaps. Falls back to a regex-based offline extractor if the LLM is unavailable.
2. **Retrieve** — hybrid search against the corpus (same engine as Knowledge/Draft).
3. **Compose** — generates either a customer email or a structured proposal (sections: Customer Requirement, Recommended Product, Technical Fit, Configuration, Benefits, Assumptions, Risks/Clarifications, Next Steps), depending on classified intent.
4. **Verify** — a claim checklist: grounding check on the recommendation, one row per `missing` item from classification, and a flag if the inquiry asked for price, lead time, or stock (not in the corpus). Those flags are shown to the reviewer; the draft text is not silently rewritten.
5. **Human approval** — the run stops (`status="approval"`) and blocks until a person **approves**, **declines**, or **requests revision** (which resets state and re-runs from Classify) on the fully editable draft.

**State**: each workflow is a row with `status ∈ {running, approval, revision, approved, declined}` and a `payload` blob (`classification`, `draft`, `verification`, `errors[]`, timestamps). `_advance()` is called on every `GET`, so steps progress lazily based on elapsed wall-clock time rather than a background worker — simple, but see Limitations.

**Tools**: retrieval (`CorpusIndex.search`) and the LLM (LangChain chat / structured output, plus embeddings) are the only two tools the workflow calls; both go through the retry helper below.

**Retries & failure handling**: `with_retries()` (`retry.py`) wraps every LangChain invocation and every embedding API call. It retries up to 3 times with exponential backoff (0.6s → 1.2s → 2.4s) on transient errors (`RateLimitError`, `APIConnectionError`, `APITimeoutError`, and 5xx `APIStatusError`), and **fails fast** (no retry) on 4xx errors like bad auth. If all retries are exhausted, the caller falls back to a deterministic offline path — regex-based classification, template-based drafting, TF-IDF-only retrieval — so the user still gets a usable result. The failure is recorded on the activity record and surfaced in Verify rather than swallowed.

## 5. Hyperscaler deployment assumptions and minimum setup

The brief allows any hyperscaler; this prototype is deployed on **Railway (API + SQLite volume) + Vercel (static frontend)** rather than Azure, because it needs zero cloud-account setup for a reviewer to run and reduces cost/complexity for a take-home assignment. The architecture maps directly onto Azure (or AWS/GCP) if productionized:

| Component | Prototype | Azure equivalent |
|---|---|---|
| API container | Railway (Dockerfile) | Azure Container Apps or App Service (Linux, container) |
| Frontend | Vercel static build | Azure Static Web Apps / Storage + CDN |
| Secrets | Railway/Vercel env vars | Azure Key Vault |
| Model calls | OpenAI via LangChain | Azure OpenAI Service (same models, swap base URL/key) |
| DB | SQLite file on a volume | Azure Database for PostgreSQL (swap the `sqlite3` calls in `database.py`) |
| Corpus/index cache | Bundled in the image | Azure Blob Storage, mounted or pulled at boot |

**Minimum viable setup** (either cloud): 1 container for the API with a persistent volume (DB + corpus + index cache), 1 static hosting target for the frontend, HTTPS termination, and two secrets (`OPENAI_API_KEY`, `JWT_SECRET`). No message queue, no GPU, no managed vector DB required at this scale — that's the "minimum," and it's exactly what's running today, just on Railway/Vercel instead of Azure.

## 6. Security, governance, and responsible-AI controls

- **Auth**: JWT bearer tokens (bcrypt-hashed passwords), one seeded admin (`mudassir@gmail.com`); anyone can self-register with no password complexity rules (deliberate simplicity for a demo, not production-grade).
- **Authorization**: per-user, per-feature permission flags (`knowledge`, `draft`, `workflow`, `capture`, `library`, `feedback`, `onboard`) toggled from an Admin panel; the sidebar hides/locks features the current user can't access, and the backend re-checks role (not just the UI) for admin-only endpoints.
- **PII redaction in telemetry**: `redact()` strips emails and phone numbers before anything is persisted to the activity log title/error fields.
- **Role-scoped retrieval**: chunk-level `access` metadata filters what a "Sales" vs. other role can retrieve, enforced server-side in `CorpusIndex.search`, not just hidden in the UI.
- **Anti-hallucination guardrails**: the system prompt forbids inventing price, lead time, stock, safety, or chemical-compatibility facts. Grounded vs. ungrounded is a first-class field shown to the user. The Verify step flags missing duty-point data and unsupported commercial asks for the human reviewer.
- **Human-in-the-loop**: no proposal leaves Workflow without an explicit approve / decline / revise decision. The Draft page is a composition aid only (copy), not a send path.
- **Telemetry/audit**: every Knowledge/Draft/Workflow interaction is logged (prompt, sources used, groundedness, latency, model, prompt version, output preview, errors, feedback rating) and viewable in the Library drawer for audit.
- **Model hosting:** the prototype calls OpenAI via LangChain for speed of build. Production would use **Azure OpenAI Service** in an EU region: customer prompts and completions stay in the tenant and are not used to train foundation models; traffic can stay on a private endpoint; identity and keys sit in Entra ID and Key Vault. That is the governance-appropriate path for a European industrial, not a different model-quality story.
- **Prototype vs production:** auth is intentionally lightweight for a demo. Production on Azure would use Entra ID, Key Vault-managed secrets, encryption-at-rest on Postgres, and login/API rate limiting. The material responsible-AI controls for this use case — grounding, human approval, redaction, and role-scoped retrieval — are already in the prototype.

## 7. Limitations, trade-offs, and next improvements

- **Evaluation is small and synthetic.** The 10-question golden set catches basic retrieval and answer regressions but is not representative of production traffic. Next step: expand it with expert-reviewed edge cases and run it automatically in CI whenever prompts, models or corpus content change.
- **Workflow progression is time-based, not event-based** (`_advance()` runs on poll, gated by elapsed seconds) — fine for a demo, but wouldn't survive a real multi-hour approval SLA or process restarts mid-step cleanly. Would move to a proper job queue (e.g., Celery/RQ or Azure Durable Functions) for production.
- **SQLite** doesn't scale past a handful of concurrent writers; fine here, would move to Postgres for multi-instance deployment.
- **No conversation memory persistence** across sessions for Knowledge chat — it's in-memory per browser tab.
- **Retry helper covers OpenAI transient failures only**; there's no circuit breaker or backpressure if OpenAI is down for an extended period, only the offline fallback path per request.
- **Auth is intentionally minimal** (no password rules, no email verification, no rate limiting on login) — acceptable for a graded prototype, not for production.
- **Two placeholder features** (Capture — nameplate intake, Onboard — training paths, Atelier — static ops dashboard) are UI-only mocks to show product direction without over-scoping the backend.

## 8. Run instructions

**Local (no Docker):**
```bash
npm run setup   # installs frontend deps + backend venv
cp backend/.env.example backend/.env   # add OPENAI_API_KEY to enable LLM mode
npm run dev     # starts backend on :8000 and frontend on :5173
```
Open `http://127.0.0.1:5173`. Without an API key the app runs in **local-grounded mode** (TF-IDF retrieval, template-based drafting/answers) — fully functional, just less fluent.

**Local (Docker):**
```bash
docker compose up --build
```
Frontend at `http://localhost`, API at `http://localhost:8000/docs`.

**Live deployment:** frontend on Vercel, API on Railway — see `railway.json` / root `Dockerfile` / `frontend/vercel.json`. Required env vars: `OPENAI_API_KEY`, `JWT_SECRET`, `OPENAI_MODEL` (optional, defaults to `gpt-4.1-mini`).

**Login**: register any email/password, or sign in as the seeded admin `mudassir@gmail.com` / `12345` to manage feature access from the Admin panel.

**What to try:** the Home page is a **chat router**. Paste any of the prompts below there and Helios classifies intent, then either answers inline (Knowledge) or sends you to Draft or Workflow. You can also paste the same prompts on the dedicated Knowledge / Draft / Workflow pages.

| Surface | What it demonstrates | Prompt |
|---|---|---|
| Home (router) → Knowledge | Grounded Q&A with citations; pump-body vs seal limit | *Can the HX-240 run continuously at 95°C with its standard EPDM seal?* |
| Home (router) → Draft | Customer-facing technical email, editable, cited | *Customer from Baltic Process is asking if their existing HX-300 can handle a new duty point at 90°C and 6 bar. They need a formal technical reply.* |
| Home (router) → Workflow | Full agentic pipeline + human approval | *We need a centrifugal pump for chemically treated water at 95°C, 7 bar, 70 m³/h. Customer is NordChem GmbH. Please prepare a technical proposal.* |

Expected behaviour: the HX-240 question should **not** confirm the standard EPDM seal at 95°C (seal limit is lower than the pump-body rating). The Baltic Process prompt should produce a cited customer email. The NordChem prompt should open the workflow stepper, stop at human approval, and show a multi-section proposal you can approve, revise, or decline.
