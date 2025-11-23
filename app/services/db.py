from __future__ import annotations

import json
import logging
import math
import sqlite3
from copy import deepcopy
from pathlib import Path
from threading import Lock
from typing import Any, Dict, List, Optional, Protocol
from uuid import uuid4

try:
    from azure.cosmos import CosmosClient, exceptions
    from azure.core.pipeline.transport import RequestsTransport
except ImportError:  # pragma: no cover - fallback for missing dependency
    CosmosClient = None  # type: ignore
    exceptions = None  # type: ignore
    RequestsTransport = None  # type: ignore

from config.settings import Settings

logger = logging.getLogger(__name__)

if RequestsTransport is not None:
    _original_send = RequestsTransport.send

    def _patched_send(self, request, *, proxies=None, **kwargs):  # type: ignore[override]
        kwargs.pop("partition_key", None)
        return _original_send(self, request, proxies=proxies, **kwargs)

    RequestsTransport.send = _patched_send  # type: ignore[assignment]


def _coerce_str(value: Any) -> str:
    return str(value) if value is not None else ""


def normalize_transcript(data) -> List[Dict[str, Any]]:
    """Ensure transcripts are stored as chat-style messages with optional metadata."""
    result: List[Dict[str, Any]] = []
    if not data:
        return result

    for entry in _prepare_transcript_source(data):
        result.extend(_normalize_transcript_entry(entry))
    return result


def _prepare_transcript_source(data) -> List[Any]:
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        return [data]
    if isinstance(data, str):
        return [{"role": "ai", "content": data}]
    if data is None:
        return []
    return [{"role": "ai", "content": _coerce_str(data)}]


def _normalize_transcript_entry(entry: Any) -> List[Dict[str, Any]]:
    if isinstance(entry, dict):
        role = entry.get("role")
        content = entry.get("content")
        if role is not None and content is not None:
            return [_normalize_chat_entry(entry, role, content)]
        return _expand_legacy_entry(entry)
    if entry is None:
        return []
    return [{"role": "ai", "content": _coerce_str(entry)}]


def _normalize_chat_entry(entry: Dict[str, Any], role: Any, content: Any) -> Dict[str, Any]:
    normalized_role = "ai" if role in {"ai", "assistant", "system"} else "user"
    normalized_entry: Dict[str, Any] = {
        "role": normalized_role,
        "content": _coerce_str(content),
    }
    _merge_known_fields(normalized_entry, entry)
    audio_url = normalized_entry.pop("questionAudioUrl", None) or entry.get("questionAudioUrl")
    if not normalized_entry.get("audioUrl") and audio_url:
        normalized_entry["audioUrl"] = _coerce_str(audio_url)
    return normalized_entry


def _merge_known_fields(target: Dict[str, Any], source: Dict[str, Any]) -> None:
    known_keys = (
        "type",
        "timestamp",
        "audioUrl",
        "questionAudioUrl",
        "answerAudioUrl",
        "feedback",
        "nextQuestion",
        "nextQuestionAudioUrl",
        "feedbackSnippet",
        "summary",
    )
    for key in known_keys:
        value = source.get(key)
        if value is None:
            continue
        target[key] = _coerce_str(value)


def _expand_legacy_entry(entry: Dict[str, Any]) -> List[Dict[str, Any]]:
    normalized: List[Dict[str, Any]] = []
    timestamp = entry.get("timestamp")

    question = entry.get("question")
    if question:
        question_entry: Dict[str, Any] = {
            "role": "ai",
            "content": _coerce_str(question),
            "type": entry.get("questionType") or "question",
        }
        if timestamp:
            question_entry["timestamp"] = timestamp
        audio_url = entry.get("questionAudioUrl") or entry.get("audioUrl")
        if audio_url:
            question_entry["audioUrl"] = _coerce_str(audio_url)
        normalized.append(question_entry)

    answer = entry.get("answer")
    if answer:
        answer_entry: Dict[str, Any] = {
            "role": "user",
            "content": _coerce_str(answer),
            "type": entry.get("answerType") or "answer",
        }
        if timestamp:
            answer_entry["timestamp"] = timestamp
        normalized.append(answer_entry)

    feedback = entry.get("feedback")
    if feedback:
        feedback_entry: Dict[str, Any] = {
            "role": "ai",
            "content": _coerce_str(feedback),
            "type": entry.get("feedbackType") or "feedback",
        }
        if timestamp:
            feedback_entry["timestamp"] = timestamp
        feedback_snippet = entry.get("feedbackSnippet")
        if feedback_snippet:
            feedback_entry["feedbackSnippet"] = _coerce_str(feedback_snippet)
        next_question = entry.get("nextQuestion")
        if next_question:
            feedback_entry["nextQuestion"] = _coerce_str(next_question)
        next_question_audio = entry.get("nextQuestionAudioUrl")
        if next_question_audio:
            feedback_entry["nextQuestionAudioUrl"] = _coerce_str(next_question_audio)
        normalized.append(feedback_entry)

    return normalized


SUMMARY_SKILL_KEYS = ("logic", "specificity", "expression", "proactive", "selfaware")


def _coerce_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return number


def _coerce_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, bool):
        return int(value)
    try:
        number = int(value)
    except (TypeError, ValueError):
        try:
            number = int(float(value))
        except (TypeError, ValueError):
            return None
    return number


def _clamp_percentage(value: Optional[float]) -> Optional[float]:
    if value is None:
        return None
    return round(max(0.0, min(100.0, value)), 1)


def _normalise_skills(skills_payload: Any) -> Dict[str, float]:
    skills: Dict[str, float] = {}
    if isinstance(skills_payload, dict):
        for key in SUMMARY_SKILL_KEYS:
            clamped = _clamp_percentage(_coerce_float(skills_payload.get(key)))
            if clamped is not None:
                skills[key] = clamped
    elif isinstance(skills_payload, list):
        for entry in skills_payload:
            if not isinstance(entry, dict):
                continue
            name = entry.get("name") or entry.get("key")
            if not name:
                continue
            name_str = str(name)
            if name_str not in SUMMARY_SKILL_KEYS:
                continue
            clamped = _clamp_percentage(_coerce_float(entry.get("score")))
            if clamped is not None:
                skills[name_str] = clamped
    return skills


def _normalise_summary_record(summary: Any) -> Optional[Dict[str, Any]]:
    if summary is None:
        return None

    if isinstance(summary, bytes):
        try:
            summary = summary.decode("utf-8")
        except UnicodeDecodeError:
            return None

    if isinstance(summary, str):
        summary = summary.strip()
        if not summary:
            return None
        try:
            parsed = json.loads(summary)
        except json.JSONDecodeError:
            return {"text": summary}
        if isinstance(parsed, dict):
            summary = parsed
        else:
            return {"text": str(parsed)}

    if isinstance(summary, dict):
        data = deepcopy(summary)
        normalised: Dict[str, Any] = {}

        text_value = data.get("text") or data.get("summary") or data.get("content")
        if isinstance(text_value, (list, dict)):
            text_value = json.dumps(text_value, ensure_ascii=False)
        if text_value:
            normalised["text"] = str(text_value).strip()

        score_value = _clamp_percentage(_coerce_float(data.get("score") or data.get("overallScore")))
        if score_value is not None:
            normalised["score"] = score_value

        duration_value = _coerce_int(data.get("durationSeconds") or data.get("duration_seconds"))
        if duration_value is not None and duration_value >= 0:
            normalised["durationSeconds"] = duration_value

        skills = _normalise_skills(data.get("skills"))
        if skills:
            normalised["skills"] = skills

        if not normalised and data:
            return {"text": json.dumps(data, ensure_ascii=False)}

        if "text" not in normalised:
            normalised["text"] = ""

        return normalised

    return {"text": str(summary)}


def _serialise_summary_record(summary: Any) -> Optional[str]:
    normalised = _normalise_summary_record(summary)
    if normalised is None:
        return None
    return json.dumps(normalised, ensure_ascii=False)


class DatabaseService(Protocol):
    """Interface for persistence layer used by the routers."""

    def create_user(self, user_id: str, password_hash: str) -> None:
        ...

    def get_user(self, user_id: str) -> Optional[Dict]:
        ...

    def create_interview(self, user_id: str, payload: Dict) -> str:
        ...

    def get_interview(self, interview_id: str) -> Optional[Dict]:
        ...

    def update_interview(self, interview_id: str, data: Dict) -> None:
        ...

    def append_transcript_entry(self, interview_id: str, entry: Dict) -> None:
        ...

    def list_interviews(self, user_id: str) -> List[Dict]:
        ...

    def clear_interviews(self, user_id: str) -> None:
        ...


class InMemoryDatabaseService:
    """Simple in-memory implementation for local development and testing."""

    def __init__(self):
        self._users: Dict[str, Dict] = {}
        self._interviews: Dict[str, Dict] = {}

    def create_user(self, user_id: str, password_hash: str) -> None:
        self._users[user_id] = {"user_id": user_id, "password_hash": password_hash}

    def get_user(self, user_id: str) -> Optional[Dict]:
        record = self._users.get(user_id)
        return deepcopy(record) if record else None

    def create_interview(self, user_id: str, payload: Dict) -> str:
        interview_id = f"interview_{len(self._interviews) + 1}"
        interview_payload = deepcopy(payload)
        interview_payload["transcript"] = normalize_transcript(interview_payload.get("transcript", []))
        interview_payload.setdefault("mode", "training")
        interview_payload["summary_report"] = _normalise_summary_record(
            interview_payload.get("summary_report")
        )
        self._interviews[interview_id] = {"id": interview_id, "userId": user_id, **interview_payload}
        return interview_id

    def get_interview(self, interview_id: str) -> Optional[Dict]:
        record = self._interviews.get(interview_id)
        if not record:
            return None
        normalized = deepcopy(record)
        normalized["transcript"] = normalize_transcript(normalized.get("transcript"))
        normalized.setdefault("mode", "training")
        normalized["summary_report"] = _normalise_summary_record(normalized.get("summary_report"))
        return normalized

    def update_interview(self, interview_id: str, data: Dict) -> None:
        if interview_id not in self._interviews:
            raise KeyError(f"Interview {interview_id} not found")
        update = deepcopy(data)
        if "transcript" in update:
            update["transcript"] = normalize_transcript(update.get("transcript"))
        if "summary_report" in update:
            update["summary_report"] = _normalise_summary_record(update.get("summary_report"))
        self._interviews[interview_id].update(update)

    def append_transcript_entry(self, interview_id: str, entry: Dict) -> None:
        if interview_id not in self._interviews:
            raise KeyError(f"Interview {interview_id} not found")
        transcript = self._interviews[interview_id].setdefault("transcript", [])
        transcript.append(deepcopy(entry))

    def list_interviews(self, user_id: str) -> List[Dict]:
        results: List[Dict] = []
        for iid, data in self._interviews.items():
            if data["userId"] != user_id:
                continue
            record = deepcopy(data)
            record["id"] = iid
            record["transcript"] = normalize_transcript(record.get("transcript"))
            record.setdefault("mode", "training")
            record["summary_report"] = _normalise_summary_record(record.get("summary_report"))
            results.append(record)
        results.sort(key=lambda item: item.get("created_at") or "", reverse=True)
        return results

    def clear_interviews(self, user_id: str) -> None:
        ids_to_delete = [iid for iid, data in self._interviews.items() if data.get("userId") == user_id]
        for iid in ids_to_delete:
            self._interviews.pop(iid, None)


class SQLiteDatabaseService:
    """SQLite-backed persistence for local development."""

    def __init__(self, db_path: str):
        path = Path(db_path)
        if path.parent and not path.parent.exists():
            path.parent.mkdir(parents=True, exist_ok=True)

        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = Lock()
        self._initialise_schema()

    def _initialise_schema(self) -> None:
        with self._conn:
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS users (
                    user_id TEXT PRIMARY KEY,
                    password_hash TEXT NOT NULL
                )
                """
            )
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS interviews (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    last_question TEXT,
                    last_question_audio_url TEXT,
                    mode TEXT NOT NULL DEFAULT 'training',
                    summary_report TEXT,
                    setup_json TEXT NOT NULL,
                    transcript_json TEXT NOT NULL,
                    FOREIGN KEY(user_id) REFERENCES users(user_id)
                )
                """
            )
        self._maybe_migrate_users_table()
        self._maybe_migrate_interviews_table()

    def _maybe_migrate_users_table(self) -> None:
        columns = {
            row["name"]
            for row in self._conn.execute("PRAGMA table_info(users)").fetchall()
        }
        if "email" in columns and "user_id" not in columns:
            logger.info("Migrating SQLite users table to user_id schema")
            with self._lock, self._conn:
                self._conn.execute("ALTER TABLE users RENAME TO users_old")
                self._conn.execute(
                    """
                    CREATE TABLE users (
                        user_id TEXT PRIMARY KEY,
                        password_hash TEXT NOT NULL
                    )
                    """
                )
                self._conn.execute(
                    "INSERT INTO users (user_id, password_hash) SELECT email, password_hash FROM users_old"
                )
                self._conn.execute("DROP TABLE users_old")

    def _maybe_migrate_interviews_table(self) -> None:
        columns = {
            row["name"]
            for row in self._conn.execute("PRAGMA table_info(interviews)").fetchall()
        }
        if "last_question_audio_url" not in columns:
            logger.info("Adding last_question_audio_url column to interviews table")
            with self._lock, self._conn:
                self._conn.execute("ALTER TABLE interviews ADD COLUMN last_question_audio_url TEXT")
        if "mode" not in columns:
            logger.info("Adding mode column to interviews table")
            with self._lock, self._conn:
                self._conn.execute("ALTER TABLE interviews ADD COLUMN mode TEXT NOT NULL DEFAULT 'training'")
        if "summary_report" not in columns:
            logger.info("Adding summary_report column to interviews table")
            with self._lock, self._conn:
                self._conn.execute("ALTER TABLE interviews ADD COLUMN summary_report TEXT")

    def _deserialize_transcript(self, value) -> List[Dict[str, str]]:
        if value is None:
            return []
        try:
            raw = json.loads(value) if isinstance(value, str) else value
        except json.JSONDecodeError:
            raw = []
        return normalize_transcript(raw)

    def create_user(self, user_id: str, password_hash: str) -> None:
        with self._lock:
            try:
                with self._conn:
                    self._conn.execute(
                        "INSERT INTO users (user_id, password_hash) VALUES (?, ?)",
                        (user_id, password_hash),
                    )
            except sqlite3.IntegrityError as exc:
                raise ValueError("User already exists") from exc

    def get_user(self, user_id: str) -> Optional[Dict]:
        cursor = self._conn.execute(
            "SELECT user_id, password_hash FROM users WHERE user_id = ?",
            (user_id,),
        )
        row = cursor.fetchone()
        if not row:
            return None
        return {"user_id": row["user_id"], "password_hash": row["password_hash"]}

    def create_interview(self, user_id: str, payload: Dict) -> str:
        interview_id = str(uuid4())
        transcript = normalize_transcript(payload.get("transcript", []))
        with self._lock, self._conn:
            self._conn.execute(
                """
                INSERT INTO interviews (
                    id, user_id, created_at, last_question, last_question_audio_url, setup_json, transcript_json, mode, summary_report
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    interview_id,
                    user_id,
                    payload.get("created_at"),
                    payload.get("last_question"),
                    payload.get("last_question_audio_url"),
                    json.dumps(payload.get("setup", {}), ensure_ascii=False),
                    json.dumps(transcript, ensure_ascii=False),
                    payload.get("mode") or "training",
                    _serialise_summary_record(payload.get("summary_report")),
                ),
            )
        return interview_id

    def get_interview(self, interview_id: str) -> Optional[Dict]:
        cursor = self._conn.execute(
            """
            SELECT id, user_id, created_at, last_question, last_question_audio_url, mode, summary_report, setup_json, transcript_json
            FROM interviews WHERE id = ?
            """,
            (interview_id,),
        )
        row = cursor.fetchone()
        if not row:
            return None
        return {
            "id": row["id"],
            "userId": row["user_id"],
            "created_at": row["created_at"],
            "last_question": row["last_question"],
            "last_question_audio_url": row["last_question_audio_url"],
            "mode": row["mode"] or "training",
            "summary_report": _normalise_summary_record(row["summary_report"]),
            "setup": json.loads(row["setup_json"]),
            "transcript": self._deserialize_transcript(row["transcript_json"]),
        }

    def update_interview(self, interview_id: str, data: Dict) -> None:
        if self.get_interview(interview_id) is None:
            raise KeyError(f"Interview {interview_id} not found")

        fields = []
        params: List[Any] = []

        if "last_question" in data:
            fields.append("last_question = ?")
            params.append(data.get("last_question"))
        if "last_question_audio_url" in data:
            fields.append("last_question_audio_url = ?")
            params.append(data.get("last_question_audio_url"))
        if "mode" in data:
            fields.append("mode = ?")
            params.append(data.get("mode") or "training")
        if "summary_report" in data:
            fields.append("summary_report = ?")
            params.append(_serialise_summary_record(data.get("summary_report")))
        if "transcript" in data:
            fields.append("transcript_json = ?")
            params.append(json.dumps(normalize_transcript(data.get("transcript")), ensure_ascii=False))

        if not fields:
            return

        params.append(interview_id)

        with self._lock, self._conn:
            self._conn.execute(
                f"UPDATE interviews SET {', '.join(fields)} WHERE id = ?",
                params,
            )

    def append_transcript_entry(self, interview_id: str, entry: Dict) -> None:
        interview = self.get_interview(interview_id)
        if interview is None:
            raise KeyError(f"Interview {interview_id} not found")

        transcript = interview.get("transcript", [])
        transcript.append(entry)

        with self._lock, self._conn:
            self._conn.execute(
                """
                UPDATE interviews
                SET transcript_json = ?
                WHERE id = ?
                """,
                (
                    json.dumps(normalize_transcript(transcript), ensure_ascii=False),
                    interview_id,
                ),
            )

    def list_interviews(self, user_id: str) -> List[Dict]:
        cursor = self._conn.execute(
            """
            SELECT id, user_id, created_at, last_question, last_question_audio_url, mode, summary_report, setup_json, transcript_json
            FROM interviews
            WHERE user_id = ?
            ORDER BY created_at DESC
            """,
            (user_id,),
        )
        items = []
        for row in cursor.fetchall():
            items.append(
                {
                    "id": row["id"],
                    "userId": row["user_id"],
                    "created_at": row["created_at"],
                    "last_question": row["last_question"],
                    "last_question_audio_url": row["last_question_audio_url"],
                    "mode": row["mode"] or "training",
                    "summary_report": _normalise_summary_record(row["summary_report"]),
                    "setup": json.loads(row["setup_json"]),
                    "transcript": self._deserialize_transcript(row["transcript_json"]),
                }
            )
        return items

    def clear_interviews(self, user_id: str) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                """
                DELETE FROM interviews
                WHERE user_id = ?
                """,
                (user_id,),
            )


class CosmosDatabaseService:
    """Azure Cosmos DB implementation backed by SQL API containers."""

    def __init__(self, settings: Settings):
        if CosmosClient is None:
            raise RuntimeError("azure-cosmos package is required for CosmosDatabaseService")

        required = [
            settings.cosmos_account_uri,
            settings.cosmos_account_key,
            settings.cosmos_database_name,
            settings.cosmos_users_container,
            settings.cosmos_interviews_container,
        ]
        if not all(required):
            raise ValueError("Cosmos DB configuration is incomplete")

        self._users_partition_key_field = settings.cosmos_users_partition_key.lstrip("/")
        self._interviews_partition_key_field = settings.cosmos_interviews_partition_key.lstrip("/")

        self._client = CosmosClient(settings.cosmos_account_uri, credential=settings.cosmos_account_key)
        self._database = self._client.get_database_client(settings.cosmos_database_name)
        self._users_container = self._database.get_container_client(settings.cosmos_users_container)
        self._interviews_container = self._database.get_container_client(settings.cosmos_interviews_container)

    def create_user(self, user_id: str, password_hash: str) -> None:
        document = {
            "id": user_id,
            "userId": user_id,
            "password_hash": password_hash,
        }
        partition_value = document.get(self._users_partition_key_field)
        if partition_value is None:
            partition_value = document.get("id")
        try:
            self._users_container.create_item(body=document, partition_key=partition_value)
        except exceptions.CosmosResourceExistsError:
            raise ValueError("User already exists") from None

    def get_user(self, user_id: str) -> Optional[Dict]:
        try:
            document = self._users_container.read_item(item=user_id, partition_key=user_id)
        except exceptions.CosmosResourceNotFoundError:
            return None
        clean = self._sanitise_document(document)
        return {
            "user_id": clean.get("id") or clean.get("userId"),
            "password_hash": clean.get("password_hash"),
        }

    def create_interview(self, user_id: str, payload: Dict) -> str:
        interview_id = str(uuid4())
        payload_copy = deepcopy(payload)
        payload_copy["transcript"] = normalize_transcript(payload_copy.get("transcript", []))
        payload_copy.setdefault("mode", "training")
        payload_copy["summary_report"] = _normalise_summary_record(payload_copy.get("summary_report"))
        document = {
            "id": interview_id,
            "userId": user_id,
            **payload_copy,
        }
        partition_value = document[self._interviews_partition_key_field]
        self._interviews_container.create_item(body=document, partition_key=partition_value)
        return interview_id

    def get_interview(self, interview_id: str) -> Optional[Dict]:
        query = "SELECT * FROM c WHERE c.id = @id"
        items = list(
            self._interviews_container.query_items(
                query=query,
                parameters=[{"name": "@id", "value": interview_id}],
                enable_cross_partition_query=True,
            )
        )
        if not items:
            return None
        return self._sanitise_document(items[0])

    def update_interview(self, interview_id: str, data: Dict) -> None:
        document = self.get_interview(interview_id)
        if document is None:
            raise KeyError(f"Interview {interview_id} not found")
        update_payload = deepcopy(data)
        if "summary_report" in update_payload:
            update_payload["summary_report"] = _normalise_summary_record(update_payload.get("summary_report"))
        document.update(update_payload)
        partition_value = document[self._interviews_partition_key_field]
        self._interviews_container.replace_item(
            item=document["id"],
            body=document,
            partition_key=partition_value,
        )

    def append_transcript_entry(self, interview_id: str, entry: Dict) -> None:
        document = self.get_interview(interview_id)
        if document is None:
            raise KeyError(f"Interview {interview_id} not found")
        transcript = document.setdefault("transcript", [])
        transcript.append(deepcopy(entry))
        partition_value = document[self._interviews_partition_key_field]
        self._interviews_container.replace_item(
            item=document["id"],
            body=document,
            partition_key=partition_value,
        )

    def list_interviews(self, user_id: str) -> List[Dict]:
        query = "SELECT * FROM c WHERE c.userId = @user_id ORDER BY c.created_at DESC"
        items = self._interviews_container.query_items(
            query=query,
            parameters=[{"name": "@user_id", "value": user_id}],
            enable_cross_partition_query=True,
        )
        return [self._sanitise_document(item) for item in items]

    def clear_interviews(self, user_id: str) -> None:
        query = "SELECT c.id, c.userId FROM c WHERE c.userId = @user_id"
        items = self._interviews_container.query_items(
            query=query,
            parameters=[{"name": "@user_id", "value": user_id}],
            enable_cross_partition_query=True,
        )
        for item in items:
            partition_value = item.get(self._interviews_partition_key_field) or item.get("userId")
            self._interviews_container.delete_item(item=item["id"], partition_key=partition_value)

    @staticmethod
    def _sanitise_document(document: Dict) -> Dict:
        """Remove Cosmos DB metadata keys from the document."""
        clean = {}
        for key, value in document.items():
            if key.startswith("_"):
                continue
            if key == "transcript":
                clean[key] = normalize_transcript(value)
            else:
                clean[key] = value
        if "mode" not in clean or not clean.get("mode"):
            clean["mode"] = "training"
        clean["summary_report"] = _normalise_summary_record(clean.get("summary_report"))
        return clean
