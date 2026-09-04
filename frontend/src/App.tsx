import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "./auth";
import {
  Activity,
  ArrowRight,
  BookOpen,
  Bookmark,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clock3,
  ClipboardList,
  Copy,
  FileText,
  Gauge,
  GraduationCap,
  Home,
  Layers3,
  Library,
  Lightbulb,
  Lock,
  Mail,
  Menu,
  MessageSquareText,
  MoreHorizontal,
  PanelLeftClose,
  PenLine,
  Plus,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  UsersRound,
  Wrench,
  X,
} from "lucide-react";
import { api, type ActivityRecord, type BoardTicket, type BoardTicketKind, type ChatResponse, type Citation, type DraftResponse, type KnowledgeResponse, type SourceDocument, type WorkflowResponse } from "./api";

type Page = "Home" | "Knowledge" | "Draft" | "Workflows" | "Capture" | "Library" | "Onboard" | "Feedback" | "Admin" | "Atelier";
type WorkflowStatus = "idle" | "running" | "approval" | "approved" | "revision" | "declined" | "failed";
type Navigate = (page: Page, options?: { prompt?: string; autoRun?: boolean; autoGenerate?: boolean }) => void;

function routeHomeCommand(text: string): "Knowledge" | "Draft" | "Workflows" {
  const q = text.toLowerCase();
  if (/\b(workflow|run a workflow|start a workflow|human approval|classify(?:\,| and)? retrieve)\b/.test(q)) {
    return "Workflows";
  }
  if (/\b(draft|write an email|compose an email|reply to|follow-up email|customer email|proposal|rfq|rfp)\b/.test(q)) {
    return "Draft";
  }
  return "Knowledge";
}

function looksLikeProposal(text: string) {
  return /\b(proposal|rfq|rfp|recommended solution|customer:|required flow)\b/i.test(text);
}

const ACME_PROPOSAL_BRIEF = `Customer: ACME Chemicals
Fluid: chemically treated water
Temperature: 95°C
Pressure: 7 bar
Required flow: 70 m³/h
Need: replacement pump + technical proposal

Hi,

We need a pump for chemically treated water operating continuously at 95°C and 7 bar.

Can the HX-240 handle this with its standard seals?

Regards,
Michael`;

const navigation: { label: Page; icon: typeof Home; group?: string }[] = [
  { label: "Home", icon: Home },
  { label: "Knowledge", icon: BookOpen, group: "AI Workspace" },
  { label: "Draft", icon: PenLine },
  { label: "Workflows", icon: Layers3 },
  { label: "Capture", icon: Camera },
  { label: "Library", icon: Library, group: "Workspace" },
  { label: "Onboard", icon: GraduationCap },
  { label: "Feedback", icon: MessageSquareText },
  { label: "Admin", icon: UsersRound },
  { label: "Atelier", icon: Gauge },
];

const sources = [
  {
    index: "01",
    title: "HX-240 Technical Manual",
    detail: "Section 4.2 · Thermal limits",
    text: "Maximum continuous operating temperature is 120°C when configured with the approved PTFE food-grade seal kit.",
  },
  {
    index: "02",
    title: "Seal & Media Compatibility",
    detail: "Table 3 · EPDM configuration",
    text: "For EPDM seals, the recommended continuous operating ceiling is 90°C under standard pressure conditions.",
  },
  {
    index: "03",
    title: "Food & Beverage Application Guide",
    detail: "Chapter 7 · CIP operations",
    text: "Validate cleaning media concentration and seal compatibility before commissioning a CIP duty cycle.",
  },
];

const workflowSteps = [
  { label: "Classify inquiry", detail: "Service · HX-240 · Technical + commercial" },
  { label: "Retrieve evidence", detail: "4 approved sources selected" },
  { label: "Compose response", detail: "Technical customer email prepared" },
  { label: "Verify claims", detail: "5 claims checked · 1 requires attention" },
  { label: "Human approval", detail: "Your review is required" },
];

function BrandMark() {
  return (
    <div className="brand-mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  );
}

function Kicker({ children }: { children: React.ReactNode }) {
  return <div className="kicker">{children}</div>;
}

function RichText({
  text,
  onCitation,
}: {
  text: string;
  onCitation?: (citation: number) => void;
}) {
  const tokens = text.split(/(\*\*.*?\*\*|\[\d+\])/g).filter(Boolean);
  return (
    <>
      {tokens.map((token, index) => {
        if (token.startsWith("**") && token.endsWith("**")) {
          return <strong key={`${token}-${index}`}>{token.slice(2, -2)}</strong>;
        }
        const citation = token.match(/^\[(\d+)]$/);
        if (citation) {
          const number = Number(citation[1]);
          return (
            <button
              className="citation"
              key={`${token}-${index}`}
              onClick={() => onCitation?.(number)}
            >
              {String(number).padStart(2, "0")}
            </button>
          );
        }
        return <span key={`${token}-${index}`}>{token}</span>;
      })}
    </>
  );
}

function TopBar({
  page,
  onOpenMenu,
  onToggleRail,
  onLogout,
  userName,
  userRole,
}: {
  page: Page;
  onOpenMenu: () => void;
  onToggleRail: () => void;
  onLogout: () => void;
  userName: string;
  userRole: string;
}) {
  const initials = userName.split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 2);
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button className="icon-button mobile-menu" onClick={onOpenMenu} aria-label="Open menu">
          <Menu size={18} />
        </button>
        <button className="icon-button rail-toggle" onClick={onToggleRail} aria-label="Collapse menu">
          <PanelLeftClose size={17} />
        </button>
        <span className="topbar-page">{page}</span>
      </div>
      <div className="topbar-actions">
        <button className="search-trigger">
          <Search size={15} />
          <span>Search workspace</span>
          <kbd>⌘ K</kbd>
        </button>
        <button className="icon-button" aria-label="Activity">
          <Activity size={17} />
          <span className="notification-dot" />
        </button>
        <div className="profile" title="Sign out" style={{ cursor: "pointer" }} onClick={onLogout} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onLogout()}>
          <div className="avatar">{initials}</div>
          <div className="profile-copy">
            <strong>{userName}</strong>
            <span>{userRole === "admin" ? "Administrator" : "Sales Engineer"}</span>
          </div>
          <ChevronDown size={14} />
        </div>
      </div>
    </header>
  );
}

function Sidebar({
  active,
  collapsed,
  mobileOpen,
  onNavigate,
  onClose,
  isAdmin,
  hasPermission,
}: {
  active: Page;
  collapsed: boolean;
  mobileOpen: boolean;
  onNavigate: Navigate;
  onClose: () => void;
  isAdmin: boolean;
  hasPermission: (f: string) => boolean;
}) {
  let lastGroup = "";
  return (
    <>
      {mobileOpen && <button className="mobile-overlay" onClick={onClose} aria-label="Close menu" />}
      <aside className={`sidebar ${collapsed ? "collapsed" : ""} ${mobileOpen ? "mobile-open" : ""}`}>
        <div className="sidebar-head">
          <BrandMark />
          {!collapsed && (
            <div className="brand-copy">
              <strong>HELIOS</strong>
              <span>Sales & Service Copilot</span>
            </div>
          )}
          <button className="icon-button sidebar-close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {!collapsed && <div className="pilot-pill"><span /> Private pilot</div>}
        <nav className="navigation">
          {navigation.map((item) => {
            // Hide Admin from non-admins entirely
            if (item.label === "Admin" && !isAdmin) return null;
            const showGroup = item.group && item.group !== lastGroup;
            if (item.group) lastGroup = item.group;
            // Page label → permission key (singular form used in DB)
            const PAGE_TO_PERM: Record<string, string> = {
              Workflows: "workflow",
              Knowledge: "knowledge",
              Draft: "draft",
              Capture: "capture",
              Library: "library",
              Feedback: "feedback",
              Onboard: "onboard",
            };
            const featureKey = PAGE_TO_PERM[item.label] ?? item.label.toLowerCase();
            const locked = !hasPermission(featureKey) && !["Home", "Admin", "Atelier", "Library"].includes(item.label);
            return (
              <div key={item.label}>
                {showGroup && !collapsed && <p className="nav-group">{item.group}</p>}
                <button
                  className={`nav-item ${active === item.label ? "active" : ""} ${locked ? "nav-locked" : ""}`}
                  onClick={() => {
                    if (!locked) { onNavigate(item.label); onClose(); }
                  }}
                  title={collapsed ? item.label : locked ? "Access restricted" : undefined}
                >
                  <item.icon size={18} strokeWidth={1.7} />
                  {!collapsed && <span>{item.label}</span>}
                  {item.label === "Workflows" && !collapsed && <span className="nav-count">2</span>}
                  {(item.label === "Capture" || item.label === "Onboard") && !collapsed && !locked && <span className="nav-soon">Soon</span>}
                  {locked && !collapsed && <Lock size={13} className="nav-lock-icon" />}
                </button>
              </div>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <div className="security-note">
            <ShieldCheck size={17} />
            {!collapsed && (
              <div>
                <strong>Enterprise protected</strong>
                <span>EU data boundary</span>
              </div>
            )}
          </div>
          <button className="nav-item" title={collapsed ? "Settings" : undefined}>
            <Settings size={18} strokeWidth={1.7} />
            {!collapsed && <span>Settings</span>}
          </button>
        </div>
      </aside>
    </>
  );
}

type HomeMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; result: ChatResponse };

function RouteLabel({ result }: { result: ChatResponse }) {
  const icons: Record<string, React.ReactNode> = {
    knowledge: <BookOpen size={12} />,
    draft: <PenLine size={12} />,
    workflow: <Layers3 size={12} />,
    clarify: <Sparkles size={12} />,
  };
  const colours: Record<string, string> = {
    knowledge: 'route-knowledge',
    draft: 'route-draft',
    workflow: 'route-workflow',
    clarify: 'route-clarify',
  };
  return (
    <span className={`route-badge ${colours[result.route] ?? ''}`}>
      {icons[result.route]} {result.label}
    </span>
  );
}

function HomePage({
  navigate,
  messages,
  setMessages,
  history,
  setHistory,
  firstName,
}: {
  navigate: Navigate;
  messages: HomeMessage[];
  setMessages: React.Dispatch<React.SetStateAction<HomeMessage[]>>;
  history: Array<{ role: string; content: string }>;
  setHistory: React.Dispatch<React.SetStateAction<Array<{ role: string; content: string }>>>;
  firstName?: string;
}) {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [homeFeedback, setHomeFeedback] = useState<Record<number, "helpful" | "not_helpful">>({});
  const [openSource, setOpenSource] = useState<Citation | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [messages, loading]);

  const send = async (text?: string) => {
    const message = (text ?? input).trim();
    if (!message || loading) return;
    setInput('');
    const newHistory = [...history, { role: 'user', content: message }];
    setMessages((prev) => [...prev, { role: 'user', content: message }]);
    setLoading(true);
    try {
      const result = await api.chat(message, history);
      setMessages((prev) => [...prev, { role: 'assistant', result }]);
      setHistory([...newHistory, { role: 'assistant', content: result.answer ?? result.clarification ?? result.route }]);
      if (result.route === 'draft') {
        window.setTimeout(() => navigate('Draft', { prompt: message, autoGenerate: true }), 1400);
      } else if (result.route === 'workflow') {
        window.setTimeout(() => navigate('Workflows', { prompt: message, autoGenerate: true }), 1400);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', result: { route: 'clarify' as const, confidence: 0, grounded: false, citations: [], label: 'Error', clarification: 'Service unavailable — please try again.' } },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const hasChat = messages.length > 0;

  return (
    <>
    <div className="page page-home">
      <section className="home-hero">
        <Kicker>Sales &amp; Service Copilot</Kicker>
        <h1>Good morning, {firstName ?? "Lena"}.</h1>
        <p className="hero-subtitle">Ask a question, draft a message, or start a workflow — one place.</p>

        {hasChat && (
          <div ref={threadRef} className="home-thread">
            {messages.map((msg, idx) => {
              if (msg.role === 'user') {
                return (
                  <div key={idx} className="home-msg home-msg-user">
                    <span className="speaker-label">You</span>
                    <p>{msg.content}</p>
                  </div>
                );
              }
              const res = msg.result;
              const userMsg = messages.slice(0, idx).filter((m) => m.role === 'user').at(-1);
              const userText = userMsg?.role === 'user' ? userMsg.content : '';
              return (
                <div key={idx} className="home-msg home-msg-assistant">
                  <div className="home-msg-meta">
                    <span className="speaker-label helios-label"><BrandMark /> Helios</span>
                    <RouteLabel result={res} />
                  </div>
                  {res.route === 'knowledge' && res.answer && (
                    <div className="home-answer">
                      <p><RichText text={res.answer} /></p>
                      {res.grounded && res.citations.length > 0 && (
                        <div className="home-citations">
                          {res.citations.slice(0, 3).map((c) => (
                            <button key={c.source_id} className="home-cite" onClick={() => setOpenSource(c)}>
                              [{c.index}] {c.title}
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="home-answer-actions">
                        <button className="continue-button" onClick={() => navigate('Knowledge', { prompt: userText })}>
                          Open in Knowledge <ArrowRight size={13} />
                        </button>
                        {res.grounded && (
                          <button className="continue-button" onClick={() => navigate('Draft', { prompt: userText })}>
                            Draft a reply <ArrowRight size={13} />
                          </button>
                        )}
                        {res.interaction_id && (
                          <span className="home-feedback">
                            <button
                              className={homeFeedback[idx] === 'helpful' ? 'saved' : ''}
                              aria-label="Mark answer helpful"
                              onClick={() => {
                                void api.feedback(res.interaction_id as string, 'helpful');
                                setHomeFeedback((prev) => ({ ...prev, [idx]: 'helpful' }));
                              }}
                            >
                              <ThumbsUp size={13} />
                            </button>
                            <button
                              className={homeFeedback[idx] === 'not_helpful' ? 'saved' : ''}
                              aria-label="Mark answer not helpful"
                              onClick={() => {
                                void api.feedback(res.interaction_id as string, 'not_helpful');
                                setHomeFeedback((prev) => ({ ...prev, [idx]: 'not_helpful' }));
                              }}
                            >
                              <ThumbsDown size={13} />
                            </button>
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  {res.route === 'draft' && (
                    <div className="home-answer">
                      <p className="home-route-note"><PenLine size={13} /> Opening <strong>Draft</strong> with your inquiry…</p>
                    </div>
                  )}
                  {res.route === 'workflow' && (
                    <div className="home-answer">
                      <p className="home-route-note"><Layers3 size={13} /> Opening <strong>Workflow</strong> — proposal preparation with human approval…</p>
                    </div>
                  )}
                  {res.route === 'clarify' && res.clarification && (
                    <div className="home-answer">
                      <p>{res.clarification}</p>
                    </div>
                  )}
                </div>
              );
            })}
            {loading && (
              <div className="home-msg home-msg-assistant">
                <div className="home-msg-meta">
                  <span className="speaker-label helios-label"><BrandMark /> Helios</span>
                  <span className="route-badge">Thinking…</span>
                </div>
                <div className="home-skeleton"><i /><i /><i /></div>
              </div>
            )}
          </div>
        )}

        <div className="command-box">
          {hasChat && (
            <div className="command-clear-row">
              <button className="clear-chat-btn" onClick={() => { setMessages([]); setHistory([]); }}>
                <X size={12} /> Clear conversation
              </button>
            </div>
          )}
          <div className="command-input">
            <Sparkles size={19} />
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={hasChat ? 'Ask a follow-up…' : 'Ask, draft, or begin a workflow…'}
              onKeyDown={(event) => {
                if (event.key === 'Enter') { event.preventDefault(); void send(); }
              }}
            />
            <button className="round-submit" onClick={() => void send()} aria-label="Submit" disabled={loading}>
              <ArrowRight size={17} />
            </button>
          </div>
          {!hasChat && (
            <div className="command-options">
              <button onClick={() => void send('Can the HX-240 run continuously at 95°C with EPDM seals?')}><BookOpen size={14} /> Seal compatibility</button>
              <button onClick={() => navigate('Draft')}><PenLine size={14} /> Draft an email</button>
              <button onClick={() => navigate('Workflows')}><Layers3 size={14} /> Run workflow</button>
            </div>
          )}
        </div>
      </section>

      <section className="workspace-grid">
            <div className="section-heading full-span">
              <div>
                <Kicker>Your workspace</Kicker>
                <h2>Continue where you left off</h2>
              </div>
              <button className="text-button" onClick={() => navigate('Library')}>View library <ArrowRight size={14} /></button>
            </div>

            <button className="feature-card knowledge-card" onClick={() => navigate('Knowledge')}>
              <div className="feature-icon"><BookOpen size={20} /></div>
              <div>
                <span className="eyebrow">Knowledge</span>
                <h3>Ask with confidence.</h3>
                <p>Grounded answers across your approved product and service knowledge.</p>
              </div>
              <span className="card-link">Begin a question <ArrowRight size={15} /></span>
            </button>

            <button className="feature-card" onClick={() => navigate('Draft')}>
              <div className="feature-icon"><PenLine size={20} /></div>
              <div>
                <span className="eyebrow">Draft</span>
                <h3>Write with precision.</h3>
                <p>Turn evidence into polished customer correspondence in your voice.</p>
              </div>
              <span className="card-link">Create a draft <ArrowRight size={15} /></span>
            </button>

            <button className="feature-card" onClick={() => navigate('Workflows')}>
              <div className="feature-icon"><Layers3 size={20} /></div>
              <div>
                <span className="eyebrow">Workflows</span>
                <h3>Move work forward.</h3>
                <p>Classify, retrieve, compose and verify—with you in control.</p>
              </div>
              <span className="card-link">View workflows <ArrowRight size={15} /></span>
            </button>
          </section>

          <section className="home-lower">
            <div className="recent-panel">
              <div className="section-heading">
                <div>
                  <Kicker>Recent</Kicker>
                  <h2>Latest work</h2>
                </div>
                <MoreHorizontal size={18} />
              </div>
              <div className="recent-list">
                {[
                  ['HX-240 operating limits', 'Knowledge', '8 min ago'],
                  ['Nordform technical response', 'Draft', 'Yesterday'],
                  ['CIP compatibility inquiry', 'Workflow', 'Yesterday'],
                ].map(([title, type, time], index) => (
                  <button className="recent-row" key={title} onClick={() => navigate(type as Page)}>
                    <span className="document-index">0{index + 1}</span>
                    <div><strong>{title}</strong><span>{type}</span></div>
                    <span className="recent-time">{time}</span>
                    <ArrowRight size={15} />
                  </button>
                ))}
              </div>
            </div>
            <div className="quality-panel">
              <Kicker>Quality pulse</Kicker>
              <div className="quality-value">94<span>%</span></div>
              <h3>grounded responses</h3>
              <p>Across your team's last 186 interactions.</p>
              <div className="quality-rule"><span /></div>
              <div className="quality-meta">
                <span><CheckCircle2 size={14} /> 31 approved</span>
                <span>+4.2% this month</span>
              </div>
            </div>
          </section>
    </div>
    <SourceViewer citation={openSource} onClose={() => setOpenSource(null)} />
    </>
  );
}
function SourceViewer({
  citation,
  onClose,
}: {
  citation: Citation | null;
  onClose: () => void;
}) {
  const [document, setDocument] = useState<SourceDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const highlightRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!citation) {
      setDocument(null);
      setError("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    setDocument(null);
    void api.source(citation.file, citation.page).then((result) => {
      if (!cancelled) {
        setDocument(result);
        setLoading(false);
      }
    }).catch((requestError) => {
      if (!cancelled) {
        setError(requestError instanceof Error ? requestError.message : "Document could not be opened");
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [citation]);

  useEffect(() => {
    if (highlightRef.current) {
      highlightRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [document]);

  useEffect(() => {
    if (!citation) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [citation, onClose]);

  if (!citation) return null;

  const kindLabel = document?.kind === "email" ? "Customer correspondence"
    : document?.kind === "ticket" ? "Service ticket"
    : document?.kind === "proposal" ? "Approved proposal"
    : document?.document_type || "Approved source";

  return (
    <>
      <button className="drawer-scrim source-scrim" aria-label="Close document" onClick={onClose} />
      <aside className="source-viewer" role="dialog" aria-modal="true" aria-labelledby="source-viewer-title">
        <header className="source-viewer-head">
          <div>
            <Kicker>Source verification</Kicker>
            <h2 id="source-viewer-title">{document?.title ?? citation.title}</h2>
            <small>{kindLabel}{document?.source_id ? ` · ${document.source_id}` : ""}{document?.status ? ` · ${document.status}` : ""}</small>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close"><X size={17} /></button>
        </header>
        <div className="source-viewer-body">
          {loading && (
            <div className="source-viewer-status">
              <span className="spinner dark" /> Opening approved document…
            </div>
          )}
          {error && (
            <div className="source-viewer-status error">
              <CircleAlert size={16} /> {error}
            </div>
          )}
          {document?.kind === "email" && (
            <article className="source-email">
              <div className="source-email-meta">
                <div><span>From</span><strong>{document.from_address}</strong></div>
                <div><span>To</span><strong>{document.to_address}</strong></div>
                <div><span>Date</span><strong>{document.date}</strong></div>
                <div><span>Subject</span><strong>{document.subject}</strong></div>
              </div>
              <div className="source-email-body">
                {(document.body ?? "").split(/\n{2,}/).map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </div>
            </article>
          )}
          {document?.kind === "ticket" && (
            <article className="source-ticket">
              <div className="source-ticket-banner">
                <ClipboardList size={18} />
                <div>
                  <strong>{document.ticket_id}</strong>
                  <span>{document.ticket_status}{document.severity ? ` · ${document.severity} severity` : ""}</span>
                </div>
              </div>
              <h3>{document.subject}</h3>
              <div className="source-ticket-grid">
                {document.customer && <div><span>Customer</span><strong>{document.customer}</strong></div>}
                {document.product && <div><span>Product</span><strong>{document.product}</strong></div>}
                {document.opened_date && <div><span>Opened</span><strong>{document.opened_date}</strong></div>}
                {Object.entries(document.conditions ?? {}).map(([key, value]) => (
                  <div key={key}><span>{key.replace(/_/g, " ")}</span><strong>{value}</strong></div>
                ))}
              </div>
              {document.symptoms && <section><h4>Symptoms</h4><p>{document.symptoms}</p></section>}
              {document.diagnosis && <section><h4>Diagnosis</h4><p>{document.diagnosis}</p></section>}
              {document.resolution && <section><h4>Resolution</h4><p>{document.resolution}</p></section>}
              {document.service_lesson && <section className="source-ticket-lesson"><h4>Service lesson</h4><p>{document.service_lesson}</p></section>}
            </article>
          )}
          {document && (document.kind === "document" || document.kind === "proposal") && (
            <div className="source-pages">
              {document.pages.map((page) => {
                const highlighted = document.highlight_page != null && page.number === document.highlight_page;
                return (
                  <article
                    key={page.number}
                    className={`source-page${highlighted ? " highlighted" : ""}`}
                    ref={highlighted ? highlightRef : undefined}
                  >
                    <div className="source-page-masthead">
                      <span>Helios Industrial Systems</span>
                      <span>Page {page.number} of {document.pages.length}</span>
                    </div>
                    {page.blocks.filter((block) => block.type === "meta").length > 0 && (
                      <dl className="source-page-meta">
                        {page.blocks.filter((block) => block.type === "meta").map((block, index) => (
                          <div key={`${block.label}-${index}`}>
                            <dt>{block.label}</dt>
                            <dd>{block.text}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                    {page.blocks.filter((block) => block.type !== "meta").map((block, index) => (
                      block.type === "heading"
                        ? <h3 key={`${page.number}-${index}`}>{block.text}</h3>
                        : <p key={`${page.number}-${index}`}>{block.text}</p>
                    ))}
                    <div className="source-page-foot">Approved source · {document.source_id}</div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

function KnowledgePage({
  navigate,
  initialPrompt = "",
  autoAsk = false,
}: {
  navigate: Navigate;
  initialPrompt?: string;
  autoAsk?: boolean;
}) {
  type Turn = { question: string; response: KnowledgeResponse };
  const [question, setQuestion] = useState(initialPrompt);
  const [submittedQuestion, setSubmittedQuestion] = useState(autoAsk ? initialPrompt : "");
  const [state, setState] = useState<"empty" | "loading" | "answer" | "refusal">(
    autoAsk && initialPrompt.trim() ? "loading" : "empty",
  );
  const [response, setResponse] = useState<KnowledgeResponse | null>(null);
  const [error, setError] = useState("");
  const [activeSource, setActiveSource] = useState(0);
  const [openSource, setOpenSource] = useState<Citation | null>(null);
  const [saved, setSaved] = useState(false);
  const [feedback, setFeedback] = useState<"helpful" | "not_helpful" | null>(null);
  const [thread, setThread] = useState<Turn[]>([]);
  const startedFromHome = useRef(false);
  const threadRef = useRef<HTMLDivElement>(null);

  const suggestions = [
    "Can the HX-240 run continuously at 95°C with its standard EPDM seal?",
    "Which model fits 17 bar, 105°C and 125 m³/h?",
    "What caused the HX-300 low-flow issue at Baltic Process?",
    "Can HX-240 safely pump concentrated nitric acid at 80°C?",
  ];

  // Build the history array for the API from the thread
  const buildHistory = (currentThread: Turn[]): Array<{ role: "user" | "assistant"; content: string }> =>
    currentThread.slice(-4).flatMap((turn) => [
      { role: "user" as const, content: turn.question },
      { role: "assistant" as const, content: turn.response.answer },
    ]);

  const ask = async (suggestion?: string) => {
    const nextQuestion = (suggestion ?? question).trim();
    if (!nextQuestion) return;
    setQuestion("");
    setSubmittedQuestion(nextQuestion);
    setResponse(null);
    setError("");
    setFeedback(null);
    setState("loading");
    try {
      const result = await api.ask(nextQuestion, buildHistory(thread));
      setResponse(result);
      setActiveSource(0);
      const newState = result.intent === "insufficient" && !result.grounded ? "refusal" : "answer";
      setState(newState);
      if (newState === "answer") {
        setThread((prev) => [...prev, { question: nextQuestion, response: result }]);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Knowledge service unavailable");
      setState("refusal");
    }
  };

  useEffect(() => {
    if (startedFromHome.current) return;
    startedFromHome.current = true;
    if (autoAsk && initialPrompt.trim()) void ask(initialPrompt);
  }, [autoAsk, initialPrompt]);

  useEffect(() => {
    if (state === "empty") return;
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [state, response]);

  return (
    <>
    <div className="page knowledge-layout">
      <main className="knowledge-main">
        <div className="page-title-row">
          <div>
            <Kicker>Knowledge AI</Kicker>
            <h1>Ask with confidence.</h1>
          </div>
          <div className="status-label"><span /> 40 sources ready</div>
        </div>

        <div ref={threadRef} className={`conversation ${state === "empty" ? "empty" : ""}`}>
          {state === "empty" && (
            <section className="knowledge-empty">
              <div className="knowledge-orbit"><BrandMark /></div>
              <Kicker>Grounded enterprise knowledge</Kicker>
              <h2>What would you like to know?</h2>
              <p>Ask across approved product manuals, service guidance and proposal knowledge.</p>
              <div className="suggestion-grid">
                {suggestions.map((suggestion, index) => (
                  <button key={suggestion} onClick={() => ask(suggestion)}>
                    <span>0{index + 1}</span>
                    <strong>{suggestion}</strong>
                    <ArrowRight size={14} />
                  </button>
                ))}
              </div>
              <div className="knowledge-trust">
                <span><ShieldCheck size={14} /> Access-aware retrieval</span>
                <span><FileText size={14} /> 40 enterprise sources</span>
                <span><CheckCircle2 size={14} /> Citations on every answer</span>
              </div>
            </section>
          )}
          {state === "loading" && (
            <section className="knowledge-loading">
              {thread.length > 0 && (
                <div className="thread-history">
                  {thread.map((turn, i) => (
                    <div key={i} className="thread-prior">
                      <div className="thread-prior-q"><span className="speaker-label">You</span><p>{turn.question}</p></div>
                      <div className="thread-prior-a"><span className="speaker-label helios-label"><BrandMark /> Helios</span><p>{turn.response.answer.slice(0, 180)}{turn.response.answer.length > 180 ? "…" : ""}</p></div>
                    </div>
                  ))}
                </div>
              )}
              <div className="question-block">
                <span className="speaker-label">You</span>
                <p>{submittedQuestion}</p>
              </div>
              <div className="answer-skeleton">
                <span className="skeleton-mark"><BrandMark /></span>
                <div><i /><i /><i /><i /></div>
              </div>
            </section>
          )}
          {state === "answer" && (
            <>
              {thread.length > 1 && (
                <div className="thread-history">
                  {thread.slice(0, -1).map((turn, i) => (
                    <div key={i} className="thread-prior">
                      <div className="thread-prior-q"><span className="speaker-label">You</span><p>{turn.question}</p></div>
                      <div className="thread-prior-a"><span className="speaker-label helios-label"><BrandMark /> Helios</span><p>{turn.response.answer.slice(0, 200)}{turn.response.answer.length > 200 ? "…" : ""}</p></div>
                    </div>
                  ))}
                </div>
              )}
              <article className="question-block">
                <span className="speaker-label">You</span>
                <p>{submittedQuestion}</p>
              </article>
              <article className="answer-block">
                <div className="answer-meta">
                  <span className="speaker-label helios-label"><BrandMark /> Helios</span>
                  <span className={`grounded-badge${response?.grounded ? "" : " assistant-badge"}`}>
                    {response?.grounded ? (
                      <><CheckCircle2 size={13} /> Grounded · {((response?.latency_ms ?? 0) / 1000).toFixed(2)}s</>
                    ) : (
                      <><CheckCircle2 size={13} /> Helios</>
                    )}
                  </span>
                </div>
                {response?.answer.split(/\n{2,}/).map((paragraph) => (
                  <p key={paragraph}>
                    <RichText
                      text={paragraph}
                      onCitation={(citation) => {
                        const source = response?.citations[citation - 1];
                        setActiveSource(Math.max(0, citation - 1));
                        if (source) setOpenSource(source);
                      }}
                    />
                  </p>
                ))}
                <div className="answer-actions">
                  <button className={saved ? "saved" : ""} onClick={() => setSaved(!saved)}>
                    <Bookmark size={15} fill={saved ? "currentColor" : "none"} /> {saved ? "Saved" : "Save"}
                  </button>
                  <button onClick={() => navigator.clipboard?.writeText(response?.answer ?? "")}>
                    <Copy size={15} /> Copy
                  </button>
                  <div className="action-spacer" />
                  <button
                    className={feedback === "helpful" ? "saved" : ""}
                    aria-label="Helpful"
                    onClick={() => {
                      if (response) void api.feedback(response.interaction_id, "helpful");
                      setFeedback("helpful");
                    }}
                  >
                    <ThumbsUp size={15} />
                  </button>
                  <button
                    className={feedback === "not_helpful" ? "saved" : ""}
                    aria-label="Not helpful"
                    onClick={() => {
                      if (response) void api.feedback(response.interaction_id, "not_helpful");
                      setFeedback("not_helpful");
                    }}
                  >
                    <ThumbsDown size={15} />
                  </button>
                  {response?.grounded && (response.citations?.length ?? 0) > 0 && (
                  <button className="continue-button" onClick={() => navigate("Draft", { prompt: submittedQuestion })}>
                    Continue in Draft <ArrowRight size={15} />
                  </button>
                  )}
                </div>
              </article>
            </>
          )}
          {state === "refusal" && (
            <>
              <article className="question-block">
                <span className="speaker-label">You</span>
                <p>{submittedQuestion}</p>
              </article>
              <article className="answer-block refusal-block">
                <div className="answer-meta">
                  <span className="speaker-label helios-label"><BrandMark /> Helios</span>
                  <span className="confidence-badge"><CircleAlert size={13} /> Insufficient evidence</span>
                </div>
                <h3>{error ? "Knowledge service unavailable." : "Not in the approved knowledge."}</h3>
                <p>
                  {error
                    ? `${error}. Confirm that the backend is running, then try again.`
                    : response?.answer ?? "I couldn’t find a reliable answer in the sources you’re permitted to access."}
                </p>
                <div className="refusal-actions">
                  <button className="secondary-button" onClick={() => { setQuestion(""); setState("empty"); }}>
                    Ask another question
                  </button>
                  <button className="text-button">Request source review <ArrowRight size={14} /></button>
                </div>
              </article>
            </>
          )}
        </div>

        <div className="ask-area">
          <div className="ask-input">
            <textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="Ask a follow-up..."
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  ask();
                }
              }}
            />
            <div className="ask-footer">
              <button className="add-context"><Plus size={15} /> Add context</button>
              <span>Answers use approved sources only</span>
              <button className="round-submit" onClick={() => ask()}><ArrowRight size={17} /></button>
            </div>
          </div>
        </div>
      </main>

      <aside className={`sources-rail ${state !== "answer" || !(response?.citations.length) ? "sources-idle" : ""}`}>
        <div className="sources-heading">
          <div><Kicker>Evidence</Kicker><h2>Sources</h2></div>
          <span>{state === "answer" && (response?.citations.length ?? 0) > 0 ? `${response?.citations.length ?? 0} used` : "Ready"}</span>
        </div>
        <p className="sources-intro">Every answer is traceable to approved company knowledge.</p>
        {state === "answer" && (response?.citations.length ?? 0) > 0 ? (
          <div className="source-list">
            {(response?.citations ?? []).map((source, index) => (
              <button
                key={`${source.source_id}-${source.index}`}
                className={`source-card ${activeSource === index ? "active" : ""}`}
                onClick={() => {
                  setActiveSource(index);
                  setOpenSource(source);
                }}
              >
                <div className="source-top">
                  <span>{String(source.index).padStart(2, "0")}</span>
                  <FileText size={16} />
                </div>
                <h3>{source.title}</h3>
                <small>{source.section ?? source.document_type}{source.page ? ` · Page ${source.page}` : ""}</small>
                <p>{source.excerpt}</p>
                <span className="source-open">Open document <ArrowRight size={13} /></span>
              </button>
            ))}
          </div>
        ) : (
          <div className="source-access-card">
            <div className="source-access-icon"><ShieldCheck size={19} /></div>
            <h3>Your knowledge boundary</h3>
            <p>Helios searches only approved content you are authorised to view.</p>
            <div><span>Product documentation</span><strong>8</strong></div>
            <div><span>Technical manuals</span><strong>6</strong></div>
            <div><span>Historical cases</span><strong>26</strong></div>
            <small>Sensitive data is excluded from interaction logs.</small>
          </div>
        )}
      </aside>
    </div>
    <SourceViewer citation={openSource} onClose={() => setOpenSource(null)} />
    </>
  );
}

function DraftPage({
  navigate,
  initialPrompt = "",
  autoGenerate = false,
}: {
  navigate: Navigate;
  initialPrompt?: string;
  autoGenerate?: boolean;
}) {
  const templates = [
    { name: "Technical response", note: "Answer a product or service question", icon: MessageSquareText },
    { name: "Sales follow-up", note: "Continue a customer conversation", icon: Send },
    { name: "Proposal introduction", note: "Duty point to tailored proposal", icon: FileText },
    { name: "Service apology", note: "Respond with clarity and accountability", icon: ShieldCheck },
  ];
  const proposalStart = looksLikeProposal(initialPrompt);
  const [template, setTemplate] = useState(proposalStart ? 2 : 0);
  const [tone, setTone] = useState("Technical");
  const [format, setFormat] = useState(proposalStart ? "Proposal note" : "Customer email");
  const [inquiry, setInquiry] = useState(initialPrompt);
  const [customer, setCustomer] = useState("");
  const [fluid, setFluid] = useState("");
  const [temperature, setTemperature] = useState("");
  const [pressure, setPressure] = useState("");
  const [flow, setFlow] = useState("");
  const [need, setNeed] = useState("");
  const [draftState, setDraftState] = useState<"empty" | "loading" | "ready">("empty");
  const [draft, setDraft] = useState<DraftResponse | null>(null);
  const [draftError, setDraftError] = useState("");
  const [copied, setCopied] = useState(false);
  const [draftFeedback, setDraftFeedback] = useState<"helpful" | "not_helpful" | null>(null);
  const [openSource, setOpenSource] = useState<Citation | null>(null);
  const proposalMode = templates[template].name === "Proposal introduction" || format === "Proposal note";
  const startedRef = useRef(false);

  const composeInquiry = () => {
    const fields = [
      customer && `Customer: ${customer}`,
      fluid && `Fluid: ${fluid}`,
      temperature && `Temperature: ${temperature}`,
      pressure && `Pressure: ${pressure}`,
      flow && `Required flow: ${flow}`,
      need && `Need: ${need}`,
    ].filter(Boolean);
    return [fields.join("\n"), inquiry.trim()].filter(Boolean).join("\n\n");
  };

  const loadAcmeExample = () => {
    setTemplate(2);
    setFormat("Proposal note");
    setCustomer("ACME Chemicals");
    setFluid("chemically treated water");
    setTemperature("95°C");
    setPressure("7 bar");
    setFlow("70 m³/h");
    setNeed("replacement pump + technical proposal");
    setInquiry(ACME_PROPOSAL_BRIEF);
  };

  const generate = async () => {
    const effectiveInquiry = composeInquiry() || ACME_PROPOSAL_BRIEF;
    if (!inquiry.trim() && !customer) setInquiry(effectiveInquiry);
    setDraftError("");
    setDraftFeedback(null);
    setDraftState("loading");
    try {
      const result = await api.draft({
        inquiry: effectiveInquiry,
        template: templates[template].name,
        tone,
        format: proposalMode ? "Proposal note" : format,
      });
      setDraft(result);
      setDraftState("ready");
    } catch (requestError) {
      setDraftError(requestError instanceof Error ? requestError.message : "Draft service unavailable");
      setDraftState("empty");
    }
  };

  useEffect(() => {
    if (autoGenerate && initialPrompt.trim() && !startedRef.current) {
      startedRef.current = true;
      void generate();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoGenerate, initialPrompt]);

  return (
    <>
    <div className="page draft-page">
      <div className="page-title-row">
        <div>
          <Kicker>Draft assistant</Kicker>
          <h1>Write with precision.</h1>
          <p className="page-description">Compose considered customer responses, grounded in approved knowledge.</p>
        </div>
        <div className="draft-status"><span /> Customer-safe workspace</div>
      </div>

      <div className={`draft-workspace ${draftState}`}>
        <section className="draft-context draft-composer">
          <div className="panel-title">
            <span className="panel-number">01</span>
            <div><Kicker>Compose</Kicker><h2>Set up your draft</h2></div>
          </div>
          <label className="composer-label">Template</label>
          <div className="template-grid">
            {templates.map((item, index) => (
              <button
                key={item.name}
                className={template === index ? "active" : ""}
                onClick={() => {
                  setTemplate(index);
                  if (item.name === "Proposal introduction") setFormat("Proposal note");
                }}
              >
                <span><item.icon size={15} /></span>
                <div><strong>{item.name}</strong><small>{item.note}</small></div>
                {template === index && <Check size={14} />}
              </button>
            ))}
          </div>
          <div className="field-grid">
            <label>
              <span>Tone</span>
              <select value={tone} onChange={(event) => setTone(event.target.value)}>
                <option>Technical</option>
                <option>Formal</option>
                <option>Commercial</option>
                <option>Concise</option>
              </select>
            </label>
            <label>
              <span>Format</span>
              <select value={format} onChange={(event) => setFormat(event.target.value)}>
                <option>Customer email</option><option>Proposal note</option>
              </select>
            </label>
          </div>
          {proposalMode && (
            <>
              <label className="composer-label">Customer requirement</label>
              <div className="field-grid requirement-grid">
                <label><span>Customer</span><input value={customer} onChange={(event) => setCustomer(event.target.value)} placeholder="ACME Chemicals" /></label>
                <label><span>Fluid</span><input value={fluid} onChange={(event) => setFluid(event.target.value)} placeholder="Chemically treated water" /></label>
                <label><span>Temperature</span><input value={temperature} onChange={(event) => setTemperature(event.target.value)} placeholder="95°C" /></label>
                <label><span>Pressure</span><input value={pressure} onChange={(event) => setPressure(event.target.value)} placeholder="7 bar" /></label>
                <label><span>Required flow</span><input value={flow} onChange={(event) => setFlow(event.target.value)} placeholder="70 m³/h" /></label>
                <label><span>Need</span><input value={need} onChange={(event) => setNeed(event.target.value)} placeholder="Replacement + technical proposal" /></label>
              </div>
            </>
          )}
          <label className="composer-label inquiry-label">{proposalMode ? "Email, RFQ or extra notes" : "Customer inquiry or instructions"}</label>
          <textarea
            value={inquiry}
            onChange={(event) => setInquiry(event.target.value)}
            placeholder={proposalMode ? "Paste the customer email or RFQ..." : "Paste the customer question, or describe what this email should accomplish..."}
          />
          <div className="composer-context">
            <span><ShieldCheck size={13} /> Approved knowledge only</span>
            <button type="button" onClick={loadAcmeExample}>Use ACME example</button>
          </div>
          <button className="primary-button wide generate-button" onClick={generate} disabled={draftState === "loading"}>
            {draftState === "loading" ? <><span className="spinner" /> Composing</> : <><Sparkles size={16} /> {proposalMode ? "Generate tailored proposal" : "Generate grounded draft"}</>}
          </button>
          {draftError && <p className="form-error"><CircleAlert size={13} /> {draftError}</p>}
        </section>

        <section className="letter-panel">
          <div className="panel-title">
            <span className="panel-number">02</span>
            <div><Kicker>Output</Kicker><h2>{draft?.kind === "proposal" ? "Technical proposal" : "Customer response"}</h2></div>
            <button className="icon-button"><MoreHorizontal size={18} /></button>
          </div>
          {draftState === "empty" && (
            <div className="draft-empty">
              <div className="draft-empty-icon"><PenLine size={22} /></div>
              <Kicker>Ready when you are</Kicker>
              <h3>Your draft will appear here.</h3>
              <p>Paste a duty point or customer email. Helios retrieves approved knowledge and drafts a proposal or reply for review — nothing is sent.</p>
              <div className="draft-empty-steps">
                <span><i>01</i> Enter the requirement</span>
                <span><i>02</i> Retrieve approved sources</span>
                <span><i>03</i> Review, then approve</span>
              </div>
            </div>
          )}
          {draftState === "loading" && (
            <div className="letter letter-loading">
              <div className="letter-watermark">COMPOSING · NOT SENT</div>
              <i /><i className="short" /><div /><i /><i /><i className="medium" /><div /><i /><i className="short" />
            </div>
          )}
          {draftState === "ready" && (
            <>
              <article className={`letter ${draft?.kind === "proposal" ? "proposal-doc" : ""}`}>
                <div className="letter-watermark">DRAFT · EDITABLE · NOT SENT</div>
                <label>{draft?.kind === "proposal" ? "Proposal title" : "Subject"}</label>
                <input
                  className="letter-subject"
                  value={draft?.subject ?? ""}
                  onChange={(event) => setDraft((current) => current ? { ...current, subject: event.target.value } : current)}
                />
                <div className="letter-rule" />
                {draft?.kind === "proposal" && (draft.sections?.length ?? 0) > 0
                  ? draft.sections?.map((section, sectionIndex) => (
                      <section className="proposal-section" key={section.heading}>
                        <h4>{section.heading}</h4>
                        <textarea
                          className="letter-body"
                          value={section.content}
                          onChange={(event) => {
                            const content = event.target.value;
                            setDraft((current) => {
                              if (!current?.sections) return current;
                              const sections = current.sections.map((item, index) =>
                                index === sectionIndex ? { ...item, content } : item
                              );
                              return {
                                ...current,
                                sections,
                                body: sections.map((item) => `${item.heading}\n${item.content}`).join("\n\n"),
                              };
                            });
                          }}
                        />
                      </section>
                    ))
                  : (
                    <textarea
                      className="letter-body"
                      value={draft?.body ?? ""}
                      onChange={(event) => setDraft((current) => current ? { ...current, body: event.target.value } : current)}
                    />
                  )}
                <p className="letter-edit-hint">Edit the text above, then copy. Citations like [1] stay in the draft. Nothing is sent.</p>
              </article>
              {!!draft?.unsupported_claims.length && (
                <div className="unsupported-banner">
                  <CircleAlert size={14} />
                  {draft.unsupported_claims[0]}
                </div>
              )}
              <div className="evidence-strip">
                <span>
                  <ShieldCheck size={14} /> Grounded in {draft?.citations.length ?? 0} approved sources
                </span>
                <span className="evidence-ids">
                  {draft?.citations.map((citation) => (
                    <button key={citation.source_id} type="button" onClick={() => setOpenSource(citation)}>
                      {citation.source_id}
                    </button>
                  ))}
                </span>
              </div>
              <div className="feedback-row">
                <span>Was this draft useful?</span>
                <button
                  className={draftFeedback === "helpful" ? "saved" : ""}
                  onClick={() => {
                    if (draft) void api.feedback(draft.interaction_id, "helpful");
                    setDraftFeedback("helpful");
                  }}
                  aria-label="Mark draft helpful"
                >
                  <ThumbsUp size={14} />
                </button>
                <button
                  className={draftFeedback === "not_helpful" ? "saved" : ""}
                  onClick={() => {
                    if (draft) void api.feedback(draft.interaction_id, "not_helpful");
                    setDraftFeedback("not_helpful");
                  }}
                  aria-label="Mark draft not helpful"
                >
                  <ThumbsDown size={14} />
                </button>
                {draftFeedback && <small>Thanks — recorded.</small>}
              </div>
              <div className="letter-actions">
                <button className="text-button" onClick={() => setDraftState("empty")}>Start over</button>
                <div>
                  <button
                    className="secondary-button"
                    onClick={() => {
                      setCopied(true);
                      void navigator.clipboard?.writeText(`${draft?.subject}\n\n${draft?.body}`);
                      window.setTimeout(() => setCopied(false), 1800);
                    }}
                  >
                    {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? "Copied" : "Copy"}
                  </button>
                  <button className="primary-button" onClick={() => navigate("Workflows", { prompt: composeInquiry() || inquiry })}>
                    Review & approve <ArrowRight size={15} />
                  </button>
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
    <SourceViewer citation={openSource} onClose={() => setOpenSource(null)} />
    </>
  );
}

function WorkflowsPage({ initialPrompt = "", autoRun = false, userName = "User" }: { initialPrompt?: string; autoRun?: boolean; userName?: string }) {
  const builtins = [
    { id: "builtin-inquiry", name: "Inquiry → approved reply", description: "Grounded technical response with human approval.", runs: "1,284 runs", success: "97.4%", state: "Active" as const, icon: MessageSquareText, outputKind: "email" as const },
    { id: "builtin-proposal", name: "Proposal preparation", description: "Duty point to a sectional proposal, then human approval.", runs: "Live", success: "Pilot", state: "Active" as const, icon: FileText, outputKind: "proposal" as const },
    { id: "builtin-service", name: "Service-ticket response", description: "Classify and prepare service guidance for review.", runs: "Planned", success: "Q4 pilot", state: "Planned" as const, icon: ShieldCheck, outputKind: "email" as const },
  ];
  const stepChoices = [
    { key: "classify", label: "Classify inquiry" },
    { key: "retrieve", label: "Retrieve evidence" },
    { key: "compose", label: "Compose response" },
    { key: "verify", label: "Verify claims" },
    { key: "approval", label: "Human approval", locked: true },
  ];
  const proposalPrompt = looksLikeProposal(initialPrompt);
  const [status, setStatus] = useState<WorkflowStatus>("idle");
  const [activeStep, setActiveStep] = useState(-1);
  const [selectedWorkflow, setSelectedWorkflow] = useState(proposalPrompt ? 1 : 0);
  const [liveRun, setLiveRun] = useState(false);
  const [creating, setCreating] = useState(false);
  const [workflowId, setWorkflowId] = useState("");
  const [workflowData, setWorkflowData] = useState<WorkflowResponse | null>(null);
  const [workflowError, setWorkflowError] = useState("");
  const [workflowFeedback, setWorkflowFeedback] = useState<"helpful" | "not_helpful" | null>(null);
  const [runInquiry, setRunInquiry] = useState(initialPrompt || "");
  const autoRunRef = useRef(false);
  const [customProtocols, setCustomProtocols] = useState<typeof builtins>([]);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newOutput, setNewOutput] = useState<"email" | "proposal">("email");
  const [newSteps, setNewSteps] = useState(["classify", "retrieve", "compose", "verify", "approval"]);
  const [createError, setCreateError] = useState("");
  const [editSubject, setEditSubject] = useState("");
  const [editBody, setEditBody] = useState("");
  const [editSections, setEditSections] = useState<Array<{ heading: string; content: string }>>([]);

  const workflows = [
    ...builtins,
    ...customProtocols.map((item) => ({
      ...item,
      runs: "Custom",
      success: "Pilot",
      state: "Active" as const,
      icon: Layers3,
    })),
  ];
  const selected = workflows[selectedWorkflow] ?? workflows[0];

  useEffect(() => {
    void api.listProtocols().then((rows) => {
      setCustomProtocols(rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        runs: "Custom",
        success: "Pilot",
        state: "Active" as const,
        icon: Layers3,
        outputKind: row.output_kind,
      })));
    }).catch(() => setCustomProtocols([]));
  }, []);

  useEffect(() => {
    if (!workflowId || status !== "running") return;
    const timer = window.setInterval(async () => {
      try {
        const result = await api.workflow(workflowId);
        setWorkflowData(result);
        setStatus(result.status);
        const runningStep = result.steps.findIndex((step) => step.status === "running");
        const attentionStep = result.steps.findIndex((step) => step.status === "attention");
        const current = runningStep >= 0 ? runningStep : attentionStep;
        setActiveStep(current < 0 ? result.steps.length - 1 : current);
      } catch (requestError) {
        setWorkflowError(requestError instanceof Error ? requestError.message : "Workflow service unavailable");
        setStatus("failed");
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [workflowId, status]);

  useEffect(() => {
    const draft = workflowData?.draft;
    if (!draft || status !== "approval") return;
    setEditSubject(draft.subject);
    setEditBody(draft.body);
    setEditSections(draft.sections ?? []);
  }, [status, workflowData?.draft?.interaction_id]);

  const begin = async () => {
    if (selected.state !== "Active") return;
    if (!runInquiry.trim()) return;
    setCreating(false);
    setWorkflowError("");
    setWorkflowFeedback(null);
    setEditSubject("");
    setEditBody("");
    setEditSections([]);
    setLiveRun(true);
    setActiveStep(0);
    setStatus("running");
    const inquiryText =
      selected.outputKind === "proposal" && !/\b(proposal|rfq|rfp)\b/i.test(runInquiry)
        ? `Need: technical proposal\n\n${runInquiry}`
        : runInquiry;
    try {
      const result = await api.createWorkflow(inquiryText, {
        output_kind: selected.outputKind,
        protocol_name: selected.name,
      });
      setWorkflowId(result.workflow_id);
      setWorkflowData(result);
      setStatus(result.status);
    } catch (requestError) {
      setWorkflowError(requestError instanceof Error ? requestError.message : "Workflow service unavailable");
      setStatus("failed");
    }
  };

  // Auto-run when routed from Home with a proposal brief
  useEffect(() => {
    if (autoRun && initialPrompt.trim() && !autoRunRef.current) {
      autoRunRef.current = true;
      void begin();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveProtocol = async () => {
    const name = newName.trim();
    if (name.length < 2) {
      setCreateError("Give the protocol a name.");
      return;
    }
    setCreateError("");
    try {
      const created = await api.createProtocol({
        name,
        description: newDescription.trim() || "Custom governed protocol with human approval.",
        output_kind: newOutput,
        steps: newSteps.includes("approval") ? newSteps : [...newSteps, "approval"],
      });
      const next = {
        id: created.id,
        name: created.name,
        description: created.description,
        runs: "Custom",
        success: "Pilot",
        state: "Active" as const,
        icon: Layers3,
        outputKind: created.output_kind,
      };
      setCustomProtocols((current) => [next, ...current]);
      setSelectedWorkflow(builtins.length);
      setCreating(false);
      setLiveRun(false);
      setNewName("");
      setNewDescription("");
      setNewOutput("email");
      setNewSteps(["classify", "retrieve", "compose", "verify", "approval"]);
    } catch (requestError) {
      setCreateError(requestError instanceof Error ? requestError.message : "Protocol could not be saved");
    }
  };

  const decide = async (decision: "approve" | "revise" | "decline") => {
    if (!workflowId) return;
    try {
      const result = await api.workflowDecision(workflowId, decision);
      setWorkflowData(result);
      setStatus(result.status);
      if (decision === "revise") setActiveStep(0);
      if (decision === "approve") {
        const body = editSections.length
          ? editSections.map((section) => `${section.heading}\n${section.content}`).join("\n\n")
          : editBody;
        void navigator.clipboard?.writeText(`${editSubject}\n\n${body}`);
      }
    } catch (requestError) {
      setWorkflowError(requestError instanceof Error ? requestError.message : "Decision could not be recorded");
    }
  };

  const visibleStep = status === "idle" ? -1 : activeStep;

  return (
    <div className="page workflow-page">
      <div className="page-title-row">
        <div>
          <Kicker>Agent workflows</Kicker>
          <h1>Move work forward.</h1>
          <p className="page-description">A governed path from customer inquiry to approved response.</p>
        </div>
        <button className="secondary-button"><Clock3 size={15} /> View run history</button>
      </div>

      <div className="workflow-studio">
        <section className="workflow-catalogue">
          <div className="catalogue-head">
            <div><Kicker>Workflow library</Kicker><h2>Protocols</h2></div>
            <button
              className={`icon-button ${creating ? "active" : ""}`}
              aria-label="Create protocol"
              title="Create protocol"
              onClick={() => {
                setCreating(true);
                setLiveRun(false);
                setStatus("idle");
                setCreateError("");
              }}
            >
              <Plus size={17} />
            </button>
          </div>
          <div className="workflow-list">
            {workflows.map((workflow, index) => (
              <button
                key={workflow.id}
                className={selectedWorkflow === index && !creating ? "active" : ""}
                onClick={() => {
                  setCreating(false);
                  setSelectedWorkflow(index);
                  setLiveRun(false);
                  setStatus("idle");
                  setActiveStep(-1);
                  setWorkflowId("");
                  setWorkflowData(null);
                  setWorkflowError("");
                }}
              >
                <span className="workflow-list-icon"><workflow.icon size={16} /></span>
                <div>
                  <span className="workflow-list-title"><strong>{workflow.name}</strong><i className={workflow.state.toLowerCase()}>{workflow.state}</i></span>
                  <p>{workflow.description}</p>
                  <small>{workflow.runs}<b>{workflow.success}</b></small>
                </div>
              </button>
            ))}
          </div>
          <div className="catalogue-note"><ShieldCheck size={15} /><span><strong>Governed by design</strong>Every customer-facing workflow requires approval.</span></div>
        </section>

        <section className={`workflow-detail ${liveRun ? "is-live" : ""}`}>
          {creating ? (
            <div className="protocol-builder">
              <div className="workflow-detail-head">
                <div>
                  <span className="workflow-state active">New</span>
                  <h2>Create a protocol</h2>
                  <p>Name it, choose the output, and keep human approval in the path.</p>
                </div>
                <button className="secondary-button" onClick={() => setCreating(false)}>Cancel</button>
              </div>
              <label className="workflow-label">Protocol name</label>
              <input className="protocol-input" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Nordics follow-up protocol" />
              <label className="workflow-label">What it does</label>
              <input className="protocol-input" value={newDescription} onChange={(event) => setNewDescription(event.target.value)} placeholder="Draft a grounded reply, verify claims, then wait for Lena." />
              <label className="workflow-label">Output</label>
              <div className="protocol-output">
                <button type="button" className={newOutput === "email" ? "active" : ""} onClick={() => setNewOutput("email")}>Customer email</button>
                <button type="button" className={newOutput === "proposal" ? "active" : ""} onClick={() => setNewOutput("proposal")}>Technical proposal</button>
              </div>
              <label className="workflow-label">Steps</label>
              <div className="step-picker">
                {stepChoices.map((step) => {
                  const checked = newSteps.includes(step.key);
                  return (
                    <label key={step.key} className={step.locked ? "locked" : ""}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={step.locked}
                        onChange={() => {
                          if (step.locked) return;
                          setNewSteps((current) =>
                            current.includes(step.key)
                              ? current.filter((key) => key !== step.key)
                              : [...current, step.key],
                          );
                        }}
                      />
                      <span>{step.label}</span>
                      {step.locked && <small>Required</small>}
                    </label>
                  );
                })}
              </div>
              {createError && <p className="form-error"><CircleAlert size={13} /> {createError}</p>}
              <button className="primary-button" onClick={() => void saveProtocol()}>Save protocol</button>
            </div>
          ) : !liveRun ? (
            <>
              <div className="workflow-detail-head">
                <div>
                  <span className={`workflow-state ${selected.state.toLowerCase()}`}>{selected.state}</span>
                  <h2>{selected.name}</h2>
                  <p>{selected.description}</p>
                </div>
              </div>

              {selected.state === "Active" && (
                <div className="run-input-box">
                  <label className="run-input-label">
                    {selected.outputKind === "proposal" ? "Customer requirement" : "Technical customer inquiry"}
                  </label>
                  <p className="run-input-hint">
                    {selected.outputKind === "proposal"
                      ? "Paste the duty point, RFQ notes or customer email. Helios will classify, retrieve evidence, draft a proposal and wait for your approval."
                      : "Paste the incoming customer request. Helios will retrieve grounded evidence, compose a response and wait for your approval."}
                  </p>
                  <textarea
                    className="run-input-textarea"
                    value={runInquiry}
                    placeholder={selected.outputKind === "proposal"
                      ? "e.g. We need a pump for chemically treated water at 95°C, 7 bar, 70 m³/h…"
                      : "e.g. Can you confirm whether the HX-300 is compatible with 90°C water at 6 bar?"}
                    onChange={(event) => setRunInquiry(event.target.value)}
                  />
                  <button className="primary-button run-input-cta" onClick={begin}>
                    <Sparkles size={15} /> Run workflow
                  </button>
                </div>
              )}
              {selected.state === "Planned" && (
                <div className="planned-panel"><Clock3 size={22} /><div><h3>Planned for the next pilot phase</h3><p>This workflow is visible for roadmap context but is intentionally not active in the prototype.</p></div></div>
              )}

              <div className="pipeline-tabs"><button className="active">Pipeline</button><button>History</button><button>Controls</button></div>
              <div className="pipeline">
                {[
                  ["Trigger", "Query received", MessageSquareText],
                  ["Retrieve", "Find evidence", Search],
                  ["Compose", "Generate draft", PenLine],
                  ["Verify", "Check claims", ShieldCheck],
                  ["Approve", "Human decision", CheckCircle2],
                ].map(([kicker, title, Icon], index) => (
                  <div className="pipeline-node" key={String(title)}>
                    <span className="pipeline-index">0{index + 1}</span>
                    <span className="pipeline-icon"><Icon size={17} /></span>
                    <small>{String(kicker)}</small>
                    <strong>{String(title)}</strong>
                    <p>{index === 4 ? "Required before output" : "Enterprise policy applied"}</p>
                  </div>
                ))}
              </div>
              <div className="workflow-metrics">
                <div><span>Total runs</span><strong>{selected.id === "builtin-inquiry" ? "1,284" : selected.runs === "Custom" ? "0" : "—"}</strong><small>Last 30 days</small></div>
                <div><span>Success rate</span><strong>{selected.id === "builtin-inquiry" ? "97.4%" : "—"}</strong><small>Within target</small></div>
                <div><span>Human approval</span><strong>100%</strong><small>Mandatory control</small></div>
                <div><span>Last executed</span><strong>{selected.id === "builtin-inquiry" ? "8 min" : "—"}</strong><small>By {userName}</small></div>
              </div>
            </>
          ) : (
            <div className="live-run-layout">
              <div className="live-run-header">
                <button className="text-button" onClick={() => { setLiveRun(false); setStatus("idle"); setActiveStep(-1); }}>← Pipeline overview</button>
                <span className={`run-state ${status}`}>
                  <span />
                  {status === "running" ? "Running" : status === "approved" ? "Approved" : status === "declined" ? "Declined" : status === "failed" ? "Failed safely" : "Review required"}
                </span>
              </div>
              <div className="live-run-grid">
                <div className="live-inquiry">
                  <Kicker>Customer request</Kicker>
                  <p>{runInquiry}</p>
                  <div><span>Owner</span><strong>{userName}</strong></div>
                  <div><span>Run ID</span><strong>{workflowId || "Starting…"}</strong></div>
                  <small><ShieldCheck size={13} /> Nothing is sent without approval.</small>
                </div>
                <div className="protocol-panel">
          <div className="protocol-head">
            <div><Kicker>Live protocol</Kicker><h2>{selected.name}</h2></div>
          </div>
          <div className="protocol-steps">
            {(workflowData?.steps ?? workflowSteps.map((step) => ({ ...step, status: "waiting" as const }))).map((step, index) => {
              const complete = step.status === "completed" || step.status === "approved" || index < visibleStep || status === "approved";
              const current = index === visibleStep && !complete;
              return (
                <div className={`protocol-step ${complete ? "complete" : ""} ${current ? "current" : ""}`} key={step.label}>
                  <div className="step-indicator">
                    {complete ? <Check size={14} /> : <span>{String(index + 1).padStart(2, "0")}</span>}
                  </div>
                  <div className="step-copy">
                    <strong>{step.label}</strong>
                    <span>{step.detail}</span>
                    {index === 0 && workflowData?.classification && (step.status === "completed" || step.status === "approved") && (
                      <div className="cls-card">
                        {workflowData.classification.product && (
                          <span className="cls-tag product">{workflowData.classification.product}</span>
                        )}
                        {workflowData.classification.intent && (
                          <span className="cls-tag intent">{workflowData.classification.intent}</span>
                        )}
                        {workflowData.classification.temperature && (
                          <span className="cls-tag">{workflowData.classification.temperature}</span>
                        )}
                        {workflowData.classification.pressure && (
                          <span className="cls-tag">{workflowData.classification.pressure}</span>
                        )}
                        {workflowData.classification.flow && (
                          <span className="cls-tag">{workflowData.classification.flow}</span>
                        )}
                        {workflowData.classification.customer && (
                          <span className="cls-tag customer">{workflowData.classification.customer}</span>
                        )}
                        {(workflowData.classification.missing ?? []).length > 0 && (
                          <div className="cls-missing">
                            {(workflowData.classification.missing ?? []).map((m) => (
                              <span key={m}><CircleAlert size={11} /> {m}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {index === 3 && visibleStep >= 3 && (
                      <div className="claim-check">
                        {(workflowData?.verification ?? []).map((check) => (
                          <div className={check.status === "removed" ? "warning" : ""} key={check.claim}>
                            {check.status === "removed" ? <CircleAlert size={14} /> : <CheckCircle2 size={14} />}
                            <span>{check.claim}</span>
                            <strong>{check.status === "removed" ? "Removed · no source" : "Grounded"}</strong>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {workflowData?.draft && (status === "approval" || status === "revision" || status === "approved" || status === "declined") && (
            <div className="draft-preview-panel">
              <div className="draft-preview-head">
                <Kicker>{workflowData.draft.kind === "proposal" ? "Proposal" : "Subject"}</Kicker>
                <span className="draft-watermark">{status === "approval" ? "EDITABLE · NOT SENT" : "DRAFT · NOT SENT"}</span>
              </div>
              {status === "approval" ? (
                <>
                  <input
                    className="draft-edit-subject"
                    value={editSubject}
                    onChange={(event) => setEditSubject(event.target.value)}
                  />
                  {workflowData.draft.kind === "proposal" && editSections.length > 0
                    ? editSections.map((section, sectionIndex) => (
                        <div key={section.heading} className="draft-preview-section">
                          <strong>{section.heading}</strong>
                          <textarea
                            className="draft-edit-body"
                            value={section.content}
                            onChange={(event) => {
                              const content = event.target.value;
                              setEditSections((current) =>
                                current.map((item, index) => index === sectionIndex ? { ...item, content } : item)
                              );
                            }}
                          />
                        </div>
                      ))
                    : (
                      <textarea
                        className="draft-edit-body"
                        value={editBody}
                        onChange={(event) => setEditBody(event.target.value)}
                      />
                    )}
                  <p className="letter-edit-hint">Edit before you approve. Approve copies the edited text. Nothing is sent.</p>
                </>
              ) : (
                <>
                  <h4 className="draft-preview-subject">{editSubject || workflowData.draft.subject}</h4>
                  <div className="draft-preview-body">
                    {workflowData.draft.kind === "proposal" && (editSections.length ? editSections : workflowData.draft.sections ?? []).length > 0
                      ? (editSections.length ? editSections : workflowData.draft.sections ?? []).map((section) => (
                          <div key={section.heading} className="draft-preview-section">
                            <strong>{section.heading}</strong>
                            {section.content.split(/\n{2,}/).map((p) => (
                              <p key={p}><RichText text={p} /></p>
                            ))}
                          </div>
                        ))
                      : (editBody || workflowData.draft.body).split(/\n{2,}/).map((p) => (
                          <p key={p}><RichText text={p} /></p>
                        ))}
                  </div>
                </>
              )}
              {workflowData.draft.unsupported_claims.length > 0 && (
                <div className="draft-preview-warning">
                  <CircleAlert size={13} /> {workflowData.draft.unsupported_claims[0]}
                </div>
              )}
            </div>
          )}

          {(status === "approval" || status === "revision" || status === "approved" || status === "declined" || status === "failed") && (
            <div className={`approval-dock ${status === "approved" ? "approved" : ""}`}>
              {status === "failed" || status === "declined" ? (
                <>
                  <div><CircleAlert size={22} /><span><strong>{status === "declined" ? "Response declined" : "Workflow failed safely"}</strong><small>{status === "declined" ? "The decision was recorded. Nothing was sent." : workflowError || "No response was generated or sent."}</small></span></div>
                  <button className="secondary-button" onClick={() => { setLiveRun(false); setStatus("idle"); setWorkflowId(""); }}>Return to overview</button>
                </>
              ) : status === "approved" ? (
                <>
                  <div><CheckCircle2 size={22} /><span><strong>Response approved</strong><small>Copied and recorded in activity</small></span></div>
                  <div className="approval-feedback">
                    <span>Rate this workflow run</span>
                    <button
                      className={workflowFeedback === "helpful" ? "saved" : ""}
                      onClick={() => {
                        if (workflowId) void api.feedback(workflowId, "helpful");
                        setWorkflowFeedback("helpful");
                      }}
                      aria-label="Mark workflow run helpful"
                    >
                      <ThumbsUp size={14} />
                    </button>
                    <button
                      className={workflowFeedback === "not_helpful" ? "saved" : ""}
                      onClick={() => {
                        if (workflowId) void api.feedback(workflowId, "not_helpful");
                        setWorkflowFeedback("not_helpful");
                      }}
                      aria-label="Mark workflow run not helpful"
                    >
                      <ThumbsDown size={14} />
                    </button>
                  </div>
                  <button className="secondary-button" onClick={() => { setLiveRun(false); setStatus("idle"); setActiveStep(-1); }}>Return to overview</button>
                </>
              ) : (
                <>
                  <div>
                    <Kicker>Human checkpoint</Kicker>
                    <strong>{status === "revision" ? "Revision requested — re-running." : "The response is ready for review."}</strong>
                    <small>{workflowData?.draft?.unsupported_claims?.length
                      ? `${workflowData.draft.unsupported_claims.length} unsupported claim(s) removed.`
                      : "All claims grounded in approved sources."}</small>
                  </div>
                  <div className="approval-actions">
                    <button className="text-danger" onClick={() => void decide("decline")}>Decline</button>
                    <button className="secondary-button" onClick={() => void decide("revise")}>Revise</button>
                    <button className="primary-button" onClick={() => void decide("approve")}><Check size={15} /> Approve & copy</button>
                  </div>
                </>
              )}
            </div>
          )}
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const delta = Math.max(0, Date.now() - then);
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString([], { dateStyle: "medium" });
}

const BOARD_KINDS: Array<{ id: BoardTicketKind; label: string; hint: string }> = [
  { id: "issue", label: "Issue", hint: "Something is broken or confusing" },
  { id: "idea", label: "Idea", hint: "A creative improvement" },
  { id: "praise", label: "Praise", hint: "Something that works well" },
];

const CAPTURE_FIELDS = [
  ["Model", "HX-300"],
  ["Serial", "HX300-19-08441"],
  ["Revision / year", "2019 · Rev C"],
  ["Seal kit", "FKM — not stamped; inferred"],
  ["Temperature", "95°C"],
  ["Pressure", "7 bar"],
  ["Flow", "70 m³/h"],
];

const CAPTURE_STEPS = [
  "Read nameplate or spec",
  "Look up approved product data",
  "Check seal and duty limits",
  "Open Knowledge, Draft, or Workflow",
];

function CapturePage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  function takeFile(file: File | undefined) {
    if (!file) return;
    if (preview) URL.revokeObjectURL(preview);
    setFileName(file.name);
    setPreview(file.type.startsWith("image/") ? URL.createObjectURL(file) : null);
  }

  function onDrop(event: React.DragEvent) {
    event.preventDefault();
    setDragging(false);
    takeFile(event.dataTransfer.files[0]);
  }

  return (
    <div className="page capture-page">
      <div className="page-title-row">
        <div>
          <Kicker>Capture</Kicker>
          <h1>Photograph the unit. Helios reads the rest.</h1>
          <p className="page-description">Nameplates, customer scans, and handwritten RFQs become structured duty points — then Knowledge, Draft, or Workflow can take over.</p>
        </div>
        <span className="dev-pill"><Lock size={13} /> Under development</span>
      </div>

      <div className="capture-banner">
        <Camera size={16} />
        <p><strong>Vision intake is designed, not connected yet.</strong> You can attach a photo so the interface is ready. Extraction, product lookup, and routing stay locked until a vision model is plugged in.</p>
      </div>

      <div className="capture-grid">
        <section className="capture-drop-card">
          <Kicker>Site evidence</Kicker>
          <h2>Upload a nameplate or spec</h2>
          <input
            ref={inputRef}
            type="file"
            accept="image/*,.pdf"
            hidden
            onChange={(event) => takeFile(event.target.files?.[0])}
          />
          <button
            type="button"
            className={`capture-dropzone ${dragging ? "dragging" : ""} ${preview ? "has-file" : ""}`}
            onClick={() => inputRef.current?.click()}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            {preview ? (
              <img src={preview} alt="Selected site photo" />
            ) : (
              <>
                <Camera size={28} />
                <strong>Drop a photo here, or click to browse</strong>
                <span>Nameplate · customer scan · gauge · competitor datasheet</span>
              </>
            )}
          </button>
          {fileName && <p className="capture-filename">{fileName} · stored locally only, not sent</p>}
          <button className="primary-button" type="button" disabled>
            <Lock size={14} /> Read nameplate
          </button>
        </section>

        <section className="capture-extract-card">
          <div className="capture-extract-lock" aria-hidden="true">
            <Lock size={16} />
            <span>Extraction pending vision model</span>
          </div>
          <Kicker>What Helios will read</Kicker>
          <h2>Structured intake</h2>
          <p>Once connected, the model fills these fields from the photo. Wrong pump and wrong seal usually start here.</p>
          <div className="capture-fields">
            {CAPTURE_FIELDS.map(([label, value]) => (
              <div className="capture-field" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="capture-pipeline">
        {CAPTURE_STEPS.map((step, index) => (
          <div className="capture-pipe-step" key={step}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{step}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

type OnboardTeam = "sales" | "service";

const ONBOARD_PATHS: Record<OnboardTeam, { label: string; hint: string; tiles: Array<{ title: string; detail: string }> }> = {
  sales: {
    label: "Sales",
    hint: "Win the inquiry with grounded product knowledge.",
    tiles: [
      { title: "Getting started", detail: "Workspace, roles, and how Helios sits next to the customer conversation." },
      { title: "Pump families", detail: "HX-240, HX-300, HX-400, HX-520 — when to recommend each." },
      { title: "Reading an RFQ", detail: "Duty point, fluid, and seal constraints from a messy customer brief." },
      { title: "Proposal workflow", detail: "Classify, retrieve, compose, verify — then human approval." },
    ],
  },
  service: {
    label: "Service",
    hint: "Diagnose from site facts, not memory.",
    tiles: [
      { title: "Getting started", detail: "Tickets, installed base, and how Helios supports a field visit." },
      { title: "Failure modes", detail: "Seals, heat, chemicals — what the manuals actually allow." },
      { title: "Site diagnosis", detail: "Nameplates, gauges, and symptoms mapped to approved service lessons." },
      { title: "Ticket workflow", detail: "Ground the reply, flag missing facts, keep the human in the loop." },
    ],
  },
};

function OnboardPage() {
  const [team, setTeam] = useState<OnboardTeam | null>(null);
  const [openTile, setOpenTile] = useState<number | null>(null);
  const path = team ? ONBOARD_PATHS[team] : null;

  return (
    <div className="page onboard-page">
      <div className="page-title-row">
        <div>
          <Kicker>Onboard</Kicker>
          <h1>Bring a new colleague up to speed.</h1>
          <p className="page-description">A short path for Sales or Service — company, products, and how Helios is used on the job.</p>
        </div>
        <span className="dev-pill"><Lock size={13} /> Under development</span>
      </div>

      <div className="capture-banner">
        <GraduationCap size={16} />
        <p><strong>Learning paths are designed, not filled yet.</strong> Pick a team to see the four modules. Content stays locked until the curriculum is connected.</p>
      </div>

      {!team ? (
        <div className="onboard-choice">
          <button type="button" className="onboard-choice-card sales" onClick={() => setTeam("sales")}>
            <PenLine size={22} />
            <Kicker>Sales team</Kicker>
            <h2>Win the inquiry</h2>
            <p>Product positioning, RFQs, and the proposal workflow — four modules.</p>
            <span>Start path <ArrowRight size={14} /></span>
          </button>
          <button type="button" className="onboard-choice-card service" onClick={() => setTeam("service")}>
            <Wrench size={22} />
            <Kicker>Service team</Kicker>
            <h2>Diagnose on site</h2>
            <p>Failure modes, site facts, and the ticket workflow — four modules.</p>
            <span>Start path <ArrowRight size={14} /></span>
          </button>
        </div>
      ) : (
        <>
          <div className="onboard-path-head">
            <button type="button" className="text-button" onClick={() => { setTeam(null); setOpenTile(null); }}>
              ← All teams
            </button>
            <div>
              <Kicker>{path?.label} path</Kicker>
              <h2>{path?.hint}</h2>
            </div>
          </div>
          <div className="onboard-tiles">
            {path?.tiles.map((tile, index) => (
              <button
                key={tile.title}
                type="button"
                className={`onboard-tile ${openTile === index ? "active" : ""}`}
                onClick={() => setOpenTile(index)}
              >
                <span className="onboard-tile-index">{String(index + 1).padStart(2, "0")}</span>
                <strong>{tile.title}</strong>
                <p>{tile.detail}</p>
                <small><Lock size={12} /> Module locked</small>
              </button>
            ))}
          </div>
          {openTile != null && path && (
            <div className="onboard-locked-note">
              <Lock size={15} />
              <p><strong>{path.tiles[openTile].title}</strong> is mapped. Lessons, quizzes, and completion tracking will plug in here.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FeedbackPage() {
  const [tickets, setTickets] = useState<BoardTicket[]>([]);
  const [kind, setKind] = useState<BoardTicketKind>("issue");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitOk, setSubmitOk] = useState(false);

  useEffect(() => {
    void api.listBoardTickets().then(setTickets).catch(() => setTickets([]));
  }, []);

  async function submitTicket() {
    setSubmitError(null);
    setSubmitOk(false);
    if (name.trim().length < 2) {
      setSubmitError("Please add your name so the team knows who to thank.");
      return;
    }
    if (title.trim().length < 4) {
      setSubmitError("Give the ticket a short title.");
      return;
    }
    if (description.trim().length < 8) {
      setSubmitError("Describe the issue, idea, or praise.");
      return;
    }
    setSubmitting(true);
    try {
      const created = await api.createBoardTicket({
        kind,
        title: title.trim(),
        description: description.trim(),
        name: name.trim(),
        email: email.trim() || null,
      });
      setTickets((current) => [created, ...current]);
      setTitle("");
      setDescription("");
      setSubmitOk(true);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Could not submit the ticket.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page feedback-page">
      <div className="page-title-row">
        <div>
          <Kicker>Feedback</Kicker>
          <h1>How is Helios performing?</h1>
          <p className="page-description">Report an issue, share an idea, or leave praise. Anyone can post — tickets are visible to everyone.</p>
        </div>
      </div>
      <div className="feedback-board">
        <form
          className="feedback-compose"
          onSubmit={(event) => {
            event.preventDefault();
            void submitTicket();
          }}
        >
          <div className="feedback-compose-head">
            <Kicker>Share with the team</Kicker>
            <h2>Open a ticket</h2>
            <p>Pick a type, add your name, and describe what you found.</p>
          </div>
          <div className="feedback-kind-row" role="radiogroup" aria-label="Ticket type">
            {BOARD_KINDS.map((option) => (
              <button
                key={option.id}
                type="button"
                className={`feedback-kind ${option.id} ${kind === option.id ? "active" : ""}`}
                onClick={() => setKind(option.id)}
                aria-pressed={kind === option.id}
              >
                {option.id === "issue" && <CircleAlert size={15} />}
                {option.id === "idea" && <Lightbulb size={15} />}
                {option.id === "praise" && <Sparkles size={15} />}
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.hint}</small>
                </span>
              </button>
            ))}
          </div>
          <div className="feedback-fields">
            <label>
              Your name
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Lena Meyer" maxLength={80} required />
            </label>
            <label>
              Email <em>optional</em>
              <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="lena@hydrax.com" maxLength={120} />
            </label>
            <label className="feedback-full">
              Title
              <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Short summary of the ticket" maxLength={120} required />
            </label>
            <label className="feedback-full">
              Description
              <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What happened, what you would change, or what you liked." maxLength={2000} rows={4} required />
            </label>
          </div>
          <div className="feedback-compose-foot">
            {submitError && <p className="feedback-form-error">{submitError}</p>}
            {submitOk && !submitError && <p className="feedback-form-ok">Posted. The team can see it below.</p>}
            <button className="primary-button" type="submit" disabled={submitting}>
              <Send size={14} /> {submitting ? "Posting…" : "Post ticket"}
            </button>
          </div>
        </form>
        <div className="feedback-list">
          <div className="feedback-list-head">
            <Kicker>Open board</Kicker>
            <span>{tickets.length} ticket{tickets.length === 1 ? "" : "s"}</span>
          </div>
          {tickets.map((ticket) => (
            <article key={ticket.id} className={`feedback-ticket ${ticket.kind}`}>
              <div className={`feedback-badge ${ticket.kind}`}>
                {ticket.kind === "issue" && <CircleAlert size={13} />}
                {ticket.kind === "idea" && <Lightbulb size={13} />}
                {ticket.kind === "praise" && <Sparkles size={13} />}
                {ticket.kind}
              </div>
              <div className="feedback-ticket-body">
                <h3>{ticket.title}</h3>
                <p>{ticket.description}</p>
                <div className="feedback-ticket-meta">
                  <strong>{ticket.name}</strong>
                  {ticket.email && <span>{ticket.email}</span>}
                  <span>{timeAgo(ticket.created_at)}</span>
                  <span>{ticket.id}</span>
                </div>
              </div>
            </article>
          ))}
          {tickets.length === 0 && (
            <div className="library-empty">
              <MessageSquareText size={20} />
              <span><strong>No tickets yet</strong>Be the first to report an issue, share an idea, or leave praise.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function LibraryPage({ navigate: _navigate }: { navigate: Navigate }) {
  const [tab, setTab] = useState<"Recent" | "Saved">("Recent");
  const [selectedItem, setSelectedItem] = useState<ActivityRecord | null>(null);
  const [items, setItems] = useState<ActivityRecord[]>([]);

  useEffect(() => {
    void api.activity().then(setItems).catch(() => setItems([]));
  }, []);

  const visibleItems = items.filter((item) => tab === "Recent" || item.status === "Saved");
  return (
    <div className="page library-page">
      <div className="page-title-row">
        <div><Kicker>Library</Kicker><h1>Your working memory.</h1><p className="page-description">Return to answers, drafts and completed protocols.</p></div>
        <button className="secondary-button"><Search size={15} /> Search library</button>
      </div>
      <div className="library-toolbar">
        <div className="tabs">
          {(["Recent", "Saved"] as const).map((item) => (
            <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}</button>
          ))}
        </div>
        <button className="filter-button">All activity <ChevronDown size={14} /></button>
      </div>
      <div className="library-table">
        <div className="library-head"><span>Item</span><span>Workspace</span><span>Status</span><span>Last updated</span><span /></div>
        {visibleItems.map((item, index) => (
          <button className="library-row" key={item.id} onClick={() => setSelectedItem(item)}>
            <span className="library-title"><span className="document-index">{String(index + 1).padStart(2, "0")}</span><strong>{item.title}</strong></span>
            <span>{item.type}</span>
            <span className={`table-status ${item.status.toLowerCase().replaceAll(" ", "-")}`}><i />{item.status}</span>
            <span>{new Date(item.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span>
            <ArrowRight size={15} />
          </button>
        ))}
        {visibleItems.length === 0 && (
          <div className="library-empty">
            <Clock3 size={20} />
            <span><strong>No interactions yet</strong>Ask a knowledge question or create a draft to begin your activity record.</span>
          </div>
        )}
      </div>
      {selectedItem && (
        <>
          <button className="drawer-scrim" aria-label="Close details" onClick={() => setSelectedItem(null)} />
          <aside className="activity-drawer">
            <div className="drawer-head"><div><Kicker>Interaction record</Kicker><h2>{selectedItem.title}</h2></div><button className="icon-button" onClick={() => setSelectedItem(null)}><X size={17} /></button></div>
            <div className="drawer-status"><CheckCircle2 size={17} /><span><strong>{selectedItem.status}</strong><small>{selectedItem.id}</small></span></div>
            <section>
              <Kicker>Overview</Kicker>
              <div className="telemetry-row"><span>Route</span><strong>{selectedItem.type}</strong></div>
              <div className="telemetry-row"><span>Recorded at</span><strong>{new Date(selectedItem.created_at).toLocaleString()}</strong></div>
            </section>
            <section><Kicker>Redacted prompt preview</Kicker><p>“{selectedItem.prompt_preview}”</p><small>Direct identifiers are redacted before telemetry is stored.</small></section>
            {selectedItem.output_preview && (
              <section>
                <Kicker>AI output preview</Kicker>
                <div className="output-preview-box">
                  <p>{selectedItem.output_preview}</p>
                </div>
                <small>First ~280 characters of the generated response, identifiers redacted.</small>
              </section>
            )}
            <section><Kicker>Retrieval</Kicker><div className="telemetry-row"><span>Sources</span><strong>{selectedItem.source_ids.join(", ") || "None"}</strong></div><div className="telemetry-row"><span>Groundedness</span><strong className={selectedItem.grounded ? "positive" : ""}>{selectedItem.grounded == null ? "Pending" : selectedItem.grounded ? "Passed" : "Insufficient evidence"}</strong></div></section>
            <section><Kicker>Operational telemetry</Kicker><div className="telemetry-row"><span>Prompt version</span><strong>{selectedItem.prompt_version}</strong></div><div className="telemetry-row"><span>Model route</span><strong>{selectedItem.model}</strong></div><div className="telemetry-row"><span>Latency</span><strong>{selectedItem.latency_ms == null ? "Pending" : `${selectedItem.latency_ms} ms`}</strong></div><div className="telemetry-row"><span>User feedback</span><strong>{selectedItem.feedback ?? "Not provided"}</strong></div><div className="telemetry-row"><span>Error</span><strong>{selectedItem.error ?? "None"}</strong></div></section>
            <div className="drawer-privacy"><ShieldCheck size={16} /><p><strong>Privacy-safe logging</strong>Raw customer content, email addresses and personal identifiers are excluded.</p></div>
          </aside>
        </>
      )}
    </div>
  );
}

function AtelierPage() {
  const knowledge = [
    ["HX Product Catalogue", "14 documents", "Updated today", "Ready"],
    ["Technical Service Manuals", "38 documents", "Updated 2 days ago", "Ready"],
    ["Warranty & SLA Policies", "6 documents", "Updated 12 days ago", "Ready"],
    ["Approved Proposal Library", "22 documents", "Updated 21 days ago", "Review"],
  ];
  return (
    <div className="page atelier-page">
      <div className="page-title-row">
        <div><Kicker>Atelier</Kicker><h1>Knowledge, governed.</h1><p className="page-description">A clear view of quality, sources and operational control.</p></div>
        <button className="primary-button"><Plus size={15} /> Add source</button>
      </div>
      <div className="metric-grid">
        <div className="metric-card"><span>Questions this month</span><strong>1,284</strong><small>↑ 18% from August</small></div>
        <div className="metric-card highlight"><span>Grounded response rate</span><strong>94.2%</strong><small>Target · 92%</small></div>
        <div className="metric-card"><span>Human approvals</span><strong>86</strong><small>2 awaiting review</small></div>
        <div className="metric-card"><span>Median response time</span><strong>2.4s</strong><small>Within service target</small></div>
      </div>
      <div className="atelier-grid">
        <section className="source-library">
          <div className="section-heading">
            <div><Kicker>Knowledge sources</Kicker><h2>Approved collections</h2></div>
            <button className="text-button">Manage all <ArrowRight size={14} /></button>
          </div>
          {knowledge.map(([name, count, updated, state], index) => (
            <div className="collection-row" key={name}>
              <span className="collection-icon"><FileText size={18} /></span>
              <div><strong>{name}</strong><span>{count}</span></div>
              <span>{updated}</span>
              <span className={`table-status ${state.toLowerCase()}`}><i />{state}</span>
              <button className="icon-button"><MoreHorizontal size={17} /></button>
            </div>
          ))}
        </section>
        <section className="governance-card">
          <Kicker>Control posture</Kicker>
          <h2>Protected by design.</h2>
          <p>Your workspace follows the approved enterprise AI policy.</p>
          {[
            ["Source-level access control", "Active"],
            ["Sensitive data redaction", "Active"],
            ["Customer-send restriction", "Active"],
            ["EU data residency", "Frankfurt"],
          ].map(([label, state]) => (
            <div className="control-row" key={label}><span><CheckCircle2 size={15} />{label}</span><strong>{state}</strong></div>
          ))}
          <button className="secondary-button wide">View governance policy</button>
        </section>
      </div>
    </div>
  );
}

// ── Admin page ──────────────────────────────────────────────────────────────
const ALL_FEATURES = ["knowledge", "draft", "workflow", "capture", "library", "feedback", "onboard"] as const;

function AdminPage() {
  const [users, setUsers] = useState<import("./api").AuthUser[]>([]);
  const [saving, setSaving] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityRecord[]>([]);

  useEffect(() => {
    void api.adminUsers().then(setUsers).catch((e: unknown) => console.error("adminUsers:", e));
    void api.activity().then(setActivity).catch(() => {});
  }, []);

  async function togglePermission(userId: string, feature: string, current: string[]) {
    setSaving(userId);
    const next = current.includes(feature)
      ? current.filter((p) => p !== feature)
      : [...current, feature];
    try {
      const updated = await api.adminUpdatePermissions(userId, next);
      setUsers((prev) => prev.map((u) => u.id === userId ? updated : u));
    } finally {
      setSaving(null);
    }
  }

  const grounded = activity.filter((a) => a.grounded === true).length;
  const groundedRate = activity.length ? Math.round((grounded / activity.length) * 100) : 0;
  const avgLatency = activity.filter((a) => a.latency_ms).length
    ? Math.round(activity.filter((a) => a.latency_ms).reduce((s, a) => s + (a.latency_ms ?? 0), 0) / activity.filter((a) => a.latency_ms).length)
    : 0;

  return (
    <div className="page admin-page">
      <div className="page-title-row">
        <div>
          <Kicker>Admin</Kicker>
          <h1>Workspace control.</h1>
          <p className="page-description">Manage users and feature access. Admins always retain full access.</p>
        </div>
      </div>

      <div className="admin-kpis">
        <div className="admin-kpi"><span>Total interactions</span><strong>{activity.length}</strong></div>
        <div className="admin-kpi"><span>Grounded rate</span><strong>{groundedRate}%</strong></div>
        <div className="admin-kpi"><span>Avg latency</span><strong>{avgLatency} ms</strong></div>
        <div className="admin-kpi"><span>Registered users</span><strong>{users.length}</strong></div>
      </div>

      <section className="admin-users-section">
        <Kicker>Users</Kicker>
        <h2>Access management</h2>
        <div className="admin-users-table">
          <div className="admin-user-head">
            <span>User</span>
            {ALL_FEATURES.map((f) => (
              <span key={f} className="admin-feature-col">{f.charAt(0).toUpperCase() + f.slice(1)}</span>
            ))}
          </div>
          {users.map((user) => (
            <div key={user.id} className={`admin-user-row ${user.role === "admin" ? "admin-row" : ""}`}>
              <div className="admin-user-info">
                <div className="avatar admin-avatar">{user.name.split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 2)}</div>
                <div>
                  <strong>{user.name}</strong>
                  <small>{user.email}</small>
                  {user.role === "admin" && <span className="admin-badge">Admin</span>}
                </div>
              </div>
              {ALL_FEATURES.map((f) => {
                const allowed = user.role === "admin" || user.permissions.includes(f);
                return (
                  <button
                    key={f}
                    className={`admin-toggle ${allowed ? "on" : "off"}`}
                    disabled={user.role === "admin" || saving === user.id}
                    onClick={() => void togglePermission(user.id, f, user.permissions)}
                    title={user.role === "admin" ? "Admin always has access" : allowed ? "Click to revoke" : "Click to grant"}
                  >
                    {allowed ? <Check size={13} /> : <X size={13} />}
                  </button>
                );
              })}
            </div>
          ))}
          {users.length === 0 && (
            <div className="library-empty">
              <span><strong>No users yet</strong>Users will appear here after they register.</span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

// ── Login / Register pages ───────────────────────────────────────────────────
function AuthPage() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (mode === "login") {
        await login(email.trim(), password);
      } else {
        await register(name.trim(), email.trim(), password);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <BrandMark />
          <div>
            <strong>HELIOS</strong>
            <span>Sales &amp; Service Copilot</span>
          </div>
        </div>
        <h1 className="auth-heading">
          {mode === "login" ? "Welcome back." : "Create your account."}
        </h1>
        <p className="auth-sub">
          {mode === "login"
            ? "Sign in to your Helios workspace."
            : "Set up your workspace in seconds."}
        </p>
        <form className="auth-form" onSubmit={(e) => void submit(e)}>
          {mode === "register" && (
            <label>
              Full name
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Lena Meyer" required />
            </label>
          )}
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required autoFocus={mode === "login"} />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Your password" required />
          </label>
          {error && <p className="auth-error">{error}</p>}
          <button className="primary-button auth-submit" type="submit" disabled={loading}>
            {loading ? (mode === "login" ? "Signing in…" : "Creating account…") : (mode === "login" ? "Sign in" : "Create account")}
          </button>
        </form>
        <p className="auth-switch">
          {mode === "login" ? "New here?" : "Already have an account?"}
          {" "}
          <button type="button" className="text-button" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(null); }}>
            {mode === "login" ? "Create an account" : "Sign in"}
          </button>
        </p>
        <p className="auth-note">Enterprise protected · EU data boundary</p>
      </div>
    </div>
  );
}

// ── Root App ─────────────────────────────────────────────────────────────────
export default function App() {
  const { user, loading: authLoading, logout, hasPermission } = useAuth();
  const [page, setPage] = useState<Page>("Home");
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [launch, setLaunch] = useState<{ text: string; autoRun: boolean; autoGenerate: boolean } | null>(null);
  // Home chat state lifted here so it survives page navigation
  const [homeMessages, setHomeMessages] = useState<HomeMessage[]>([]);
  const [homeHistory, setHomeHistory] = useState<Array<{ role: string; content: string }>>([]);

  const navigate: Navigate = useCallback((next, options) => {
    const text = options?.prompt?.trim() ?? "";
    setLaunch(text ? { text, autoRun: Boolean(options?.autoRun), autoGenerate: Boolean(options?.autoGenerate) } : null);
    setPage(next);
  }, []);

  // If user loses access to current page, redirect home
  useEffect(() => {
    const featureKey = page.toLowerCase();
    if (user && !hasPermission(featureKey) && !["home", "admin", "atelier", "library"].includes(featureKey)) {
      setPage("Home");
    }
  }, [user, page, hasPermission]);

  const firstName = user?.name.split(" ")[0] ?? "there";

  const content = useMemo(() => {
    const prompt = launch?.text ?? "";
    const autoRun = launch?.autoRun ?? false;
    switch (page) {
      case "Home": return <HomePage navigate={navigate} messages={homeMessages} setMessages={setHomeMessages} history={homeHistory} setHistory={setHomeHistory} firstName={firstName} />;
      case "Knowledge": return <KnowledgePage navigate={navigate} initialPrompt={prompt} autoAsk={autoRun} />;
      case "Draft": return <DraftPage navigate={navigate} initialPrompt={prompt} autoGenerate={launch?.autoGenerate ?? false} />;
      case "Workflows": return <WorkflowsPage initialPrompt={prompt} autoRun={launch?.autoGenerate ?? false} userName={user?.name ?? "User"} />;
      case "Capture": return <CapturePage />;
      case "Library": return <LibraryPage navigate={navigate} />;
      case "Onboard": return <OnboardPage />;
      case "Feedback": return <FeedbackPage />;
      case "Admin": return <AdminPage />;
      case "Atelier": return <AtelierPage />;
    }
  }, [page, launch, navigate, homeMessages, homeHistory, firstName, user]);

  if (authLoading) {
    return <div className="auth-splash"><div className="auth-splash-inner"><BrandMark /><span>Helios</span></div></div>;
  }

  if (!user) {
    return <AuthPage />;
  }

  return (
    <div className={`app-shell ${collapsed ? "rail-collapsed" : ""}`}>
      <Sidebar
        active={page}
        collapsed={collapsed}
        mobileOpen={mobileOpen}
        onNavigate={navigate}
        onClose={() => setMobileOpen(false)}
        isAdmin={user.role === "admin"}
        hasPermission={hasPermission}
      />
      <div className="app-main">
        <TopBar
          page={page}
          onOpenMenu={() => setMobileOpen(true)}
          onToggleRail={() => setCollapsed((value) => !value)}
          onLogout={logout}
          userName={user.name}
          userRole={user.role}
        />
        <div className="page-frame">{content}</div>
      </div>
    </div>
  );
}
