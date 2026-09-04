import hashlib
import json
import re
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

import bcrypt as _bcrypt_lib


def hash_password(password: str) -> str:
    return _bcrypt_lib.hashpw(password.encode(), _bcrypt_lib.gensalt()).decode()


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return _bcrypt_lib.checkpw(plain.encode(), hashed.encode())
    except Exception:
        return False


EMAIL_PATTERN = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)
PHONE_PATTERN = re.compile(r"(?<!\w)(?:\+?\d[\d\s().-]{7,}\d)")


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def redact(text: str, limit: int = 220) -> str:
    safe = EMAIL_PATTERN.sub("[email redacted]", text)
    safe = PHONE_PATTERN.sub("[number redacted]", safe)
    safe = re.sub(r"\s+", " ", safe).strip()
    return safe[:limit] + ("…" if len(safe) > limit else "")


class Database:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self._initialize()

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialize(self) -> None:
        with self.connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS activity (
                    id TEXT PRIMARY KEY,
                    type TEXT NOT NULL,
                    title TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    prompt_hash TEXT NOT NULL,
                    prompt_preview TEXT NOT NULL,
                    source_ids TEXT NOT NULL,
                    grounded INTEGER,
                    latency_ms INTEGER,
                    feedback TEXT,
                    error TEXT,
                    model TEXT NOT NULL,
                    prompt_version TEXT NOT NULL
                );
                """
            )
            # Migrate: add output_preview column if it does not exist yet
            try:
                connection.execute("ALTER TABLE activity ADD COLUMN output_preview TEXT")
            except Exception:
                pass  # column already exists
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS workflows (
                    id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    owner TEXT NOT NULL,
                    inquiry TEXT NOT NULL,
                    role TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS workflow_protocols (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL,
                    output_kind TEXT NOT NULL,
                    steps TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS board_feedback (
                    id TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    title TEXT NOT NULL,
                    description TEXT NOT NULL,
                    name TEXT NOT NULL,
                    email TEXT,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    email TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    role TEXT NOT NULL DEFAULT 'user',
                    permissions TEXT NOT NULL DEFAULT '["knowledge","draft","workflow","capture","library","feedback","onboard"]',
                    created_at TEXT NOT NULL
                );
                """
            )
            self._seed_admin()

    def log_activity(
        self,
        *,
        activity_type: str,
        title: str,
        status: str,
        prompt: str,
        source_ids: list[str],
        grounded: bool | None,
        latency_ms: int | None,
        model: str,
        prompt_version: str,
        output: str | None = None,
        error: str | None = None,
        activity_id: str | None = None,
    ) -> str:
        record_id = activity_id or f"INT-{uuid4().hex[:10].upper()}"
        prompt_hash = hashlib.sha256(prompt.encode("utf-8")).hexdigest()
        output_preview = redact(output)[:280] if output else None
        title_safe = redact(title, limit=90)
        error_safe = redact(error, limit=200) if error else None
        with self.connect() as connection:
            connection.execute(
                """
                INSERT OR REPLACE INTO activity
                (id, type, title, status, created_at, prompt_hash, prompt_preview,
                 source_ids, grounded, latency_ms, feedback, error, model, prompt_version,
                 output_preview)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
                """,
                (
                    record_id,
                    activity_type,
                    title_safe,
                    status,
                    utc_now(),
                    prompt_hash,
                    redact(prompt),
                    json.dumps(source_ids),
                    None if grounded is None else int(grounded),
                    latency_ms,
                    error_safe,
                    model,
                    prompt_version,
                    output_preview,
                ),
            )
        return record_id

    def set_feedback(self, interaction_id: str, rating: str) -> bool:
        with self.connect() as connection:
            cursor = connection.execute(
                "UPDATE activity SET feedback = ? WHERE id = ?",
                (rating, interaction_id),
            )
            return cursor.rowcount > 0

    def list_activity(self, limit: int = 50) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM activity ORDER BY created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [self._activity_row(row) for row in rows]

    def get_activity(self, activity_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM activity WHERE id = ?",
                (activity_id,),
            ).fetchone()
        return self._activity_row(row) if row else None

    @staticmethod
    def _activity_row(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "type": row["type"],
            "title": row["title"],
            "status": row["status"],
            "created_at": row["created_at"],
            "prompt_preview": row["prompt_preview"],
            "source_ids": json.loads(row["source_ids"]),
            "grounded": None if row["grounded"] is None else bool(row["grounded"]),
            "latency_ms": row["latency_ms"],
            "feedback": row["feedback"],
            "error": row["error"],
            "model": row["model"],
            "prompt_version": row["prompt_version"],
            "output_preview": row["output_preview"] if row["output_preview"] else None,
        }

    def create_workflow(self, inquiry: str, role: str, owner: str) -> str:
        workflow_id = f"WF-{uuid4().hex[:8].upper()}"
        now = utc_now()
        payload = {"started_at": now, "decision_comment": None}
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO workflows
                (id, status, owner, inquiry, role, payload, created_at, updated_at)
                VALUES (?, 'running', ?, ?, ?, ?, ?, ?)
                """,
                (workflow_id, owner, inquiry, role, json.dumps(payload), now, now),
            )
        return workflow_id

    def get_workflow(self, workflow_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM workflows WHERE id = ?",
                (workflow_id,),
            ).fetchone()
        if not row:
            return None
        return {
            "id": row["id"],
            "status": row["status"],
            "owner": row["owner"],
            "inquiry": row["inquiry"],
            "role": row["role"],
            "payload": json.loads(row["payload"]),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def update_workflow(
        self,
        workflow_id: str,
        *,
        status: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> bool:
        current = self.get_workflow(workflow_id)
        if not current:
            return False
        next_status = status or current["status"]
        next_payload = payload or current["payload"]
        with self.connect() as connection:
            connection.execute(
                "UPDATE workflows SET status = ?, payload = ?, updated_at = ? WHERE id = ?",
                (next_status, json.dumps(next_payload), utc_now(), workflow_id),
            )
        return True

    def list_protocols(self) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM workflow_protocols ORDER BY created_at DESC"
            ).fetchall()
        return [self._protocol_row(row) for row in rows]

    def create_protocol(
        self,
        name: str,
        description: str,
        output_kind: str,
        steps: list[str],
    ) -> dict[str, Any]:
        record_id = f"PR-{uuid4().hex[:8].upper()}"
        now = utc_now()
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO workflow_protocols
                (id, name, description, output_kind, steps, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (record_id, name, description, output_kind, json.dumps(steps), now),
            )
        return {
            "id": record_id,
            "name": name,
            "description": description,
            "output_kind": output_kind,
            "steps": steps,
            "created_at": now,
        }

    @staticmethod
    def _protocol_row(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "name": row["name"],
            "description": row["description"],
            "output_kind": row["output_kind"],
            "steps": json.loads(row["steps"]),
            "created_at": row["created_at"],
        }

    def _seed_admin(self) -> None:
        """Create the admin account on first boot if it doesn't exist."""
        with self.connect() as connection:
            existing = connection.execute(
                "SELECT id FROM users WHERE email = ?", ("mudassir@gmail.com",)
            ).fetchone()
            if existing:
                return
            connection.execute(
                """
                INSERT INTO users (id, name, email, password_hash, role, permissions, created_at)
                VALUES (?, ?, ?, ?, 'admin', '["knowledge","draft","workflow","capture","library","feedback","onboard"]', ?)
                """,
                (
                    f"USR-{uuid4().hex[:8].upper()}",
                    "Mudassir Khan",
                    "mudassir@gmail.com",
                    hash_password("12345"),
                    utc_now(),
                ),
            )

    def create_user(self, *, name: str, email: str, password: str) -> dict[str, Any]:
        user_id = f"USR-{uuid4().hex[:8].upper()}"
        now = utc_now()
        default_perms = json.dumps(["knowledge", "draft", "workflow", "capture", "library", "feedback", "onboard"])
        with self.connect() as connection:
            try:
                connection.execute(
                    """
                    INSERT INTO users (id, name, email, password_hash, role, permissions, created_at)
                    VALUES (?, ?, ?, ?, 'user', ?, ?)
                    """,
                    (user_id, name, email.lower().strip(), hash_password(password), default_perms, now),
                )
            except sqlite3.IntegrityError:
                raise ValueError("Email already registered.")
        return self.get_user_by_email(email)  # type: ignore[return-value]

    def get_user_by_email(self, email: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM users WHERE email = ?", (email.lower().strip(),)
            ).fetchone()
        return self._user_row(row) if row else None

    def get_user_by_id(self, user_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM users WHERE id = ?", (user_id,)
            ).fetchone()
        return self._user_row(row) if row else None

    def list_users(self) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM users ORDER BY created_at DESC"
            ).fetchall()
        return [self._user_row(row) for row in rows]

    def update_user_permissions(self, user_id: str, permissions: list[str]) -> bool:
        with self.connect() as connection:
            cursor = connection.execute(
                "UPDATE users SET permissions = ? WHERE id = ?",
                (json.dumps(permissions), user_id),
            )
        return cursor.rowcount > 0

    @staticmethod
    def _user_row(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "name": row["name"],
            "email": row["email"],
            "password_hash": row["password_hash"],
            "role": row["role"],
            "permissions": json.loads(row["permissions"]),
            "created_at": row["created_at"],
        }

    def create_board_ticket(
        self,
        *,
        kind: str,
        title: str,
        description: str,
        name: str,
        email: str | None,
    ) -> dict[str, Any]:
        record_id = f"FB-{uuid4().hex[:8].upper()}"
        now = utc_now()
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO board_feedback
                (id, kind, title, description, name, email, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (record_id, kind, title, description, name, email, now),
            )
        return {
            "id": record_id,
            "kind": kind,
            "title": title,
            "description": description,
            "name": name,
            "email": email,
            "created_at": now,
        }

    def list_board_tickets(self, limit: int = 100) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM board_feedback ORDER BY created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [self._board_ticket_row(row) for row in rows]

    @staticmethod
    def _board_ticket_row(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "kind": row["kind"],
            "title": row["title"],
            "description": row["description"],
            "name": row["name"],
            "email": row["email"] or None,
            "created_at": row["created_at"],
        }
