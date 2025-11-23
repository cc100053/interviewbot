# Learning Roadmap for ポケメン

目的:  
1. プロジェクトの全機能とコードの詳細を日本語で説明できる。  
2. Java/MySQL から Python/FastAPI への思考の橋渡しを行い、バックエンド〜フロントまで自走できる。  
3. 学んだ内容を口頭・文章でアウトプットし、面接対策ボットの説明資料としてまとめる。

## フェーズ0: 俯瞰と準備 (半日)
- `README.md` と `setup.txt` を音読し、環境変数や依存関係を理解。  
- `uvicorn app.main:app --reload` を起動 → `index.html` で一連の画面遷移を体験。  
- Notion/紙に「フロント(HTML/JS) → FastAPI → AI/DB → 応答」の矢印図を描き、現時点で説明できる/できない箇所をマーキング。  
- 成果物: 30秒で話せる「アプリ紹介（日本語）」と、疑問点リスト。

## フェーズ1: Python 基礎ギャップ補完 (1〜2日)
- Java との比較表を作る（型ヒント、クラス定義、例外、モジュールの import）。  
- `config/settings.py`, `app/dependencies.py` を題材に `pydantic` / `Depends` / `@lru_cache` を手書きで説明。  
- SQLite CLI (`sqlite3 data/interviews.db`) を使い、MySQL との SQL 文の違いを確認。  
- 「FastAPI でのリクエスト処理の流れ」を `AuthRequest` クラスを例に 5 文で日本語説明。  
- 成果物: Python 用語ミニ辞書（例: 「dependency injection = 依存オブジェクトを自動で渡す仕組み」）。

## フェーズ2: リクエストフロー追跡 (1日)
- `static/app.js` の `apiRequest` → `app/routers/...` → `app/services/...` の順に、「ログイン」「面接開始」「チャット」「音声処理」の 4 フローをシーケンス図化。  
- 各フローごとに「入力」「重要な関数/クラス (`@router.post`, `AIService.chat_response` など)」「レスポンス構造」をテーブル化。  
- 成果物: フローごとの日本語解説シート（A4 1 枚×4 フロー）。

## フェーズ3: バックエンド詳細 (2日)
- `app/main.py`: WebSocket (`/ws/stt`) のライフサイクルを async/await 目線で説明できるようにする。  
- `app/routers/auth.py`: JWT 発行ロジックを Java の `Filter` との比較でメモ。  
- `app/routers/interview.py`: Pydantic モデルとレスポンスの alias (`Field(..., alias="interviewId")`) を意識しつつ、各エンドポイントの責務を整理。  
- 各ファイルごとに「関数一覧」「外部依存」「例外ハンドリング」の 3 観点で表を作る。  
- 成果物: FastAPI 各層を 5 分で順番に説明するためのスクリプト（台本）。

## フェーズ4: AI + 音声サービス (1.5日)
- `app/services/ai.py` を 3 ブロックに分解（Gemini, Azure STT, Azure TTS）。  
- `generate_summary`, `chat_response`, `analyze_answer` の共通処理（正規化・音声合成）を図示。  
- Azure Speech SDK, Gemini SDK の英語ドキュメントを読み、learn.md に日本語要約を 3 文ずつ追加。  
- ローカルで Azure/Gemini キーをダミー設定し、`/health/ai` を叩いてレスポンス JSON を翻訳。  
- 成果物: 外部サービス設計メモ（いつフェールバックするか、ログの見方）。

## フェーズ5: データ層と正規化 (1日)
- `app/services/db.py` の `normalize_transcript`, `_normalise_summary_record` を重点的に読む。  
- InMemory / SQLite / Cosmos のクラスごとに「接続初期化」「CRUD」「データ整形」の違いを比較表化。  
- MySQL での経験を使って SQLite 版の CRUD にコメントを入れ、自分の言葉で説明できるように練習。  
- 成果物: Transcript/summary の JSON 例（before/after 正規化）を実際に書き起こし、日本語コメントを添える。

## フェーズ6: フロントエンドと UI 状態管理 (1.5日)
- `static/app.js` の `state` オブジェクトをスプレッドシート化し、「どのイベントで更新されるか」「DOM id」「関連 API」を紐づける。  
- 代表タブ（TOP/Interview/History/Profile）の UI フローをデベロッパーツールで確認し、イベント→API→DOM 更新を日本語で説明。  
- `audio` フォルダや `styles.css` も含め、資産の役割を 1 行説明するアセットリストを作成。  
- 成果物: ブラウザ操作動画（自分用）を撮り、画面を見ながら日本語で解説する練習。

## フェーズ7: 日本語アウトプット訓練 (継続)
- 各フェーズの学習後に 5 分タイマーで「〇〇の仕組み」を日本語で説明し、録音してセルフレビュー。  
- 週 1 回、プロジェクト全体を 10 分で解説する LT 資料 (Google Slides 等) を更新。  
- 用語集を更新し、`README` 風の日本語文章を 3 パラグラフで書き直す。  
- 成果物: 「新人に教えるためのチートシート」 (日本語)。

## フェーズ8: 応用ミニ課題 (2日)
1. **Python モディフィケーション**: 既存 API にテキスト翻訳フィールドを追加し、FastAPI で DTO を拡張。Pull Request を書く想定で説明文も作成。  
2. **SQL 実務練習**: SQLite で `interviews` テーブルの集計（面接回数/平均スコア）クエリを書き、MySQL との差異をメモ。  
3. **フロント改善**: `static/app.js` に 1 つ状態フラグを追加し、`status-indicator` の文言を状況別に切り替える。  
- それぞれ実装 → 動作確認 → 日本語レビュー (自問自答) の順で行い、GitHub Issue 形式で記録。

## 評価と復習フレーム
- 週末に `learn.md` の未達項目を見直し、進捗を ✅ / ❌ / ❓ で更新。  
- 友人や mentor に向けて 15 分の日本語デモを行い、質問されたら該当コードを即座に指差せるかチェック。  
- AI 面接ボット以外の Python プロジェクト記事を 1 本読み、差分を説明する練習をする。

この計画を上から順に実行すれば、FastAPI + フロント一体型の設計を詳細に語れるようになり、Python での実装/解説スキルも同時に鍛えられます。進捗と不明点は都度 `learn.md` に追記してください。
