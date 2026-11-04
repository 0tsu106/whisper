# 04 Modal:セットアップとデプロイ

**ゴール**: GPU で文字起こしを行う Modal アプリ `whisper-transcriber` をデプロイし、Worker から呼ぶための値を手に入れる。
**前提**: [01](01-prerequisites.md)(Python)、[02](02-accounts.md)(Modal アカウント)、[03](03-huggingface.md)(`HF_TOKEN`)。
**仕組み**: [../architecture/04-transcription-pipeline.md](../architecture/04-transcription-pipeline.md)

公式ドキュメント: <https://modal.com/docs/guide>

## ステップ 1: Python の仮想環境と Modal CLI を入れる

仮想環境(venv)は、このアプリ専用の Python 置き場です。他のソフトに影響しません。

**やること**

1. `modal` フォルダへ移動する。

```sh
cd ~/my_development/whisper/modal
```

2. 仮想環境を作る。

```sh
python3 -m venv .venv
```

3. Modal CLI とテスト用ツールを入れる。

```sh
.venv/bin/pip install -r requirements-dev.txt
```

✅ **正常な場合**: `Successfully installed modal-1.6.3 …` と出る。続けて確認する。

```sh
.venv/bin/modal --version
```

```
modal client version: 1.6.3
```

❌ **異常な場合**

| 表示 | 対処 |
|---|---|
| `ensurepip is not available` | `sudo apt install -y python3-venv` の後、`.venv` を削除して再作成 |
| `No matching distribution found` | Python が新しすぎる/古すぎる可能性。Python 3.10〜3.13 を使う |
| `ERROR: Could not install packages` + ネットワーク | 接続を確認して再実行 |

## ステップ 2: Modal にログインする(`modal setup`)

**やること**

1. 次を実行する。

```sh
.venv/bin/modal setup
```

2. ブラウザが自動で開き、Modal の認証画面になる。開かない場合は、ターミナルに表示された URL をブラウザに貼り付ける。
3. 画面の **Authorize**(許可)ボタンをクリックする。
4. ターミナルに戻り、完了メッセージを確認する。

✅ **正常な場合**

```
The web browser should have opened for you to authenticate and get an API token.
...
Web authentication finished successfully!
Token is connected to the workspace <あなたのワークスペース名>.
Verifying token against https://api.modal.com
Token verified successfully!
```

❌ **異常な場合**

| 表示 | 原因 | 対処 |
|---|---|---|
| ブラウザが開かない(WSL) | ブラウザ自動起動の失敗 | 表示された URL を手動でブラウザに貼る |
| `Token verification failed` | 認証が中断された | もう一度 `modal setup` |
| `modal: command not found` | venv を使っていない | `.venv/bin/modal` と**パス付き**で実行する |

## ステップ 3: シークレットを登録する

Modal の Secret は、パスワード類を安全に保存する機能です。`whisper-secrets` という名前で、`HF_TOKEN` と `CALLBACK_SECRET` を入れます([app.py](../../modal/app.py) が `modal.Secret.from_name("whisper-secrets")` で読み込みます)。

**やること**

1. `CALLBACK_SECRET` を作る。ランダムな64文字の文字列です。

```sh
openssl rand -hex 32
```

✅ **正常な場合**: 英数字64文字が1行表示される。

```
<ここに値>   (例: 3b1f…64文字)
```

📝 **控える値**: `CALLBACK_SECRET`(**Worker にも同じ値を登録します**。[05](05-cloudflare.md))

2. シークレットを登録する。`<…>` を実際の値に置き換えて実行する。

```sh
.venv/bin/modal secret create whisper-secrets HF_TOKEN=<03で控えたhf_トークン> CALLBACK_SECRET=<上で作った64文字>
```

✅ **正常な場合**

```
Created a new secret 'whisper-secrets' with the keys 'HF_TOKEN', 'CALLBACK_SECRET'
```

❌ **異常な場合**

| 表示 | 原因 | 対処 |
|---|---|---|
| `Secret 'whisper-secrets' already exists` | 作成済み | `--force` を付けて上書き: `modal secret create whisper-secrets … --force` |
| `openssl: command not found` | openssl 未インストール | `sudo apt install -y openssl`、または別の方法で64文字の乱数を作る |
| `Not authenticated` | ステップ 2 が未完了 | `modal setup` をやり直す |

確認(ダッシュボード): 左メニュー **Secrets** をクリックし、`whisper-secrets` が一覧にあれば OK。

## ステップ 4: デプロイする

**やること**

```sh
.venv/bin/modal deploy app.py
```

初回は、コンテナの画像(Docker イメージ)を作るため**数分〜十数分**かかります(Python パッケージ、ffmpeg、PyTorch などを入れます)。待ちましょう。

✅ **正常な場合**: 最後に Web エンドポイントの URL が表示される。

```
✓ Created objects.
├── 🔨 Created mount …
├── 🔨 Created function run_job.
├── 🔨 Created web function start => https://<ワークスペース名>--whisper-transcriber-start.modal.run
└── 🔨 Created function transcribe_file.
✓ App deployed! 🎉
```

📝 **控える値**: `https://…--whisper-transcriber-start.modal.run` → [05](05-cloudflare.md) で `MODAL_ENDPOINT_URL` に設定する。

❌ **異常な場合**

| 表示 | 原因 | 対処 |
|---|---|---|
| `Secret 'whisper-secrets' not found` | シークレット名の違い/未作成 | ステップ 3 を確認 |
| `No such file … requirements.txt` | 実行場所が違う | `modal` フォルダで実行しているか確認 |
| イメージのビルドが失敗(パッケージの取得エラー) | 一時的なネットワークの問題 | 同じコマンドを再実行 |
| `Billing / credits` 関連のエラー | クレジット不足/支払い設定 | ダッシュボードの **Settings → Billing** を確認 |
| `Please add a payment method to use T4 GPU functions` | GPU 関数の利用にはカード登録が必須 | **Settings → Billing** でカードを登録し、**Budgets** で Spend limit(支払い上限)を小さく設定してから再デプロイ |

## ステップ 5: Proxy Auth Token を発行する

このトークンが無いと、Worker から Modal を呼べません(誰でも呼べると、他人にクレジットを使われるためです)。

**やること**

1. ブラウザで Modal のダッシュボードを開く(<https://modal.com/home>)。
2. 左下(または左メニュー)の **Settings** をクリックする。
3. **Proxy Auth Tokens**(プロキシ認証トークン)をクリックする。
4. **New Token**(新規トークン)ボタンをクリックする。
5. 表示された **Token ID**(`wk-…`)と **Token Secret**(`ws-…`)を、それぞれコピーして控える。

✅ **正常な場合**: 2つの値が表示される。**Secret は一度しか表示されません**。

```
Token ID:     wk-<ここに値>
Token Secret: ws-<ここに値>
```

📝 **控える値**

| 値 | Worker での名前([05](05-cloudflare.md)) |
|---|---|
| Token ID(`wk-…`) | `MODAL_KEY` |
| Token Secret(`ws-…`) | `MODAL_SECRET` |

❌ **異常な場合**

| 症状 | 対処 |
|---|---|
| Secret をコピーし忘れた | トークンを削除して新しく作る |
| メニューに **Proxy Auth Tokens** が無い | **Settings** 内を探す/画面表記の変更の可能性。公式: <https://modal.com/docs/guide/webhook-proxy-auth> |

## ステップ 6: エンドポイントが認証で守られているか確認する

**やること**(URL は控えた値に置き換える)

```sh
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<ワークスペース名>--whisper-transcriber-start.modal.run -H "Content-Type: application/json" -d '{}'
```

✅ **正常な場合**: `401`(トークン無しでは拒否される=守られている)

❌ **異常な場合**

| 表示 | 意味 | 対処 |
|---|---|---|
| `200` / `500` | 認証が掛かっていない/中身が動いた | `app.py` の `requires_proxy_auth=True` を確認し、再デプロイ |
| `404` | URL の誤り | デプロイ時の表示と見比べる |

## ステップ 7: 単体で1本だけ実行して精度・時間・消費を測る(推奨)

Worker を作る前に、Modal だけを試せます。短い音声(数分)を用意してください。

**やること**

```sh
.venv/bin/modal run app.py::main --input lecture.mp3 --output result.json
```

話者分離なし、用語リスト付きの例:

```sh
.venv/bin/modal run app.py::main --input lecture.mp3 --no-diarization --terms "専門用語,固有名詞"
```

精度を上げたいときのオプション(1つずつ変えて、結果を見比べてください):

| オプション | 効果 |
|---|---|
| `--terms "心理ゼミ,Discord,人名…"` | 固有名詞・専門用語の認識を助ける。**人名や団体名は必ず入れる** |
| `--normalize` | 音量を整える。片方の声が小さい通話録音で、取りこぼしが減る |
| `--vad-threshold 0.35 --vad-min-silence-ms 600` | 小声やあいづちを拾いやすくする(既定は 0.5 / 2000) |
| `--context` | 前の文を手がかりにする。固有名詞は安定するが、繰り返しが出ないか確認する |
| `--model large-v2` など | Whisper のモデルを変える(`kotoba-tech/kotoba-whisper-v2.0-faster` も試せる) |
| `--no-vad` | 音声の検出を切る(抜けが多いときの切り分け用) |
| `--debug` | 結合前の Whisper の結果と話者の区間を `<出力名>.debug.json` に保存する(話者の誤りの切り分け用) |

初回はモデル(Whisper と話者分離モデル。合計で数GB)のダウンロードで時間がかかり、2回目以降はキャッシュ(Volume)が効いて速くなります。

✅ **正常な場合**: 最後に出力ファイルが作られる。

```
uploading lecture.mp3 (… bytes)
...
removed the uploaded audio from the volume
wrote result.json: 300s of audio, 42 segments, 95s elapsed
```

`result.json` を開き、`segments` に日本語の本文と `speaker` があれば成功。

❌ **異常な場合**

| 表示/症状 | 原因 | 対処 |
|---|---|---|
| `FileNotFoundError: lecture.mp3` | ファイルがその場所に無い | パスを正しく指定する |
| `diarization_failed` / `401` / `gated` | `HF_TOKEN` が無効、または利用条件に未同意 | [03](03-huggingface.md) を確認し、Secret を `--force` で作り直す |
| `out_of_memory` | 音声が長い/GPU メモリ不足 | 短い音声で試す、または `app.py` の GPU を変更する |
| 本文が空 | 無音/声が小さい | 別の音声で試す |
| 文字化け・変な繰り返し | 音質が悪い | 用語リストや別の音声で確認 |

## 補足: 更新したいとき

`modal/` の Python を変更したら、同じ `modal deploy app.py` を再実行します。依存パッケージを変えたい場合は [../../README.md](../../README.md) の「Modal の依存関係を更新する」を参照。

## チェックリスト

- ☐ `modal setup` が成功した
- ☐ `whisper-secrets`(`HF_TOKEN`, `CALLBACK_SECRET`)を登録した
- ☐ `modal deploy app.py` が成功し、URL を控えた
- ☐ Proxy Auth Token(Token ID / Secret)を控えた
- ☐ 認証なしの POST が `401` になる
- ☐ (推奨)`modal run` で結果 JSON が得られた

## 次に読むファイル

- [07-discord.md](07-discord.md) → [05-cloudflare.md](05-cloudflare.md)
