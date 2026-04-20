'use strict';
const path = require('path');
const fs = require('fs');
const { getAuthenticatedPage, TIKTOK_AFFILIATE_URL } = require('../auth/session');
const sheets = require('../sheets/googleSheets');
const { notifyInvitationSummary, notifyError } = require('../notifications/notify');
const logger = require('../utils/logger');
const dayjs = require('dayjs');

const FILTER_MIN_AVG_VIEWS = parseInt(process.env.FILTER_MIN_AVG_VIEWS ?? '5000');
const FILTER_MIN_GMV       = parseInt(process.env.FILTER_MIN_GMV ?? '500000');
const FILTER_MIN_ENGAGEMENT = parseFloat(process.env.FILTER_MIN_ENGAGEMENT ?? '1.0');
const INVITE_PER_LETTER    = parseInt(process.env.INVITE_PER_LETTER ?? '50');
const INVITE_DELAY_MS      = parseInt(process.env.INVITE_DELAY_MS ?? '2000');

const CREATOR_SEARCH_URL = `${TIKTOK_AFFILIATE_URL}/creator/marketplace`;

// ── Local cache: tracks invited creator IDs to avoid re-inviting within 30 days
const CACHE_FILE = path.join(process.cwd(), 'data', 'invited_creators.json');

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch { /* corrupted file — start fresh */ }
  return {};
}

function saveCache(data) {
  const dir = path.dirname(CACHE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
}

function wasInvitedRecently(creatorId, withinDays = 30) {
  const cache = loadCache();
  const ts = cache[creatorId];
  return ts ? Date.now() - new Date(ts).getTime() < withinDays * 86_400_000 : false;
}

function markInvited(creatorId) {
  const cache = loadCache();
  cache[creatorId] = new Date().toISOString();
  // Prune entries older than 60 days to keep the file small
  const cutoff = Date.now() - 60 * 86_400_000;
  for (const [id, ts] of Object.entries(cache)) {
    if (new Date(ts).getTime() < cutoff) delete cache[id];
  }
  saveCache(cache);
}

// ── Playwright helpers ────────────────────────────────────────────────────────

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms + Math.floor(Math.random() * 500)));
}

async function applyFilters(page) {
  logger.info('フィルター条件を適用中...');
  try {
    const filterBtn = page
      .locator('[data-testid="filter-btn"], button:has-text("フィルター"), button:has-text("Filter")')
      .first();
    await filterBtn.click({ timeout: 10000 });
    await page.waitForTimeout(1000);

    const avgViewsInput = page
      .locator('input[placeholder*="最小"], input[name*="minViews"], input[aria-label*="avg view"]')
      .first();
    if (await avgViewsInput.isVisible()) await avgViewsInput.fill(String(FILTER_MIN_AVG_VIEWS));

    const gmvInput = page
      .locator('input[placeholder*="GMV"], input[name*="gmv"], input[aria-label*="GMV"]')
      .first();
    if (await gmvInput.isVisible()) await gmvInput.fill(String(FILTER_MIN_GMV));

    const engInput = page
      .locator('input[placeholder*="エンゲージ"], input[name*="engagement"], input[aria-label*="engagement"]')
      .first();
    if (await engInput.isVisible()) await engInput.fill(String(FILTER_MIN_ENGAGEMENT));

    const confirmBtn = page
      .locator('button:has-text("確認"), button:has-text("Apply"), button:has-text("適用")')
      .first();
    if (await confirmBtn.isVisible()) await confirmBtn.click();

    await page.waitForTimeout(2000);
    logger.info(
      `フィルター適用: 視聴数≥${FILTER_MIN_AVG_VIEWS}, GMV≥${FILTER_MIN_GMV}, エンゲージ≥${FILTER_MIN_ENGAGEMENT}%`
    );
  } catch (err) {
    logger.warn(`フィルター適用エラー (手動確認推奨): ${err.message}`);
  }
}

async function collectCreators(page, limit) {
  const creators = [];
  let pageNum = 1;

  while (creators.length < limit) {
    logger.info(`クリエイター収集中 (p.${pageNum}, 取得済: ${creators.length}/${limit})`);

    await page
      .waitForSelector('[data-testid="creator-card"], .creator-item, .creator-list-item', {
        timeout: 15000,
      })
      .catch(() => null);

    const cards = await page
      .locator('[data-testid="creator-card"], .creator-item, .creator-list-item')
      .all();

    if (cards.length === 0) {
      logger.warn('クリエイターカードが見つかりません。セレクター要確認。');
      break;
    }

    for (const card of cards) {
      if (creators.length >= limit) break;
      try {
        const creatorId =
          (await card.getAttribute('data-creator-id')) ??
          (await card.locator('[data-testid="creator-id"]').textContent().catch(() => null)) ??
          `creator_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        const creatorName = (
          await card.locator('[data-testid="creator-name"], .creator-name, h3, h4').first().textContent().catch(() => null)
        )?.trim();

        const creatorHandle = (
          await card.locator('[data-testid="creator-handle"], .creator-handle, [class*="handle"]').first().textContent().catch(() => null)
        )?.trim();

        if (wasInvitedRecently(creatorId.trim(), 30)) {
          logger.debug(`スキップ (招待済): ${creatorName ?? creatorId}`);
          continue;
        }

        creators.push({ creatorId: creatorId.trim(), creatorName, creatorHandle, card });
      } catch (err) {
        logger.debug(`カード解析エラー: ${err.message}`);
      }
    }

    const nextBtn = page
      .locator('button[aria-label="Next"], button:has-text("次へ"), .pagination-next')
      .first();
    const disabled = await nextBtn.isDisabled().catch(() => true);
    if (disabled || creators.length >= limit) break;

    await nextBtn.click();
    await page.waitForTimeout(2000);
    pageNum++;
  }

  return creators.slice(0, limit);
}

async function selectInvitationLetter(page, letterIndex) {
  try {
    const sel = page
      .locator('select[name*="letter"], [data-testid="invitation-select"], .invitation-template-select')
      .first();
    if (await sel.isVisible()) {
      const opts = await sel.locator('option').all();
      if (opts[letterIndex]) {
        await sel.selectOption(await opts[letterIndex].getAttribute('value'));
        return true;
      }
    }
    const dropBtn = page.locator('[data-testid="letter-dropdown"], button:has-text("招待状")').first();
    if (await dropBtn.isVisible()) {
      await dropBtn.click();
      await page.waitForTimeout(500);
      const item = page.locator('[role="option"], .dropdown-item').nth(letterIndex);
      if (await item.isVisible()) { await item.click(); return true; }
    }
  } catch (err) {
    logger.warn(`招待状選択エラー: ${err.message}`);
  }
  return false;
}

async function sendInviteToCreator(page, creator, letterNumber) {
  try {
    const inviteBtn = creator.card
      .locator('button:has-text("招待"), button:has-text("Invite"), [data-testid="invite-btn"]')
      .first();

    if (!await inviteBtn.isVisible()) {
      logger.warn(`招待ボタンなし: ${creator.creatorName}`);
      return false;
    }

    await inviteBtn.click();
    await page.waitForTimeout(1000);

    const modal = page.locator('[role="dialog"], .modal, [data-testid="invite-modal"]').first();
    if (await modal.isVisible({ timeout: 3000 })) {
      await selectInvitationLetter(page, letterNumber - 1);
      await page.waitForTimeout(500);
      await modal
        .locator('button:has-text("送信"), button:has-text("Send"), button:has-text("確認")')
        .first()
        .click({ timeout: 5000 });
      await page.waitForTimeout(1000);
    }

    await page
      .waitForSelector('[data-testid="invite-success"], .success-toast, text=送信完了, text=Sent', {
        timeout: 5000,
      })
      .catch(() => null);

    logger.info(`招待送信: ${creator.creatorName} (招待状${letterNumber})`);
    return true;
  } catch (err) {
    logger.error(`招待送信失敗 [${creator.creatorName}]: ${err.message}`);
    return false;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function runCreatorInvite() {
  const runDate = dayjs().format('YYYY-MM-DD');
  const runTime = dayjs().format('HH:mm:ss');
  logger.info(`=== クリエイター招待開始 [${runDate}] ===`);

  let browser, context, page;
  const stats = { letter1Sent: 0, letter2Sent: 0, totalSent: 0, runDate };
  let errorMsg = null;

  try {
    ({ browser, context, page } = await getAuthenticatedPage(CREATOR_SEARCH_URL));
    await page.goto(CREATOR_SEARCH_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2000);

    await applyFilters(page);

    // ── 招待状①: 50人 ──────────────────────────────────────────
    logger.info(`招待状①用クリエイター ${INVITE_PER_LETTER}人を収集中...`);
    const letter1Creators = await collectCreators(page, INVITE_PER_LETTER);
    logger.info(`招待状①対象: ${letter1Creators.length}人`);

    for (const creator of letter1Creators) {
      if (await sendInviteToCreator(page, creator, 1)) {
        stats.letter1Sent++;
        markInvited(creator.creatorId);
      }
      await sleep(INVITE_DELAY_MS);
    }
    logger.info(`招待状①完了: ${stats.letter1Sent}人`);

    // ── 招待状②: 別の50人 ─────────────────────────────────────
    logger.info(`招待状②用クリエイター ${INVITE_PER_LETTER}人を収集中...`);
    const alreadyInvited = new Set(letter1Creators.map((c) => c.creatorId));
    const letter2Creators = (await collectCreators(page, INVITE_PER_LETTER * 2))
      .filter((c) => !alreadyInvited.has(c.creatorId))
      .slice(0, INVITE_PER_LETTER);
    logger.info(`招待状②対象: ${letter2Creators.length}人`);

    for (const creator of letter2Creators) {
      if (await sendInviteToCreator(page, creator, 2)) {
        stats.letter2Sent++;
        markInvited(creator.creatorId);
      }
      await sleep(INVITE_DELAY_MS);
    }
    logger.info(`招待状②完了: ${stats.letter2Sent}人`);

    stats.totalSent = stats.letter1Sent + stats.letter2Sent;

    // ── Google Sheets に記録 ────────────────────────────────────
    await sheets.appendDailyRow({
      date: runDate,
      letter1Sent: stats.letter1Sent,
      letter2Sent: stats.letter2Sent,
      totalSent: stats.totalSent,
      runTime,
      error: null,
    });

    await notifyInvitationSummary(stats);
    logger.info(`=== クリエイター招待完了: 合計${stats.totalSent}人 ===`);
  } catch (err) {
    errorMsg = err.message;
    logger.error(`クリエイター招待エラー: ${err.message}`);

    // Record partial results even on error
    await sheets.appendDailyRow({
      date: runDate,
      letter1Sent: stats.letter1Sent,
      letter2Sent: stats.letter2Sent,
      totalSent: stats.letter1Sent + stats.letter2Sent,
      runTime,
      error: err.message,
    }).catch(() => null);

    await notifyError('クリエイター招待', err);
    throw err;
  } finally {
    await context?.close().catch(() => null);
    await browser?.close().catch(() => null);
  }

  return stats;
}

module.exports = { runCreatorInvite };
