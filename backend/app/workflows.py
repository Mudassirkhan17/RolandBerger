import re
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException

from .database import Database, utc_now
from .models import (
    DraftRequest,
    DraftResponse,
    WorkflowCreateRequest,
    WorkflowResponse,
    WorkflowStep,
)
from .rag import RAGService


STEP_DEFINITIONS = [
    ("classify", "Classify inquiry"),
    ("retrieve", "Retrieve evidence"),
    ("compose", "Compose response"),
    ("verify", "Verify claims"),
    ("approval", "Human approval"),
]


class WorkflowService:
    def __init__(self, database: Database, rag: RAGService):
        self.database = database
        self.rag = rag

    def create(self, request: WorkflowCreateRequest) -> WorkflowResponse:
        workflow_id = self.database.create_workflow(
            inquiry=request.inquiry,
            role=request.user_role,
            owner=request.owner,
        )
        record = self.database.get_workflow(workflow_id)
        if record:
            payload = record["payload"]
            payload["output_kind"] = request.output_kind
            payload["protocol_name"] = request.protocol_name
            self.database.update_workflow(workflow_id, payload=payload)
        self.database.log_activity(
            activity_type="Workflow",
            title=request.protocol_name or "Inquiry → approved reply",
            status="Running",
            prompt=request.inquiry,
            source_ids=[],
            grounded=None,
            latency_ms=None,
            model=self.rag.model if self.rag.client else "Local grounded workflow",
            prompt_version="workflow-v1.0",
            activity_id=workflow_id,
        )
        return self.get(workflow_id)

    def _advance(self, record: dict[str, Any]) -> dict[str, Any]:
        if record["status"] != "running":
            return record
        payload = record["payload"]
        started = datetime.fromisoformat(payload["started_at"])
        elapsed = (datetime.now(UTC) - started).total_seconds()

        # Step 1 — Classify: extract structured intent from inquiry (real LLM call)
        if elapsed >= 0.4 and "classification" not in payload:
            classification, classify_error = self._classify(record["inquiry"])
            payload["classification"] = classification
            if classify_error:
                payload["errors"] = payload.get("errors", []) + [classify_error]
            self.database.update_workflow(record["id"], payload=payload)

        # Steps 2–4 — Retrieve + Compose + Verify
        if elapsed >= 1.5 and "draft" not in payload:
            wants_proposal = payload.get("output_kind") == "proposal" or any(
                term in record["inquiry"].lower()
                for term in ("proposal", "rfq", "rfp", "recommended solution")
            )
            # Use classified intent to improve template choice
            cls = payload.get("classification", {})
            intent = cls.get("intent", "")
            if intent == "proposal":
                wants_proposal = True

            draft = self.rag.draft(
                DraftRequest(
                    inquiry=record["inquiry"],
                    template="Proposal introduction" if wants_proposal else "Technical response",
                    tone="Technical",
                    format="Proposal note" if wants_proposal else "Customer email",
                    user_role=record["role"],
                ),
                log=False,
            )
            payload["draft"] = draft.model_dump()
            payload["verification"] = self._verification(draft, payload.get("classification"))
            if draft.error:
                payload["errors"] = payload.get("errors", []) + [draft.error]
            self.database.update_workflow(record["id"], payload=payload)

        if elapsed >= 3.2:
            if "draft" not in payload:
                return record
            self.database.update_workflow(record["id"], status="approval", payload=payload)
            record = self.database.get_workflow(record["id"]) or record
        return record

    def _classify(self, inquiry: str) -> tuple[dict[str, Any], str | None]:
        """Extract structured intent, product, and duty point from the inquiry.

        Returns (classification, error). error is None unless the LLM path
        failed and the workflow fell back to the offline heuristic.
        """
        if not self.rag.client:
            return self._classify_offline(inquiry), None

        import json as _json
        prompt = (
            "Extract structured information from this sales inquiry. "
            "Return JSON only:\n"
            '{"intent":"email|proposal|service","product":"HX-240|HX-300|HX-400|HX-520|null",'
            '"temperature":"value or null","pressure":"value or null","flow":"value or null",'
            '"customer":"company name or null",'
            '"missing":["list of key information that is absent but needed for a recommendation"]}\n\n'
            f"Inquiry:\n{inquiry[:1200]}"
        )
        try:
            raw = self.rag.client.chat.completions.create(
                model=self.rag.model,
                temperature=0.0,
                response_format={"type": "json_object"},
                messages=[{"role": "user", "content": prompt}],
            )
            return _json.loads(raw.choices[0].message.content or "{}"), None
        except Exception as exc:
            error = f"Classify LLM unavailable ({type(exc).__name__}); used offline extraction."
            return self._classify_offline(inquiry), error

    @staticmethod
    def _classify_offline(inquiry: str) -> dict[str, Any]:
        model_match = re.search(r"\bHX-?(\d{3})\b", inquiry, re.IGNORECASE)
        temp = re.search(r"(\d+)\s*°?C", inquiry)
        pressure = re.search(r"(\d+(?:\.\d+)?)\s*bar", inquiry)
        flow = re.search(r"(\d+(?:\.\d+)?)\s*m[³3]/h", inquiry)
        return {
            "intent": "proposal" if re.search(r"\b(proposal|rfq|rfp|recommend)\b", inquiry, re.IGNORECASE) else "email",
            "product": f"HX-{model_match.group(1)}" if model_match else None,
            "temperature": f"{temp.group(1)}°C" if temp else None,
            "pressure": f"{pressure.group(1)} bar" if pressure else None,
            "flow": f"{flow.group(1)} m³/h" if flow else None,
            "customer": None,
            "missing": [],
        }

    @staticmethod
    def _verification(draft: DraftResponse, classification: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        checks = [
            {
                "claim": "Technical recommendation is supported by approved documents",
                "status": "grounded" if draft.grounded else "attention",
                "source": draft.citations[0].source_id if draft.citations else None,
            }
        ]
        # Surface missing information flagged during classification
        if classification:
            for missing in classification.get("missing", []):
                checks.append({
                    "claim": f"Missing: {missing}",
                    "status": "removed",
                    "source": None,
                })
        for claim in draft.unsupported_claims:
            checks.append(
                {
                    "claim": claim,
                    "status": "removed",
                    "source": None,
                }
            )
        return checks

    def _steps(self, record: dict[str, Any]) -> list[WorkflowStep]:
        status = record["status"]
        payload = record["payload"]
        started = datetime.fromisoformat(payload["started_at"])
        elapsed = (datetime.now(UTC) - started).total_seconds()
        active_index = min(int(elapsed / 0.65), 4) if status == "running" else 4

        cls = payload.get("classification", {})
        product = cls.get("product") or "product"
        intent = cls.get("intent", "email")
        classified_detail = (
            f"{product} · {cls.get('temperature', '—')} · {cls.get('pressure', '—')} · {intent}"
            if cls else "Technical service inquiry identified"
        )

        details = [
            classified_detail,
            f"{len(payload.get('draft', {}).get('citations', [])) or 'Approved'} sources selected",
            "Technical proposal prepared" if payload.get("draft", {}).get("kind") == "proposal" else "Grounded customer email prepared",
            f"{len(payload.get('verification', [])) or 'Pending'} claim checks completed",
            "Decision recorded" if status in {"approved", "declined"} else "Your review is required",
        ]
        steps: list[WorkflowStep] = []
        for index, (key, label) in enumerate(STEP_DEFINITIONS):
            if status == "approved":
                step_status = "approved" if index == 4 else "completed"
            elif status == "declined":
                step_status = "declined" if index == 4 else "completed"
            elif status in {"approval", "revision"}:
                step_status = "running" if index == 4 else "completed"
            elif index < active_index:
                step_status = "completed"
            elif index == active_index:
                step_status = "running"
            else:
                step_status = "waiting"
            if key == "verify" and payload.get("draft", {}).get("unsupported_claims") and index <= active_index:
                step_status = "attention" if status not in {"approved", "declined"} else "completed"
            steps.append(
                WorkflowStep(
                    key=key,
                    label=label,
                    status=step_status,
                    detail=details[index] if step_status != "waiting" else "Waiting",
                )
            )
        return steps

    def get(self, workflow_id: str) -> WorkflowResponse:
        record = self.database.get_workflow(workflow_id)
        if not record:
            raise HTTPException(status_code=404, detail="Workflow not found")
        record = self._advance(record)
        payload = record["payload"]
        draft = DraftResponse.model_validate(payload["draft"]) if payload.get("draft") else None
        return WorkflowResponse(
            workflow_id=record["id"],
            status=record["status"],
            owner=record["owner"],
            steps=self._steps(record),
            draft=draft,
            verification=payload.get("verification", []),
            classification=payload.get("classification"),
            created_at=record["created_at"],
            updated_at=record["updated_at"],
        )

    def decide(self, workflow_id: str, decision: str, comment: str | None = None) -> WorkflowResponse:
        record = self.database.get_workflow(workflow_id)
        if not record:
            raise HTTPException(status_code=404, detail="Workflow not found")
        if record["status"] not in {"approval", "revision"}:
            raise HTTPException(status_code=409, detail="Workflow is not awaiting a decision")
        payload = record["payload"]
        payload["decision_comment"] = comment
        payload["decision_at"] = utc_now()

        if decision == "revise":
            payload["started_at"] = utc_now()
            payload.pop("draft", None)
            payload.pop("verification", None)
            status = "running"
        elif decision in {"approved", "declined"}:
            status = decision
        else:
            raise HTTPException(status_code=400, detail="Unknown workflow decision")
        self.database.update_workflow(workflow_id, status=status, payload=payload)

        activity_status = {
            "approved": "Approved",
            "declined": "Declined",
            "revise": "Revision requested",
        }[decision]
        draft = payload.get("draft", {})
        draft_output = None
        if draft.get("subject") or draft.get("body"):
            draft_output = f"{draft.get('subject', '')}\n\n{draft.get('body', '')}".strip()
        run_errors = payload.get("errors", [])
        self.database.log_activity(
            activity_type="Workflow",
            title="Inquiry → approved reply",
            status=activity_status,
            prompt=record["inquiry"],
            source_ids=[item["source_id"] for item in draft.get("citations", [])],
            grounded=draft.get("grounded"),
            latency_ms=draft.get("latency_ms"),
            model=self.rag.model if self.rag.client else "Local grounded workflow",
            prompt_version="workflow-v1.0",
            output=draft_output,
            error="; ".join(run_errors) if run_errors else None,
            activity_id=workflow_id,
        )
        return self.get(workflow_id)
