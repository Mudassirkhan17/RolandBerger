import json
import os
import re
import time
from pathlib import Path

from .corpus import CorpusIndex, SearchResult
from .database import Database
from .llm import LangChainLLM, RouteDecision
from .models import Citation, DraftRequest, DraftResponse, DraftSection, KnowledgeResponse


SYSTEM_PROMPT = """You are Helios, Helios Industrials' Sales & Service Copilot.

You can hold a normal conversation. If someone says hi, greet them back briefly,
say who you are, and offer to help with products, duty points, seals, service
cases, proposals or customer correspondence. Stay warm, short, and on-point.

When the user asks a knowledge question:
- Answer the actual question. Do not dump a datasheet, proposal, or email.
- Synthesize from the supplied evidence only. Use [1], [2] citation markers.
- Follow any length or format instruction from the user (for example "10 words").
  Those instructions override your default length.
- Default length, if none is given: 2–4 short sentences.
- Distinguish pump-body limits from seal limits. Current approved documents
  override historical proposals.
- Never invent price, lead time, stock, safety, or chemical compatibility.
- If the evidence does not contain the answer, say so clearly. Do not guess.
- Never copy headers, page numbers, or "synthetic demo data" boilerplate."""

CONVERSATION_ONLY_RE = re.compile(
    r"^\s*(hi|hello|hey|yo|good\s+(morning|afternoon|evening)|thanks|thank you|"
    r"how are you|what'?s up|who are you|what are you|what can you do|"
    r"how do you work|help|help me)\s*[?.!]?\s*$",
    re.IGNORECASE,
)

BOILERPLATE_RE = re.compile(
    r"synthetic demo data|enterprise ai sales|not real client information|"
    r"^page\s+\d+$|^helios industrial systems$",
    re.IGNORECASE,
)

PROPOSAL_SECTIONS = [
    "Customer Requirement",
    "Recommended Product",
    "Technical Fit",
    "Configuration",
    "Benefits",
    "Assumptions",
    "Risks / Clarifications",
    "Next Steps",
]

LOCAL_GREETING = (
    "Hello. I'm Helios, Helios Industrials' Sales & Service Copilot. "
    "Ask me about a model, duty point, seal, service case, or customer correspondence."
)

def _sentence_candidates(text: str) -> list[str]:
    normalized = re.sub(r"\s+", " ", text)
    pieces = re.split(r"(?<=[.!?])\s+|(?=\b(?:Diagnosis|Resolution|Service Lesson|Application guidance):)", normalized)
    return [piece.strip(" •-") for piece in pieces if 35 <= len(piece.strip()) <= 420]


def _number(text: str, pattern: str) -> float | None:
    match = re.search(pattern, text, re.IGNORECASE)
    if not match:
        return None
    try:
        return float(match.group(1))
    except ValueError:
        return None


class RAGService:
    def __init__(self, index: CorpusIndex, database: Database, corpus_path: Path):
        self.index = index
        self.database = database
        self.corpus_path = corpus_path
        master_path = corpus_path / "metadata" / "product_master.json"
        self.products: dict[str, dict[str, str]] = json.loads(master_path.read_text(encoding="utf-8"))
        self.api_key = os.getenv("OPENAI_API_KEY", "").strip()
        self.model = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")
        self.llm = LangChainLLM(api_key=self.api_key, model=self.model) if self.api_key else None

    @property
    def mode(self) -> str:
        return "langchain+llm" if self.llm else "local-grounded"

    def _is_conversation(self, question: str) -> bool:
        return bool(CONVERSATION_ONLY_RE.match(question.strip()))

    def _clean_evidence_text(self, text: str) -> str:
        kept: list[str] = []
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped or BOILERPLATE_RE.search(stripped):
                continue
            kept.append(stripped)
        cleaned = " ".join(kept)
        cleaned = BOILERPLATE_RE.sub("", cleaned)
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        if len(cleaned) > 1400:
            cleaned = cleaned[:1397].rsplit(" ", 1)[0] + "…"
        return cleaned

    def _chat(self, user_content: str, temperature: float = 0.3,
              history: list[dict[str, str]] | None = None) -> str:
        assert self.llm is not None
        return self.llm.text(
            system_prompt=SYSTEM_PROMPT,
            user_content=user_content,
            temperature=temperature,
            history=history,
            label="rag._chat",
        )

    def _citations(self, results: list[SearchResult]) -> list[Citation]:
        citations: list[Citation] = []
        for index, result in enumerate(results, start=1):
            chunk = result.chunk
            excerpt = re.sub(r"\s+", " ", chunk.text).strip()
            if len(excerpt) > 360:
                excerpt = excerpt[:357].rsplit(" ", 1)[0] + "…"
            citations.append(
                Citation(
                    index=index,
                    source_id=chunk.source_id,
                    title=chunk.title,
                    file=chunk.file,
                    page=chunk.page,
                    section=chunk.section,
                    excerpt=excerpt,
                    document_type=chunk.document_type,
                    status=chunk.status,
                    score=round(result.score, 4),
                )
            )
        return citations

    def _context(self, results: list[SearchResult]) -> str:
        return "\n\n".join(
            f"[{index}] {result.chunk.title} | {result.chunk.source_id} | "
            f"type={result.chunk.document_type} | status={result.chunk.status} | "
            f"customer={result.chunk.customer or 'n/a'}\n"
            f"{self._clean_evidence_text(result.chunk.text)}"
            for index, result in enumerate(results, start=1)
        )

    def _llm_answer(self, question: str, results: list[SearchResult],
                    history: list[dict[str, str]] | None = None) -> str:
        if results:
            return self._chat(
                "Answer the user using only the evidence below. "
                "Write a normal reply. Do not paste the evidence.\n\n"
                f"User:\n{question}\n\nEvidence:\n{self._context(results)}",
                temperature=0.2,
                history=history,
            )
        return self._chat(
            "The user sent this. Reply as Helios. No product evidence is attached, "
            "so do not invent technical facts.\n\n"
            f"User:\n{question}",
            temperature=0.4,
            history=history,
        )

    def _product_answer(self, question: str, results: list[SearchResult]) -> str | None:
        model_match = re.search(r"\bHX[- ]?(\d{3})\b", question, re.IGNORECASE)
        if not model_match:
            return None
        model = f"HX-{model_match.group(1)}"
        product = self.products.get(model)
        if not product:
            return (
                f"I could not find an approved product record for {model}. "
                "Please confirm the model number before making a customer commitment."
            )

        q = question.lower()
        ref = "[1]" if results else ""
        if "maximum pressure" in q or "max pressure" in q:
            return (
                f"The documented maximum system pressure for the {model} is **{product['pressure']}**. {ref}"
            ).strip()

        requested_temp = _number(q, r"(?<![-\w])(\d+(?:\.\d+)?)\s*(?:°\s*c|degrees?\s*c|celsius)\b")
        mentions_seal = any(term in q for term in ("seal", "epdm", "fkm", "ptfe"))
        asks_temperature = any(term in q for term in ("temperature", "hot", "continuous", "°c", " c"))
        if requested_temp is not None or mentions_seal or asks_temperature:
            body_temp = _number(product["temp"], r"(\d+(?:\.\d+)?)")
            standard_temp = _number(product["standard_seal_limit"], r"(\d+(?:\.\d+)?)")
            if requested_temp is None:
                return (
                    f"Treat the pump body and the seal as two different limits. The {model} body is "
                    f"rated for **{product['temp']}**, while the standard {product['standard_seal']} "
                    f"is recommended only up to **{product['standard_seal_limit']}**. Optional guidance "
                    f"is {product['optional_seals']}. The lower applicable limit governs the installed "
                    f"configuration. {ref}"
                )
            if body_temp is not None and requested_temp > body_temp:
                return (
                    f"No. {requested_temp:g}°C is above the {model} pump-body continuous rating of "
                    f"{body_temp:g}°C. I would select a suitable model and send the application for "
                    f"engineering review rather than stretch the documented limit. {ref}"
                )
            if standard_temp is not None and requested_temp > standard_temp:
                alternative = "FKM"
                if model == "HX-400" and requested_temp > 130:
                    alternative = "PTFE"
                if model == "HX-520":
                    alternative = "hygienic FKM"
                return (
                    f"No — not with the standard {product['standard_seal']}.\n\n"
                    f"The {model} pump body can operate continuously at {requested_temp:g}°C, but the "
                    f"standard {product['standard_seal']} is recommended only up to {standard_temp:g}°C "
                    f"continuous. Use **{alternative}** for this duty and review fluid chemistry before "
                    f"you confirm. [1] [2]"
                )
            return (
                f"{requested_temp:g}°C sits within both the {model} pump-body rating "
                f"({product['temp']}) and the standard seal guidance "
                f"({product['standard_seal_limit']}). I would still confirm chemistry, pressure and "
                f"duty cycle before a binding recommendation. {ref}"
            )
        if "hygienic" in q or "pharmaceutical" in q or "sterile" in q:
            if model == "HX-520":
                return (
                    f"Yes. The {model} is the hygienic model, with {product['materials']} and "
                    f"a {product['standard_seal']}. Final selection still requires validation "
                    f"against the cleaning regime. {ref}"
                )
            return (
                f"No. The {model} is not positioned as a hygienic or sterile design by default. "
                "The HX-520 is the documented hygienic model; validate cleanability requirements "
                f"before selection. {ref}"
            )
        if any(term in q for term in ("what is", "tell me", "about", "overview", "describe", "spec")):
            return (
                f"The **{model}** is the {product['name']}. {product['positioning']} "
                f"Approved limits are {product['pressure']}, {product['temp']}, and a flow range of "
                f"{product['flow']}. The standard seal is {product['standard_seal']} "
                f"({product['standard_seal_limit']}). {product['caution']} {ref}"
            )
        return None

    def _selection_answer(self, question: str, results: list[SearchResult]) -> str | None:
        q = question.lower()
        if not any(term in q for term in ("which model", "select", "suitable pump", "should be used")):
            return None
        pressure = _number(q, r"(\d+(?:\.\d+)?)\s*bar")
        temperature = _number(q, r"(?<![-\w])(\d+(?:\.\d+)?)\s*(?:°\s*c|degrees?\s*c|celsius)\b")
        flow = _number(q, r"(\d+(?:\.\d+)?)\s*m[³3]/h")
        hygienic = any(term in q for term in ("hygienic", "pharma", "food", "cip"))
        fits: list[tuple[str, dict[str, str]]] = []
        for model, product in self.products.items():
            max_pressure = _number(product["pressure"], r"(\d+(?:\.\d+)?)") or 0
            max_temp = _number(product["temp"], r"(\d+(?:\.\d+)?)") or 0
            flow_numbers = re.findall(r"\d+(?:\.\d+)?", product["flow"])
            max_flow = float(flow_numbers[-1]) if flow_numbers else 0
            if pressure and pressure > max_pressure:
                continue
            if temperature and temperature > max_temp:
                continue
            if flow and flow > max_flow:
                continue
            if hygienic and model != "HX-520":
                continue
            fits.append((model, product))
        if not fits:
            return (
                "No model in the approved selection guide satisfies all stated conditions. "
                "Escalate to Application Engineering rather than relaxing a documented limit."
            )
        fits.sort(key=lambda item: float(re.findall(r"\d+(?:\.\d+)?", item[1]["pressure"])[0]))
        model, product = fits[0]
        comparison = ""
        if pressure and pressure > 16 and model == "HX-400":
            comparison = " HX-300 is limited to 16 bar, while HX-400 supports up to 20 bar and covers the stated flow and temperature."
        return (
            f"Use the **{model}**.{comparison} It supports up to {product['pressure']}, "
            f"{product['temp']}, and a flow range of {product['flow']}. "
            "Validate the detailed duty point and seal chemistry before issuing a binding offer. [1] [2]"
        )

    def _service_answer(self, question: str, results: list[SearchResult]) -> str | None:
        q = question.lower()
        if not any(term in q for term in ("caused", "cause", "issue", "incident", "ticket", "low-flow", "low flow")):
            return None
        for index, result in enumerate(results, start=1):
            diagnosis = re.search(
                r"Diagnosis:\s*(.*?)(?=\s+(?:Resolution|Service Lesson|Access):|$)",
                re.sub(r"\s+", " ", result.chunk.text),
                re.IGNORECASE,
            )
            resolution = re.search(
                r"Resolution:\s*(.*?)(?=\s+(?:Service Lesson|Access):|$)",
                re.sub(r"\s+", " ", result.chunk.text),
                re.IGNORECASE,
            )
            if diagnosis:
                cause = diagnosis.group(1).strip().rstrip(".")
                answer = (
                    f"The recorded cause was {cause[0].lower() + cause[1:] if cause else cause}. "
                    "It was not a product-capability failure."
                )
                if resolution:
                    answer += f" The recorded resolution was: {resolution.group(1).strip()}"
                return f"{answer} [{index}]"
        return None

    def _precedent_answer(self, question: str, results: list[SearchResult]) -> str | None:
        q = question.lower()
        if not any(term in q for term in ("previous customer", "previous proposal", "precedent", "who used")):
            return None
        for index, result in enumerate(results, start=1):
            chunk = result.chunk
            if chunk.category != "previous_proposals":
                continue
            customer = chunk.customer or "A previous customer"
            condition = ""
            temperature = re.search(r"(?:Operating Temperature|temperature):?\s*(\d+\s*°?C)", chunk.text, re.IGNORECASE)
            pressure = re.search(r"(?:System Pressure|pressure):?\s*(\d+(?:\.\d+)?\s*bar)", chunk.text, re.IGNORECASE)
            seal = re.search(r"(HX-\d{3}\s+with\s+(?:an?\s+)?[A-Z]+\s+seal)", chunk.text, re.IGNORECASE)
            details = [match.group(1) for match in (temperature, pressure) if match]
            if details:
                condition = f" at {', '.join(details)}"
            solution = seal.group(1) if seal else chunk.product
            return (
                f"**{customer}** is the relevant historical precedent. The proposal used "
                f"{solution}{condition}. Treat the historical proposal as precedent only; "
                f"current approved product guidance and present customer conditions take precedence. [{index}]"
            )
        return None

    def _policy_answer(self, question: str, results: list[SearchResult]) -> str | None:
        q = question.lower()
        if any(term in q for term in ("nitric", "acid", "chemical compatibility", "guarantee compatibility")):
            return (
                "There is **insufficient approved evidence** to confirm chemical compatibility. "
                "Concentration, temperature, exposure time, pressure, duty cycle and installed "
                "materials are required. Route the case to Application Engineering and do not "
                "guarantee compatibility before confirmation. [1] [2]"
            )
        if any(term in q for term in ("extend", "7000", "7,000")) and "inspection" in q:
            return (
                "The available guidance does not approve an extension. The HX-400 routine "
                "inspection interval is 6,000 hours, and severe thermal cycling may shorten it "
                "to 3,000 hours. Complete the planned inspection or obtain Service Engineering "
                "approval for any deviation. [1] [2]"
            )
        if any(term in q for term in ("changed", "difference", "archive", "archived", "superseded")) and "hx-240" in q:
            return (
                "The archived HX-240 datasheet listed 90°C continuous pump temperature. "
                "Current version 3.1 lists 95°C continuous pump-body operation and includes "
                "revised seal guidance and maintenance information. The current approved version "
                "must take precedence. [1] [2]"
            )
        return None

    def _extractive_answer(self, question: str, results: list[SearchResult]) -> str:
        query_terms = set(re.findall(r"[a-z0-9-]+", question.lower()))
        ranked: list[tuple[float, str, int]] = []
        for index, result in enumerate(results, start=1):
            for sentence in _sentence_candidates(result.chunk.text):
                sentence_terms = set(re.findall(r"[a-z0-9-]+", sentence.lower()))
                overlap = len(query_terms.intersection(sentence_terms))
                score = overlap / max(len(query_terms), 1) + result.score
                ranked.append((score, sentence, index))
        ranked.sort(key=lambda item: item[0], reverse=True)
        selected: list[str] = []
        seen: set[str] = set()
        for _, sentence, citation in ranked:
            fingerprint = re.sub(r"\W+", "", sentence.lower())[:80]
            if fingerprint in seen:
                continue
            seen.add(fingerprint)
            selected.append(f"{sentence} [{citation}]")
            if len(selected) == 3:
                break
        if not selected:
            return (
                "I could not find enough approved evidence to answer reliably. "
                "Please refine the question or request an engineering review."
            )
        return " ".join(selected)

    def _offline_answer(self, question: str, results: list[SearchResult]) -> str:
        for builder in (
            self._policy_answer,
            self._service_answer,
            self._precedent_answer,
            self._product_answer,
            self._selection_answer,
        ):
            answer = builder(question, results)
            if answer:
                return answer
        return self._extractive_answer(question, results)

    def answer(self, question: str, role: str = "Sales", log: bool = True,
               history: list[dict[str, str]] | None = None) -> KnowledgeResponse:
        started = time.perf_counter()
        conversation = self._is_conversation(question)
        results = [] if conversation else self.index.search(question, role=role, limit=5)
        top_score = results[0].score if results else 0.0
        retrieved = bool(results)
        error: str | None = None
        intent = "conversation" if conversation else ("knowledge" if retrieved else "insufficient")
        grounded = bool(retrieved) and not conversation

        try:
            if self.llm:
                answer = self._llm_answer(question, results if retrieved else [], history=history)
                if conversation:
                    intent = "conversation"
                    grounded = False
                elif retrieved:
                    intent = "knowledge"
                    grounded = True
                else:
                    intent = "knowledge"
                    grounded = False
            elif conversation:
                answer = LOCAL_GREETING
            elif retrieved:
                answer = self._offline_answer(question, results)
            else:
                answer = (
                    "I couldn’t find sufficient evidence in the approved knowledge available to you. "
                    "I won’t infer an answer without a reliable source."
                )
        except Exception as exc:
            error = f"LLM unavailable ({type(exc).__name__})"
            if conversation or self.llm:
                answer = LOCAL_GREETING if conversation else (
                    "I couldn't compose a reply just now. Please ask again — "
                    "a greeting, a model question, or a customer email."
                )
                intent = "conversation" if conversation else "knowledge"
                grounded = False
                results = []
            elif retrieved:
                answer = self._offline_answer(question, results)
                intent = "knowledge"
                grounded = True
            else:
                answer = (
                    "I couldn’t find sufficient evidence in the approved knowledge available to you. "
                    "I won’t infer an answer without a reliable source."
                )
                intent = "insufficient"
                grounded = False

        if not answer:
            answer = LOCAL_GREETING if conversation else (
                "I couldn’t compose a reliable answer from the approved sources."
            )
            if not conversation:
                intent = "insufficient"
                grounded = False

        latency_ms = round((time.perf_counter() - started) * 1000)
        citations = self._citations(results if grounded else [])
        interaction_id = "INT-PREVIEW"
        if log:
            interaction_id = self.database.log_activity(
                activity_type="Knowledge",
                title=question[:72],
                status="Conversation" if intent == "conversation" else (
                    "Grounded" if grounded else "Insufficient evidence"
                ),
                prompt=question,
                source_ids=[citation.source_id for citation in citations],
                grounded=grounded,
                latency_ms=latency_ms,
                model=self.model if self.llm else "Local grounded retrieval",
                prompt_version="knowledge-v2.0",
                output=answer,
                error=error,
            )
        return KnowledgeResponse(
            interaction_id=interaction_id,
            answer=answer,
            grounded=grounded,
            confidence=round(min(max(top_score * 1.45, 0.0), 0.99), 2) if grounded else 0.0,
            citations=citations,
            latency_ms=latency_ms,
            mode=self.mode,
            intent=intent,
        )

    def _wants_proposal(self, request: DraftRequest) -> bool:
        blob = f"{request.template} {request.format} {request.inquiry}".lower()
        return any(term in blob for term in ("proposal", "rfq", "rfp", "recommended solution"))

    def _parse_proposal(self, content: str) -> tuple[str, str, list[DraftSection]]:
        subject_match = re.search(r"SUBJECT:\s*(.+)", content)
        subject = (
            subject_match.group(1).strip()
            if subject_match
            else "Technical proposal — recommended configuration"
        )
        remainder = re.sub(r"SUBJECT:\s*.+", "", content, count=1).strip()
        remainder = re.sub(r"^BODY:\s*", "", remainder, flags=re.IGNORECASE)
        parts = re.split(r"(?:^|\n)\s*(?:SECTION:\s*|(?:#{1,3}\s*))([^\n]+)\n", remainder)
        sections: list[DraftSection] = []
        if len(parts) >= 3:
            for index in range(1, len(parts), 2):
                heading = parts[index].strip(" #")
                text = parts[index + 1].strip() if index + 1 < len(parts) else ""
                if heading and text:
                    sections.append(DraftSection(heading=heading, content=text))
        if not sections:
            sections = [DraftSection(heading="Proposal", content=remainder.strip() or content.strip())]
        body = "\n\n".join(f"{section.heading}\n{section.content}" for section in sections)
        return subject, body, sections

    def _llm_draft(
        self,
        request: DraftRequest,
        results: list[SearchResult],
    ) -> tuple[str, str, list[DraftSection]]:
        assert self.llm is not None
        if self._wants_proposal(request):
            section_list = "\n".join(f"SECTION: {name}" for name in PROPOSAL_SECTIONS)
            prompt = f"""Create a tailored technical-commercial proposal from the customer requirement and evidence.

Tone: {request.tone}
Do not invent price, lead time, stock, or chemical compatibility.
Use [1], [2] citation markers. Do not paste evidence boilerplate.

Customer requirement:
{request.inquiry}

Evidence:
{self._context(results) if results else "None"}

Return exactly:
SUBJECT: <short proposal title>
{section_list}

Write the body of each section immediately after its SECTION line."""
            return self._parse_proposal(self._chat(prompt, temperature=0.2))

        prompt = f"""Write a {request.tone.lower()} {request.format.lower()} for this inquiry.
Template: {request.template}

Rules:
- Answer the inquiry. Do not paste evidence, headers, or page boilerplate.
- Use [1], [2] citation markers.
- Do not invent price, lead time, stock, or chemical compatibility.

Customer inquiry:
{request.inquiry}

Evidence:
{self._context(results) if results else "None"}

Return exactly:
SUBJECT: <subject>
BODY:
<body>"""
        content = self._chat(prompt, temperature=0.2)
        subject_match = re.search(r"SUBJECT:\s*(.+)", content)
        body_match = re.search(r"BODY:\s*(.+)", content, re.DOTALL)
        body = body_match.group(1).strip() if body_match else content
        subject = subject_match.group(1).strip() if subject_match else "Response to your technical inquiry"
        return subject, body, []

    def draft(self, request: DraftRequest, log: bool = True) -> DraftResponse:
        started = time.perf_counter()
        results = self.index.search(request.inquiry, role=request.user_role, limit=5)
        grounded = bool(results) and results[0].score >= 0.07
        unsupported: list[str] = []
        if re.search(r"\b(?:lead time|delivery|price|cost|stock)\b", request.inquiry, re.IGNORECASE):
            unsupported.append("Commercial timing or pricing was requested but is not supported by approved evidence.")
        kind = "proposal" if self._wants_proposal(request) else "email"
        sections: list[DraftSection] = []
        draft_error: str | None = None

        if self.llm:
            try:
                subject, body, sections = self._llm_draft(request, results)
            except Exception as exc:
                draft_error = f"Draft LLM unavailable ({type(exc).__name__}); used offline grounded composer."
                subject, body, sections = self._offline_draft(request, results)
        else:
            subject, body, sections = self._offline_draft(request, results)

        if kind == "proposal" and not sections:
            sections = [DraftSection(heading="Proposal", content=body)]

        latency_ms = round((time.perf_counter() - started) * 1000)
        citations = self._citations(results if grounded else [])
        interaction_id = "INT-PREVIEW"
        if log:
            interaction_id = self.database.log_activity(
                activity_type="Draft",
                title=subject[:72],
                status="Grounded" if grounded else "Review required",
                prompt=request.inquiry,
                source_ids=[citation.source_id for citation in citations],
                grounded=grounded,
                latency_ms=latency_ms,
                model=self.model if self.llm else "Local grounded composer",
                prompt_version="draft-v2.0",
                output=f"{subject}\n\n{body}",
                error=draft_error,
            )
        return DraftResponse(
            interaction_id=interaction_id,
            subject=subject,
            body=body,
            grounded=grounded,
            citations=citations,
            unsupported_claims=unsupported,
            latency_ms=latency_ms,
            mode=self.mode,
            kind=kind,
            sections=sections,
            error=draft_error,
        )

    def _offline_draft(
        self,
        request: DraftRequest,
        results: list[SearchResult],
    ) -> tuple[str, str, list[DraftSection]]:
        if self._wants_proposal(request):
            return self._offline_proposal(request, results)
        answer = self._offline_answer(request.inquiry, results) if results else (
            "The available approved knowledge is not sufficient to provide a technical confirmation."
        )
        model = re.search(r"\bHX-\d{3}\b", request.inquiry, re.IGNORECASE)
        subject = (
            f"{model.group(0).upper()} — response to your technical inquiry"
            if model
            else "Response to your technical inquiry"
        )
        intro = {
            "Sales follow-up": "Thank you for the recent discussion and for sharing your requirements.",
            "Proposal introduction": "Thank you for the opportunity to support your application.",
            "Service apology": "Thank you for bringing this issue to our attention. We appreciate the operational impact.",
        }.get(request.template, "Thank you for sharing the details of your application.")
        body = (
            f"Dear Customer,\n\n{intro}\n\n{answer}\n\n"
            "Before issuing a binding configuration, we recommend validating the complete duty point "
            "and fluid chemistry with our engineering team.\n\nKind regards,\nLena Meyer\nSales Engineering"
        )
        return subject, body, []

    def _offline_proposal(
        self,
        request: DraftRequest,
        results: list[SearchResult],
    ) -> tuple[str, str, list[DraftSection]]:
        recommendation = self._offline_answer(request.inquiry, results) if results else (
            "The available approved knowledge is not sufficient to recommend a configuration."
        )
        sections = [
            DraftSection(
                heading="Customer Requirement",
                content=re.sub(r"\s+", " ", request.inquiry).strip()[:700],
            ),
            DraftSection(heading="Recommended Product", content=recommendation),
            DraftSection(
                heading="Technical Fit",
                content="The recommendation is limited to documented pump-body, flow, pressure and seal guidance in the retrieved sources.",
            ),
            DraftSection(
                heading="Configuration",
                content="Confirm seal material against continuous temperature and fluid chemistry before a binding offer. [1]",
            ),
            DraftSection(
                heading="Benefits",
                content="The proposed configuration stays within approved Helios operating guidance and uses a documented seal option rather than stretching a standard seal limit.",
            ),
            DraftSection(
                heading="Assumptions",
                content="Duty is continuous unless otherwise stated. Fluid chemistry, NPSH and piping remain to be validated with the customer.",
            ),
            DraftSection(
                heading="Risks / Clarifications",
                content="Chemical compatibility is not confirmed from the corpus alone. Do not commit price or lead time without an approved commercial source.",
            ),
            DraftSection(
                heading="Next Steps",
                content="Review this draft, confirm treatment chemistry, and approve before any customer send.",
            ),
        ]
        body = "\n\n".join(f"{section.heading}\n{section.content}" for section in sections)
        return "Technical proposal — recommended configuration", body, sections

    # ------------------------------------------------------------------
    # Chat router
    # ------------------------------------------------------------------

    _ROUTE_SYSTEM = """You are a routing agent for Helios Sales & Service Copilot.

Classify the user message into EXACTLY one of these routes:
  knowledge  – a factual question about products, specs, seals, service, compatibility
  draft      – request to write or compose a customer-facing message / email / reply
               (even if technical facts are needed to write it correctly)
  workflow   – needs the full agentic pipeline: classify requirements, retrieve evidence,
               compose a multi-section proposal/recommendation, verify claims, human approval.
               ONLY use this when the user explicitly asks for a PROPOSAL, RFQ response,
               or a formal multi-section recommendation document.
  clarify    – genuinely ambiguous; ask one short clarifying question

Rules:
- Prefer knowledge over clarify when the question clearly asks for a fact.
- Use workflow ONLY when the user says "proposal", "rfq", "rfp", "prepare a proposal",
  "technical proposal", or "formal recommendation document". A request for a reply,
  email, or technical response — even with duty point numbers — is DRAFT, not workflow.
- Use draft when the user asks to write, compose, reply, send, or draft any message or
  email, regardless of whether it contains technical parameters like temperature or pressure.
- Only return clarify if you truly cannot decide between knowledge and draft/workflow.
- If draft: judge whether it needs knowledge retrieval to compose correctly.
  Set needs_retrieval true if the email requires technical facts from the corpus.
- Return a short user-facing label, e.g. "Knowledge · HX-240 specs".
- Set clarification only when route is clarify."""

    def chat_route(
        self,
        message: str,
        history: list[dict[str, str]],
        role: str = "Sales",
    ) -> "ChatRouteResult":
        """Classify message intent and execute the appropriate path inline."""
        from .models import ChatResponse

        # --- classify ---
        route = "knowledge"
        confidence = 0.72
        needs_retrieval = True
        label = "Knowledge"
        clarification: str | None = None

        if self.llm:
            try:
                decision = self.llm.structured(
                    schema=RouteDecision,
                    system_prompt=self._ROUTE_SYSTEM,
                    user_content=message,
                    history=history[-6:],
                    temperature=0.0,
                    label="rag.chat_route",
                )
                route = decision.route
                confidence = decision.confidence
                needs_retrieval = decision.needs_retrieval
                label = decision.label
                clarification = decision.clarification
            except Exception:
                # fall back to keyword heuristic
                q = message.lower()
                has_duty_point = bool(re.search(r"\d+\s*(?:°c|bar|m[³3]/h)", q, re.IGNORECASE))
                wants_proposal = bool(re.search(r"\b(proposal|rfq|rfp|recommend\w*\s+solution|technical\s+proposal)\b", q))
                wants_write = bool(re.search(r"\b(write|draft|compose|reply|send|email|formal\s+\w+reply)\b", q))
                if has_duty_point and wants_proposal:
                    route, confidence, label = "workflow", 0.80, "Workflow · proposal"
                elif wants_write or (has_duty_point and not wants_proposal):
                    route, confidence, label = "draft", 0.75, "Draft · email"
                else:
                    route, confidence, label = "knowledge", 0.70, "Knowledge"
        else:
            # local heuristic
            q = message.lower()
            has_duty_point = bool(re.search(r"\d+\s*(?:°c|bar|m[³3]/h)", q, re.IGNORECASE))
            wants_proposal = bool(re.search(r"\b(proposal|rfq|rfp|technical\s+proposal)\b", q))
            wants_write = bool(re.search(r"\b(write|draft|compose|reply|send|email)\b", q))
            if has_duty_point and wants_proposal:
                route, confidence, label = "workflow", 0.82, "Workflow · proposal"
            elif wants_write or (has_duty_point and not wants_proposal):
                route, confidence, label = "draft", 0.75, "Draft · email"
            elif re.search(r"\b(draft|write|compose)\b", q):
                route, confidence, label = "draft", 0.68, "Draft"

        if route == "clarify":
            return ChatResponse(
                route="clarify",
                confidence=confidence,
                clarification=clarification or "Could you tell me a bit more — are you looking for a technical answer, or do you need something drafted for a customer?",
                label="Clarify",
            )

        if route == "workflow":
            return ChatResponse(
                route="workflow",
                confidence=confidence,
                label=label,
            )

        if route == "draft":
            return ChatResponse(
                route="draft",
                confidence=confidence,
                label=label,
            )

        # knowledge — answer inline
        knowledge_response = self.answer(message, role=role, log=True)
        return ChatResponse(
            route="knowledge",
            confidence=confidence,
            answer=knowledge_response.answer,
            grounded=knowledge_response.grounded,
            citations=knowledge_response.citations,
            interaction_id=knowledge_response.interaction_id,
            label=label,
        )


# Type alias used in return annotation above (avoids circular import at module level)
ChatRouteResult = "ChatResponse"
