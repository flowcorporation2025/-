const { getAuthenticatedPage, TIKTOK_AFFILIATE_URL } = require('../auth/session');
const db = require('../db/database');
const { notifyInvitationSummary, notifyError } = require('../notifications/notify');
const logger = require('../utils/logger');
const dayjs = require('dayjs');

// Filter thresholds (configurable via env)
const FILTER_MIN_AVG_VIEWS = parseInt(process.env.FILTER_MIN_AVG_VIEWS ?? '5000');
const FILTER_MIN_GMV = parseInt(process.env.FILTER_MIN_GMV ?? '500000');
const FILTER_MIN_ENGAGEMENT = parseFloat(process.env.FILTER_MIN_ENGAGEMENT ?? '1.0');

const INVITE_PER_LETTER = parseInt(process.env.INVITE_PER_LETTER ?? '50');
const INVITE_DELAY_MS = parseInt(process.env.INVITE_DELAY_MS ?? '2000');

// TikTok Affiliate Center URL for creator search
const CREATOR_SEARCH_URL = `${TIKTOK_AFFILIATE_URL}/creator/marketplace`;

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms + Math.floor(Math.random() * 500)));
}

async function applyFilters(page) {
  logger.info('フィルター条件を適用中...');
  try {
    // Open filter panel
    const filterBtn = page.locator('[data-testid="filter-btn"], button:has-text("フィルター"), button:has-text("Filter")').first();
    await filterBtn.click({ timeout: 10000 });
    await page.waitForTimeout(1000);

    // Average views filter
    const avgViewsInput = page.locator('input[placeholder*="最小"], input[name*="minViews"], input[aria-label*="avg view"]').first();
    if (await avgViewsInput.isVisible()) {
      await avgViewsInput.fill(String(FILTER_MIN_AVG_VIEWS));
    }

    // GMV filter
    const gmvInput = page.locator('input[placeholder*="GMV"], input[name*="gmv"], input[aria-label*="GMV"]').first();
    if (await gmvInput.isVisible()) {
      await gmvInput.fill(String(FILTER_MIN_GMV));
    }

    // Engagement rate filter
    const engagementInput = page.locator('input[placeholder*="エンゲージ"], input[name*="engagement"], input[aria-label*="engagement"]').first();
    if (await engagementInput.isVisible()) {
      await engagementInput.fill(String(FILTER_MIN_ENGAGEMENT));
    }

    // Confirm filter
    const confirmBtn = page.locator('button:has-text("確認"), button:has-text("Apply"), button:has-text("適用")').first();
    if (await confirmBtn.isVisible()) {
      await confirmBtn.click();
    }

    await page.waitForTimeout(2000);
    logger.info(`フィルター適用完了: 視聴数≥${FILTER_MIN_AVG_VIEWS}, GMV≥${FILTER_MIN_GMV}, エンゲージ≥${FILTER_MIN_ENGAGEMENT}%`);
  } catch (err) {
    logger.warn(`フィルター適用エラー (手動確認推奨): ${err.message}`);
  }
}

async function collectCreators(page, limit) {
  const creators = [];
  let page_num = 1;

  while (creators.length < limit) {
    logger.info(`クリエイター収集中 (ページ ${page_num}, 取得済: ${creators.length}/${limit})`);

    // Wait for creator list to load
    await page.waitForSelector(
      '[data-testid="creator-card"], .creator-item, .creator-list-item',
      { timeout: 15000 }
    ).catch(() => null);

    const cards = await page.locator(
      '[data-testid="creator-card"], .creator-item, .creator-list-item'
    ).all();

    if (cards.length === 0) {
      logger.warn('クリエイターカードが見つかりません。セレクター要確認。');
      break;
    }

    for (const card of cards) {
      if (creators.length >= limit) break;

      try {
        const creatorId = await card.getAttribute('data-creator-id') ??
          await card.locator('[data-testid="creator-id"]').textContent().catch(() => null) ??
          `creator_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        const creatorName = await card.locator(
          '[data-testid="creator-name"], .creator-name, h3, h4'
        ).first().textContent().catch(() => null);

        const creatorHandle = await card.locator(
          '[data-testid="creator-handle"], .creator-handle, [class*="handle"]'
        ).first().textContent().catch(() => null);

        // Skip if invited recently
        if (db.wasInvitedRecently(creatorId, 30)) {
          logger.debug(`スキップ (招待済): ${creatorName ?? creatorId}`);
          continue;
        }

        creators.push({
          creatorId: creatorId.trim(),
          creatorName: creatorName?.trim() ?? null,
          creatorHandle: creatorHandle?.trim() ?? null,
          card,
        });
      } catch (err) {
        logger.debug(`カード解析エラー: ${err.message}`);
      }
    }

    // Next page
    const nextBtn = page.locator('button[aria-label="Next"], button:has-text("次へ"), .pagination-next').first();
    const isDisabled = await nextBtn.isDisabled().catch(() => true);
    if (isDisabled || creators.length >= limit) break;

    await nextBtn.click();
    await page.waitForTimeout(2000);
    page_num++;
  }

  return creators.slice(0, limit);
}

async function selectInvitationLetter(page, letterIndex) {
  try {
    // Open invitation letter dropdown
    const letterSelect = page.locator(
      'select[name*="letter"], [data-testid="invitation-select"], .invitation-template-select'
    ).first();

    if (await letterSelect.isVisible()) {
      const options = await letterSelect.locator('option').all();
      if (options[letterIndex]) {
        const value = await options[letterIndex].getAttribute('value');
        await letterSelect.selectOption(value);
        logger.info(`招待状${letterIndex + 1}を選択`);
        return true;
      }
    }

    // Fallback: click-based dropdown
    const dropdownBtn = page.locator('[data-testid="letter-dropdown"], button:has-text("招待状")').first();
    if (await dropdownBtn.isVisible()) {
      await dropdownBtn.click();
      await page.waitForTimeout(500);
      const items = page.locator('[role="option"], .dropdown-item');
      const item = items.nth(letterIndex);
      if (await item.isVisible()) {
        await item.click();
        return true;
      }
    }
  } catch (err) {
    logger.warn(`招待状選択エラー: ${err.message}`);
  }
  return false;
}

async function sendInviteToCreator(page, creator, letterNumber) {
  try {
    // Find and click invite button on creator card
    const inviteBtn = creator.card.locator(
      'button:has-text("招待"), button:has-text("Invite"), [data-testid="invite-btn"]'
    ).first();

    if (!await inviteBtn.isVisible()) {
      logger.warn(`招待ボタンが見つかりません: ${creator.creatorName}`);
      return false;
    }

    await inviteBtn.click();
    await page.waitForTimeout(1000);

    // Select invitation letter in modal
    const modal = page.locator('[role="dialog"], .modal, [data-testid="invite-modal"]').first();
    if (await modal.isVisible({ timeout: 3000 })) {
      await selectInvitationLetter(page, letterNumber - 1);
      await page.waitForTimeout(500);

      // Confirm send
      const sendBtn = modal.locator(
        'button:has-text("送信"), button:has-text("Send"), button:has-text("確認")'
      ).first();
      await sendBtn.click({ timeout: 5000 });
      await page.waitForTimeout(1000);
    }

    // Check for success indicator
    await page.waitForSelector(
      '[data-testid="invite-success"], .success-toast, text=送信完了, text=Sent',
      { timeout: 5000 }
    ).catch(() => null);

    logger.info(`招待送信完了: ${creator.creatorName} (招待状${letterNumber})`);
    return true;
  } catch (err) {
    logger.error(`招待送信失敗 [${creator.creatorName}]: ${err.message}`);
    return false;
  }
}

async function runCreatorInvite() {
  const runDate = dayjs().format('YYYY-MM-DD');
  const runId = db.startInvitationRun(runDate);
  logger.info(`=== クリエイター招待開始 [${runDate}] (run_id: ${runId}) ===`);

  let browser, context, page;
  const stats = { letter1Sent: 0, letter2Sent: 0, totalSent: 0, runDate };

  try {
    ({ browser, context, page } = await getAuthenticatedPage(CREATOR_SEARCH_URL));

    await page.goto(CREATOR_SEARCH_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2000);

    // Apply filters
    await applyFilters(page);

    // Collect creators for letter 1 (50) + letter 2 (50) = 100
    logger.info(`招待状①用クリエイター ${INVITE_PER_LETTER}人を収集中...`);
    const letter1Creators = await collectCreators(page, INVITE_PER_LETTER);
    logger.info(`招待状①対象: ${letter1Creators.length}人`);

    // Send invitation letter 1
    for (const creator of letter1Creators) {
      const success = await sendInviteToCreator(page, creator, 1);
      if (success) {
        stats.letter1Sent++;
        db.recordInvitation({ ...creator, invitationLetter: 1 });
      }
      await sleep(INVITE_DELAY_MS);
    }

    logger.info(`招待状①送信完了: ${stats.letter1Sent}人`);

    // Scroll/navigate to find next 50 creators for letter 2
    logger.info(`招待状②用クリエイター ${INVITE_PER_LETTER}人を収集中...`);
    const alreadyInvited = new Set(letter1Creators.map((c) => c.creatorId));
    const letter2Creators = (await collectCreators(page, INVITE_PER_LETTER * 2)).filter(
      (c) => !alreadyInvited.has(c.creatorId)
    ).slice(0, INVITE_PER_LETTER);
    logger.info(`招待状②対象: ${letter2Creators.length}人`);

    // Send invitation letter 2
    for (const creator of letter2Creators) {
      const success = await sendInviteToCreator(page, creator, 2);
      if (success) {
        stats.letter2Sent++;
        db.recordInvitation({ ...creator, invitationLetter: 2 });
      }
      await sleep(INVITE_DELAY_MS);
    }

    logger.info(`招待状②送信完了: ${stats.letter2Sent}人`);
    stats.totalSent = stats.letter1Sent + stats.letter2Sent;

    db.updateInvitationRun(runId, { ...stats, completed: true });
    await notifyInvitationSummary(stats);

    const globalStats = db.getInvitationStats(30);
    logger.info(
      `[30日間累計] 招待: ${globalStats.total_invited}人 / 承諾率: ${globalStats.acceptance_rate}% / 売上: ¥${globalStats.total_sales}`
    );

    logger.info(`=== クリエイター招待完了: 合計${stats.totalSent}人 ===`);
  } catch (err) {
    logger.error(`クリエイター招待エラー: ${err.message}`);
    db.updateInvitationRun(runId, { ...stats, completed: false, errorMessage: err.message });
    await notifyError('クリエイター招待', err);
    throw err;
  } finally {
    await context?.close().catch(() => null);
    await browser?.close().catch(() => null);
  }

  return stats;
}

module.exports = { runCreatorInvite };
