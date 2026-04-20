# TikTok Shop 自動運用 Bot v3.0

Playwright (Node.js) + Google Sheets API + Chatwork + Claude AI による TikTok Shop 完全自動運用 Bot。

## 機能一覧

| 機能 | 説明 | スケジュール |
|------|------|-------------|
| ①クリエイター自動招待 | 条件フィルタリング後、招待状①②で各50人・計100人に招待。結果をSheets①②に記録 | 毎日 10:00 JST |
| ②商品自動復旧 | 違反商品を検知し再申請、Sheets③に記録、Chatworkで即時通知 | 30分ごと |
| ③Sheetsデータ蓄積 | 日次/売上/違反/週次/月次の5シートに自動蓄積 | 各機能実行時 |
| ④週次レポート | KPI集計＋Claude AI分析→Chatworkへ。Sheets④に記録 | 毎週月曜 09:00 JST |
| ⑤月次レポート | KPI集計＋Claude AI分析→Chatworkへ。Sheets⑤に記録 | 毎月1日 09:00 JST |

## セットアップ

### 1. 依存パッケージ & ブラウザ
```bash
npm install
npx playwright install chromium
```

### 2. Google Cloud サービスアカウントの設定
1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクト作成
2. **APIとサービス** → **有効なAPI** → **Google Sheets API** を有効化
3. **IAMと管理** → **サービスアカウント** → 新規作成
4. サービスアカウントの **キー** → **新しいキーを追加 (JSON)** でダウンロード
5. スプレッドシートの共有設定でサービスアカウントのメールを **編集者** として追加

### 3. 環境変数の設定
```bash
cp .env.example .env
# .env を編集して各値を入力
```

### 4. Google Sheets を初期化（5シート自動作成）
```bash
npm run init-sheets
```

### 5. TikTok セッションの保存（初回のみ）
```bash
npm run login
# → ブラウザが開くのでログインし、Enter を押してセッション保存
```

### 6. 起動
```bash
npm start   # スケジューラー常駐起動（24時間稼働）
```

## コマンド一覧

```bash
npm run login           # セッション保存（初回）
npm run init-sheets     # Sheetsを初期化（初回）

npm run invite          # クリエイター招待を今すぐ実行
npm run recovery        # 商品復旧チェックを今すぐ実行
npm run weekly-report   # 週次レポートを今すぐ生成・送信
npm run monthly-report  # 月次レポートを今すぐ生成・送信
```

## Google Sheets 5シート構成

| シート | 内容 | 更新タイミング |
|--------|------|--------------|
| **①日次データ** | 日付・招待数①②・合計・実行時刻・エラー | 招待実行後 |
| **②売上データ** | 日付・承諾数・承諾率・転換率・売上金額・GMV | 別途更新 |
| **③違反履歴** | 商品ID/名・違反種別・検知日時・再申請・復旧時間・ステータス | 違反検知時 |
| **④週次サマリー** | 週集計＋AI改善提案 | 週次レポート実行時 |
| **⑤月次サマリー** | 月集計＋AI改善提案 | 月次レポート実行時 |

## Chatworkレポートサンプル

```
【週次レポート】2026/04/14〜04/20
招待数：700人 / 承諾率：12.0%（先週比+3.0%）
売上金額：480万円（先週比+15%）
GMV変化：+8%
商品落ち：3件（平均復旧時間12分）

【改善提案】
今週の承諾率は12%と先週比+3%で改善しました。GMVフィルターの絞り込み
効果が表れています。ただし売上転換率が低下しており、承諾後のフォロー
アップが課題です。来週はエンゲージメント率の閾値を1.5%に引き上げ、
より購買力の高いクリエイターに絞り込むことを推奨します。

詳細はこちら→ https://docs.google.com/spreadsheets/d/xxxxx
```

## ファイル構成

```
├── src/
│   ├── index.js                    # エントリーポイント・スケジューラー
│   ├── auth/session.js             # セッション管理
│   ├── features/
│   │   ├── creatorInvite.js        # 機能①：クリエイター自動招待
│   │   ├── productRecovery.js      # 機能②：商品自動復旧
│   │   └── reportGenerator.js      # 機能④⑤：週次・月次レポート（Claude API）
│   ├── sheets/
│   │   └── googleSheets.js         # Google Sheets API ラッパー（5シート管理）
│   ├── notifications/
│   │   ├── chatwork.js             # Chatwork API ラッパー
│   │   └── notify.js               # 通知ヘルパー
│   └── utils/logger.js             # ログ出力
├── data/
│   ├── sessions/                   # TikTokセッション（gitignore）
│   └── invited_creators.json       # 招待済みクリエイターキャッシュ（gitignore）
└── logs/                           # ログファイル（gitignore）
```

## 環境変数

| 変数名 | 必須 | 説明 |
|--------|------|------|
| `TIKTOK_EMAIL` | ✓ | TikTokアカウントのメールアドレス |
| `TIKTOK_PASSWORD` | ✓ | TikTokアカウントのパスワード |
| `CHATWORK_API_TOKEN` | ✓ | Chatwork APIトークン |
| `CHATWORK_ROOM_ID` | ✓ | アラート送信先ルームID |
| `CHATWORK_REPORT_ROOM_ID` | | レポート送信先ルームID（省略可） |
| `ANTHROPIC_API_KEY` | ✓ | Claude APIキー |
| `GOOGLE_SHEETS_ID` | ✓ | スプレッドシートID |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | ✓ | サービスアカウントJSONキーのパス |
| `FILTER_MIN_AVG_VIEWS` | | 平均視聴数下限（デフォルト: 5000） |
| `FILTER_MIN_GMV` | | GMV下限・円（デフォルト: 500000） |
| `FILTER_MIN_ENGAGEMENT` | | エンゲージメント率下限・%（デフォルト: 1.0） |
| `INVITE_PER_LETTER` | | 招待状ごとの送信人数（デフォルト: 50） |
| `INVITE_DELAY_MS` | | 招待間隔ms（デフォルト: 2000） |
| `HEADLESS` | | ヘッドレスモード（デフォルト: false） |

## 注意事項

- **初回のみ** `npm run login` と `npm run init-sheets` が必要です
- Sheet②（売上データ）は TikTok アフィリエイトダッシュボードから手動または別途スクレイピングで更新してください
- サービスアカウントキー (`*.json`) は機密情報です。`.gitignore` に追加し外部に漏洩しないよう管理してください
- TikTok UIの変更でセレクターが壊れた場合は各 feature ファイルの `SELECTORS` を更新してください
