from typing import Any, Literal

from pydantic import BaseModel, Field


class Citation(BaseModel):
    index: int
    source_id: str
    title: str
    file: str
    page: int | None = None
    section: str | None = None
    excerpt: str
    document_type: str
    status: str
    score: float


class ConversationTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class KnowledgeRequest(BaseModel):
    question: str = Field(min_length=2, max_length=4000)
    user_role: str = "Sales"
    history: list[ConversationTurn] = []


class KnowledgeResponse(BaseModel):
    interaction_id: str
    answer: str
    grounded: bool
    confidence: float
    citations: list[Citation]
    latency_ms: int
    mode: str
    intent: Literal["conversation", "knowledge", "insufficient"] = "knowledge"


class DraftSection(BaseModel):
    heading: str
    content: str


class DraftRequest(BaseModel):
    inquiry: str = Field(min_length=2, max_length=10000)
    template: str = "Technical response"
    tone: str = "Technical"
    format: str = "Customer email"
    user_role: str = "Sales"


class DraftResponse(BaseModel):
    interaction_id: str
    subject: str
    body: str
    grounded: bool
    citations: list[Citation]
    unsupported_claims: list[str]
    latency_ms: int
    not_sent: bool = True
    mode: str
    kind: Literal["email", "proposal"] = "email"
    sections: list[DraftSection] = []
    error: str | None = None


class FeedbackRequest(BaseModel):
    interaction_id: str
    rating: Literal["helpful", "not_helpful"]


class WorkflowCreateRequest(BaseModel):
    inquiry: str = Field(min_length=2, max_length=10000)
    user_role: str = "Sales"
    owner: str = "Lena Meyer"
    output_kind: Literal["email", "proposal"] | None = None
    protocol_name: str | None = None


class WorkflowProtocol(BaseModel):
    id: str
    name: str
    description: str
    output_kind: Literal["email", "proposal"]
    steps: list[str]
    created_at: str


class WorkflowProtocolCreate(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    description: str = Field(default="Custom governed protocol.", max_length=240)
    output_kind: Literal["email", "proposal"] = "email"
    steps: list[str] = ["classify", "retrieve", "compose", "verify", "approval"]


class WorkflowDecisionRequest(BaseModel):
    comment: str | None = Field(default=None, max_length=2000)


class WorkflowStep(BaseModel):
    key: str
    label: str
    status: Literal["waiting", "running", "completed", "attention", "approved", "declined"]
    detail: str


class WorkflowResponse(BaseModel):
    workflow_id: str
    status: Literal["running", "approval", "revision", "approved", "declined", "failed"]
    owner: str
    steps: list[WorkflowStep]
    draft: DraftResponse | None = None
    verification: list[dict[str, Any]] = []
    classification: dict[str, Any] | None = None
    created_at: str
    updated_at: str


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=10000)
    user_role: str = "Sales"
    history: list[dict[str, str]] = []


class ChatResponse(BaseModel):
    route: Literal["knowledge", "draft", "workflow", "clarify"]
    confidence: float
    answer: str | None = None
    clarification: str | None = None
    grounded: bool = False
    citations: list[Citation] = []
    interaction_id: str | None = None
    label: str = ""


class SourceBlock(BaseModel):
    type: str
    text: str = ""
    label: str | None = None


class SourcePage(BaseModel):
    number: int
    blocks: list[SourceBlock]


class SourceDocument(BaseModel):
    kind: Literal["document", "proposal", "email", "ticket"]
    file: str
    title: str
    source_id: str
    document_type: str
    status: str = ""
    product: str = ""
    customer: str = ""
    version: str = ""
    effective_date: str = ""
    category: str = ""
    highlight_page: int | None = None
    pages: list[SourcePage] = []
    from_address: str | None = None
    to_address: str | None = None
    date: str | None = None
    subject: str | None = None
    body: str | None = None
    ticket_id: str | None = None
    severity: str | None = None
    ticket_status: str | None = None
    opened_date: str | None = None
    symptoms: str | None = None
    diagnosis: str | None = None
    resolution: str | None = None
    service_lesson: str | None = None
    conditions: dict[str, str] | None = None


class ActivityRecord(BaseModel):
    id: str
    type: str
    title: str
    status: str
    created_at: str
    prompt_preview: str
    source_ids: list[str]
    grounded: bool | None
    latency_ms: int | None
    feedback: str | None
    error: str | None
    model: str
    prompt_version: str
    output_preview: str | None = None


class UserRegisterRequest(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    email: str = Field(min_length=5, max_length=120)
    password: str = Field(min_length=1, max_length=200)


class UserLoginRequest(BaseModel):
    email: str
    password: str


class UserResponse(BaseModel):
    id: str
    name: str
    email: str
    role: Literal["user", "admin"]
    permissions: list[str]
    created_at: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserResponse


class PermissionUpdateRequest(BaseModel):
    permissions: list[str]


class BoardTicketCreate(BaseModel):
    kind: Literal["issue", "idea", "praise"]
    title: str = Field(min_length=4, max_length=120)
    description: str = Field(min_length=8, max_length=2000)
    name: str = Field(min_length=2, max_length=80)
    email: str | None = Field(default=None, max_length=120)


class BoardTicket(BaseModel):
    id: str
    kind: Literal["issue", "idea", "praise"]
    title: str
    description: str
    name: str
    email: str | None = None
    created_at: str
