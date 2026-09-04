import os
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from dotenv import load_dotenv

from .auth import create_access_token, decode_token
from .corpus import CorpusIndex
from .database import EMAIL_PATTERN, Database, verify_password
from .models import (
    ActivityRecord,
    BoardTicket,
    BoardTicketCreate,
    ChatRequest,
    ChatResponse,
    DraftRequest,
    DraftResponse,
    FeedbackRequest,
    KnowledgeRequest,
    KnowledgeResponse,
    PermissionUpdateRequest,
    TokenResponse,
    UserLoginRequest,
    UserRegisterRequest,
    UserResponse,
    WorkflowCreateRequest,
    WorkflowDecisionRequest,
    WorkflowProtocol,
    WorkflowProtocolCreate,
    WorkflowResponse,
    SourceDocument,
)
from .rag import RAGService
from .workflows import WorkflowService

_bearer = HTTPBearer(auto_error=False)


def _get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> dict:
    if not creds:
        raise HTTPException(status_code=401, detail="Not authenticated")
    payload = decode_token(creds.credentials)
    if not payload or "sub" not in payload:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    user = database.get_user_by_id(payload["sub"])
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


def _require_admin(user: dict = Depends(_get_current_user)) -> dict:
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


BACKEND_PATH = Path(__file__).resolve().parents[1]
PROJECT_PATH = BACKEND_PATH.parent
load_dotenv(PROJECT_PATH / ".env")
load_dotenv(BACKEND_PATH / ".env")
CORPUS_PATH = Path(
    os.getenv("HELIOS_CORPUS_PATH", str(PROJECT_PATH / "helios_rag_corpus"))
).expanduser().resolve()
DATABASE_PATH = Path(
    os.getenv("HELIOS_DATABASE_PATH", str(BACKEND_PATH / "data" / "helios.db"))
).expanduser().resolve()
INDEX_PATH = BACKEND_PATH / "data" / "corpus_index.pkl"

if not CORPUS_PATH.exists():
    raise RuntimeError(f"Corpus not found: {CORPUS_PATH}")

database = Database(DATABASE_PATH)
index = CorpusIndex(CORPUS_PATH, INDEX_PATH, api_key=os.getenv("OPENAI_API_KEY", "").strip() or None)
rag = RAGService(index, database, CORPUS_PATH)
workflows = WorkflowService(database, rag)

app = FastAPI(
    title="Helios Sales & Service Copilot API",
    description="Grounded enterprise knowledge, drafting, and governed workflow prototype.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5173",
        "http://localhost:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, object]:
    return {
        "status": "ok",
        "mode": rag.mode,
        "model": rag.model if rag.llm else "Local grounded retrieval",
        "retrieval": index.retrieval_mode,
        "sources": index.source_count,
        "chunks": index.chunk_count,
    }


@app.post("/api/chat", response_model=ChatResponse)
def chat(request: ChatRequest) -> ChatResponse:
    """Unified chat router: classify intent and execute the right path inline."""
    return rag.chat_route(
        message=request.message,
        history=request.history,
        role=request.user_role,
    )


@app.post("/api/knowledge/query", response_model=KnowledgeResponse)
def query_knowledge(request: KnowledgeRequest) -> KnowledgeResponse:
    history = [{"role": t.role, "content": t.content} for t in request.history] if request.history else None
    return rag.answer(request.question, role=request.user_role, history=history)


@app.post("/api/drafts", response_model=DraftResponse)
def create_draft(request: DraftRequest) -> DraftResponse:
    return rag.draft(request)


@app.post("/api/feedback")
def submit_feedback(request: FeedbackRequest) -> dict[str, bool]:
    if not database.set_feedback(request.interaction_id, request.rating):
        raise HTTPException(status_code=404, detail="Interaction not found")
    return {"ok": True}


@app.get("/api/activity", response_model=list[ActivityRecord])
def list_activity(limit: int = Query(default=50, ge=1, le=200)) -> list[dict[str, object]]:
    return database.list_activity(limit=limit)


@app.get("/api/activity/{activity_id}", response_model=ActivityRecord)
def get_activity(activity_id: str) -> dict[str, object]:
    record = database.get_activity(activity_id)
    if not record:
        raise HTTPException(status_code=404, detail="Activity record not found")
    return record


@app.get("/api/sources", response_model=SourceDocument)
def get_source(
    file: str = Query(..., min_length=3, max_length=400),
    page: int | None = Query(default=None),
) -> dict[str, object]:
    try:
        document = index.load_document(file)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Source document not found")
    document["highlight_page"] = page
    return document


@app.post("/api/workflows", response_model=WorkflowResponse)
def create_workflow(request: WorkflowCreateRequest) -> WorkflowResponse:
    return workflows.create(request)


@app.get("/api/workflow-protocols", response_model=list[WorkflowProtocol])
def list_workflow_protocols() -> list[dict[str, object]]:
    return database.list_protocols()


@app.post("/api/workflow-protocols", response_model=WorkflowProtocol)
def create_workflow_protocol(request: WorkflowProtocolCreate) -> dict[str, object]:
    name = request.name.strip()
    if len(name) < 2:
        raise HTTPException(status_code=400, detail="Give the protocol a name.")
    steps = request.steps or ["classify", "retrieve", "compose", "verify", "approval"]
    if "approval" not in steps:
        steps.append("approval")
    return database.create_protocol(
        name=name,
        description=request.description.strip() or "Custom governed protocol.",
        output_kind=request.output_kind,
        steps=steps,
    )


@app.get("/api/workflows/{workflow_id}", response_model=WorkflowResponse)
def get_workflow(workflow_id: str) -> WorkflowResponse:
    return workflows.get(workflow_id)


@app.post("/api/workflows/{workflow_id}/approve", response_model=WorkflowResponse)
def approve_workflow(
    workflow_id: str,
    request: WorkflowDecisionRequest,
) -> WorkflowResponse:
    return workflows.decide(workflow_id, "approved", request.comment)


@app.post("/api/workflows/{workflow_id}/revise", response_model=WorkflowResponse)
def revise_workflow(
    workflow_id: str,
    request: WorkflowDecisionRequest,
) -> WorkflowResponse:
    return workflows.decide(workflow_id, "revise", request.comment)


@app.post("/api/workflows/{workflow_id}/decline", response_model=WorkflowResponse)
def decline_workflow(
    workflow_id: str,
    request: WorkflowDecisionRequest,
) -> WorkflowResponse:
    return workflows.decide(workflow_id, "declined", request.comment)


# ── Auth endpoints ──────────────────────────────────────────────────────────

def _user_to_response(user: dict) -> UserResponse:
    return UserResponse(
        id=user["id"],
        name=user["name"],
        email=user["email"],
        role=user["role"],
        permissions=user["permissions"],
        created_at=user["created_at"],
    )


@app.post("/api/auth/register", response_model=TokenResponse)
def register(request: UserRegisterRequest) -> TokenResponse:
    email = request.email.strip().lower()
    if not EMAIL_PATTERN.search(email):
        raise HTTPException(status_code=400, detail="Enter a valid email address.")
    try:
        user = database.create_user(
            name=request.name.strip(),
            email=email,
            password=request.password,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    token = create_access_token({"sub": user["id"]})
    return TokenResponse(access_token=token, user=_user_to_response(user))


@app.post("/api/auth/login", response_model=TokenResponse)
def login(request: UserLoginRequest) -> TokenResponse:
    user = database.get_user_by_email(request.email)
    if not user or not verify_password(request.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Incorrect email or password.")
    token = create_access_token({"sub": user["id"]})
    return TokenResponse(access_token=token, user=_user_to_response(user))


@app.get("/api/auth/me", response_model=UserResponse)
def me(user: dict = Depends(_get_current_user)) -> UserResponse:
    return _user_to_response(user)


# ── Admin endpoints ──────────────────────────────────────────────────────────

@app.get("/api/admin/users", response_model=list[UserResponse])
def admin_list_users(admin: dict = Depends(_require_admin)) -> list[UserResponse]:
    return [_user_to_response(u) for u in database.list_users()]


@app.patch("/api/admin/users/{user_id}/permissions", response_model=UserResponse)
def admin_update_permissions(
    user_id: str,
    request: PermissionUpdateRequest,
    admin: dict = Depends(_require_admin),
) -> UserResponse:
    # Admins cannot be restricted
    target = database.get_user_by_id(user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if target["role"] == "admin":
        raise HTTPException(status_code=403, detail="Admin permissions cannot be changed.")
    valid = {"knowledge", "draft", "workflow", "capture", "library", "feedback", "onboard"}
    perms = [p for p in request.permissions if p in valid]
    database.update_user_permissions(user_id, perms)
    updated = database.get_user_by_id(user_id)
    return _user_to_response(updated)  # type: ignore[arg-type]


# ── Board feedback ───────────────────────────────────────────────────────────

@app.get("/api/board-feedback", response_model=list[BoardTicket])
def list_board_feedback(limit: int = Query(default=100, ge=1, le=200)) -> list[dict[str, object]]:
    return database.list_board_tickets(limit=limit)


@app.post("/api/board-feedback", response_model=BoardTicket)
def create_board_feedback(request: BoardTicketCreate) -> dict[str, object]:
    name = request.name.strip()
    title = request.title.strip()
    description = request.description.strip()
    email = (request.email or "").strip() or None
    if len(name) < 2:
        raise HTTPException(status_code=400, detail="Please add your name.")
    if len(title) < 4:
        raise HTTPException(status_code=400, detail="Give the ticket a short title.")
    if len(description) < 8:
        raise HTTPException(status_code=400, detail="Describe the issue, idea, or praise.")
    if email and not EMAIL_PATTERN.fullmatch(email):
        raise HTTPException(status_code=400, detail="That email does not look valid.")
    return database.create_board_ticket(
        kind=request.kind,
        title=title,
        description=description,
        name=name,
        email=email,
    )
