import logging
import math
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, UploadFile, status
from fastapi import File as FastAPIFile
from fastapi import Form
from pydantic import BaseModel, Field

from app.dependencies import (
    get_ai_service,
    get_current_user,
    get_db_service,
)
from app.services.ai import AIService
from app.services.db import DatabaseService, normalize_transcript, _normalise_summary_record


logger = logging.getLogger(__name__)

DEBUG_AUDIO_DIR = Path("tmp/audio_debug")
DEBUG_AUDIO_DIR.mkdir(parents=True, exist_ok=True)


def _feedback_snippet(text: Optional[str]) -> Optional[str]:
    if not text:
        return None
    for line in str(text).splitlines():
        snippet = line.strip() #冒頭の空白を削除
        if snippet: #もしsnippetが空じゃない
            return snippet[:140]
    return None


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    interview_id: str = Field(..., alias="interviewId")
    user_message: str = Field(..., alias="userMessage")
    chat_history: Optional[List[ChatMessage]] = Field(None, alias="chatHistory")

    class Config:
        allow_population_by_field_name = True #JavaScriptとPythonスタイルも対応できる


class ChatResponse(BaseModel):
    ai_message: str = Field(..., alias="aiMessage")
    ai_message_text: Optional[str] = Field(None, alias="aiMessageText")
    ai_audio_url: Optional[str] = Field(None, alias="aiAudioUrl")
    feedback: Optional[str] = Field(None, alias="feedback")
    next_question: Optional[str] = Field(None, alias="nextQuestion")
    next_question_audio_url: Optional[str] = Field(None, alias="nextQuestionAudioUrl")
    user_transcript: Optional[str] = Field(None, alias="userTranscript")

    class Config:
        allow_population_by_field_name = True


class InterviewSetupRequest(BaseModel):
    interview_type: str = Field(..., alias="interviewType")
    target_industry: str = Field(..., alias="targetIndustry")
    mode: str = Field(..., alias="mode")

    class Config:
        allow_population_by_field_name = True


class InterviewStartResponse(BaseModel):
    interview_id: str = Field(..., alias="interviewId")
    question_text: str = Field(..., alias="questionText")
    audio_url: Optional[str] = Field(None, alias="audioUrl")
    mode: str = Field(..., alias="mode")

    class Config:
        allow_population_by_field_name = True


class ProcessAnswerRequest(BaseModel):
    interview_id: str = Field(..., alias="interviewId")
    answer_text: str = Field(..., alias="answerText")

    class Config:
        allow_population_by_field_name = True


class ProcessAnswerResponse(BaseModel):
    feedback: str
    next_question_text: str = Field(..., alias="nextQuestionText")
    next_question_audio_url: Optional[str] = Field(None, alias="nextQuestionAudioUrl")

    class Config:
        allow_population_by_field_name = True


class InterviewSummary(BaseModel):
    id: str
    created_at: str = Field(..., alias="createdAt")
    setup: dict
    transcript: List[dict] #入力Hint、内容はJSON
    last_question: Optional[str] = Field(None, alias="lastQuestion")
    last_question_audio_url: Optional[str] = Field(None, alias="lastQuestionAudioUrl")
    mode: Optional[str] = Field(None, alias="mode")
    summary_report: Optional[Dict[str, Any]] = Field(None, alias="summaryReport")

    class Config:
        allow_population_by_field_name = True


class DashboardStats(BaseModel):
    total_sessions: int = Field(..., alias="totalSessions")
    avg_score: float = Field(..., alias="avgScore")
    total_time_minutes: int = Field(..., alias="totalTimeMinutes")
    skills: Dict[str, float] = Field(default_factory=dict)

    class Config:
        allow_population_by_field_name = True


class InterviewFinishResponse(BaseModel):
    summary: str

    class Config:
        allow_population_by_field_name = True


router = APIRouter(prefix="/interviews", tags=["interviews"])
chat_router = APIRouter(tags=["chat"])
#tupleは変更できないList
SKILL_KEYS: tuple[str, ...] = ("logic", "specificity", "expression", "proactive", "selfaware")


def _ensure_chat_transcript(transcript) -> List[dict]:
    return normalize_transcript(transcript)


def _default_skills() -> Dict[str, float]:
    return {key: 0.0 for key in SKILL_KEYS}


def _get_user_interview_or_404(
    db: DatabaseService,
    interview_id: str,
    user: dict,
) -> Dict[str, Any]:
    interview = db.get_interview(interview_id)
    if interview is None or interview.get("userId") != user["user_id"]:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Interview not found")
    return interview


def _extract_summary_data(summary: Any) -> Optional[Dict[str, Any]]:
    return _normalise_summary_record(summary)


def _parse_timestamp(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(float(value))
        except (OSError, ValueError):
            return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            return datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            for pattern in ("%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S"):
                try:
                    return datetime.strptime(text, pattern)
                except ValueError:
                    continue
    return None


def _compute_interview_duration_seconds(interview: Dict[str, Any]) -> int:
    timestamps = _accumulate_transcript_timestamps(interview)
    if len(timestamps) < 2:
        return 0
    return max(0, int((max(timestamps) - min(timestamps)).total_seconds()))


def _accumulate_transcript_timestamps(interview: Dict[str, Any]) -> List[datetime]:
    timestamps: List[datetime] = []
    created = _parse_timestamp(interview.get("created_at") or interview.get("createdAt"))
    if created:
        timestamps.append(created)
    transcript = interview.get("transcript") or []
    for entry in transcript:
        if not isinstance(entry, dict):
            continue
        ts = _parse_timestamp(entry.get("timestamp"))
        if ts:
            timestamps.append(ts)
    return timestamps


def _build_training_transcript_entry(
    question_text: str,
    answer_text: str,
    feedback_text: Optional[str],
    question_audio_url: str,
    next_question_text: str,
    next_question_audio_url: str,
    timestamp: str,
) -> Dict[str, Any]:
    return {
        "question": question_text,
        "answer": answer_text,
        "feedback": feedback_text,
        "feedbackSnippet": _feedback_snippet(feedback_text),
        "questionAudioUrl": question_audio_url,
        "nextQuestion": next_question_text,
        "nextQuestionAudioUrl": next_question_audio_url,
        "timestamp": timestamp,
    }


def _persist_training_turn(
    db: DatabaseService,
    interview_id: str,
    transcript_entry: Dict[str, Any],
    next_question_text: str,
    next_question_audio_url: str,
) -> None:
    try:
        db.append_transcript_entry(interview_id, transcript_entry)
        db.update_interview(
            interview_id,
            {
                "last_question": next_question_text,
                "last_question_audio_url": next_question_audio_url,
            },
        )
    except KeyError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Interview not found") from None


@router.post("/start", response_model=InterviewStartResponse, status_code=status.HTTP_201_CREATED)
async def start_interview(
    request: InterviewSetupRequest,
    user: dict = Depends(get_current_user),
    db: DatabaseService = Depends(get_db_service),
    ai_service: AIService = Depends(get_ai_service),
) -> InterviewStartResponse:
    """Start a new interview session for the current user."""
    # Rotate to the next Gemini API key for load balancing
    ai_service.rotate_gemini_key()

    setup_payload = request.dict(by_alias=True)
    setup_payload.pop("mode", None)
    question_payload = ai_service.generate_initial_question(setup_payload)
    initial_question = question_payload.get("question_text") or "自己紹介をお願いします。"
    question_audio_url = question_payload.get("audio_url") or ""
    mode = (request.mode or "training").lower()
    if mode not in {"training", "interview"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid mode selected.")
    created_at = datetime.utcnow().isoformat(timespec="seconds")
    transcript = []
    if initial_question:
        ai_entry = {
            "role": "ai",
            "content": initial_question,
            "type": "question",
            "timestamp": created_at,
        }
        if question_audio_url:
            ai_entry["audioUrl"] = question_audio_url
        transcript.append(ai_entry)

    interview_payload = {
        "setup": setup_payload,
        "transcript": transcript,
        "created_at": created_at,
        "last_question": initial_question,
        "last_question_audio_url": question_audio_url,
        "mode": mode,
        "summary_report": None,
    }
    interview_id = db.create_interview(user_id=user["user_id"], payload=interview_payload)

    return InterviewStartResponse(
        interviewId=interview_id,
        questionText=initial_question,
        audioUrl=question_payload.get("audio_url"),
        mode=mode,
    )


@router.post("/process", response_model=ProcessAnswerResponse)
async def process_answer(
    request: ProcessAnswerRequest,
    user: dict = Depends(get_current_user),
    db: DatabaseService = Depends(get_db_service),
    ai_service: AIService = Depends(get_ai_service),
) -> ProcessAnswerResponse:
    """Process an interview answer and return feedback plus next question."""
    interview = _get_user_interview_or_404(db, request.interview_id, user)

    mode = (interview.get("mode") or "training").lower()
    timestamp = datetime.utcnow().isoformat(timespec="seconds")

    if mode == "interview":
        transcript = _ensure_chat_transcript(interview.get("transcript", []))
        user_entry = {
            "role": "user",
            "content": request.answer_text,
            "type": "answer",
            "timestamp": timestamp,
        }
        transcript.append(user_entry)

        try:
            ai_result = ai_service.chat_response(transcript, mode="interview")
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("AI chat response failed: %s", exc)
            db.update_interview(request.interview_id, {"transcript": transcript})
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="AIサービスの呼び出しに失敗しました。")

        ai_entry = {
            "role": "ai",
            "content": ai_result["ai_message_text"],
            "type": "question",
            "timestamp": datetime.utcnow().isoformat(timespec="seconds"),
        }
        if ai_result.get("next_question_audio_url"):
            ai_entry["audioUrl"] = ai_result.get("next_question_audio_url")
        transcript.append(ai_entry)

        db.update_interview(
            request.interview_id,
            {
                "transcript": transcript,
                "last_question": ai_result.get("next_question"),
                "last_question_audio_url": ai_result.get("next_question_audio_url"),
            },
        )

        return ProcessAnswerResponse(
            feedback="",
            nextQuestionText=ai_result.get("next_question", ""),
            nextQuestionAudioUrl=ai_result.get("next_question_audio_url"),
        )

    question_text = interview.get("last_question", "")
    question_audio_url = interview.get("last_question_audio_url") or ""
    ai_result = ai_service.analyze_answer(request.answer_text, request.interview_id)
    next_question_text = ai_result.get("next_question_text", "")
    next_question_audio_url = ai_result.get("next_question_audio_url") or ""
    feedback_text = ai_result.get("feedback")

    transcript_entry = _build_training_transcript_entry(
        question_text=question_text,
        answer_text=ai_result.get("transcript") or request.answer_text,
        feedback_text=feedback_text,
        question_audio_url=question_audio_url,
        next_question_text=next_question_text,
        next_question_audio_url=next_question_audio_url,
        timestamp=timestamp,
    )
    _persist_training_turn(
        db,
        request.interview_id,
        transcript_entry,
        next_question_text,
        next_question_audio_url,
    )

    return ProcessAnswerResponse(
        feedback=ai_result.get("feedback", ""),
        nextQuestionText=ai_result.get("next_question_text", ""),
        nextQuestionAudioUrl=ai_result.get("next_question_audio_url"),
    )


@chat_router.post("/chat", response_model=ChatResponse)
def chat_endpoint(
    request: ChatRequest,
    user: dict = Depends(get_current_user),
    db: DatabaseService = Depends(get_db_service),
    ai_service: AIService = Depends(get_ai_service),
) -> ChatResponse:
    interview_id = request.interview_id
    if not interview_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="interviewId is required")

    interview = _get_user_interview_or_404(db, interview_id, user)

    user_message = (request.user_message or "").strip()
    if not user_message:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="ユーザー入力が必要です。")

    mode = (interview.get("mode") or "training").lower()
    transcript = _ensure_chat_transcript(interview.get("transcript", []))
    user_timestamp = datetime.utcnow().isoformat(timespec="seconds")

    user_entry = {
        "role": "user",
        "content": user_message,
        "type": "answer",
        "timestamp": user_timestamp,
    }
    transcript.append(user_entry)

    try:
        ai_result = ai_service.chat_response(transcript, mode=mode)
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("AI chat response failed: %s", exc)
        db.update_interview(interview_id, {"transcript": transcript})
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="AIサービスの呼び出しに失敗しました。")

    timestamp = datetime.utcnow().isoformat(timespec="seconds")
    ai_message_text = ai_result.get("ai_message_text", "")
    ai_audio_url = ai_result.get("ai_audio_url") or ""

    if mode == "interview":
        ai_entry = {
            "role": "ai",
            "content": ai_message_text,
            "type": "question",
            "timestamp": timestamp,
        }
        if ai_audio_url:
            ai_entry["audioUrl"] = ai_audio_url
    else:
        ai_entry = {
            "role": "ai",
            "content": ai_message_text,
            "type": "feedback",
            "feedback": ai_result.get("feedback"),
            "nextQuestion": ai_result.get("next_question"),
            "nextQuestionAudioUrl": ai_result.get("next_question_audio_url"),
            "feedbackSnippet": _feedback_snippet(ai_result.get("feedback")),
            "timestamp": timestamp,
        }
        if ai_audio_url:
            ai_entry["audioUrl"] = ai_audio_url

    transcript.append(ai_entry)

    db.update_interview(
        interview_id,
        {
            "transcript": transcript,
            "last_question": ai_result.get("next_question"),
            "last_question_audio_url": ai_result.get("next_question_audio_url"),
        },
    )

    if not ai_audio_url:
        ai_audio_url = ai_result.get("next_question_audio_url") or ""

    return ChatResponse(
        aiMessage=ai_message_text,
        aiMessageText=ai_message_text,
        aiAudioUrl=ai_audio_url or None,
        feedback=None if mode == "interview" else ai_result.get("feedback"),
        nextQuestion=ai_result.get("next_question"),
        nextQuestionAudioUrl=ai_result.get("next_question_audio_url"),
        userTranscript=user_message,
    )


@router.post("/process_audio", response_model=ProcessAnswerResponse)
async def process_audio_answer(
    interview_id: str = Form(..., alias="interviewId"),
    audio_file: UploadFile = FastAPIFile(..., alias="audio"),
    user: dict = Depends(get_current_user),
    db: DatabaseService = Depends(get_db_service),
    ai_service: AIService = Depends(get_ai_service),
) -> ProcessAnswerResponse:
    """Process an audio answer using MediaRecorder payload."""
    interview = _get_user_interview_or_404(db, interview_id, user)

    audio_bytes = await audio_file.read()
    debug_path = None
    if audio_bytes:
        debug_path = DEBUG_AUDIO_DIR / f"process_{datetime.utcnow().strftime('%Y%m%dT%H%M%S')}_{uuid4().hex}.wav"
        try:
            debug_path.write_bytes(audio_bytes)
            logger.info("Saved process_audio payload: %s (%s bytes)", debug_path, len(audio_bytes))
        except Exception as exc:
            logger.warning("Failed to persist process_audio debug file: %s", exc)
    audio_content_type = getattr(audio_file, "content_type", None)
    if not audio_bytes:
        audio_bytes = b""
    mode = (interview.get("mode") or "training").lower()
    timestamp = datetime.utcnow().isoformat(timespec="seconds")

    if mode == "interview":
        transcript = _ensure_chat_transcript(interview.get("transcript", []))
        transcript_text = ai_service._transcribe_audio(audio_bytes, audio_content_type) if ai_service else ""
        user_entry = {
            "role": "user",
            "content": transcript_text or "[音声回答]",
            "type": "answer",
            "timestamp": timestamp,
        }
        if audio_content_type:
            user_entry["mediaContentType"] = audio_content_type
        transcript.append(user_entry)

        try:
            ai_result = ai_service.chat_response(transcript, mode="interview")
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("AI chat response failed: %s", exc)
            db.update_interview(interview_id, {"transcript": transcript})
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="AIサービスの呼び出しに失敗しました。")

        ai_entry = {
            "role": "ai",
            "content": ai_result["ai_message_text"],
            "type": "question",
            "timestamp": datetime.utcnow().isoformat(timespec="seconds"),
        }
        if ai_result.get("next_question_audio_url"):
            ai_entry["audioUrl"] = ai_result.get("next_question_audio_url")
        transcript.append(ai_entry)

        db.update_interview(
            interview_id,
            {
                "transcript": transcript,
                "last_question": ai_result.get("next_question"),
                "last_question_audio_url": ai_result.get("next_question_audio_url"),
            },
        )

        return ProcessAnswerResponse(
            feedback="",
            nextQuestionText=ai_result.get("next_question", ""),
            nextQuestionAudioUrl=ai_result.get("next_question_audio_url"),
        )

    ai_result = ai_service.analyze_answer(audio_bytes, interview_id, content_type=audio_content_type)

    question_text = interview.get("last_question", "")
    question_audio_url = interview.get("last_question_audio_url") or ""
    next_question_text = ai_result.get("next_question_text", "")
    next_question_audio_url = ai_result.get("next_question_audio_url") or ""
    feedback_text = ai_result.get("feedback")
    transcript_entry = _build_training_transcript_entry(
        question_text=question_text,
        answer_text=ai_result.get("transcript") or "[音声回答]",
        feedback_text=feedback_text,
        question_audio_url=question_audio_url,
        next_question_text=next_question_text,
        next_question_audio_url=next_question_audio_url,
        timestamp=timestamp,
    )
    _persist_training_turn(
        db,
        interview_id,
        transcript_entry,
        next_question_text,
        next_question_audio_url,
    )

    return ProcessAnswerResponse(
        feedback=ai_result.get("feedback", ""),
        nextQuestionText=ai_result.get("next_question_text", ""),
        nextQuestionAudioUrl=ai_result.get("next_question_audio_url"),
    )


@router.get("/", response_model=List[InterviewSummary])
async def list_interviews(
    user: dict = Depends(get_current_user),
    db: DatabaseService = Depends(get_db_service),
) -> List[InterviewSummary]:
    """Return all interviews recorded for the current user."""
    interviews = db.list_interviews(user["user_id"])
    return [
        InterviewSummary(
            id=interview["id"],
            createdAt=interview.get("created_at", ""),
            setup=interview.get("setup", {}),
            transcript=interview.get("transcript", []),
            lastQuestion=interview.get("last_question"),
            lastQuestionAudioUrl=interview.get("last_question_audio_url"),
            mode=interview.get("mode"),
            summaryReport=interview.get("summary_report"),
        )
        for interview in interviews
    ]


@router.get("/stats", response_model=DashboardStats)
async def get_dashboard_stats(
    user: dict = Depends(get_current_user),
    db: DatabaseService = Depends(get_db_service),
) -> DashboardStats:
    interviews = db.list_interviews(user["user_id"])

    total_sessions = len(interviews)
    total_scores = 0.0
    score_count = 0
    total_duration_seconds = 0
    skill_sums = {key: 0.0 for key in SKILL_KEYS}
    skill_counts = {key: 0 for key in SKILL_KEYS}

    for interview in interviews:
        summary = _extract_summary_data(interview.get("summary_report"))
        if summary:
            score = summary.get("score") or summary.get("overallScore")
            if score is not None:
                try:
                    score_value = float(score)
                except (TypeError, ValueError):
                    score_value = None
                if score_value is not None and math.isfinite(score_value):
                    total_scores += score_value
                    score_count += 1

            duration_value = summary.get("durationSeconds") or summary.get("duration_seconds")
            duration_seconds = None
            if duration_value is not None:
                try:
                    duration_seconds = int(duration_value)
                except (TypeError, ValueError):
                    duration_seconds = None
            if duration_seconds is None or duration_seconds <= 0:
                duration_seconds = _compute_interview_duration_seconds(interview)
            if duration_seconds:
                total_duration_seconds += max(0, duration_seconds)

            skills = summary.get("skills") or {}
            if isinstance(skills, dict):
                for key in SKILL_KEYS:
                    if key not in skills:
                        continue
                    try:
                        skill_value = float(skills[key])
                    except (TypeError, ValueError):
                        continue
                    if not math.isfinite(skill_value):
                        continue
                    skill_sums[key] += skill_value
                    skill_counts[key] += 1
        else:
            total_duration_seconds += _compute_interview_duration_seconds(interview)

    avg_score = round(total_scores / score_count, 1) if score_count else 0.0
    total_time_minutes = int(round(total_duration_seconds / 60)) if total_duration_seconds else 0
    skill_averages = {
        key: (round(skill_sums[key] / skill_counts[key], 1) if skill_counts[key] else 0.0)
        for key in SKILL_KEYS
    }

    return DashboardStats(
        totalSessions=total_sessions,
        avgScore=avg_score,
        totalTimeMinutes=total_time_minutes,
        skills=skill_averages,
    )


@router.post("/{interview_id}/finish", response_model=InterviewFinishResponse)
async def finish_interview(
    interview_id: str,
    user: dict = Depends(get_current_user),
    db: DatabaseService = Depends(get_db_service),
    ai_service: AIService = Depends(get_ai_service),
) -> InterviewFinishResponse:
    interview = db.get_interview(interview_id)
    if interview is None or interview.get("userId") != user["user_id"]:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Interview not found")

    mode = (interview.get("mode") or "training").lower()
    if mode != "interview":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="面接モードのみサマリーを生成できます。")

    summary_payload = ai_service.generate_summary(interview.get("transcript", []))
    if isinstance(summary_payload, dict):
        summary_data = summary_payload
    else:
        summary_data = {"text": str(summary_payload or "")}

    normalised_summary = _extract_summary_data(summary_data) or {"text": str(summary_payload or "")}
    if not isinstance(normalised_summary.get("skills"), dict):
        normalised_summary["skills"] = {}
    duration_value = normalised_summary.get("durationSeconds") or normalised_summary.get("duration_seconds")
    if duration_value is not None:
        try:
            normalised_summary["durationSeconds"] = max(0, int(duration_value))
        except (TypeError, ValueError):
            normalised_summary.pop("durationSeconds", None)
    normalised_summary.pop("duration_seconds", None)
    db.update_interview(interview_id, {"summary_report": normalised_summary})
    summary_text = normalised_summary.get("text") or "面接のサマリーを生成できませんでした。"
    return InterviewFinishResponse(summary=summary_text)


@router.delete("/clear")
async def clear_interview_history(
    user: dict = Depends(get_current_user),
    db: DatabaseService = Depends(get_db_service),
) -> dict:
    """Delete all interviews for the current user."""
    db.clear_interviews(user["user_id"])
    return {"message": "履歴が正常にクリアされました"}
