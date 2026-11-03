# 08 ローカル開発(任意)

**ゴール**: 自分のパソコン上で Worker と画面を動かし、画面確認や Cron の動作確認ができるようにする。
**前提**: [01](01-prerequisites.md) が済んでいること。本番のセットアップ([04](04-modal.md)〜[06](06-access.md))より前でも画面は確認できます。

## ローカルでできること・できないこと

| できる | できない(実物のサービスが必要) |
|---|---|
| 画面の表示と操作、API、D1(ローカルの模擬 DB)、Cron の手動実行 | **音声のアップロード**(署名付き URL の宛先が実際の R2 のため、R2 の API キーが要る) |
| ログイン無しの開発(`DEV_SKIP_ACCESS`) | 文字起こし本体(Modal へのデプロイと `MODAL_*` が要る) |

## ステップ 1: `.dev.vars` を作る

`.dev.vars` は、ローカル専用の設定ファイル(秘密の値を入れる)です。Git には含まれません([.gitignore](../../.gitignore))。

**やること**

1. サンプルをコピーする。

```sh
cd ~/my_development/whisper
cp worker/.dev.vars.example worker/.dev.vars
```

2. `worker/.dev.vars` を開き、必要な値を入れる。

```
DEV_SKIP_ACCESS=true
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
MODAL_KEY=
MODAL_SECRET=
CALLBACK_SECRET=
DISCORD_WEBHOOK_URL=
```

| 項目 | 画面だけ確認 | アップロードまで試す |
|---|---|---|
| `DEV_SKIP_ACCESS` | `true` のまま | `true` のまま |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | 空でよい(アップロードで失敗する) | [05](05-cloudflare.md) のステップ 5 の値 |
| `MODAL_KEY` / `MODAL_SECRET` / `CALLBACK_SECRET` | 空でよい | [04](04-modal.md) の値 |
| `DISCORD_WEBHOOK_URL` | 空でよい(通知は送られず、ログだけ出る) | 自分の Webhook(テスト通知が届く) |

✅ **正常な場合**: ファイルが `worker/.dev.vars` にあり、`git status` に表示されない。

❌ **異常な場合**: `git status` に `.dev.vars` が出る → `.gitignore` を確認(**コミットしない**こと)。

⚠️ `DEV_SKIP_ACCESS=true` は**ローカル専用**です。本番のシークレットや `wrangler.jsonc` に絶対に入れないでください。

## ステップ 2: ローカルの D1 にテーブルを作る

```sh
npm run db:migrate:local -w worker
```

途中で確認が出たら **y**。

✅ **正常な場合**: `0001_create_jobs.sql` の適用に ✅ が付く。

❌ **異常な場合**

| 表示 | 対処 |
|---|---|
| `Couldn't find a D1 DB` | [wrangler.jsonc](../../worker/wrangler.jsonc) の `database_id` が未設定でもローカルは動くことが多い。失敗する場合は [05](05-cloudflare.md) のステップ 3 |
| `npm: command not found` | [01](01-prerequisites.md) |

## ステップ 3: 画面をビルドして Worker を起動する

```sh
npm run build
npm run dev:worker
```

✅ **正常な場合**: ターミナルに次が出て、起動したまま止まらない。

```
⎔ Starting local server...
[wrangler:info] Ready on http://localhost:8787
```

ブラウザで <http://localhost:8787> を開くと、**ジョブ一覧**画面(「まだジョブはありません」)が出る。

❌ **異常な場合**

| 表示 | 原因 | 対処 |
|---|---|---|
| `The directory specified by the "assets.directory" field … does not exist` | `npm run build` を忘れた | 先に `npm run build` |
| `Address already in use` (8787) | 別のプロセスが使用中 | 古い `wrangler dev` を止める |
| 画面は出るが API が `401` | `.dev.vars` が読めていない/`DEV_SKIP_ACCESS` が無い | `worker/.dev.vars` を確認し、再起動 |
| `Error: … wrangler.jsonc` の `REPLACE_WITH_` | 値が未設定 | ローカルでは通常問題ないが、起動時に失敗する場合は D1 の `database_id` を確認 |

## ステップ 4: 画面の開発サーバーを別ターミナルで起動する(画面を編集するとき)

画面のソースを変えながら確認する場合は、**別のターミナル**で次を実行します。

```sh
cd ~/my_development/whisper
npm run dev:frontend
```

✅ **正常な場合**: <http://localhost:5173> で画面が開く。API 呼び出し(`/api`)は自動で 8787 の Worker に転送される([vite.config.ts](../../frontend/vite.config.ts))。ファイルを保存すると画面が自動で更新される。

❌ **異常な場合**: 画面は出るが一覧が読み込めない → `npm run dev:worker` が動いているか確認。

## ステップ 5: Cron をローカルで動かす

Worker を起動した状態で、別のターミナルから次を実行します。

5分ごとの処理(時間切れの検知と取りこぼしの再投入):

```sh
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*"
```

毎日の処理(放置アップロードの整理と期限切れ削除):

```sh
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+18+*+*+*"
```

✅ **正常な場合**: `Ran scheduled event` のような応答が返り、`dev:worker` のターミナルに JSON のログが出る。

```
{"level":"info","event":"cron.started","cron":"*/5 * * * *"}
{"level":"info","event":"cron.timeout_check","timed_out":0}
{"level":"info","event":"cron.finished","cron":"*/5 * * * *"}
```

❌ **異常な場合**: `404` → 起動時に `--test-scheduled` が必要な古い wrangler の可能性。`npm run dev -w worker -- --test-scheduled` で起動してみる。

## ステップ 6: テストを動かす

```sh
npm run typecheck
npm test
```

Modal 側:

```sh
cd modal
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/pytest
```

✅ **正常な場合**: すべて `passed`。詳細は [../architecture/11-testing.md](../architecture/11-testing.md)。

## 次に読むファイル

- [09-verification.md](09-verification.md)
