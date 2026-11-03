# 音声文字起こしアプリ 実装計画

Whisper と話者分離を使い、長時間の日本語音声を文字起こしする個人用 Web アプリ。
ジョブを投入すれば、PC の電源を落としてもクラウド側で処理が完了する。

## 1. 要件

| 項目 | 内容 |
|---|---|
| 利用者 | 自分のみ |
| 想定音声 | 日本語の講義・会議、1本あたり約90分 |
| 入力上限 | 300MB |
| 優先機能 | タイムスタンプ、話者分離 |
| 費用 | 無料枠の範囲で運用する |
| 実行条件 | ジョブ投入後は PC を落としても処理が続く |
| 完了通知 | Discord の個人チャンネル |
| 出力形式 | JSON / Markdown / TXT / SRT / VTT(ブラウザからファイルとしてダウンロード) |
| 保存期間 | 文字起こし結果は1年 |

### 対象外

- ブラウザでの音声再生、再生との同期
- 文字起こし本文の編集
- 複数ユーザー対応
- Cloudflare Workers AI へのフォールバック(クレジット切れ時の代替実行)。必要になったら別途検討する

## 2. 技術構成

| 領域 | 採用技術 |
|---|---|
| フロントエンド | React, TypeScript |
| API | Cloudflare Workers, Hono, TypeScript |
| 配信 | Workers Static Assets(フロントエンドと API を同一オリジンにする) |
| メタデータ | Cloudflare D1 |
| ファイル保存 | Cloudflare R2 |
| 定期処理 | Cloudflare Cron Triggers |
| 認証 | Cloudflare Access |
| GPU 処理 | Modal, Python |
| 文字起こし | faster-whisper(large-v3) |
| 話者分離 | pyannote(speaker-diarization-community-1) |
| 通知 | Discord Webhook |

### リポジトリ構成

```
frontend/   React アプリ
worker/     Hono API、Cron 処理、D1 マイグレーション
modal/      Python の文字起こし処理
docs/       設計資料
```

## 3. 処理フロー

```
ブラウザ          Worker              R2             Modal          Discord
  │ ジョブ作成      │                  │               │               │
  ├───────────────>│                  │               │               │
  │ アップロード用URL│                  │               │               │
  │<───────────────┤                  │               │               │
  │ 音声を直接 PUT  │                  │               │               │
  ├──────────────────────────────────>│               │               │
  │ アップロード完了 │                  │               │               │
  ├───────────────>│ サイズ確認        │               │               │
  │                ├─────────────────>│               │               │
  │                │ 起動(署名付きURLを渡す)           │               │
  │                ├─────────────────────────────────>│               │
  │                │                  │ 音声を取得     │               │
  │   (ここから先は PC を落としてよい)  │<──────────────┤               │
  │                │                  │ 結果を PUT     │               │
  │                │                  │<──────────────┤               │
  │                │ 完了コールバック  │               │               │
  │                │<─────────────────────────────────┤               │
  │                │ 音声を削除        │               │               │
  │                ├─────────────────>│               │               │
  │                │ 完了通知          │               │               │
  │                ├─────────────────────────────────────────────────>│
```

### Modal の処理内容

1. 署名付き URL から音声を取得する
2. ffmpeg で 16kHz モノラルに変換する(mp4 などの動画は音声のみ抽出)
3. faster-whisper で文字起こしする(単語単位のタイムスタンプ付き)
4. 話者分離が有効なら pyannote を実行する
5. 単語ごとに、重なりが最も長い話者区間を割り当てる。話者が変わる位置で区間を分割する
6. 結果の JSON を署名付き URL で R2 に PUT する
7. Worker に完了または失敗をコールバックする
8. コンテナ内の一時ファイルを削除する

モデルの重みは Modal Volume にキャッシュし、起動のたびにダウンロードしない。

## 4. 入力

- **対応形式**: mp3, m4a, wav, mp4, webm, ogg
- **上限**: 300MB。ブラウザで事前に確認し、アップロード完了時に Worker が R2 上の実サイズで再確認する。超過していれば音声を削除してジョブを失敗にする
- **アップロード**: ブラウザから R2 へ署名付き URL で直接 PUT する(Worker を経由しない)

### ジョブごとの設定

| 設定 | 既定値 | 内容 |
|---|---|---|
| 話者分離 | オン | 単独話者の講義ではオフにして時間とクレジットを節約できる |
| 話者数のヒント | 指定なし | 最小・最大人数を指定できる |
| 用語リスト | 空 | 専門用語や固有名詞を Whisper の `initial_prompt` に渡す |

言語は日本語に固定し、自動判定は使わない。

## 5. 出力

R2 に保存する JSON を正本とする。他の形式はこの JSON からブラウザ上で生成し、Blob としてダウンロードさせる。Worker では変換しない(無料プランの CPU 時間制限を避けるため)。

### JSON スキーマ

```json
{
  "version": 1,
  "language": "ja",
  "duration_sec": 5400.0,
  "model": { "transcription": "large-v3", "diarization": "pyannote/speaker-diarization-community-1" },
  "speakers": ["SPEAKER_00", "SPEAKER_01"],
  "segments": [
    {
      "start": 12.34,
      "end": 18.9,
      "speaker": "SPEAKER_00",
      "text": "それでは始めます。",
      "words": [{ "start": 12.34, "end": 12.8, "text": "それでは" }]
    }
  ]
}
```

話者分離がオフの場合、`speakers` は空配列、`speaker` と `model.diarization` は `null` とする。

### 形式ごとの出力

| 形式 | 例 |
|---|---|
| JSON | 上記スキーマ。`speaker_names` にリネーム内容を加える |
| Markdown | 発言者が変わるごとに `**田中** [00:12:34]` の見出し行と本文 |
| TXT | `[00:12:34] 田中: それでは始めます。` |
| SRT / VTT | 字幕の各行の先頭に話者名を付ける |

### 画面

- **一覧**: ジョブの状態、作成日時、ファイル名
- **新規作成**: ファイル選択、設定、アップロード進捗
- **結果**: タイムスタンプと話者付きの本文、話者リネーム、形式別のダウンロードボタン

処理中の状態はブラウザを開いている間だけポーリングで更新する。

### 話者リネーム

`SPEAKER_00` と表示名の対応を D1 に保存し、正本の JSON は書き換えない。画面表示とすべてのダウンロード形式に反映する。

## 6. ジョブ管理

### 状態遷移

```
uploading ──> queued ──> processing ──> completed
                 ^            │
                 │            ├─ 失敗(再試行あり)──> queued
                 │            └─ 失敗(再試行なし)──> failed
                 └──────── 手動再実行 ──────────────────┘
```

### 再試行

- 自動再試行は2回(初回と合わせて最大3回実行)。Worker が管理し、実行のたびに署名付き URL を発行し直す
- 3回とも失敗したら `failed` にして Discord に通知する
- 古い実行からのコールバックは、`attempt` が一致しなければ無視する
- Modal からコールバックが届かない場合に備え、Cron で5分ごとに確認し、起動から75分経過した `processing` のジョブを失敗として扱う
- `failed` のジョブは、音声が残っている24時間以内なら画面から手動で再実行できる

### 保存期間

| 対象 | 期間 | 削除方法 |
|---|---|---|
| 音声(成功時) | 処理完了後すぐ | Worker が結果の存在を確認してから削除 |
| 音声(失敗時・アップロード放棄時) | 約24時間 | R2 ライフサイクルルール(`audio/` を1日で削除)。放棄されたジョブは Cron が1日1回 `failed`(`upload_abandoned`)にする |
| 文字起こし結果 | 1年 | Cron が1日1回、`expires_at` を過ぎた D1 の行と R2 の結果を削除 |

### D1 スキーマ

```sql
CREATE TABLE jobs (
  id            TEXT PRIMARY KEY,
  filename      TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  status        TEXT NOT NULL,      -- uploading | queued | processing | completed | failed
  attempt       INTEGER NOT NULL DEFAULT 0,  -- 手動再実行でも戻さない(古いコールバックとの衝突を防ぐ)
  retries_left  INTEGER NOT NULL DEFAULT 2,  -- 手動再実行で2に戻す
  options       TEXT NOT NULL,      -- JSON: 話者分離、話者数、用語リスト
  speaker_names TEXT NOT NULL DEFAULT '{}', -- JSON: { "SPEAKER_00": "田中" }
  error_code    TEXT,
  duration_sec  REAL,
  created_at    TEXT NOT NULL,
  started_at    TEXT,
  completed_at  TEXT,
  expires_at    TEXT
);
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_expires_at ON jobs(expires_at);
```

### R2 のキー

```
audio/{job_id}          入力音声
results/{job_id}.json   文字起こし結果
```

## 7. API

Access で保護する API:

| メソッド | パス | 内容 |
|---|---|---|
| POST | `/api/jobs` | ジョブ作成、アップロード用 URL を返す |
| POST | `/api/jobs/:id/complete` | アップロード完了を受け、サイズ確認後に Modal を起動 |
| GET | `/api/jobs` | 一覧 |
| GET | `/api/jobs/:id` | 状態と話者名 |
| GET | `/api/jobs/:id/result` | 結果 JSON |
| PATCH | `/api/jobs/:id/speakers` | 話者リネーム |
| POST | `/api/jobs/:id/retry` | 手動再実行 |

Modal 専用の API:

| メソッド | パス | 内容 |
|---|---|---|
| POST | `/internal/callback` | 完了・失敗の通知。Access の対象外とし、HMAC 署名で検証する |

## 8. セキュリティ

### 権限の分離

Modal には R2 の API キーを渡さない。Worker がジョブごとに次の2つの署名付き URL を発行して渡す。

| URL | 操作 | 対象 | 有効期限 |
|---|---|---|---|
| 入力用 | GET | `audio/{job_id}` | 90分 |
| 出力用 | PUT | `results/{job_id}.json` | 90分 |

有効期限は Modal 関数のタイムアウト(60分)より長くする。音声の削除は Worker のみが行う。

### 通信の保護

- **ブラウザ → Worker**: Cloudflare Access で保護する。Worker 側でも Access の JWT を検証し、Access を経由しない経路(`workers.dev` など)からのアクセスを拒否する
- **Worker → Modal**: Modal のプロキシ認証トークンで保護する。無認証だと第三者にクレジットを消費される
- **Modal → Worker**: リクエスト本文とタイムスタンプの HMAC 署名を検証し、古いリクエストは拒否する
- **R2**: パブリックアクセスは無効のままにする。CORS はアプリのオリジンからの PUT のみ許可する

### ログと通知

- 文字起こし本文、署名付き URL、用語リストをログに出さない
- Discord にはジョブの成否、ファイル名、失敗理由の分類、結果ページへのリンクのみ送る。本文は送らない
- Discord への送信失敗はジョブの結果に影響させない

### シークレット

| 保存先 | 名前 | 用途 |
|---|---|---|
| Worker | `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | 署名付き URL の発行(対象バケットの読み書きのみ) |
| Worker | `MODAL_KEY` / `MODAL_SECRET` | Modal の呼び出し |
| Worker / Modal | `CALLBACK_SECRET` | コールバックの署名 |
| Worker | `DISCORD_WEBHOOK_URL` | 通知 |
| Worker | `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` | Access の JWT 検証(シークレットではないが環境変数で管理) |
| Modal | `HF_TOKEN` | pyannote モデルの取得(読み取り専用) |

### 残るリスク

処理中の音声は Modal の環境に存在する。機密性の高い会議(人事、未公開情報など)はこのアプリで扱わない。

## 9. 費用の管理

- GPU の種類は実測で決める。まず最も安いもの(T4 など)で試す
- Modal の関数にタイムアウト(60分)を設定し、暴走時の消費を抑える
- Modal 側で利用上限を設定できれば、無料クレジットの範囲に設定する
- クレジットが切れると Modal の呼び出しが失敗し、ジョブは `failed` になって Discord に通知される。翌月のクレジット付与後に、再度アップロードして実行する

## 10. 実装フェーズ

1. **Modal 単体**: コマンドから音声ファイルを渡し、JSON が出力される。実音声で精度、処理時間、クレジット消費を測る
2. **Worker と R2、D1**: ジョブ作成、署名付き URL、Modal の起動、コールバック、音声の削除
3. **信頼性**: 再試行、タイムアウト検知、Discord 通知、期限切れデータの削除
4. **フロントエンド**: 一覧、アップロード、結果表示、話者リネーム、ダウンロード
5. **公開**: Access の設定、セキュリティの確認、本番デプロイ

## 11. 実装前に確認すること

### 実測で確認

- [ ] 日本語の講義・会議音声での文字起こし精度と話者分離の精度
- [ ] 90分の音声の処理時間と1本あたりのクレジット消費
- [ ] 60分のタイムアウトで足りるか(上限の 300MB は低ビットレートだと数時間の音声になりうる)
- [ ] 単語単位のタイムスタンプを含む結果 JSON のサイズ
- [ ] 署名付き URL による 300MB のアップロードが安定して完了するか

### 公式ドキュメントで確認

- [ ] Modal の無料クレジットの額と条件(カード登録の要否)、利用上限の設定方法
- [ ] Modal のデータの扱いとセキュリティ認証
- [ ] R2 の有効化にカード登録が必要か、無料枠の範囲
- [ ] D1、Workers、Cron Triggers の無料枠
- [ ] Cloudflare Access を `workers.dev` で使えるか(独自ドメインが必要なら費用が発生する)
- [ ] pyannote の採用モデルの利用条件(個人利用の可否、Hugging Face での同意)
