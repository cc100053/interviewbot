import json
import logging
import math
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional
from uuid import uuid4

try:  # Azure Speech SDK
    import azure.cognitiveservices.speech as speechsdk
except ImportError:  # pragma: no cover - optional dependency
    speechsdk = None  # type: ignore

try:  # Gemini SDK
    import google.generativeai as genai
except ImportError:  # pragma: no cover - optional dependency
    genai = None  # type: ignore

from config.settings import get_settings
from app.services.db import normalize_transcript

logger = logging.getLogger(__name__)

SUMMARY_SKILL_KEYS: tuple[str, ...] = ("logic", "specificity", "expression", "proactive", "selfaware")


class AIService:
    """Service that orchestrates question generation, STT, feedback, and TTS."""

    def __init__(self) -> None:
        self.settings = get_settings()
        self.audio_dir = Path("static/audio")
        self.audio_dir.mkdir(parents=True, exist_ok=True)

        self.use_gemini = bool(genai and self.settings.gemini_api_key)
        if self.use_gemini:
            try:
                genai.configure(api_key=self.settings.gemini_api_key)
                model_name = self.settings.gemini_model_name or "models/gemini-1.5-flash-latest"
                try:
                    self.generative_model = genai.GenerativeModel(model_name)
                except Exception:
                    fallback_model = "models/gemini-1.5-flash-latest"
                    if model_name != fallback_model:
                        logger.warning("Gemini model %s unavailable, falling back to %s", model_name, fallback_model)
                        self.generative_model = genai.GenerativeModel(fallback_model)
                    else:
                        raise
            except Exception as exc:  # pragma: no cover - defensive
                logger.warning("Failed to initialise Gemini model: %s", exc)
                self.use_gemini = False

        self.use_azure = bool(
            speechsdk and self.settings.azure_speech_key and self.settings.azure_speech_region
        )
        if self.use_azure:
            try:
                self.speech_config = speechsdk.SpeechConfig(
                    subscription=self.settings.azure_speech_key,
                    region=self.settings.azure_speech_region,
                )
                voice = self.settings.azure_speech_voice or "ja-JP-NanamiNeural"
                self.speech_config.speech_synthesis_voice_name = voice
                # Default STT recognition to Japanese to match interview language.
                self.speech_config.speech_recognition_language = "ja-JP"
            except Exception as exc:  # pragma: no cover - defensive
                logger.warning("Failed to initialise Azure Speech: %s", exc)
                self.use_azure = False

    def get_status(self) -> dict:
        gemini_details = None
        if self.use_gemini:
            model = getattr(self, "generative_model", None)
            gemini_details = getattr(model, "model_name", None) if model else self.settings.gemini_model_name

        return {
            "gemini": {
                "enabled": self.use_gemini,
                "model": gemini_details,
            },
            "azure_speech": {
                "enabled": self.use_azure,
                "voice": self.settings.azure_speech_voice if self.use_azure else None,
            },
        }

    def generate_initial_question(self, setup: dict) -> dict:
        question_text = self._generate_question_text(setup)
        audio_url = None
        if self.use_azure:
            audio_url = self._synthesize_text(question_text)
        if audio_url is None:
            audio_url = ""
        return {
            "question_text": question_text,
            "audio_url": audio_url,
        }

    def analyze_answer(self, answer_payload, interview_id: str, content_type: Optional[str] = None) -> dict:
        """Accept either text (str) or audio bytes and return feedback + next question."""

        if isinstance(answer_payload, bytes):
            transcript = self._transcribe_audio(answer_payload, content_type)
        else:
            transcript = str(answer_payload)

        feedback, next_question = self._generate_feedback(transcript)
        next_audio_url = None
        if next_question and self.use_azure:
            next_audio_url = self._synthesize_text(next_question)

        return {
            "transcript": transcript,
            "feedback": feedback,
            "next_question_text": next_question,
            "next_question_audio_url": next_audio_url or "",
        }

    def chat_response(self, chat_history, mode: str = "training") -> dict:
        """Generate the next response based on the configured interview mode."""
        normalized_history = normalize_transcript(chat_history)
        current_mode = (mode or "training").lower()

        if current_mode == "interview":
            next_question = self._generate_interview_next_question(normalized_history)
            if not next_question:
                next_question = "志望動機を教えてください。"
            question_audio_url = ""
            if self.use_azure and next_question:
                question_audio_url = self._synthesize_text(next_question) or ""
            return {
                "ai_message_text": next_question,
                "ai_audio_url": question_audio_url,
                "feedback": "",
                "next_question": next_question,
                "next_question_audio_url": question_audio_url,
            }

        if not normalized_history:
            question = self._generate_question_text({})
            audio_url = ""
            if question and self.use_azure:
                audio_url = self._synthesize_text(question) or ""
            return {
                "ai_message_text": question,
                "ai_audio_url": audio_url,
                "feedback": "",
                "next_question": question,
                "next_question_audio_url": audio_url,
            }

        latest_message = normalized_history[-1]
        user_message = latest_message.get("content", "")
        history_text = self._build_history_text(normalized_history[:-1])

        feedback, next_question = self._generate_feedback(user_message, history_text)
        combined = f"フィードバック：\n{feedback}\n\n次の質問：\n{next_question}"
        question_audio_url = ""
        if self.use_azure and next_question:
            question_audio_url = self._synthesize_text(next_question) or ""

        return {
            "ai_message_text": combined,
            "ai_audio_url": question_audio_url,
            "feedback": feedback,
            "next_question": next_question,
            "next_question_audio_url": question_audio_url,
        }

    def generate_summary(self, transcript: List[dict]) -> Dict[str, object]:
        """Produce a final interview summary report with structured skill scores."""
        normalized_transcript = normalize_transcript(transcript)
        duration_seconds = self._estimate_duration_seconds(normalized_transcript)

        def default_summary(text: str) -> Dict[str, object]:
            return {
                "text": text,
                "score": 0.0,
                "durationSeconds": duration_seconds,
                "skills": {key: 0.0 for key in SUMMARY_SKILL_KEYS},
            }

        if not normalized_transcript:
            return default_summary("面接記録が見つからなかったため、サマリーを作成できませんでした。")

        conversation = self._build_history_text(normalized_transcript)

        if not self.use_gemini:
            return default_summary("面接のサマリーは現在利用できません。")

        summary_instruction = """
あなたは日本語の面接コーチです。以下の面接記録を分析し、要点をまとめたサマリーテキストと、候補者のパフォーマンスを示すスコアを算出してください。

必ず次のJSON形式のみで回答してください（前後に説明やマークダウンを付けないこと）:
{
  "summaryText": "日本語の文章。複数段落可。",
  "overallScore": 0-100 の数値,
  "skills": {
    "logic": 0-100 の数値,
    "specificity": 0-100 の数値,
    "expression": 0-100 の数値,
    "proactive": 0-100 の数値,
    "selfaware": 0-100 の数値
  }
}

スコアは整数または1桁小数で構いません。summaryTextには全体所感、良かった点、改善点、今後のアドバイスを含めてください。
""".strip()

        raw_response = ""
        try:
            response = self.generative_model.generate_content(
                f"{summary_instruction}\n\n=== 面接記録 ===\n{conversation}\n=== 記録ここまで ==="
            )
            raw_response = self._extract_plain_text(response)
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("Gemini summary generation request failed: %s", exc)
            return default_summary("面接のサマリーを生成できませんでした。")

        parsed = self._parse_summary_json(raw_response)
        if parsed is None:
            logger.warning("Failed to parse Gemini summary JSON: %s", raw_response[:200])
            return default_summary("面接のサマリーを生成できませんでした。")

        summary_text = str(parsed.get("summaryText") or "").strip()
        if not summary_text:
            summary_text = "面接のサマリーを生成できませんでした。"

        score_value = self._clamp_score(parsed.get("overallScore") or parsed.get("score") or 0.0)
        skills_value = self._sanitize_skill_scores(parsed.get("skills"))

        return {
            "text": summary_text,
            "score": score_value,
            "durationSeconds": duration_seconds,
            "skills": skills_value,
        }

    @staticmethod
    def _clamp_score(value, minimum: float = 0.0, maximum: float = 100.0) -> float:
        try:
            numeric = float(value)
        except (TypeError, ValueError):
            return minimum
        if not math.isfinite(numeric):
            return minimum
        return max(minimum, min(maximum, numeric))

    @staticmethod
    def _parse_timestamp(value) -> Optional[datetime]:
        if value is None:
            return None
        if isinstance(value, (int, float)):
            try:
                return datetime.fromtimestamp(float(value), tz=timezone.utc)
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
                        return datetime.strptime(text, pattern).replace(tzinfo=timezone.utc)
                    except ValueError:
                        continue
        return None

    def _estimate_duration_seconds(self, transcript: List[dict]) -> int:
        timestamps = []
        for entry in transcript:
            if not isinstance(entry, dict):
                continue
            parsed = self._parse_timestamp(entry.get("timestamp"))
            if parsed:
                timestamps.append(parsed)
        if len(timestamps) >= 2:
            duration = (max(timestamps) - min(timestamps)).total_seconds()
            if duration > 0:
                return int(duration)
        user_turns = sum(1 for entry in transcript if isinstance(entry, dict) and entry.get("role") == "user")
        if user_turns > 0:
            return user_turns * 90
        return 0

    def _sanitize_skill_scores(self, skills_payload) -> Dict[str, float]:
        sanitized: Dict[str, float] = {}
        if isinstance(skills_payload, dict):
            for key in SUMMARY_SKILL_KEYS:
                value = skills_payload.get(key)
                sanitized[key] = round(self._clamp_score(value), 1)
        else:
            sanitized = {key: 0.0 for key in SUMMARY_SKILL_KEYS}
        return sanitized

    @staticmethod
    def _extract_plain_text(response) -> str:
        text = (getattr(response, "text", None) or "").strip()
        if text:
            return text
        parts = []
        for candidate in getattr(response, "candidates", []) or []:
            content = getattr(candidate, "content", None)
            if not content:
                continue
            for part in getattr(content, "parts", []) or []:
                value = getattr(part, "text", None)
                if value:
                    parts.append(value)
        return "\n".join(parts).strip()

    @staticmethod
    def _extract_json_object(raw_text: str) -> Optional[dict]:
        if not raw_text:
            return None
        cleaned = raw_text.strip()
        if cleaned.startswith("```"):
            cleaned = re.sub(r"^```(?:json)?", "", cleaned, flags=re.IGNORECASE).strip()
            if cleaned.endswith("```"):
                cleaned = cleaned[:-3].strip()
        try:
            return json.loads(cleaned)
        except json.JSONDecodeError:
            match = re.search(r"\{.*\}", cleaned, flags=re.DOTALL)
            if not match:
                return None
            try:
                return json.loads(match.group(0))
            except json.JSONDecodeError:
                return None

    @staticmethod
    def _parse_summary_json(raw_text: str) -> Optional[dict]:
        return AIService._extract_json_object(raw_text)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _generate_interview_next_question(self, history: list[dict]) -> str:
        if not self.use_gemini:
            return "志望動機を教えてください。"

        history_text = self._build_history_text(history)
        prompt = (
            "あなたは日本語のプロの面接官です。以下はこれまでの面接の会話記録です。"
            "候補者の最新の回答内容を踏まえて、次に質問すべき内容を1つだけ日本語で生成してください。"
            "フィードバックや解説は出力せず、質問文のみを作成してください。"
            "この面接は標準的な30分を想定しています。現在の会話履歴を考慮し、既に約5〜6つの主要な質問が議論されていると判断できる場合は、"
            "新しい話題の質問ではなく、面接を締めくくる質問（例：「最後に、何か質問はありますか？」）を生成してください。"
            '必ず次のJSON形式で回答してください: {"next_question": "質問文"}'
        )
        try:
            response = self.generative_model.generate_content(
                f"{prompt}\n\nこれまでの会話:\n{history_text}"
            )
            text = self._extract_plain_text(response)
            data = self._extract_json_object(text)
            if data:
                next_question = data.get("next_question") or data.get("nextQuestion")
                if next_question:
                    return str(next_question).strip()
            lines = [line.strip() for line in text.splitlines() if line.strip()]
            return lines[0] if lines else "志望動機を教えてください。"
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("Gemini interview-mode question generation failed: %s", exc)
            return "志望動機を教えてください。"

    def _generate_question_text(self, setup: dict) -> str:
        if not self.use_gemini:
            return "自己紹介をお願いします。"

        setup = setup or {}
        interview_type = setup.get("interviewType", "一般的な面接")
        industry_and_role = setup.get("targetIndustry", "指定なし")

        persona = "あなたは日本のプロの面接官です。"
        if "一次面接" in interview_type:
            persona = (
                "あなたはHR（人事）担当者として、候補者の性格、コミュニケーションスキル、基本的なモチベーションを評価する「一次面接」を行っています。"
            )
        elif "二次面接" in interview_type:
            persona = (
                "あなたは部署のマネージャーまたはチームリーダーとして、候補者の専門スキル、経験、チーム適合性を評価する「二次面接」を行っています。"
            )
        elif "最終面接" in interview_type:
            persona = (
                "あなたは役員または社長として、候補者の長期的なカルチャーフィットと入社意欲を評価する「最終面接」を行っています。"
            )

        prompt = f"""
{persona}

以下のコンテキストに基づいて、面接の**最初の質問を1つだけ**、簡潔に日本語で生成してください。

**コンテキスト:**
- **面接タイプ:** {interview_type}
- **志望業界 & 職種:** {industry_and_role}

あなたの役割（{persona}）と、候補者の志望（{industry_and_role}）に最もふさわしい、自然な開始の質問をしてください。
(例: 「自己紹介をお願いします」や「本日はよろしくお願いします。まず、{industry_and_role}を志望された理由を教えていただけますか？」など)

質問文のみを返してください。
""".strip()

        try:
            response = self.generative_model.generate_content(prompt)
            text = (response.text or "").strip()
            return text if text else "自己紹介をお願いします。"
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("Gemini question generation failed: %s", exc)
            return "自己紹介をお願いします。"

    def _generate_feedback(self, transcript: str, history_text: Optional[str] = None) -> tuple[str, str]:
        if not self.use_gemini or not transcript:
            return (
                "フィードバックのプレースホルダーです。",
                "志望動機を教えてください。",
            )

        system_prompt = """
You are an expert Japanese interview coach (面接コーチ) conducting a realistic but supportive practice interview simulation in Japanese. Your primary goal is to help the user improve their interview skills for the Japanese job market.

**Your Role:**
* Act as a professional interviewer appropriate for the specified interview type and industry (if provided in context).
* Provide constructive, actionable feedback after each user answer.
* Guide the user towards better responses by explaining *why* certain approaches are more effective.
* Pay special attention to Japanese language use (敬語 - keigo, 言葉遣い - kotobazukai), especially if the user seems non-native, offering polite corrections and suggestions.
* Ask logical, relevant follow-up questions based on the user's answers and the overall interview flow.

**Analysis and Feedback Process:**
When analyzing the user's latest response (provided in the prompt context, along with previous history):
1.  **Acknowledge:** Briefly acknowledge the user's answer positively if appropriate (e.g., "ありがとうございます。", "なるほど。").
2.  **Evaluate Content:**
    * Assess clarity, structure, and relevance to the question.
    * For behavioral questions, check if the STAR method (Situation, Task, Action, Result - 状況、課題、行動、結果) was used effectively. If not, suggest incorporating it.
    * Identify strengths and weaknesses in the content.
    * Provide 1-2 specific, actionable suggestions for improvement. Explain *why* the suggestion would make the answer stronger (e.g., "Adding a specific metric would make the result more impactful.").
3.  **Evaluate Japanese Language (if necessary):**
    * Gently point out significant or repeated errors in politeness level (敬語), word choice (言葉遣い), or unnatural phrasing.
    * Offer specific, polite corrections or alternative phrasings (e.g., "「〜と思います」を少し多用されているようです。代わりに「〜と考えております」や「〜です」を使うと、より断定的に聞こえ、自信がある印象を与えられます。").
    * Focus on clarity and professionalism suitable for an interview setting.
4.  **Format Feedback:** Combine the content and language feedback into a single, concise paragraph or short bullet points. Start with the most important points.

**Next Question Generation:**
* Based on the user's answer and the simulated interview context, generate the *next logical question*.
* The question should flow naturally. It could be a follow-up to dig deeper into their last answer or move to a new standard interview topic.
* この面接は標準的な30分を想定しています。約5〜6つの主要な質問（深掘り含む）が完了したら、新しいトピックの質問を始めるのではなく、面接を締めくくるような最終質問（例：「最後に、何か質問はありますか？」や「本日の面接は以上となります。結果については後日ご連絡いたします。」）を生成して面接を終了方向に導いてください。

**Tone:**
* Professional, polite (using appropriate 敬語).
* Supportive and encouraging, not overly critical. Remember, this is practice.
* Clear and easy to understand.

**Output Format:**
* **Strictly** respond ONLY with a valid JSON object containing two keys: "feedback" and "next_question". Both values must be strings containing Japanese text.

**Example JSON Output Structure:**
```json
{
  "feedback": "ありがとうございます。具体的なプロジェクト経験についてお話しいただき、状況はよく理解できました。可能であれば、ご自身が取られた「行動」と、それによって得られた具体的な「結果」をもう少し詳しく説明されると、さらに良い回答になりますね。また、「ちょっと」は少しカジュアルな印象を与える可能性があるので、「少々」や「若干」などの言葉を選ぶとより丁寧です。",
  "next_question": "そのプロジェクトで、チーム内でのご自身の役割は何でしたか？"
}
```
"""
        try:
            prompt = system_prompt
            if history_text:
                prompt += f"\n\nこれまでの会話:\n{history_text}"
            prompt += f"\n\n候補者の最新回答:\n{transcript}"
            response = self.generative_model.generate_content(prompt)
            text = self._extract_plain_text(response)
            data = self._extract_json_object(text)
            if data:
                feedback = data.get("feedback") or "良い回答でした。"
                next_question = data.get("next_question") or data.get("nextQuestion") or "志望動機を教えてください。"
                return feedback, next_question
            lines = [line.strip() for line in text.splitlines() if line.strip()]
            feedback = lines[0] if lines else "良い回答でした。"
            next_question = lines[1] if len(lines) > 1 else "志望動機を教えてください。"
            return feedback, next_question
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("Gemini feedback generation failed: %s", exc)
            return (
                "フィードバックのプレースホルダーです。",
                "志望動機を教えてください。",
            )

    def _build_history_text(self, history: list[dict]) -> str:
        if not history:
            return ""
        lines = []
        for message in history:
            role = message.get("role")
            label = "AI面接官" if role == "ai" else "候補者"
            lines.append(f"{label}: {message.get('content', '')}")
        return "\n".join(lines)

    def _synthesize_text(self, text: str) -> Optional[str]:
        if not self.use_azure or not text:
            return None

        filename = f"tts-{uuid4().hex}.mp3"
        output_path = self.audio_dir / filename
        try:
            audio_config = speechsdk.audio.AudioOutputConfig(filename=str(output_path))
            synthesizer = speechsdk.SpeechSynthesizer(
                speech_config=self.speech_config,
                audio_config=audio_config,
            )
            result = synthesizer.speak_text_async(text).get()
            if result.reason == speechsdk.ResultReason.SynthesizingAudioCompleted:
                return f"/static/audio/{filename}"
            logger.warning("Azure TTS failed: %s", result.reason)
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("Azure TTS error: %s", exc)
        return None

    def _transcribe_audio(self, audio_bytes: bytes, content_type: Optional[str] = None) -> str:
        if not self.use_azure:
            return ""
        if not audio_bytes:
            return ""
        try:
            audio_format, stream_payload = self._determine_stream_format(content_type, audio_bytes)
            audio_config, temp_file_path = self._create_audio_config(
                content_type, audio_bytes, audio_format, stream_payload
            )
            return self._recognize_speech(audio_config, temp_file_path)
        except Exception as exc:  # pragma: no cover - defensive
            error_details = getattr(exc, "error_details", None) or str(exc)
            logger.warning("Azure STT error: %s", error_details, exc_info=True)
        return ""

    def _determine_stream_format(
        self, content_type: Optional[str], audio_bytes: bytes
    ) -> tuple[Optional[object], bytes]:
        audio_format = None
        stream_payload = audio_bytes
        audio_module = getattr(speechsdk, "audio", None)
        if audio_module and hasattr(audio_module, "AudioStreamFormat") and hasattr(
            audio_module, "AudioStreamContainerFormat"
        ):
            preferred = []
            lowered = (content_type or "").lower()
            if "ogg" in lowered:
                preferred.extend(["OGG_OPUS", "WEBM_OPUS"])
            elif "webm" in lowered:
                preferred.extend(["WEBM_OPUS", "OGG_OPUS"])
            else:
                preferred.extend(["OGG_OPUS", "WEBM_OPUS"])
            preferred.append("MP3")

            for candidate in preferred:
                container_format = getattr(audio_module.AudioStreamContainerFormat, candidate, None)
                if container_format is None:
                    continue
                try:
                    audio_format = audio_module.AudioStreamFormat(compressed_stream_format=container_format)
                    break
                except TypeError:
                    audio_format = None

        if audio_format is None and audio_module and hasattr(audio_module, "AudioStreamFormat"):
            normalized_type = (content_type or "").lower()
            if "audio/wav" in normalized_type or "pcm" in normalized_type:
                audio_format = self._build_pcm_audio_stream_format(audio_module)
                if stream_payload and len(stream_payload) > 44 and stream_payload[:4] == b"RIFF":
                    try:
                        stream_payload = stream_payload[44:]
                    except Exception:
                        stream_payload = audio_bytes
        return audio_format, stream_payload

    def _build_pcm_audio_stream_format(self, audio_module) -> Optional[object]:
        pcm_sample_rate = 16000
        pcm_bits = 16
        pcm_channels = 1
        try:
            return audio_module.AudioStreamFormat(
                samples_per_second=pcm_sample_rate,
                bits_per_sample=pcm_bits,
                channels=pcm_channels,
            )
        except TypeError:
            try:
                return audio_module.AudioStreamFormat(samples_per_second=pcm_sample_rate)
            except TypeError:
                return None

    def _create_audio_config(
        self,
        content_type: Optional[str],
        audio_bytes: bytes,
        audio_format,
        stream_payload: bytes,
    ) -> tuple[object, Optional[Path]]:
        if self._should_use_file_config(content_type, audio_bytes):
            temp_file = self._write_temp_audio_file(audio_bytes)
            return speechsdk.AudioConfig(filename=str(temp_file)), temp_file

        stream_kwargs = {}
        if audio_format is not None:
            stream_kwargs["stream_format"] = audio_format

        stream = speechsdk.audio.PushAudioInputStream(**stream_kwargs)
        chunk_size = 8192
        for start in range(0, len(stream_payload), chunk_size):
            stream.write(stream_payload[start : start + chunk_size])
        stream.close()

        return speechsdk.AudioConfig(stream=stream), None

    @staticmethod
    def _should_use_file_config(content_type: Optional[str], audio_bytes: bytes) -> bool:
        normalized_type = (content_type or "").lower()
        if normalized_type.startswith("audio/wav"):
            return True
        return len(audio_bytes) > 44 and audio_bytes[:4] == b"RIFF"

    def _write_temp_audio_file(self, audio_bytes: bytes) -> Path:
        tmp_dir = Path("tmp")
        tmp_dir.mkdir(parents=True, exist_ok=True)
        temp_file = tmp_dir / f"stt-{uuid4().hex}.wav"
        temp_file.write_bytes(audio_bytes)
        return temp_file

    @staticmethod
    def _cleanup_temp_file(temp_file_path: Optional[Path]) -> None:
        if temp_file_path and temp_file_path.exists():
            try:
                temp_file_path.unlink()
            except Exception as cleanup_exc:  # pragma: no cover - defensive
                logger.debug("Failed to remove temp STT file %s: %s", temp_file_path, cleanup_exc)

    def _recognize_speech(self, audio_config, temp_file_path: Optional[Path]) -> str:
        recognizer = speechsdk.SpeechRecognizer(
            speech_config=self.speech_config,
            audio_config=audio_config,
        )
        try:
            result = recognizer.recognize_once_async().get()
        finally:
            self._cleanup_temp_file(temp_file_path)

        if result.reason == speechsdk.ResultReason.RecognizedSpeech:
            return result.text
        if result.reason == speechsdk.ResultReason.Canceled:
            cancellation_details = speechsdk.CancellationDetails(result)
            logger.warning("Azure STT cancelled: %s", cancellation_details.reason)
            if cancellation_details.error_details:
                logger.warning("Azure STT cancellation details: %s", cancellation_details.error_details)
        logger.warning("Azure STT failed: %s", result.reason)
        return ""
