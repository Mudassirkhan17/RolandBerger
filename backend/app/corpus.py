import csv
import hashlib
import json
import logging
import os
import pickle
import re
from dataclasses import asdict, dataclass
from email import policy
from email.parser import BytesParser
from pathlib import Path
from typing import Iterable

import numpy as np
from pypdf import PdfReader
from sklearn.feature_extraction.text import TfidfVectorizer

logger = logging.getLogger(__name__)

EMBED_MODEL = "text-embedding-3-small"
EMBED_BATCH = 96          # max texts per embedding API call
EMBED_DIMS  = 1536        # text-embedding-3-small output dims


@dataclass
class Chunk:
    id: str
    source_id: str
    title: str
    file: str
    text: str
    page: int | None
    section: str | None
    category: str
    document_type: str
    product: str
    customer: str
    status: str
    version: str
    effective_date: str
    access: str


@dataclass
class SearchResult:
    chunk: Chunk
    score: float
    lexical_score: float = 0.0


def _clean_text(text: str) -> str:
    text = text.replace("\x00", " ").replace("\t", " ")
    text = re.sub(r"[ \u00a0]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _friendly_title(path: Path) -> str:
    title = path.stem
    title = re.sub(r"^(?:HEL-|PR-\d{4}-\d+_|SR-\d+_|EM-\d{4}-\d+_)", "", title)
    title = re.sub(r"_v?\d+(?:\.\d+)?$", "", title, flags=re.IGNORECASE)
    return title.replace("_", " ").replace("ARCHIVED ", "Archived — ").strip()


def _source_id(path: Path, text: str) -> str:
    patterns = [
        r"Document ID\s+([A-Z0-9.-]+)",
        r"Proposal ID\s+([A-Z0-9.-]+)",
        r'"ticket_id"\s*:\s*"([^"]+)"',
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            return match.group(1)
    return path.stem.split("_")[0]


def _flatten_json(value: object, prefix: str = "") -> list[str]:
    lines: list[str] = []
    if isinstance(value, dict):
        for key, item in value.items():
            label = key.replace("_", " ").strip().title()
            lines.extend(_flatten_json(item, f"{prefix}{label}: "))
    elif isinstance(value, list):
        lines.append(prefix + ", ".join(str(item) for item in value))
    else:
        lines.append(prefix + str(value))
    return lines


_BOILERPLATE_LINE = re.compile(
    r"synthetic demo data|enterprise ai sales|not real client information|"
    r"^helios industrial systems$|^-- \d+ of \d+ --$",
    re.IGNORECASE,
)
_META_LINE = re.compile(
    r"^(Document ID|Proposal ID|Version|Status|Effective date|Owner|Access|Ticket ID)\s+(.+)$",
    re.IGNORECASE,
)
_HEADING_HINTS = {
    "product overview", "key operating data", "application guidance",
    "typical service and maintenance", "commercial and technical product summary",
    "recommended configuration", "technical fit", "assumptions", "next steps",
    "operating limits", "seal guidance", "maintenance", "installation",
}


def _is_heading(line: str) -> bool:
    stripped = line.strip()
    if len(stripped) < 4 or len(stripped) > 72:
        return False
    if stripped.endswith((".", ",", ";", ":")):
        return False
    lower = stripped.lower()
    if lower in _HEADING_HINTS or "datasheet" in lower or "manual" in lower:
        return True
    words = stripped.split()
    if 2 <= len(words) <= 8 and stripped[0].isupper() and not any(ch.isdigit() for ch in stripped[:3]):
        if sum(1 for w in words if w[0].isupper()) >= max(1, len(words) - 1):
            return True
    return False


def _format_page_blocks(text: str) -> list[dict[str, str]]:
    blocks: list[dict[str, str]] = []
    pending: list[str] = []

    def flush() -> None:
        if pending:
            blocks.append({"type": "paragraph", "text": " ".join(pending).strip()})
            pending.clear()

    for raw in text.splitlines():
        line = raw.strip()
        if not line or _BOILERPLATE_LINE.search(line):
            flush()
            continue
        if re.fullmatch(r"Page\s+\d+", line, re.IGNORECASE):
            continue
        meta = _META_LINE.match(line)
        if meta:
            flush()
            blocks.append({"type": "meta", "label": meta.group(1), "text": meta.group(2).strip()})
            continue
        if _is_heading(line):
            flush()
            blocks.append({"type": "heading", "text": line})
            continue
        pending.append(line)
    flush()
    return blocks or [{"type": "paragraph", "text": _clean_text(text)}]


def _read_email(path: Path) -> dict[str, object]:
    message = BytesParser(policy=policy.default).parsebytes(path.read_bytes())
    body = message.get_body(preferencelist=("plain",))
    payload = body.get_content() if body else str(message.get_payload() or "")
    return {
        "from_address": str(message.get("From", "")),
        "to_address": str(message.get("To", "")),
        "date": str(message.get("Date", "")),
        "subject": str(message.get("Subject", path.stem)),
        "body": _clean_text(str(payload)),
        "pages": [],
    }


def _read_ticket(path: Path) -> dict[str, object]:
    data = json.loads(path.read_text(encoding="utf-8"))
    conditions = data.get("operating_conditions") or {}
    if not isinstance(conditions, dict):
        conditions = {}
    return {
        "ticket_id": data.get("ticket_id") or path.stem.split("_")[0],
        "subject": data.get("subject") or "",
        "severity": data.get("severity") or "",
        "ticket_status": data.get("status") or "",
        "opened_date": data.get("opened_date") or "",
        "symptoms": data.get("symptoms") or "",
        "diagnosis": data.get("diagnosis") or "",
        "resolution": data.get("resolution") or "",
        "service_lesson": data.get("service_lesson") or "",
        "conditions": {str(k): str(v) for k, v in conditions.items()},
        "pages": [],
    }


def _extract(path: Path) -> list[tuple[int | None, str]]:
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        reader = PdfReader(path)
        return [
            (index + 1, _clean_text(page.extract_text() or ""))
            for index, page in enumerate(reader.pages)
            if (page.extract_text() or "").strip()
        ]
    if suffix == ".json":
        data = json.loads(path.read_text(encoding="utf-8"))
        return [(None, _clean_text("\n".join(_flatten_json(data))))]
    if suffix == ".eml":
        message = BytesParser(policy=policy.default).parsebytes(path.read_bytes())
        body = message.get_body(preferencelist=("plain",))
        payload = body.get_content() if body else message.get_payload()
        headers = "\n".join(
            f"{name}: {message.get(name, '')}"
            for name in ("From", "To", "Date", "Subject", "X-Access")
        )
        return [(None, _clean_text(f"{headers}\n\n{payload}"))]
    return [(None, _clean_text(path.read_text(encoding="utf-8")))]


def _split_text(text: str, target_words: int = 190, overlap: int = 40) -> Iterable[str]:
    """Sliding window chunker with word overlap."""
    words = text.split()
    if len(words) <= target_words:
        if text:
            yield text
        return
    start = 0
    while start < len(words):
        end = min(start + target_words, len(words))
        yield " ".join(words[start:end])
        if end == len(words):
            break
        start = max(start + 1, end - overlap)


def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Cosine similarity between a 1-D query vector and an (N, D) matrix."""
    norm_a = np.linalg.norm(a)
    norms_b = np.linalg.norm(b, axis=1)
    if norm_a == 0:
        return np.zeros(len(b))
    denom = norms_b * norm_a
    denom[denom == 0] = 1e-9
    return (b @ a) / denom


class CorpusIndex:
    def __init__(self, corpus_path: Path, cache_path: Path, api_key: str | None = None):
        self.corpus_path = corpus_path.resolve()
        self.cache_path = cache_path.resolve()
        self.api_key = api_key or os.getenv("OPENAI_API_KEY", "").strip() or None
        self.chunks: list[Chunk] = []
        # TF-IDF fallback (always built)
        self.vectorizer: TfidfVectorizer
        self.tfidf_matrix: object
        # Semantic embeddings (built when API key is available)
        self.embeddings: np.ndarray | None = None   # shape (N, 1536)
        self.has_embeddings = False
        self.manifest: dict[str, dict[str, str]] = {}
        self._load_manifest()
        if not self._load_cache():
            self._build()
            self._save_cache()

    # ------------------------------------------------------------------
    # Cache helpers
    # ------------------------------------------------------------------

    def _fingerprint(self) -> str:
        digest = hashlib.sha256()
        # include API key presence in fingerprint so cache is invalidated
        # when a key is added for the first time
        digest.update(b"has_key:" + (b"1" if self.api_key else b"0"))
        for path in sorted(self.corpus_path.rglob("*")):
            if path.is_file():
                digest.update(str(path.relative_to(self.corpus_path)).encode())
                digest.update(str(path.stat().st_mtime_ns).encode())
                digest.update(str(path.stat().st_size).encode())
        return digest.hexdigest()

    def _load_manifest(self) -> None:
        manifest_path = self.corpus_path / "metadata" / "corpus_manifest.csv"
        with manifest_path.open(encoding="utf-8-sig", newline="") as handle:
            for row in csv.DictReader(handle):
                self.manifest[row["file"]] = row

    def _load_cache(self) -> bool:
        if not self.cache_path.exists():
            return False
        try:
            with self.cache_path.open("rb") as handle:
                payload = pickle.load(handle)
            if payload["fingerprint"] != self._fingerprint():
                return False
            self.chunks = [Chunk(**item) for item in payload["chunks"]]
            self.vectorizer = payload["vectorizer"]
            self.tfidf_matrix = payload["tfidf_matrix"]
            raw_emb = payload.get("embeddings")
            if raw_emb is not None:
                self.embeddings = np.array(raw_emb, dtype=np.float32)
                self.has_embeddings = True
            return True
        except (OSError, KeyError, pickle.PickleError, TypeError, ValueError):
            return False

    def _save_cache(self) -> None:
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        with self.cache_path.open("wb") as handle:
            pickle.dump(
                {
                    "fingerprint": self._fingerprint(),
                    "chunks": [asdict(chunk) for chunk in self.chunks],
                    "vectorizer": self.vectorizer,
                    "tfidf_matrix": self.tfidf_matrix,
                    "embeddings": self.embeddings.tolist() if self.embeddings is not None else None,
                },
                handle,
            )

    # ------------------------------------------------------------------
    # Build
    # ------------------------------------------------------------------

    def _build(self) -> None:
        chunks: list[Chunk] = []
        for relative_path, metadata in self.manifest.items():
            path = self.corpus_path / relative_path
            if not path.exists():
                continue
            extracted = _extract(path)
            complete_text = "\n".join(text for _, text in extracted)
            source_id = _source_id(path, complete_text)
            for page, page_text in extracted:
                for index, chunk_text in enumerate(_split_text(page_text)):
                    section_match = re.search(
                        r"(?:^|\n)(\d+(?:\.\d+)?\s+[A-Z][^\n]{2,80}|[A-Z][A-Za-z &/-]{3,60})",
                        chunk_text,
                    )
                    section = section_match.group(1).strip() if section_match else None
                    chunks.append(
                        Chunk(
                            id=f"{source_id}-p{page or 0}-c{index}",
                            source_id=source_id,
                            title=_friendly_title(path),
                            file=relative_path,
                            text=chunk_text,
                            page=page,
                            section=section,
                            category=metadata.get("category", ""),
                            document_type=metadata.get("document_type", ""),
                            product=metadata.get("product", ""),
                            customer=metadata.get("customer", ""),
                            status=metadata.get("status", ""),
                            version=metadata.get("version", ""),
                            effective_date=metadata.get("effective_date", ""),
                            access=metadata.get("access", ""),
                        )
                    )
        self.chunks = chunks

        # --- TF-IDF (always, fast, used as hybrid component) ---
        self.vectorizer = TfidfVectorizer(
            lowercase=True,
            stop_words="english",
            ngram_range=(1, 2),
            sublinear_tf=True,
            max_df=0.96,
        )
        self.tfidf_matrix = self.vectorizer.fit_transform(
            f"{chunk.title} {chunk.product} {chunk.customer} {chunk.text}"
            for chunk in chunks
        )

        # --- Semantic embeddings (when API key is available) ---
        if self.api_key:
            self._build_embeddings()

    def _build_embeddings(self) -> None:
        """Embed all chunks with text-embedding-3-small, batched."""
        try:
            from openai import OpenAI  # local import avoids hard dep at module level
            client = OpenAI(api_key=self.api_key)
            texts = [
                f"{c.title} | {c.product} | {c.customer}\n{c.text}"[:2000]
                for c in self.chunks
            ]
            all_embeddings: list[list[float]] = []
            for batch_start in range(0, len(texts), EMBED_BATCH):
                batch = texts[batch_start: batch_start + EMBED_BATCH]
                response = client.embeddings.create(model=EMBED_MODEL, input=batch)
                all_embeddings.extend(item.embedding for item in response.data)
                logger.info("Embedded chunks %d–%d", batch_start, batch_start + len(batch))
            self.embeddings = np.array(all_embeddings, dtype=np.float32)
            self.has_embeddings = True
            logger.info("Semantic index ready: %d embeddings", len(self.embeddings))
        except Exception as exc:
            logger.warning("Embedding build failed — falling back to TF-IDF only: %s", exc)
            self.embeddings = None
            self.has_embeddings = False

    # ------------------------------------------------------------------
    # Search
    # ------------------------------------------------------------------

    def _embed_query(self, query: str) -> np.ndarray | None:
        """Embed a single query string. Returns None on failure."""
        if not self.has_embeddings or not self.api_key:
            return None
        try:
            from openai import OpenAI
            client = OpenAI(api_key=self.api_key)
            response = client.embeddings.create(model=EMBED_MODEL, input=[query[:2000]])
            return np.array(response.data[0].embedding, dtype=np.float32)
        except Exception as exc:
            logger.warning("Query embedding failed: %s", exc)
            return None

    def search(self, query: str, role: str = "Sales", limit: int = 5) -> list[SearchResult]:
        # --- TF-IDF scores (always available) ---
        query_tfidf = self.vectorizer.transform([query])
        tfidf_scores = (self.tfidf_matrix @ query_tfidf.T).toarray().ravel()

        # --- Semantic scores (when embeddings exist) ---
        query_emb = self._embed_query(query)
        if query_emb is not None and self.embeddings is not None:
            semantic_scores = _cosine_similarity(query_emb, self.embeddings)
        else:
            semantic_scores = None

        terms = set(re.findall(r"[a-z0-9-]+", query.lower()))
        wants_history = bool(
            terms.intersection({"archive", "archived", "version", "versions", "changed", "superseded", "historic", "historical"})
        )
        wants_email = bool(
            terms.intersection(
                {"email", "emails", "eml", "correspondence", "message", "mail", "inbox", "feedback", "received"}
            )
        )
        role_lower = role.lower()

        candidates: list[tuple[int, float, float]] = []
        for index, chunk in enumerate(self.chunks):
            if role_lower not in chunk.access.lower():
                continue
            if chunk.status.lower().startswith("archiv") and not wants_history:
                continue

            lexical = float(tfidf_scores[index])

            # Hybrid score: 50% semantic + 50% lexical when embeddings available
            if semantic_scores is not None:
                semantic = float(semantic_scores[index])
                base_score = 0.55 * semantic + 0.45 * lexical
            else:
                base_score = lexical

            score = base_score

            # Metadata overlap boost
            haystack = f"{chunk.product} {chunk.customer} {chunk.source_id} {chunk.title}".lower()
            metadata_overlap = len(terms.intersection(set(re.findall(r"[a-z0-9-]+", haystack))))
            score += metadata_overlap * 0.040

            # Category and domain boosts (same as before, scaled slightly)
            if chunk.status.lower() == "approved" and lexical >= 0.04:
                score += 0.015
            if chunk.product.lower() in terms and chunk.category in {"product_documentation", "technical_manuals"}:
                score += 0.06
            if wants_email and chunk.category == "customer_correspondence":
                score += 0.55
            elif chunk.category == "customer_correspondence" and not wants_email:
                score -= 0.04
            if wants_email and chunk.category == "previous_proposals":
                score -= 0.22
            if wants_history and chunk.status.lower().startswith("archiv"):
                score += 0.16
            if "proposal" in terms and chunk.category == "previous_proposals":
                score += 0.08
            if terms.intersection({"cause", "caused", "issue", "ticket", "resolved", "resolution"}) and chunk.category == "service_tickets":
                score += 0.08
            if terms.intersection({"acid", "nitric", "oxidiser", "oxidizer", "alkali", "solvent", "chemistry", "chemical"}) and chunk.source_id in {
                "HEL-AE-PR-17",
                "HEL-SEAL-GUIDE-2026",
            }:
                score += 0.28
            if terms.intersection({"temperature", "seal", "epdm", "fkm", "ptfe", "continuous"}) and chunk.source_id == "HEL-APPLICATION-NOTE-09":
                score += 0.12
            if terms.intersection({"inspection", "maintenance", "interval", "hours", "extend"}) and chunk.source_id == "HEL-MAINT-2026":
                score += 0.22
            if terms.intersection({"inspection", "maintenance", "interval", "extend"}) and chunk.category == "service_tickets":
                score += 0.12
            if terms.intersection({"previous", "proposal", "precedent"}) and chunk.category == "previous_proposals":
                score += 0.13
            if terms.intersection({"which", "model", "select", "selection", "suitable"}) and chunk.source_id == "HEL-PUMP-FAMILY-2026":
                score += 0.3
            if (
                terms.intersection({"which", "should", "seal", "suitable", "recommend", "used"})
                and chunk.category == "customer_correspondence"
                and re.search(r"From:\s+\S+@helios-demo\.example", chunk.text, re.IGNORECASE)
            ):
                score += 0.2

            candidates.append((index, score, lexical))

        candidates.sort(key=lambda item: item[1], reverse=True)

        results: list[SearchResult] = []
        source_counts: dict[str, int] = {}
        for index, score, lexical in candidates:
            chunk = self.chunks[index]
            if source_counts.get(chunk.source_id, 0) >= 1:
                continue
            email_hit = wants_email and chunk.category == "customer_correspondence"
            # Relaxed floor when semantic scoring is active (semantic handles semantics)
            min_score = 0.05 if semantic_scores is not None else 0.08
            min_lex = 0.0 if semantic_scores is not None else 0.03
            if email_hit:
                if score < 0.06:
                    continue
            elif score < min_score or lexical < min_lex:
                continue
            results.append(SearchResult(chunk=chunk, score=score, lexical_score=lexical))
            source_counts[chunk.source_id] = source_counts.get(chunk.source_id, 0) + 1
            if len(results) >= limit:
                break
        return results

    @property
    def retrieval_mode(self) -> str:
        return "semantic+lexical hybrid" if self.has_embeddings else "lexical (TF-IDF)"

    @property
    def source_count(self) -> int:
        return len({chunk.file for chunk in self.chunks})

    @property
    def chunk_count(self) -> int:
        return len(self.chunks)

    def resolve_file(self, relative_path: str) -> Path:
        """Resolve a corpus-relative path, rejecting traversal."""
        relative = relative_path.replace("\\", "/").lstrip("/")
        if not relative or ".." in Path(relative).parts:
            raise FileNotFoundError(relative_path)
        candidate = (self.corpus_path / relative).resolve()
        corpus_root = self.corpus_path.resolve()
        if corpus_root not in candidate.parents and candidate != corpus_root:
            raise FileNotFoundError(relative_path)
        if not candidate.is_file():
            raise FileNotFoundError(relative_path)
        return candidate

    def load_document(self, relative_path: str) -> dict[str, object]:
        """Return a structured, display-ready view of a corpus document."""
        path = self.resolve_file(relative_path)
        metadata = self.manifest.get(relative_path.replace("\\", "/"), {})
        suffix = path.suffix.lower()
        title = _friendly_title(path)
        source_id = path.stem.split("_")[0]
        base = {
            "file": relative_path.replace("\\", "/"),
            "title": title,
            "source_id": source_id,
            "document_type": metadata.get("document_type", path.suffix.upper().lstrip(".")),
            "status": metadata.get("status", ""),
            "product": metadata.get("product", ""),
            "customer": metadata.get("customer", ""),
            "version": metadata.get("version", ""),
            "effective_date": metadata.get("effective_date", ""),
            "category": metadata.get("category", ""),
        }
        if suffix == ".eml":
            return {**base, "kind": "email", **_read_email(path)}
        if suffix == ".json":
            return {**base, "kind": "ticket", **_read_ticket(path)}
        pages = _extract(path)
        formatted = [
            {"number": page or index + 1, "blocks": _format_page_blocks(text)}
            for index, (page, text) in enumerate(pages)
        ]
        if not formatted:
            formatted = [{"number": 1, "blocks": [{"type": "paragraph", "text": "This document has no extractable text."}]}]
        kind = "proposal" if "proposal" in str(metadata.get("category", "")).lower() else "document"
        return {**base, "kind": kind, "pages": formatted}
