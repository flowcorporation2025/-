'use strict';
const { getAuthenticatedPage, TIKTOK_SELLER_URL } = require('../auth/session');
const sheets = require('../sheets/googleSheets');
const {
  notifyProductViolation,
  notifyProductRecovered,
  notifyError,
} = require('../notifications/notify');
const logger = require('../utils/logger');
const dayjs = require('dayjs');

const PRODUCT_LIST_URL = `${TIKTOK_SELLER_URL}/product/list`;

const SELECTORS = {
  productRow: '[data-testid="product-row"], .product-list-item, tr[data-product-id]',
  productId:  '[data-testid="product-id"], [data-product-id], td:first-child',
  productName: '[data-testid="product-name"], .product-name, td:nth-child(2)',
  statusBadge: '[data-testid="product-status"], .status-badge, .product-status',
  reapplyBtn:
    'button:has-text("再申請"), button:has-text("Appeal"), button:has-text("Reapply"), [data-testid="reapply-btn"]',
  violationTab:
    'button:has-text("違反"), button:has-text("Violation"), [data-testid="violation-tab"], [role="tab"]:has-text("違反")',
  nextPageBtn:
    'button[aria-label="Next page"], button:has-text("次へ"), .pagination-next:not([disabled])',
};

const VIOLATION_KEYWORDS = [
  '非公開', '違反', 'violation', 'suspended', 'delisted',
  'removed', 'prohibited', 'ガイドライン', 'guideline', 'banned',
];

function isViolationStatus(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return VIOLATION_KEYWORDS.some((kw) => lower.includes(kw));
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms + Math.floor(Math.random() * 300)));
}

async function navigateToProductList(page) {
  await page.goto(PRODUCT_LIST_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2000);

  const violationTab = page.locator(SELECTORS.violationTab).first();
  if (await violationTab.isVisible({ timeout: 3000 }).catch(() => false)) {
    await violationTab.click();
    await page.waitForTimeout(1500);
    logger.info('違反タブに切り替えました');
  }
}

async function scrapeProductsOnPage(page) {
  await page.waitForSelector(SELECTORS.productRow, { timeout: 15000 }).catch(() => null);

  const rows = await page.locator(SELECTORS.productRow).all();
  const products = [];

  for (const row of rows) {
    try {
      const productId =
        (await row.getAttribute('data-product-id')) ??
        (await row.locator(SELECTORS.productId).first().textContent().catch(() => null))?.trim();

      if (!productId) continue;

      const productName = (
        await row.locator(SELECTORS.productName).first().textContent().catch(() => null)
      )?.trim();

      const statusText = (
        await row.locator(SELECTORS.statusBadge).first().textContent().catch(() => null)
      )?.trim();

      products.push({
        productId,
        productName: productName ?? productId,
        statusText,
        row,
        isViolated: isViolationStatus(statusText),
      });
    } catch (err) {
      logger.debug(`商品行解析エラー: ${err.message}`);
    }
  }
  return products;
}

async function attemptReapply(page, product) {
  try {
    logger.info(`再申請試行: ${product.productName} (${product.productId})`);

    let reapplyBtn = product.row.locator(SELECTORS.reapplyBtn).first();

    if (!await reapplyBtn.isVisible({ timeout: 3000 })) {
      // Navigate into product detail page to find the button
      await product.row.locator(SELECTORS.productName).first().click();
      await page.waitForTimeout(1500);

      reapplyBtn = page.locator(SELECTORS.reapplyBtn).first();
      if (!await reapplyBtn.isVisible({ timeout: 5000 })) {
        logger.warn(`再申請ボタンが見つかりません: ${product.productName}`);
        await page.goBack({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
        return false;
      }
    }

    await reapplyBtn.click();
    await page.waitForTimeout(1000);

    // Confirmation modal
    const modal = page.locator('[role="dialog"], .confirm-modal').first();
    if (await modal.isVisible({ timeout: 3000 }).catch(() => false)) {
      const confirmBtn = modal
        .locator('button:has-text("確認"), button:has-text("Confirm"), button:has-text("送信"), button:has-text("Submit")')
        .first();
      if (await confirmBtn.isVisible()) {
        await confirmBtn.click();
        await page.waitForTimeout(1000);
      }
    }

    await page
      .waitForSelector('text=申請完了, text=submitted, text=success, .success-toast', { timeout: 8000 })
      .catch(() => null);

    if (!page.url().includes('/list')) {
      await page.goto(PRODUCT_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1500);
    }

    logger.info(`再申請完了: ${product.productName}`);
    return true;
  } catch (err) {
    logger.error(`再申請失敗 [${product.productName}]: ${err.message}`);
    return false;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function runProductRecovery() {
  logger.info('=== 商品ステータス監視・復旧 開始 ===');

  let browser, context, page;
  const summary = { totalProducts: 0, violatedCount: 0, reappliedCount: 0 };

  try {
    ({ browser, context, page } = await getAuthenticatedPage(PRODUCT_LIST_URL));
    await navigateToProductList(page);

    let pageNum = 1;
    let hasNext = true;

    while (hasNext) {
      logger.info(`商品一覧 p.${pageNum} 確認中...`);
      const products = await scrapeProductsOnPage(page);
      summary.totalProducts += products.length;

      const violated = products.filter((p) => p.isViolated);
      summary.violatedCount += violated.length;

      if (violated.length > 0) logger.info(`違反商品 ${violated.length}件 を検知`);

      for (const product of violated) {
        const detectedAt = dayjs().format('YYYY-MM-DD HH:mm:ss');

        // Record in Sheets③ (status='submitted')
        await sheets.appendViolationRow({
          productId: product.productId,
          productName: product.productName,
          violationType: product.statusText,
          detectedAt,
        });

        // Chatwork alert
        await notifyProductViolation(product);

        // Attempt re-application
        const reappliedAt = dayjs().format('YYYY-MM-DD HH:mm:ss');
        const reapplied = await attemptReapply(page, product);

        if (reapplied) {
          summary.reappliedCount++;
          const recoveryAt = dayjs().format('YYYY-MM-DD HH:mm:ss');
          const recoveryMinutes = dayjs(recoveryAt).diff(dayjs(detectedAt), 'minute');

          await sheets.updateViolationRow(product.productId, {
            reappliedAt,
            recoveryAt,
            recoveryMinutes,
            status: 'recovered',
          });

          await notifyProductRecovered(product);
        } else {
          await sheets.updateViolationRow(product.productId, {
            reappliedAt,
            recoveryAt: '',
            recoveryMinutes: '',
            status: 'failed',
          });
        }

        await sleep(2000);
      }

      // Pagination
      const nextBtn = page.locator(SELECTORS.nextPageBtn).first();
      const canNext =
        (await nextBtn.isVisible().catch(() => false)) &&
        !(await nextBtn.isDisabled().catch(() => true));

      if (canNext && products.length > 0) {
        await nextBtn.click();
        await page.waitForTimeout(2000);
        pageNum++;
      } else {
        hasNext = false;
      }
    }

    logger.info(
      `監視完了: 全${summary.totalProducts}件 / 違反${summary.violatedCount}件 / 再申請${summary.reappliedCount}件`
    );
  } catch (err) {
    logger.error(`商品復旧エラー: ${err.message}`);
    await notifyError('商品自動復旧', err);
    throw err;
  } finally {
    await context?.close().catch(() => null);
    await browser?.close().catch(() => null);
  }

  return summary;
}

module.exports = { runProductRecovery };
