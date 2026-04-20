require('dotenv').config();
const cron = require('node-cron');
const logger = require('./utils/logger');
const { runCreatorInvite } = require('./features/creatorInvite');
const { runProductRecovery } = require('./features/productRecovery');
const { runWeeklyReport, runMonthlyReport } = require('./features/reportGenerator');
const { getAuthenticatedPage, saveSession, TIKTOK_SELLER_URL } = require('./auth/session');
const db = require('./db/database');

const args = process.argv.slice(2);
const taskArg = args.find((a) => a.startsWith('--task='))?.split('=')[1];

// ── Schedules (Asia/Tokyo) ────────────────────────────────────────────────────
const INVITE_CRON         = process.env.INVITE_CRON         ?? '0 10 * * *';   // daily 10:00
const RECOVERY_CRON       = process.env.RECOVERY_CRON       ?? '*/30 * * * *'; // every 30 min
const WEEKLY_REPORT_CRON  = process.env.WEEKLY_REPORT_CRON  ?? '0 9 * * 1';   // Mon 09:00
const MONTHLY_REPORT_CRON = process.env.MONTHLY_REPORT_CRON ?? '0 9 1 * *';   // 1st 09:00

// ── One-shot task runner ─────────────────────────────────────────────────────
async function runTask(task) {
  switch (task) {
    case 'login': {
      logger.info('手動ログイン & セッション保存モード');
      const { browser, context } = await getAuthenticatedPage(TIKTOK_SELLER_URL);
      await saveSession(context);
      await browser.close();
      logger.info('セッション保存完了。次回から自動ログインが使用されます。');
      break;
    }

    case 'invite':
      logger.info('クリエイター招待を即時実行します');
      await runCreatorInvite();
      break;

    case 'recovery':
      logger.info('商品復旧チェックを即時実行します');
      await runProductRecovery();
      break;

    case 'weekly-report':
      logger.info('週次レポートを即時生成・送信します');
      await runWeeklyReport();
      break;

    case 'monthly-report':
      logger.info('月次レポートを即時生成・送信します');
      await runMonthlyReport();
      break;

    case 'report': {
      const stats = db.getInvitationStats(30);
      const violations = db.getViolationHistory(7);
      logger.info('=== 招待レポート (直近30日) ===');
      logger.info(`招待総数: ${stats.total_invited}人`);
      logger.info(`承諾数: ${stats.accepted}人`);
      logger.info(`承諾率: ${stats.acceptance_rate}%`);
      logger.info(`売上転換率: ${stats.conversion_rate}%`);
      logger.info(`売上金額: ¥${stats.total_sales}`);
      logger.info(`GMV: ¥${stats.total_gmv}`);
      logger.info('=== 違反商品履歴 (直近7日) ===');
      violations.forEach((v) => {
        logger.info(`[${v.detected_at}] ${v.product_name} - ${v.violation_type} → ${v.reapply_status}`);
      });
      break;
    }

    default:
      logger.error(
        `不明なタスク: ${task}. 使用可能: login, invite, recovery, weekly-report, monthly-report, report`
      );
      process.exit(1);
  }
}

// ── Scheduler ────────────────────────────────────────────────────────────────
function startScheduler() {
  logger.info('スケジューラー起動 (Asia/Tokyo)');
  logger.info(`クリエイター招待    : ${INVITE_CRON}`);
  logger.info(`商品復旧チェック    : ${RECOVERY_CRON}`);
  logger.info(`週次レポート        : ${WEEKLY_REPORT_CRON}`);
  logger.info(`月次レポート        : ${MONTHLY_REPORT_CRON}`);

  db.getDb();

  const schedule = (cronExpr, label, fn) => {
    cron.schedule(
      cronExpr,
      async () => {
        logger.info(`[CRON] ${label} 開始`);
        try {
          await fn();
        } catch (err) {
          logger.error(`[CRON] ${label} 失敗: ${err.message}`);
        }
      },
      { timezone: 'Asia/Tokyo' }
    );
  };

  schedule(INVITE_CRON,         'クリエイター招待',   runCreatorInvite);
  schedule(RECOVERY_CRON,       '商品復旧チェック',   runProductRecovery);
  schedule(WEEKLY_REPORT_CRON,  '週次レポート送信',   runWeeklyReport);
  schedule(MONTHLY_REPORT_CRON, '月次レポート送信',   runMonthlyReport);

  logger.info('スケジューラー稼働中。Ctrl+C で停止します。');
}

// ── Entry point ───────────────────────────────────────────────────────────────
(async () => {
  if (taskArg) {
    try {
      await runTask(taskArg);
    } catch (err) {
      logger.error(`タスク実行エラー: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  } else {
    startScheduler();
  }
})();
