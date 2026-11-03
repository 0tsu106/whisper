# 10 トラブルシュート

「症状 → 原因 → 対処」の早見表です。各手順書の「異常な場合」を集めました。まず**症状**の列で探してください。ログの見方は [09-verification.md](09-verification.md#ステップ-6-ログの見方)。

## 1. インストール・準備([01](01-prerequisites.md))

| 症状 | 原因 | 対処 |
|---|---|---|
| `node: command not found` / `v18…` | Node.js 未導入/古い | nvm で `nvm install 22` |
| `python3 -m venv` が失敗 | venv 未導入 | `sudo apt install -y python3-venv` |
| `ffmpeg: command not found` | 未導入 | `sudo apt install -y ffmpeg` |
| `npm install` が `EACCES` | 権限 | `sudo` を使わず nvm の Node を使う |

## 2. Hugging Face・Modal([03](03-huggingface.md)、[04](04-modal.md))

| 症状 | 原因 | 対処 |
|---|---|---|
| モデルへのアクセスが 403 | 利用条件に未同意/承認待ち | モデルページで **Agree and access repository** |
| `modal: command not found` | venv 外で実行 | `.venv/bin/modal` と指定 |
| `modal setup` でブラウザが開かない | WSL の制約 | 表示された URL を手動で開く |
| `Secret 'whisper-secrets' not found` | 未作成/名前の違い | `modal secret create whisper-secrets …` |
| `Secret … already exists` | 作成済み | `--force` を付けて上書き |
| `modal deploy` のイメージ作成が失敗 | 一時的なネットワーク | 再実行 |
| Modal の URL に認証無しで POST して `200` | 認証が掛かっていない | `requires_proxy_auth=True` を確認し再デプロイ |
| `modal run` で `diarization_failed` | `HF_TOKEN` 不正/未同意 | トークンを作り直し `--force` で Secret 更新 |
| `out_of_memory` | 音声が長い/GPU メモリ不足 | 短い音声で確認。必要なら `app.py` の `GPU` を変更 |

## 3. Cloudflare([05](05-cloudflare.md))

| 症状 | 原因 | 対処 |
|---|---|---|
| `You are not authenticated` | wrangler 未ログイン | `npx wrangler login` |
| `Please enable R2 through the Cloudflare Dashboard` | R2 未有効 | ダッシュボードの **R2 Object Storage** で有効化 |
| `Couldn't find a D1 DB with the name or binding 'whisper'` | `database_id` 未設定 | `npx wrangler d1 create whisper` の ID を `wrangler.jsonc` に |
| デプロイ時に `assets.directory … does not exist` | 画面を未ビルド | ルートで `npm run deploy`(ビルド込み) |
| デプロイ時に `You need to register a workers.dev subdomain` | サブドメイン未登録 | 案内に従い登録 |
| アップロードで `blocked by CORS policy` | `r2-cors.json` のオリジン不一致/未反映 | URL を完全一致で書き、`wrangler r2 bucket cors set …` を再実行 |
| アップロードが `403` | R2 の鍵が不正/権限不足 | R2 のトークンを作り直し `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` を入れ直す |
| 失敗ジョブの音声が24時間たっても残る | ライフサイクルルール未設定 | `wrangler r2 bucket lifecycle add …`([05](05-cloudflare.md) ステップ 4) |

## 4. Access([06](06-access.md))

| 症状 | 原因 | 対処 |
|---|---|---|
| 画面が開かず Access のログインが出続ける | メールが許可リストに無い | Policy の Include に正しいメールを入れる |
| 画面は開くが「認証の有効期限が切れています」 | `ACCESS_AUD`/`ACCESS_TEAM_DOMAIN` の誤り | 値を確認し再デプロイ。`wrangler tail` で `access.invalid_token` |
| 画面は開くが全 API が `401` で `access.missing_token` | Access を経由しない URL を開いている | Access で保護したホストで開く |
| コールバックが届かない(ジョブが処理中のまま) | `/internal/callback` が Bypass されていない | Bypass アプリの Path を確認([06](06-access.md) ステップ 3)。Modal のログに `callback.rejected` の status を見る |
| `DEV_SKIP_ACCESS` を本番に入れてしまった | 設定ミス | **削除して**再デプロイ(`wrangler secret delete`/`vars` から削除) |

## 5. 処理の途中(ジョブ)([09](09-verification.md))

| 症状 | 原因 | 対処 |
|---|---|---|
| 失敗:「処理を開始できませんでした」(`modal_start_failed`) | Modal の URL/トークン誤り、クレジット切れ、Modal の障害 | `MODAL_ENDPOINT_URL`、`MODAL_KEY`、`MODAL_SECRET` を確認。Modal の Billing を確認 |
| 処理中のまま75分 → `timeout` | コールバック不達、Modal の停止 | Worker のログ `callback.rejected`、Modal のログ `callback.gave_up` を確認 |
| `callback.rejected` + `bad_signature` | `CALLBACK_SECRET` が Modal と Worker で違う | 同じ値に揃える(Modal: `modal secret create … --force`、Worker: `wrangler secret put CALLBACK_SECRET`)。Modal は再デプロイ |
| `callback.rejected` + `stale_timestamp` | 時計のずれ | 通常は自動復旧。続く場合は Modal 側の時刻異常を疑う |
| `result_missing` | 結果の PUT が失敗/期限切れ | 署名付き URL の期限(90分)内に完了したか、R2 の鍵を確認 |
| 失敗: `audio_decode_failed` | 壊れたファイル | 別のファイルで試す |
| 失敗後に再実行すると `audio_expired`(410) | 音声が24時間で削除された | もう一度アップロード |
| 完了したのに Discord に来ない | Webhook 未登録/無効 | `discord.skipped_no_webhook` / `discord.rejected` を確認し、[07](07-discord.md) |
| 「アップロードが完了しませんでした」(`upload_abandoned`) | アップロード中にタブを閉じた等 | 新しく作り直す |

## 6. 画面

| 症状 | 原因 | 対処 |
|---|---|---|
| 画面が真っ白 | ビルド漏れ/JS エラー | `npm run build` を確認。ブラウザの Console を見る |
| `ページが見つかりません。` | URL の誤り | トップ `/` から開く |
| 一覧が更新されない | 処理中のジョブが無いとポーリングしない | 画面を再読み込み |
| ダウンロードした SRT/VTT が再生ソフトで読めない | 文字コード/形式の違い | UTF-8 で開く |

## 7. ローカル開発([08](08-local-dev.md))

| 症状 | 原因 | 対処 |
|---|---|---|
| `dev:worker` 起動時に `assets.directory` エラー | 未ビルド | `npm run build` |
| 画面は出るが API が `401` | `.dev.vars` が無い/`DEV_SKIP_ACCESS=true` が無い | `worker/.dev.vars` を作成して再起動 |
| ローカルでアップロードに失敗 | R2 の鍵が空 | 実際の R2 の鍵を入れる(宛先が実際の R2 のため) |
| Cron の `curl` が `404` | 起動オプション | `npm run dev -w worker -- --test-scheduled` で起動 |

## 8. 調べても分からないとき

1. `npx wrangler tail`(Worker)と `modal app logs whisper-transcriber`(Modal)を流しながら、もう一度操作する。
2. `job_id` で絞り込み、**どこで止まったか**を [../architecture/02-job-lifecycle.md](../architecture/02-job-lifecycle.md) の状態遷移図と照らす。
3. 仕組みの理解には [../architecture/README.md](../architecture/README.md) の「目的別の読み順」を使う。

## 関連ファイル

- [README.md](README.md)
- [../architecture/05-callback-and-notification.md](../architecture/05-callback-and-notification.md) — コールバックの仕組み
- [../architecture/06-cron-and-cleanup.md](../architecture/06-cron-and-cleanup.md) — タイムアウトと削除
