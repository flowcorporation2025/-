require('dotenv').config();
const cron = require('node-cron');
const logger = require('./utils/logger');
const { runCreatorInvite } = require('./features/creatorInvite');
const { runProductRecovery } = require('./features/productRecovery');
const { getAuthenticatedPage, saveSession, TIKTOK_SELLER_URL } = require('./auth/session');
const db = require('./db/database');

const args = process.argv.slice(2);
const taskArg = args.find((a) => a.startsWith('--task='))?.split('=')[1];

// ── Schedules ────────────────────────────────────────────────────────────────
// Creator invite: daily at 10:00 AM JST (01:00 UTC)
const INVITE_CRON = process.env.INVITE_CRON ?? '0 1 * * *';

// Product recovery: every 30 minutes
const RECOVERY_CRON = process.env.RECOVERY_CRON ?? '*/30 * * * *';

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

    case 'invite': {
      logger.info('クリエイター招待を即時実行します');
      await runCreatorInvite();
      break;
    }

    case 'recovery': {
      logger.info('商品復旧チェックを即時実行します');
      await runProductRecovery();
      break;
    }

    case 'report': {
      const stats = db.getInvitationStats(30);
      const violations = db.getViolationHistory(7);
      logger.info('=== 招待レポート (直近30日) ===');
      logger.info(`招待総数: ${stats.total_invited}`);
      logger.info(`承諾数: ${stats.accepted}`);
      logger.info(`承諾率: ${stats.acceptance_rate}%`);
      logger.info(`売上合計: ¥${stats.total_sales}`);
      logger.info(`=== 違反商品履歴 (直近7日) ===`);
      violations.forEach((v) => {
        logger.info(
          `[${v.detected_at}] ${v.product_name} - ${v.violation_type} → ${v.reapply_status}`
        );
      });
      break;
    }

    default:
      logger.error(`不明なタスク: ${task}. 使用可能: login, invite, recovery, report`);
      process.exit(1);
  }
}

// ── Scheduler ────────────────────────────────────────────────────────────────
function startScheduler() {
  logger.info('スケジューラー起動');
  logger.info(`クリエイター招待スケジュール: ${INVITE_CRON}`);
  logger.info(`商品復旧チェックスケジュール: ${RECOVERY_CRON}`);

  // Initialize DB on start
  db.getDb();

  // Creator invite schedule
  cron.schedule(
    INVITE_CRON,
    async () => {
      logger.info('[CRON] クリエイター招待タスク開始');
      try {
        await runCreatorInvite();
      } catch (err) {
        logger.error(`[CRON] クリエイター招待失敗: ${err.message}`);
      }
    },
    { timezone: 'Asia/Tokyo' }
  );

  // Product recovery schedule
  cron.schedule(
    RECOVERY_CRON,
    async () => {
      logger.info('[CRON] 商品復旧チェック開始');
      try {
        await runProductRecovery();
      } catch (err) {
        logger.error(`[CRON] 商品復旧チェック失敗: ${err.message}`);
      }
    },
    { timezone: 'Asia/Tokyo' }
  );

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
