# 01 前提ツールの準備

**ゴール**: Node.js 22 以上、Python 3、ffmpeg、Git がコマンドで動く状態にする。
**前提**: ターミナル(コマンドを入力する黒い画面)が開けること。Windows の場合は WSL2(Ubuntu)で作業する想定です。

以下の `$` は入力する行の目印です(`$` 自体は打ちません)。

## ステップ 1: Git

**やること**

1. ターミナルを開く。
2. 次のコマンドを入力して **Enter** を押す。

```sh
git --version
```

✅ **正常な場合**: バージョンが表示される。

```
git version 2.43.0
```

❌ **異常な場合**: `git: command not found`
→ 未インストール。Ubuntu/WSL では次を実行する。

```sh
sudo apt update && sudo apt install -y git
```

## ステップ 2: Node.js 22 以上

**やること**

```sh
node -v
```

✅ **正常な場合**: `v22.` 以上。

```
v22.12.0
```

❌ **異常な場合**

| 表示 | 原因 | 対処 |
|---|---|---|
| `command not found` | 未インストール | 下の手順で入れる |
| `v18.x.x` や `v20.x.x` | バージョンが古い | 下の手順で 22 以上にする |

**インストール方法(nvm を使う例)**

1. nvm の公式手順に従って nvm を入れる: <https://github.com/nvm-sh/nvm#installing-and-updating>
2. ターミナルを開き直し、次を実行する。

```sh
nvm install 22
nvm use 22
node -v
```

## ステップ 3: Python 3 と venv

Python は Modal の CLI(`modal` コマンド)を動かすために使います。

**やること**

```sh
python3 --version
python3 -m venv --help
```

✅ **正常な場合**: `Python 3.x.x` が表示され、`venv` のヘルプが出る(Python 3.10 以上を推奨)。

❌ **異常な場合**

| 表示 | 対処 |
|---|---|
| `python3: command not found` | `sudo apt install -y python3 python3-venv` |
| `No module named venv` / `ensurepip is not available` | `sudo apt install -y python3-venv` |

## ステップ 4: ffmpeg

ffmpeg は音声変換のコマンドです。本番の変換は Modal 上で行われますが、Modal 側のテスト(`pytest`)を手元で動かすときに必要です。

**やること**

```sh
ffmpeg -version
```

✅ **正常な場合**: 1行目にバージョンが出る。

```
ffmpeg version 6.1.1 Copyright (c) 2000-2023 the FFmpeg developers
```

❌ **異常な場合**: `command not found` → `sudo apt install -y ffmpeg`

## ステップ 5: ソースコードの取得と依存関係のインストール

**やること**

1. ソースを置いたフォルダへ移動する(すでに手元にある場合は、そのフォルダ)。

```sh
cd ~/my_development/whisper
```

2. Node.js の依存パッケージをまとめて入れる。

```sh
npm install
```

✅ **正常な場合**: 最後に `added … packages` と出て、エラー終了しない。`node_modules/` フォルダができる。

❌ **異常な場合**

| 表示 | 原因 | 対処 |
|---|---|---|
| `Unsupported engine` / 構文エラー | Node.js が古い | ステップ 2 に戻る |
| `EACCES: permission denied` | 権限の問題 | `sudo` は使わず、nvm で入れた Node を使う |
| `ENOTFOUND registry.npmjs.org` | ネットワーク | 接続を確認して再実行 |

3. 動作確認として型検査とテストを実行する。

```sh
npm run typecheck
npm test
```

✅ **正常な場合**: エラーなく終わり、テストが `passed` と表示される。

❌ **異常な場合**: テストが失敗する → 出力の最初のエラーを確認し、[10-troubleshooting.md](10-troubleshooting.md) を参照。

## チェックリスト

- ☐ `git --version` が出る
- ☐ `node -v` が v22 以上
- ☐ `python3 --version` と venv が使える
- ☐ `ffmpeg -version` が出る
- ☐ `npm install` が成功し、`npm test` が通る

## 次に読むファイル

- [02-accounts.md](02-accounts.md)
