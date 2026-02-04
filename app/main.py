import asyncio
import logging
import json
from typing import Optional
from pathlib import Path
from datetime import datetime
import wave

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from starlette.websockets import WebSocketState

from app.dependencies import get_ai_service
from app.services.ai import speechsdk

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)
from app.routers import auth, interview
from app.routers.interview import chat_router


def create_app() -> FastAPI:
    """Application factory to keep initialization testable."""
    app = FastAPI(title="AI Interview Trainer API")
    ai_service = get_ai_service()

    app.add_middleware( #HTTPのリクエストを許可する
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(auth.router) #認証のルーター、もし/authが来れば認証のルーターを呼び出す
    app.include_router(interview.router) #面接のルーター
    app.include_router(chat_router) #チャットのルーター

    app.mount("/static", StaticFiles(directory="static"), name="static") #staticのルーター

    @app.get("/", include_in_schema=False)
    async def root() -> FileResponse:
        return FileResponse("index.html")

    @app.get("/health/ai", include_in_schema=False)
    async def ai_health():
        return ai_service.get_status()

    @app.websocket("/ws/stt")
    async def stt_websocket(websocket: WebSocket) -> None:
        await handle_stt_websocket(websocket, ai_service)

    return app


app = create_app()


async def handle_stt_websocket(websocket: WebSocket, ai_service) -> None:
    logger.info("STT websocket connect: client=%s", websocket.client)
    if not ai_service.use_azure or speechsdk is None:
        await websocket.close(code=1013)
        return

    await websocket.accept()
    handler = STTSessionHandler(websocket, ai_service)
    await handler.run()


class STTSessionHandler:
    """Encapsulates STT websocket flow so create_app stays readable."""

    def __init__(self, websocket: WebSocket, ai_service) -> None:
        self.websocket = websocket
        self.ai_service = ai_service
        self.loop = asyncio.get_running_loop()
        self.debug_file: Optional[Path] = None
        self.debug_handle = None
        self.recognizer: Optional[speechsdk.SpeechRecognizer] = None
        self.stream: Optional[speechsdk.audio.PushAudioInputStream] = None
        self.audio_config: Optional[speechsdk.audio.AudioConfig] = None
        self.mime_hint: Optional[str] = None
        self.pcm_sample_rate: Optional[int] = None
        self.recognition_started = False

    async def run(self) -> None:
        try:
            await self._receive_loop()
        except Exception as exc:  # pragma: no cover - defensive
            logger.exception("STT websocket encountered an error: %s", exc)
        finally:
            await self._cleanup()
            logger.info("STT websocket cleanup complete")

    async def _receive_loop(self) -> None:
        while True:
            try:
                message = await self.websocket.receive()
            except WebSocketDisconnect:
                logger.info("STT websocket disconnect requested by client")
                break

            if message["type"] == "websocket.disconnect":
                logger.info("STT websocket disconnect frame received")
                break

            text_data = message.get("text")
            if text_data is not None:
                self._handle_text_message(text_data)
                continue

            binary_data = message.get("bytes")
            if not binary_data:
                continue

            await self._handle_audio_chunk(binary_data)

    def _handle_text_message(self, text_data: str) -> None:
        try:
            payload = json.loads(text_data)
            if isinstance(payload, dict) and "mimeType" in payload:
                self.mime_hint = str(payload["mimeType"])
                logger.info("STT websocket received MIME hint: %s", self.mime_hint)
            if isinstance(payload, dict) and payload.get("pcm"):
                try:
                    self.pcm_sample_rate = int(payload.get("sampleRate") or 16000)
                except (TypeError, ValueError):
                    self.pcm_sample_rate = 16000
                logger.info("STT websocket configured for PCM at %s Hz", self.pcm_sample_rate)
                self.mime_hint = "audio/pcm"
        except json.JSONDecodeError:
            self.mime_hint = text_data
            logger.info("STT websocket received raw MIME hint: %s", self.mime_hint)

    async def _handle_audio_chunk(self, binary_data: bytes) -> None:
        if self.recognizer is None:
            try:
                await self._ensure_recognizer(binary_data)
            except Exception as exc:  # pragma: no cover - defensive
                logger.exception("Failed to initialise Azure recognizer: %s", exc)
                await self.websocket.close(code=1011)
                raise

        if self.stream is None:
            return

        try:
            logger.debug("STT: writing chunk %s", len(binary_data))
            self.stream.write(binary_data)
            self._write_debug_audio(binary_data)
        except Exception as exc:  # pragma: no cover - defensive
            logger.exception("Failed to write audio chunk to Azure stream: %s", exc)
            await self.websocket.close(code=1011)
            raise

    async def _ensure_recognizer(self, initial_bytes: bytes) -> None:
        if self.recognizer is not None:
            return
        if self.pcm_sample_rate is None:
            self.pcm_sample_rate = 16000

        stream_kwargs = self._select_stream_kwargs(initial_bytes)
        logger.debug("STT: creating PushAudioInputStream with kwargs %s", stream_kwargs)
        self.stream = speechsdk.audio.PushAudioInputStream(**stream_kwargs)
        self.audio_config = speechsdk.AudioConfig(stream=self.stream)

        speech_config = self._build_speech_config()
        language = getattr(getattr(self.ai_service, "speech_config", None), "speech_recognition_language", None) or "ja-JP"
        logger.debug("STT: creating SpeechRecognizer (language=%s)", language)
        self.recognizer = speechsdk.SpeechRecognizer(
            speech_config=speech_config,
            audio_config=self.audio_config,
            language=language,
        )
        self._wire_recognizer_events()
        await self._start_recognition()

    def _select_stream_kwargs(self, initial_bytes: bytes) -> dict:
        kwargs: dict = {}
        if not hasattr(speechsdk.audio, "AudioStreamFormat") or not hasattr(
            speechsdk.audio, "AudioStreamContainerFormat"
        ):
            return kwargs

        if self.pcm_sample_rate:
            return self._build_pcm_stream_kwargs(kwargs)
        return self._build_container_stream_kwargs(kwargs, initial_bytes)

    def _build_pcm_stream_kwargs(self, kwargs: dict) -> dict:
        audio_format = None
        try:
            audio_format = speechsdk.audio.AudioStreamFormat(
                samples_per_second=self.pcm_sample_rate,
                bits_per_sample=16,
                channels=1,
            )
        except TypeError:
            try:
                audio_format = speechsdk.audio.AudioStreamFormat(samples_per_second=self.pcm_sample_rate)
            except TypeError:
                audio_format = None
        if audio_format is not None:
            kwargs["stream_format"] = audio_format
        return kwargs

    def _build_container_stream_kwargs(self, kwargs: dict, initial_bytes: bytes) -> dict:
        lowered = (self.mime_hint or "").lower()
        header = initial_bytes[:4]
        container_name: Optional[str] = None
        if "ogg" in lowered or header == b"OggS":
            container_name = "OGG_OPUS"
        elif "webm" in lowered or header == b"\x1aE\xdf\xa3":
            container_name = "WEBM_OPUS"
        elif "mp3" in lowered:
            container_name = "MP3"

        if container_name:
            container = getattr(speechsdk.audio.AudioStreamContainerFormat, container_name, None)
            if container is not None:
                try:
                    audio_format = speechsdk.audio.AudioStreamFormat.get_compressed_format(container)
                    kwargs["stream_format"] = audio_format
                    logger.info("STT will use container format %s", container_name)
                except (TypeError, AttributeError) as exc:
                    logger.warning("STT failed to set container format %s: %s", container_name, exc)
        return kwargs

    def _build_speech_config(self) -> speechsdk.SpeechConfig:
        base_config = getattr(self.ai_service, "speech_config", None)
        settings = getattr(self.ai_service, "settings", None)
        if settings and getattr(settings, "azure_speech_key", None) and getattr(settings, "azure_speech_region", None):
            try:
                return speechsdk.SpeechConfig(
                    subscription=settings.azure_speech_key,
                    region=settings.azure_speech_region,
                )
            except Exception as exc:  # pragma: no cover - defensive
                logger.exception("Failed to create SpeechConfig for streaming STT: %s", exc)
        if base_config is None:
            raise RuntimeError("Azure Speech configuration is unavailable.")
        return base_config

    def _wire_recognizer_events(self) -> None:
        self.recognizer.recognizing.connect(self._handle_recognizing)
        self.recognizer.recognized.connect(self._handle_recognized)
        self.recognizer.session_stopped.connect(
            lambda evt: logger.debug("Azure STT session stopped: %s", getattr(evt, "reason", None))
        )
        self.recognizer.canceled.connect(
            lambda evt: logger.warning(
                "Azure STT canceled: %s (%s)",
                getattr(evt, "reason", None),
                getattr(evt, "error_details", None),
            )
        )

    def _handle_recognizing(self, evt) -> None:
        text = getattr(evt.result, "text", "")
        if text:
            logger.info("Azure STT recognizing: %s", text)
        self._schedule_send("intermediate", text)

    def _handle_recognized(self, evt) -> None:
        text = getattr(evt.result, "text", "")
        if text:
            logger.info("Azure STT recognized: %s", text)
        self._schedule_send("final", text)

    async def _start_recognition(self) -> None:
        logger.debug("STT: starting continuous recognition")
        start_future = self.recognizer.start_continuous_recognition_async()
        await self.loop.run_in_executor(None, start_future.get)
        logger.info(
            "Azure STT continuous recognition started (session=%s)",
            getattr(getattr(self.recognizer, "properties", None), "id", None),
        )
        self.recognition_started = True

    def _schedule_send(self, message_type: str, text: str) -> None:
        if not text:
            return
        payload = json.dumps({"type": message_type, "text": text}, ensure_ascii=False)
        future = asyncio.run_coroutine_threadsafe(self.websocket.send_text(payload), self.loop)

        def _silent_done(task: asyncio.Future) -> None:
            try:
                task.result()
            except Exception:
                pass

        future.add_done_callback(_silent_done)

    def _write_debug_audio(self, binary_data: bytes) -> None:
        if self.debug_handle is None:
            debug_dir = Path("tmp/audio_debug")
            debug_dir.mkdir(parents=True, exist_ok=True)
            self.debug_file = debug_dir / f"ws_{datetime.utcnow().strftime('%Y%m%dT%H%M%S%f')}.wav"
            self.debug_handle = wave.open(str(self.debug_file), "wb")
            self.debug_handle.setnchannels(1)
            self.debug_handle.setsampwidth(2)
            self.debug_handle.setframerate(self.pcm_sample_rate or 16000)
            logger.info("STT debug file opened: %s", self.debug_file)
        if hasattr(self.debug_handle, "writeframes"):
            self.debug_handle.writeframes(binary_data)

    async def _cleanup(self) -> None:
        if self.stream is not None:
            try:
                self.stream.close()
            except Exception:  # pragma: no cover - defensive
                pass
        if self.recognizer is not None and self.recognition_started:
            try:
                stop_future = self.recognizer.stop_continuous_recognition_async()
                await self.loop.run_in_executor(None, stop_future.get)
            except Exception:  # pragma: no cover - defensive
                pass
        try:
            if self.websocket.application_state != WebSocketState.DISCONNECTED:
                await self.websocket.close()
        except Exception:  # pragma: no cover - defensive
            pass
        if self.debug_handle is not None:
            try:
                self.debug_handle.close()
                logger.info("STT debug file closed: %s", self.debug_file)
            except Exception:  # pragma: no cover - defensive
                pass
