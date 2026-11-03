# 11 テスト

**このファイルで分かること**: どこに何のテストがあり、どう実行し、何を保証しているか。
**前提**: [02](02-job-lifecycle.md)〜[08](08-frontend.md) を読んでいると理解しやすい。

## テストの全体像

| 対象 | ファイル | ツール | 何を試すか |
|---|---|---|---|
| Worker(API・状態遷移・Cron) | [worker/test/jobs.test.ts](../../worker/test/jobs.test.ts) | Vitest + Cloudflare 用プラグイン | D1・R2 は**テスト用の本物に近い環境**、Modal と Discord は偽物 |
| フロント(出力形式) | [frontend/src/lib/formats.test.ts](../../frontend/src/lib/formats.test.ts) | Vitest | 5形式の文字列生成 |
| Modal(処理の本体) | [modal/tests/test_pipeline.py](../../modal/tests/test_pipeline.py) | pytest | 話者割当、ダウンロード、コールバック、ffmpeg |

GPU が要る Whisper / pyannote の実行そのものは**自動テストの対象外**です。実音声は `modal run` で手動確認します([09-verification](../setup/09-verification.md))。

## 実行方法

```sh
npm install
npm run typecheck     # 型の検査 (frontend と worker)
npm test              # frontend と worker のテスト
```

```sh
cd modal
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/pytest
```

正常なら緑の `passed` が並び、失敗があれば失敗したテスト名と差分が出ます。

## Worker のテストが保証すること

[worker/vitest.config.ts](../../worker/vitest.config.ts) が D1・R2 のテスト用環境と偽の環境変数を用意します。

| グループ | テストの内容 | 関連する設計 |
|---|---|---|
| `POST /api/jobs` | `uploading` のジョブと署名付き PUT URL ができる | [03](03-upload-flow.md) |
| `POST …/complete` | 音声が無ければ拒否/Modal を正しい URL とプロキシ認証で起動/二重完了で二重起動しない/300MB 超は削除して失敗 | [03](03-upload-flow.md) |
| `POST /internal/callback` | 不正署名・古い時刻を拒否/完了で音声削除+通知/結果が無ければ再試行/2回再試行後に失敗して通知は1回/古い attempt を無視/Discord 失敗がジョブに影響しない | [05](05-callback-and-notification.md) |
| Modal start failures | 起動失敗で再試行を使い切り失敗 | [02](02-job-lifecycle.md) |
| `POST …/retry` | 新 attempt と再試行回数の回復/音声が無ければ 410/失敗以外は拒否 | [02](02-job-lifecycle.md) |
| cron | 75分未満は失敗にしない/最終試行のタイムアウトで失敗通知/`queued` の再投入/期限切れの削除/1日経過の `uploading` を放置扱い | [06](06-cron-and-cleanup.md) |
| result and speakers | 完了前は 409/話者名保存で結果は不変、空は除外/不正キーを拒否 | [07](07-api-reference.md) |
| Access | トークン無し・不正トークンを 401/コールバックは対象外 | [09](09-security.md) |
| logging | 署名付き URL と用語がログに出ない | [09](09-security.md) |
| verifySignature | 正しい署名の受理と改ざんの拒否 | [05](05-callback-and-notification.md) |

## Modal のテストが保証すること(pytest)

| クラス/内容 | 例 |
|---|---|
| `merge_speakers` | 話者が変わる位置で分割/重なり最長の話者/複数区間の合算/重ならないときは最も近い区間/単語なしのセグメント/空白の除去 |
| `process_audio`(結果の形) | 話者分離オン/オフの JSON |
| `download_audio` | ファイル書き込み/サイズ超過の拒否/通信エラーに URL を含めない/ステータスエラー |
| `upload_result`, `send_callback` | UTF-8 JSON/失敗の分類/署名が `timestamp.body`/5xx は指数バックオフで再送/4xx は再送しない/上限で諦める |
| `convert_to_wav` | 16kHz モノラル出力/動画の映像を除去/壊れた入力の分類(ffmpeg が必要) |

## フロントのテストが保証すること

`formatClock`(時間の書式)、`toMarkdown`(話者が変わるたびに見出し、話者分離オフ、空)、`toText`、`toSrt`(連番、カンマ区切り、繰り上がり)、`toVtt`(ヘッダ、ドット区切り、特殊文字のエスケープ)、`toJson`(名前追加で本文は不変)、`exportFilename`(拡張子の置換)。

## テストの追加方法の目安

- Worker の振る舞いを足したら、`worker/test/jobs.test.ts` に同じ書き方で追加する(偽の Modal / Discord の呼び出し履歴を確認している)。
- 純粋な関数(`formats.ts`、`pipeline.py` の変換類)は、入力と出力を書くだけで試せるので、追加しやすい。
- ログに載せる項目を増やすときは、`logging` のテストの観点(URL・用語・本文を出さない)を守る。

## 関連ファイル

- [02-job-lifecycle.md](02-job-lifecycle.md), [05-callback-and-notification.md](05-callback-and-notification.md), [06-cron-and-cleanup.md](06-cron-and-cleanup.md) — テストが守っている仕様
- [../setup/08-local-dev.md](../setup/08-local-dev.md) — 開発環境の準備
