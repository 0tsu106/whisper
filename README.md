# 音声文字起こしアプリ

Whisper と話者分離で長時間の日本語音声を文字起こしする個人用 Web アプリ。ジョブを投入すれば、PC の電源を落としてもクラウド側で処理が完了する。設計は [docs/plan.md](docs/plan.md) を参照。

```
frontend/   React アプリ
worker/     Hono API、Cron 処理、D1 マイグレーション
modal/      Python の文字起こし処理
```

## 開発

Node.js 22 以上と ffmpeg が必要。

```sh
npm install
npm run typecheck
npm test

# Modal 側のテスト
cd modal
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/pytest
```

### ローカル起動

```sh
cp worker/.dev.vars.example worker/.dev.vars   # 値を埋める
npm run db:migrate:local -w worker
npm run build
npm run dev:worker     # http://localhost:8787
npm run dev:frontend   # 別ターミナル。http://localhost:5173(API は 8787 に転送)
```

音声のアップロードには実際の R2 の API キーが必要になる。署名付き URL の宛先が R2 本体のため。

### Cron をローカルで動かす

```sh
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*"   # タイムアウト検知
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+18+*+*+*"    # 期限切れデータの削除
```

## デプロイ

### 1. Modal

1. Hugging Face で [speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1) の利用条件に同意し、読み取り専用のトークンを発行する
2. シークレットを登録してデプロイする

   ```sh
   cd modal
   .venv/bin/modal setup
   .venv/bin/modal secret create whisper-secrets HF_TOKEN=... CALLBACK_SECRET="$(openssl rand -hex 32)"
   .venv/bin/modal deploy app.py
   ```

3. Modal のダッシュボードで Proxy Auth Token を発行する(Worker の `MODAL_KEY` / `MODAL_SECRET` になる)

`CALLBACK_SECRET` は Worker にも同じ値を登録するので控えておく。

デプロイの前に、コマンドから1本だけ実行して精度、処理時間、クレジット消費を測れる。

```sh
.venv/bin/modal run app.py::main --input lecture.mp3 --output result.json
.venv/bin/modal run app.py::main --input lecture.mp3 --no-diarization --terms "専門用語,固有名詞"
```

### 2. Cloudflare

```sh
cd worker
npx wrangler d1 create whisper                # 表示された ID を wrangler.jsonc の database_id に設定
npx wrangler r2 bucket create whisper-files
npx wrangler r2 bucket lifecycle add whisper-files delete-audio audio/ --expire-days 1
```

`worker/wrangler.jsonc` の `vars` と `worker/r2-cors.json` の `REPLACE_WITH_*` を実際の値に置き換える。

```sh
npx wrangler r2 bucket cors set whisper-files --file r2-cors.json
npm run db:migrate:remote
```

ダッシュボードの「R2 > API トークン」で、`whisper-files` のみを対象にした読み書き用トークンを発行し、シークレットを登録する。

```sh
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put MODAL_KEY
npx wrangler secret put MODAL_SECRET
npx wrangler secret put CALLBACK_SECRET
npx wrangler secret put DISCORD_WEBHOOK_URL
```

ルートでデプロイする。

```sh
cd ..
npm run deploy
```

### 3. Cloudflare Access

1. アプリのホスト全体を自分のメールアドレスのみ許可する Allow ポリシーで保護する
2. `/internal/callback` だけを別のアプリケーションとして登録し、Bypass ポリシーにする(Modal からのコールバックは HMAC 署名で検証する)
3. Access アプリケーションの AUD を `ACCESS_AUD` に、チームのドメインを `ACCESS_TEAM_DOMAIN` に設定する

`DEV_SKIP_ACCESS` は本番に設定しない。設定すると JWT の検証が無効になる。

## ログ

各処理は1行の JSON を出力する。`job_id` で絞り込むと、Worker と Modal をまたいで1つのジョブを追える。

```sh
npx wrangler tail                              # Worker
.venv/bin/modal app logs whisper-transcriber   # Modal
```

文字起こし本文、署名付き URL、用語リストはログに出さない。ログを追加するときも同じルールに従う。

## Modal の依存関係を更新する

`modal/requirements.in` を編集してから、ロックファイルを生成し直す。

```sh
cd modal
uv pip compile requirements.in --python-version 3.12 --python-platform x86_64-unknown-linux-gnu \
  --no-header --no-annotate -o requirements.txt
```
