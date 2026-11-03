# 用語集

**このファイルで分かること**: 設計書とコードに出てくる用語の意味。
**前提**: なし。分からない言葉が出たらここに戻ってきてください。

## サービス・製品

| 用語 | 意味 | 使っている場所 |
|---|---|---|
| **Cloudflare** | Web サイトやアプリを動かすクラウドサービスの会社。このアプリの API・保存先・ログインを担当 | [worker/](../../worker/) |
| **Worker (Cloudflare Workers)** | Cloudflare 上で動く小さなプログラム。サーバーを自分で用意しなくてよい。このアプリの「API の窓口」 | [worker/src/index.ts](../../worker/src/index.ts) |
| **Hono** | Worker 用の軽量な Web フレームワーク。「このパスに来たらこの関数」と書ける | [routes/api.ts](../../worker/src/routes/api.ts) |
| **D1** | Cloudflare のデータベース(SQLite 互換)。ジョブの一覧と状態を保存する「台帳」 | [migrations/](../../worker/migrations/0001_create_jobs.sql) |
| **R2** | Cloudflare のファイル置き場(オブジェクトストレージ)。音声と結果 JSON を置く | [r2.ts](../../worker/src/r2.ts) |
| **Cron Trigger** | 「5分ごと」などの時刻で Worker を自動起動する仕組み | [cron.ts](../../worker/src/cron.ts) |
| **Cloudflare Access** | 「許可したメールアドレスの人だけ通す」ログイン門番 | [access.ts](../../worker/src/access.ts) |
| **Modal** | Python のコードを GPU 付きのクラウドで動かせるサービス。文字起こしを担当 | [modal/](../../modal/app.py) |
| **Hugging Face** | AI モデルの配布サイト。話者分離モデルの取得にトークンが要る | [03-huggingface.md](../setup/03-huggingface.md) |
| **Discord Webhook** | Discord のチャンネルに外部からメッセージを送るための URL | [discord.ts](../../worker/src/discord.ts) |

## AI・音声処理

| 用語 | 意味 |
|---|---|
| **Whisper / faster-whisper** | 音声を文字にする AI。faster-whisper は高速版の実装。モデルは `large-v3` |
| **話者分離 (diarization)** | 「いつ誰が話したか」を判定する処理。pyannote というライブラリで行う |
| **pyannote** | 話者分離のライブラリ。モデル名は `speaker-diarization-community-1` |
| **タイムスタンプ** | 発言の開始・終了時刻(秒) |
| **セグメント (segment)** | 発言のひとかたまり。開始・終了・話者・本文・単語を持つ |
| **ffmpeg** | 音声・動画を変換するコマンド。16kHz モノラルの WAV に揃えるのに使う |
| **GPU / T4** | AI 計算を速くする部品。T4 は Modal で最も安い部類の GPU |
| **VAD** | 無音部分を除く処理(`vad_filter=True`) |
| **initial_prompt** | Whisper に最初に渡すヒント文。用語リストをここに入れて認識精度を上げる |

## 仕組み

| 用語 | 意味 |
|---|---|
| **ジョブ** | 「1本の音声を文字起こしする依頼」。D1 の1行に対応 |
| **署名付き URL (presigned URL)** | 「この1ファイルを、この操作だけ、期限内なら」許可する特別な URL。R2 の鍵を渡さずにファイルを預けられる |
| **コールバック** | 処理を頼んだ側(Worker)に、終わったとき相手(Modal)から連絡する仕組み |
| **HMAC** | 秘密の合言葉(`CALLBACK_SECRET`)と本文から署名を作る方式。偽の連絡を見破れる |
| **attempt** | そのジョブの「何回目の実行か」。古い実行からの連絡を無視するための番号 |
| **JWT** | ログイン済みであることを示す署名付きの札。Access が `Cf-Access-Jwt-Assertion` ヘッダに付ける |
| **AUD** | Access アプリごとの識別子。JWT がこのアプリ宛てか確認するのに使う |
| **ポーリング** | 画面が一定間隔でサーバーに状態を聞きに行くこと |
| **Volume (Modal)** | Modal 上の永続ディスク。モデルの重みを置いて毎回のダウンロードを避ける |
| **Secret (Modal / Worker)** | パスワードなどを安全に登録する機能。コードやログに書かない |
| **CORS** | ブラウザが別オリジンへリクエストしてよいかのルール。R2 への直接 PUT に必要 |
| **マイグレーション** | データベースの表を作る・変える SQL を順番に適用すること |
| **Mermaid** | 文章から図を描く記法。この設計書の図はすべて Mermaid |

## 状態とエラーコード

ジョブの状態は `uploading` / `queued` / `processing` / `completed` / `failed` の5つ([02](02-job-lifecycle.md))。
エラーコードの一覧は [02](02-job-lifecycle.md#エラーコード一覧) にあります。

## 関連ファイル

- [README.md](README.md): 設計書の入口
