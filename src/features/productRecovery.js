const { getAuthenticatedPage, TIKTOK_SELLER_URL } = require('../auth/session');
const db = require('../db/database');
const {
  notifyProductViolation,
  notifyProductRecovered,
  notifyError,
} = require('../notifications/notify');
const logger = require('../utils/logger');

const PRODUCT_LIST_URL = `${TIKTOK_SELLER_URL}/product/list`;

// Selectors for product listing page - adjust if TikTok updates their UI
const SELECTORS = {
  productRow: '[data-testid="product-row"], .product-list-item, tr[data-product-id]',
  productId: '[data-testid="product-id"], [data-product-id], td:first-child',
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
  '非公開',
  '違反',
  'violation',
  'suspended',
  'delisted',
  'removed',
  'prohibited',
  'ガイドライン',
  'guideline',
  'banned',
];

function isViolationStatus(statusText) {
  if (!statusText) return false;
  const lower = statusText.toLowerCase();
  return VIOLATION_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms + Math.floor(Math.random() * 300)));
}

async function navigateToProductList(page) {
  await page.goto(PRODUCT_LIST_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2000);

  // Click violation tab if available to narrow down to violated products
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

      const productName = (
        await row.locator(SELECTORS.productName).first().textContent().catch(() => null)
      )?.trim();

      const statusText = (
        await row.locator(SELECTORS.statusBadge).first().textContent().catch(() => null)
      )?.trim();

      if (!productId) continue;

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

    const reapplyBtn = product.row.locator(SELECTORS.reapplyBtn).first();

    if (!await reapplyBtn.isVisible({ timeout: 3000 })) {
      // Try clicking into product detail for reapply button
      await product.row.locator(SELECTORS.productName).first().click();
      await page.waitForTimeout(1500);

      const detailReapplyBtn = page.locator(SELECTORS.reapplyBtn).first();
      if (!await detailReapplyBtn.isVisible({ timeout: 5000 })) {
        logger.warn(`再申請ボタンが見つかりません: ${product.productName}`);
        await page.goBack({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
        return false;
      }
      await detailReapplyBtn.click();
    } else {
      await reapplyBtn.click();
    }

    await page.waitForTimeout(1000);

    // Handle confirmation modal if present
    const confirmModal = page.locator('[role="dialog"], .confirm-modal').first();
    if (await confirmModal.isVisible({ timeout: 3000 }).catch(() => false)) {
      const confirmBtn = confirmModal.locator(
        'button:has-text("確認"), button:has-text("Confirm"), button:has-text("送信"), button:has-text("Submit")'
      ).first();
      if (await confirmBtn.isVisible()) {
        await confirmBtn.click();
        await page.waitForTimeout(1000);
      }
    }

    // Wait for success feedback
    await page.waitForSelector(
      'text=申請完了, text=submitted, text=success, .success-toast',
      { timeout: 8000 }
    ).catch(() => null);

    // Navigate back to list if we went to detail page
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

async function runProductRecovery() {
  logger.info('=== 商品ステータス監視・復旧 開始 ===');

  let browser, context, page;
  const monitorData = {
    totalProducts: 0,
    violatedCount: 0,
    reappliedCount: 0,
    errorMessage: null,
  };

  try {
    ({ browser, context, page } = await getAuthenticatedPage(PRODUCT_LIST_URL));
    await navigateToProductList(page);

    let pageNum = 1;
    let hasNextPage = true;

    while (hasNextPage) {
      logger.info(`商品一覧 ページ${pageNum} を確認中...`);
      const products = await scrapeProductsOnPage(page);
      monitorData.totalProducts += products.length;

      const violated = products.filter((p) => p.isViolated);
      monitorData.violatedCount += violated.length;

      if (violated.length > 0) {
        logger.info(`違反商品 ${violated.length}件 を検知`);
      }

      for (const product of violated) {
        const violationId = db.recordViolation({
          productId: product.productId,
          productName: product.productName,
          violationType: product.statusText,
        });

        // Notify detection
        await notifyProductViolation(product);
        db.updateViolationStatus(violationId, 'submitted', { notified: true });

        // Attempt reapply
        const reapplied = await attemptReapply(page, product);
        if (reapplied) {
          monitorData.reappliedCount++;
          db.updateViolationStatus(violationId, 'recovered', { notified: true });
          await notifyProductRecovered(product);
        } else {
          db.updateViolationStatus(violationId, 'failed', { notified: true });
        }

        await sleep(2000);
      }

      // Go to next page
      const nextBtn = page.locator(SELECTORS.nextPageBtn).first();
      const canNext = await nextBtn.isVisible().catch(() => false) &&
        !await nextBtn.isDisabled().catch(() => true);

      if (canNext && products.length > 0) {
        await nextBtn.click();
        await page.waitForTimeout(2000);
        pageNum++;
      } else {
        hasNextPage = false;
      }
    }

    logger.info(
      `監視完了: 全${monitorData.totalProducts}件 / 違反${monitorData.violatedCount}件 / 再申請${monitorData.reappliedCount}件`
    );
  } catch (err) {
    logger.error(`商品復旧エラー: ${err.message}`);
    monitorData.errorMessage = err.message;
    await notifyError('商品自動復旧', err);
    throw err;
  } finally {
    db.logMonitorRun(monitorData);
    await context?.close().catch(() => null);
    await browser?.close().catch(() => null);
  }

  return monitorData;
}

module.exports = { runProductRecovery };
