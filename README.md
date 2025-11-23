# AI Interview Trainer

ポケメンは日本語の模擬面接をチャット + 音声で練習できるフルスタックアプリです。Gemini がフィードバックと次の質問を生成し、Azure Speech が STT/TTS を担当します。FastAPI バックエンドは SQLite（または Cosmos DB）にセッションを保存します。

## 概要
- **認証**: `/auth/signup`, `/auth/login` が JWT を発行。フロントの `state.token` に保存して全 API で利用。
- **モード**: 訓練モード=逐次フィードバック / 面接モード=最後にまとめてフィードバック。`/interviews/start` の `mode` で切り替え。
- **チャット**: `/chat` がフロントの `chatHistory` を受け取り、Gemini でフィードバック + 次の質問を返却（モードに応じて形式が変化）。
- **終了処理**: 面接モードのみ `POST /interviews/{id}/finish` で Gemini サマリーを生成し、`summary_report` に保存。
- **音声**: `/interviews/process_audio` が音声バイナリを Azure STT → Gemini → Azure TTS へ流す。リアルタイム STT は `/ws/stt` WebSocket。
- **ステータス**: `/health/ai` で Gemini/Azure Speech の有効・設定を確認。
- **永続化**: デフォルトは SQLite (`SQLITE_DB_PATH=./data/interviews.db`)。Cosmos 設定を与えると自動で切り替わる。`normalize_transcript` で旧データも統一。

## クイックスタート
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```
ブラウザで `http://127.0.0.1:8000/` にアクセスし、signup → start interview で動作確認できます。

## 主要エンドポイント
| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/signup` | Register a userId/password |
| POST | `/auth/login` | Get JWT |
| POST | `/interviews/start` | Start interview, seed chat |
| POST | `/chat` | Submit text answer, get Gemini response (mode-aware) |
| POST | `/interviews/process_audio` | Submit audio answer via Azure Speech |
| POST | `/interviews/{id}/finish` | Interview mode only: generate & persist summary |
| GET  | `/interviews/` | List interviews + chat history |
| GET  | `/health/ai` | AI service status |

## Config / Environment
| Key | Purpose |
|-----|---------|
| `SQLITE_DB_PATH` | Path for SQLite DB (default `./data/interviews.db`) |
| `USE_IN_MEMORY_DB` | Force in-memory DB when `true` |
| `COSMOS_*` | Cosmos account URI/key/db/container settings |
| `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, `AZURE_SPEECH_VOICE` | Enable Azure Speech |
| `GEMINI_API_KEY`, `GEMINI_MODEL_NAME` | Gemini config |

## Linux/WSL Note (Audio)
Azure Speech の STT が WebM/Opus を解読できるよう、WSL/Ubuntu では以下の GStreamer 依存を入れてください。
```bash
sudo apt update
sudo apt install -y   gstreamer1.0-plugins-base   gstreamer1.0-plugins-good   gstreamer1.0-plugins-bad   gstreamer1.0-plugins-ugly   gstreamer1.0-libav   libgstreamer1.0-dev   libgstreamer-plugins-base1.0-dev
```

## ユーティリティ
- `scripts/local_api_smoketest.py`: in-memory DB で signup → start → chat を自動実行。
- `GET /health/ai`: Gemini/Azure Speech の状態を確認。

## 最近のアップデート
- フロント: シングルページの `index.html` + `static/app.js` に集約。タブ切り替え、プロフィール編集、チャット履歴フィルタ、ミニ音声プレイヤーを実装。
- バックエンド: `/ws/stt` でリアルタイム STT、Gemini からの JSON パース共有化、SQLite/Cosmos 双方で transcript/summary の正規化を統一。全依存は `app/dependencies.py` にまとめた。
- 音声: Azure STT/TTS のフォールバック、デバッグ用 WAV 保存、GStreamer 手順書を README に追加。
