# TikTok Shop 自動運用 Bot v2.0

Playwright (Node.js) を使用した TikTok Shop アフィリエイトセンターの自動化 Bot。

## 機能

| 機能 | 説明 | スケジュール |
|------|------|-------------|
| クリエイター自動招待 | 条件でフィルタリングし、招待状①②で各50人・計100人に招待を送る | 毎日 10:00 JST |
| 商品自動復旧 | 違反で非公開になった商品を検知し再申請。Chatwork で即時通知 | 30分ごと |
| 週次レポート | KPI集計 + Claude AIによる分析・改善提案を Chatwork へ送付 | 毎週月曜 09:00 JST |
| 月次レポート | KPI集計 + Claude AIによる分析・改善提案を Chatwork へ送付 | 毎月1日 09:00 JST |

## セットアップ

```bash
# 1. 依存パッケージインストール
npm install

# 2. Playwright ブラウザをインストール
npx playwright install chromium

# 3. 環境変数を設定
cp .env.example .env
# .env を編集して各APIキーを入力

# 4. 初回ログイン（セッション保存）
npm run login
# → ブラウザが開くので TikTok にログインし、Enter を押す
```

## 使い方

```bash
# スケジューラーを起動（24時間稼働）
npm start

# 即時実行
npm run invite          # クリエイター招待を今すぐ実行
npm run recovery        # 商品復旧チェックを今すぐ実行
npm run weekly-report   # 週次レポートを今すぐ生成・送信
npm run monthly-report  # 月次レポートを今すぐ生成・送信

# ローカルレポート表示（直近30日の招待実績 & 7日間の違反履歴）
npm run report
```

## 環境変数

| 変数名 | デフォルト | 説明 |
|--------|-----------|------|
| `CHATWORK_API_TOKEN` | **必須** | Chatwork API トークン |
| `CHATWORK_ROOM_ID` | **必須** | アラート送信先ルームID |
| `CHATWORK_REPORT_ROOM_ID` | = ROOM_ID | レポート送信先ルームID |
| `ANTHROPIC_API_KEY` | **必須** | Claude API キー（週次・月次レポートのAI分析） |
| `FILTER_MIN_AVG_VIEWS` | `5000` | 平均視聴数フィルター |
| `FILTER_MIN_GMV` | `500000` | GMV フィルター（円） |
| `FILTER_MIN_ENGAGEMENT` | `1.0` | エンゲージメント率フィルター（%） |
| `INVITE_PER_LETTER` | `50` | 招待状ごとの送信人数 |
| `INVITE_DELAY_MS` | `2000` | 招待間隔（ms） |
| `INVITE_CRON` | `0 10 * * *` | 招待 cron (Asia/Tokyo) |
| `RECOVERY_CRON` | `*/30 * * * *` | 復旧チェック cron |
| `WEEKLY_REPORT_CRON` | `0 9 * * 1` | 週次レポート cron |
| `MONTHLY_REPORT_CRON` | `0 9 1 * *` | 月次レポート cron |
| `HEADLESS` | `false` | ヘッドレスモード |
| `LOG_LEVEL` | `info` | ログレベル |

## レポートサンプル（Chatwork送信イメージ）

```
[TikTok Shop] 週次レポート (2026年4月20日週)
========================================

■ クリエイター招待実績
招待数      : 700人 (前期比: +0)
承諾率      : 12.5% (前期比: +2.3%)
売上転換率  : 8.2% (前期比: -0.5%)
売上金額    : ¥1,250,000 (前期比: +15.2%)
GMV        : ¥3,800,000 (前期比: +8.5%)

■ 商品ガイドライン違反
違反検知    : 3件 (前期比: -2)
復旧済み    : 3件
平均復旧時間: 42分 (前期比: -25)

■ AIによる分析・改善提案
今週の承諾率は12.5%（先週比+2.3%）と改善しました。GMVフィルター強化の
効果が表れています。一方、売上転換率が0.5%低下しており、承諾後のフォロー
アップが課題です。来週はエンゲージメント率の閾値を1.5%に引き上げ、
より質の高いクリエイターに絞り込むことを推奨します。

生成日時: 2026-04-21 09:00 JST
```

## ファイル構成

```
├── src/
│   ├── index.js                    # エントリーポイント・スケジューラー
│   ├── auth/session.js             # セッション管理
│   ├── features/
│   │   ├── creatorInvite.js        # 機能①：クリエイター自動招待
│   │   ├── productRecovery.js      # 機能②：商品自動復旧
│   │   └── reportGenerator.js      # 機能③：週次・月次レポート（Claude API）
│   ├── db/database.js              # SQLite（招待・売上・GMV・違反履歴）
│   ├── notifications/
│   │   ├── chatwork.js             # Chatwork API ラッパー
│   │   └── notify.js               # 通知ヘルパー関数
│   └── utils/logger.js             # ログ出力
├── data/                           # DB・セッションファイル（gitignore）
├── logs/                           # ログファイル（gitignore）
└── .env                            # 環境変数（gitignore）
```

## データベース

SQLite (`data/tiktok_bot.db`) に以下のテーブルを自動作成します。

| テーブル | 内容 |
|---------|------|
| `creator_invitations` | 招待履歴・承諾状況・売上金額・GMV |
| `invitation_runs` | 招待バッチ実行ログ |
| `product_violations` | 違反商品の検知・再申請・復旧時間 |
| `product_monitor_logs` | 監視バッチ実行ログ |

## Chatwork API キーの取得方法

1. Chatwork にログイン
2. 右上のアカウント名 → **「サービス連携」** → **「API Token」**
3. 発行されたトークンを `CHATWORK_API_TOKEN` に設定
4. ルームID: Chatwork のルームを開き URL の `#!rid` 以降の数字

## 注意事項

- **初回のみ手動ログインが必要**です（`npm run login`）。以降はセッションが自動復元されます。
- TikTok の UI 変更でセレクターが壊れる場合は各 feature ファイルの `SELECTORS` を更新してください。
- セッションファイル (`data/sessions/`) には認証情報が含まれます。外部に漏洩しないよう管理してください。
- Claude API の利用には Anthropic アカウントとクレジットが必要です。レポートの AI 分析のみに使用します。
