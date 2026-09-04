export type Citation = {
  index: number;
  source_id: string;
  title: string;
  file: string;
  page: number | null;
  section: string | null;
  excerpt: string;
  document_type: string;
  status: string;
  score: number;
};

export type KnowledgeResponse = {
  interaction_id: string;
  answer: string;
  grounded: boolean;
  confidence: number;
  citations: Citation[];
  latency_ms: number;
  mode: string;
  intent?: "conversation" | "knowledge" | "insufficient";
};

export type DraftSection = {
  heading: string;
  content: string;
};

export type DraftResponse = {
  interaction_id: string;
  subject: string;
  body: string;
  grounded: boolean;
  citations: Citation[];
  unsupported_claims: string[];
  latency_ms: number;
  not_sent: boolean;
  mode: string;
  kind?: "email" | "proposal";
  sections?: DraftSection[];
  error?: string | null;
};

export type WorkflowStep = {
  key: string;
  label: string;
  status: "waiting" | "running" | "completed" | "attention" | "approved" | "declined";
  detail: string;
};

export type WorkflowClassification = {
  intent?: string;
  product?: string | null;
  temperature?: string | null;
  pressure?: string | null;
  flow?: string | null;
  customer?: string | null;
  missing?: string[];
};

export type WorkflowResponse = {
  workflow_id: string;
  status: "running" | "approval" | "revision" | "approved" | "declined" | "failed";
  owner: string;
  steps: WorkflowStep[];
  draft: DraftResponse | null;
  verification: Array<{ claim: string; status: string; source: string | null }>;
  classification: WorkflowClassification | null;
  created_at: string;
  updated_at: string;
};

export type ActivityRecord = {
  id: string;
  type: string;
  title: string;
  status: string;
  created_at: string;
  prompt_preview: string;
  source_ids: string[];
  grounded: boolean | null;
  latency_ms: number | null;
  feedback: string | null;
  error: string | null;
  model: string;
  prompt_version: string;
  output_preview: string | null;
};

export type BoardTicketKind = "issue" | "idea" | "praise";

export type BoardTicket = {
  id: string;
  kind: BoardTicketKind;
  title: string;
  description: string;
  name: string;
  email: string | null;
  created_at: string;
};

function getToken(): string | null {
  return localStorage.getItem("helios_token");
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const payload = (await response.json()) as { detail?: string };
      if (payload.detail) message = payload.detail;
    } catch {
      // Keep the HTTP fallback message.
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  role: "user" | "admin";
  permissions: string[];
  created_at: string;
};

export type ChatResponse = {
  route: "knowledge" | "draft" | "workflow" | "clarify";
  confidence: number;
  answer?: string;
  clarification?: string;
  grounded: boolean;
  citations: Citation[];
  interaction_id?: string;
  label: string;
};

export type SourceBlock = {
  type: string;
  text: string;
  label?: string | null;
};

export type SourceDocument = {
  kind: "document" | "proposal" | "email" | "ticket";
  file: string;
  title: string;
  source_id: string;
  document_type: string;
  status: string;
  product: string;
  customer: string;
  version: string;
  effective_date: string;
  category: string;
  highlight_page: number | null;
  pages: Array<{ number: number; blocks: SourceBlock[] }>;
  from_address?: string | null;
  to_address?: string | null;
  date?: string | null;
  subject?: string | null;
  body?: string | null;
  ticket_id?: string | null;
  severity?: string | null;
  ticket_status?: string | null;
  opened_date?: string | null;
  symptoms?: string | null;
  diagnosis?: string | null;
  resolution?: string | null;
  service_lesson?: string | null;
  conditions?: Record<string, string> | null;
};

export const api = {
  health: () => request<{ status: string; mode: string; sources: number; chunks: number }>("/api/health"),

  chat: (message: string, history: Array<{ role: string; content: string }> = []) =>
    request<ChatResponse>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message, history, user_role: "Sales" }),
    }),

  ask: (question: string, history: Array<{ role: "user" | "assistant"; content: string }> = []) =>
    request<KnowledgeResponse>("/api/knowledge/query", {
      method: "POST",
      body: JSON.stringify({ question, user_role: "Sales", history }),
    }),

  draft: (payload: { inquiry: string; template: string; tone: string; format: string }) =>
    request<DraftResponse>("/api/drafts", {
      method: "POST",
      body: JSON.stringify({ ...payload, user_role: "Sales" }),
    }),

  feedback: (interactionId: string, rating: "helpful" | "not_helpful") =>
    request<{ ok: boolean }>("/api/feedback", {
      method: "POST",
      body: JSON.stringify({ interaction_id: interactionId, rating }),
    }),

  activity: () => request<ActivityRecord[]>("/api/activity"),

  createWorkflow: (inquiry: string, options?: { output_kind?: "email" | "proposal"; protocol_name?: string; owner?: string }) =>
    request<WorkflowResponse>("/api/workflows", {
      method: "POST",
      body: JSON.stringify({
        inquiry,
        user_role: "Sales",
        owner: options?.owner ?? localStorage.getItem("helios_user_name") ?? "User",
        output_kind: options?.output_kind ?? null,
        protocol_name: options?.protocol_name ?? null,
      }),
    }),

  workflow: (id: string) => request<WorkflowResponse>(`/api/workflows/${id}`),

  workflowDecision: (id: string, decision: "approve" | "revise" | "decline", comment?: string) =>
    request<WorkflowResponse>(`/api/workflows/${id}/${decision}`, {
      method: "POST",
      body: JSON.stringify({ comment: comment ?? null }),
    }),

  listProtocols: () =>
    request<Array<{
      id: string;
      name: string;
      description: string;
      output_kind: "email" | "proposal";
      steps: string[];
      created_at: string;
    }>>("/api/workflow-protocols"),

  createProtocol: (payload: {
    name: string;
    description: string;
    output_kind: "email" | "proposal";
    steps: string[];
  }) =>
    request<{
      id: string;
      name: string;
      description: string;
      output_kind: "email" | "proposal";
      steps: string[];
      created_at: string;
    }>("/api/workflow-protocols", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  source: (file: string, page?: number | null) => {
    const params = new URLSearchParams({ file });
    if (page) params.set("page", String(page));
    return request<SourceDocument>(`/api/sources?${params.toString()}`);
  },

  listBoardTickets: () => request<BoardTicket[]>("/api/board-feedback"),

  createBoardTicket: (payload: {
    kind: BoardTicketKind;
    title: string;
    description: string;
    name: string;
    email?: string | null;
  }) =>
    request<BoardTicket>("/api/board-feedback", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  // Admin
  adminUsers: () => request<AuthUser[]>("/api/admin/users"),

  adminUpdatePermissions: (userId: string, permissions: string[]) =>
    request<AuthUser>(`/api/admin/users/${userId}/permissions`, {
      method: "PATCH",
      body: JSON.stringify({ permissions }),
    }),
};
