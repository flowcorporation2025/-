# TikTok Shop 自動運用 Bot

Playwright (Node.js) を使用した TikTok Shop アフィリエイトセンターの自動化 Bot。

## 機能

| 機能 | 説明 | スケジュール |
|------|------|-------------|
| クリエイター自動招待 | 条件でフィルタリングし、招待状①②で各50人・計100人に招待を送る | 毎日 10:00 JST |
| 商品自動復旧 | 違反で非公開になった商品を検知し再申請。LINE/Slack で通知 | 30分ごと |

## セットアップ

```bash
# 1. 依存パッケージインストール
npm install

# 2. Playwright ブラウザをインストール
npx playwright install chromium

# 3. 環境変数を設定
cp .env.example .env
# .env を編集して通知先 (Slack/LINE) を設定

# 4. 初回ログイン（セッション保存）
npm run login
# → ブラウザが開くので TikTok にログインし、Enter を押す
```

## 使い方

```bash
# スケジューラーを起動（24時間稼働）
npm start

# 即時実行
npm run invite     # クリエイター招待を今すぐ実行
npm run recovery   # 商品復旧チェックを今すぐ実行

# レポート表示（直近30日の招待実績 & 7日間の違反履歴）
npm run report
```

## 環境変数

| 変数名 | デフォルト | 説明 |
|--------|-----------|------|
| `SLACK_WEBHOOK_URL` | - | Slack 通知用 Webhook URL |
| `LINE_NOTIFY_TOKEN` | - | LINE Notify トークン |
| `FILTER_MIN_AVG_VIEWS` | `5000` | 平均視聴数フィルター |
| `FILTER_MIN_GMV` | `500000` | GMV フィルター（円） |
| `FILTER_MIN_ENGAGEMENT` | `1.0` | エンゲージメント率フィルター（%） |
| `INVITE_PER_LETTER` | `50` | 招待状ごとの送信人数 |
| `INVITE_DELAY_MS` | `2000` | 招待間隔（ms） |
| `INVITE_CRON` | `0 10 * * *` | 招待 cron (Asia/Tokyo) |
| `RECOVERY_CRON` | `*/30 * * * *` | 復旧チェック cron |
| `HEADLESS` | `false` | ヘッドレスモード |
| `LOG_LEVEL` | `info` | ログレベル |

## ファイル構成

```
├── src/
│   ├── index.js                 # エントリーポイント・スケジューラー
│   ├── auth/session.js          # セッション管理（ログイン・保存・復元）
│   ├── features/
│   │   ├── creatorInvite.js     # 機能①：クリエイター自動招待
│   │   └── productRecovery.js   # 機能②：商品自動復旧
│   ├── db/database.js           # SQLite データベース（招待履歴・違反履歴）
│   ├── notifications/notify.js  # Slack / LINE 通知
│   └── utils/logger.js          # ログ出力
├── data/                        # DB・セッションファイル（gitignore）
├── logs/                        # ログファイル（gitignore）
└── .env                         # 環境変数（gitignore）
```

## データベース

SQLite (`data/tiktok_bot.db`) に以下のテーブルを自動作成します。

| テーブル | 内容 |
|---------|------|
| `creator_invitations` | 招待履歴・承諾状況・売上転換 |
| `invitation_runs` | 招待バッチ実行ログ |
| `product_violations` | 違反商品の検知・再申請・復旧記録 |
| `product_monitor_logs` | 監視バッチ実行ログ |

## 注意事項

- **初回のみ手動ログインが必要**です（`npm run login`）。以降はセッションが自動復元されます。
- TikTok の UI 変更でセレクターが壊れる場合があります。その際は各 feature ファイルの `SELECTORS` を更新してください。
- 招待の連続送信はレート制限に注意。`INVITE_DELAY_MS` を調整してください。
- セッションファイル (`data/sessions/`) には認証情報が含まれます。外部に漏洩しないよう管理してください。
