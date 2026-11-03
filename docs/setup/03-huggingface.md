# 03 Hugging Face:モデルの利用同意とトークン

**ゴール**: 話者分離モデルの利用条件に同意し、読み取り用の `HF_TOKEN` を発行する。
**前提**: [02-accounts.md](02-accounts.md) で Hugging Face のアカウントを作成済み。

話者分離モデル `pyannote/speaker-diarization-community-1` は「利用条件に同意した人だけがダウンロードできる」設定(gated model)です。同意しないと、話者分離を有効にしたジョブが `diarization_failed` で失敗します。

公式ページ: <https://huggingface.co/pyannote/speaker-diarization-community-1>

## ステップ 1: 利用条件に同意する

**やること**

1. Hugging Face にログインした状態で、上記のモデルページを開く。
2. ページ上部またはファイル一覧の上に、利用条件の案内(`You need to agree to share your contact information to access this model` など)が表示される。
3. 入力欄(会社名・用途など)があれば入力する。
4. **Agree and access repository**(リポジトリへのアクセスに同意)ボタンをクリックする。

✅ **正常な場合**: 案内が消え、ページ上で **Files and versions** タブのファイルが開けるようになる。
アカウント設定の **Gated Repositories**(<https://huggingface.co/settings/gated-repos>)に、このモデルが「承認済み」として載る。

❌ **異常な場合**

| 症状 | 原因 | 対処 |
|---|---|---|
| ボタンが見当たらない | ログインしていない | 右上の **Log in** からログインし、ページを再読み込み |
| 同意後も 403 / `gated` の表示のまま | メール未認証/反映待ち | メール認証を確認し、数分待って再読み込み |
| 承認待ち(Pending) | 作者の承認が必要な設定 | 承認されるまで待つ(承認までは話者分離を使えない) |

> 利用条件(個人利用の可否など)はモデルページに書かれています。**必ず自分で読んで**から同意してください。

## ステップ 2: アクセストークンを作る

**やること**

1. 右上のアイコンをクリックし、**Settings** をクリックする。
2. 左メニューの **Access Tokens** をクリックする(直接: <https://huggingface.co/settings/tokens>)。
3. **Create new token**(新しいトークンを作成)をクリックする。
4. **Token type**(種類)で **Read**(読み取り専用)を選ぶ。
   - 「Fine-grained」を選ぶ場合は、上記モデルへの読み取り権限だけを与える。
5. **Token name** に分かりやすい名前(例: `whisper-modal`)を入力する。
6. **Create token** をクリックする。
7. 表示された `hf_` で始まる文字列の横の **コピー** ボタンを押して、手元に控える。

✅ **正常な場合**: 緑の「Token created」的な表示とともに `hf_…` で始まる長い文字列が表示される。

```
hf_<ここに値>      ← 実際の値は 1 度しか表示されません
```

❌ **異常な場合**

| 症状 | 対処 |
|---|---|
| 閉じてしまいトークンが分からない | 同じ画面で既存トークンを **Invalidate and refresh**(または削除)して作り直す |
| **Write** を選んでしまった | 権限が広すぎる。**Read** で作り直し、古いほうを削除する |

📝 **控える値**

| 値 | 使う場所 |
|---|---|
| `HF_TOKEN`(`hf_…`) | [04-modal.md](04-modal.md) の `modal secret create` |

⚠️ トークンは**パスワードと同じ**扱いです。チャットやコードに貼らないでください。

## ステップ 3: 同意とトークンが有効か確認する(任意)

次のコマンドは、トークンでモデルのファイル情報を取得できるかを確かめます。`<ここに値>` を自分のトークンに置き換えて実行します。

```sh
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer <ここに値>" https://huggingface.co/pyannote/speaker-diarization-community-1/resolve/main/config.yaml
```

✅ **正常な場合**: `200`(または `302`)

❌ **異常な場合**

| 表示 | 意味 | 対処 |
|---|---|---|
| `401` | トークンが無効 | トークンを作り直す |
| `403` | 利用条件に未同意/未承認 | ステップ 1 をやり直す |
| `404` | ファイル名が変わった可能性 | モデルページで同意状況だけ確認すれば十分 |

## チェックリスト

- ☐ モデルの利用条件に同意し、承認済みになっている
- ☐ Read のトークンを作り、安全な場所に控えた

## 次に読むファイル

- [04-modal.md](04-modal.md)
