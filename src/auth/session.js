const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

const SESSION_DIR = path.join(process.cwd(), 'data', 'sessions');
const SESSION_FILE = path.join(SESSION_DIR, 'tiktok_session.json');

const TIKTOK_SELLER_URL = 'https://seller.tiktokglobalshop.com';
const TIKTOK_AFFILIATE_URL = 'https://affiliate.tiktokglobalshop.com';

// URLs that indicate the user is NOT yet logged in
const LOGIN_URL_PATTERNS = ['login', 'passport', 'account/login', 'auth/login'];

function isLoginUrl(url) {
  return LOGIN_URL_PATTERNS.some((p) => url.includes(p));
}

// ── Browser / context factories ───────────────────────────────────────────────

async function launchBrowser({ headless = false } = {}) {
  return chromium.launch({
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
    ],
    // Ensure the browser window is visible and large enough during manual login
    ...(!headless && { slowMo: 0 }),
  });
}

/**
 * Create a browser context.
 * @param {import('playwright').Browser} browser
 * @param {{ forLogin?: boolean }} options
 *   forLogin=true  → fresh context, no session loaded, no resource blocking
 *                    (needed so CAPTCHA images render correctly)
 *   forLogin=false → load saved session, block heavy resources for speed
 */
async function createContext(browser, { forLogin = false } = {}) {
  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

  const contextOptions = {
    viewport: { width: 1280, height: 800 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  };

  if (!forLogin && fs.existsSync(SESSION_FILE)) {
    logger.info('既存セッションを読み込み中...');
    contextOptions.storageState = SESSION_FILE;
  }

  const context = await browser.newContext(contextOptions);

  // Block heavy resources only during normal automation (not during login,
  // where CAPTCHA images must load)
  if (!forLogin) {
    await context.route('**/*.{png,jpg,jpeg,gif,webp,svg,ico,woff,woff2,ttf}', (route) =>
      route.abort()
    );
  }

  return context;
}

async function saveSession(context) {
  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
  await context.storageState({ path: SESSION_FILE });
  logger.info(`セッション保存完了: ${SESSION_FILE}`);
}

// ── Login detection ───────────────────────────────────────────────────────────

async function isLoggedIn(page, targetUrl = TIKTOK_SELLER_URL) {
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Wait for potential client-side (SPA) redirects to complete
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => null);
    await page.waitForTimeout(1000);
    return !isLoginUrl(page.url());
  } catch {
    return false;
  }
}

/**
 * Open a visible browser, navigate to TikTok, and wait for the user to
 * complete login (including any CAPTCHA) without any terminal interaction.
 *
 * Completion is detected automatically when the URL moves away from a
 * login/passport page and the seller dashboard becomes visible.
 *
 * @param {import('playwright').Page} page
 * @param {number} timeoutMs  Maximum wait time (default: 5 minutes)
 */
async function performLogin(page, timeoutMs = 5 * 60 * 1000) {
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info('  手動ログインモード');
  logger.info('  ブラウザが開きます。TikTok Shopにログインしてください。');
  logger.info('  CAPTCHA・2段階認証も画面上で完了させてください。');
  logger.info('  ログイン完了後、自動的にセッションが保存されます。');
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  await page.goto(TIKTOK_SELLER_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait until the URL leaves any login/passport page
  logger.info('ログイン完了を待機中... (最大5分)');
  await page.waitForURL(
    (url) => !isLoginUrl(url.href),
    { timeout: timeoutMs, waitUntil: 'domcontentloaded' }
  );

  // Wait for the dashboard to fully settle:
  // - networkidle ensures background XHR/fetch (including cookie-setting requests) finish
  // - extra 3s buffer for any remaining async JS
  logger.info('ダッシュボード読み込み中...');
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => null);
  await page.waitForTimeout(3000);

  // Sanity check: confirm we did NOT end up back on a login page
  const finalUrl = page.url();
  if (isLoginUrl(finalUrl)) {
    throw new Error('ログイン後にログインページへ戻りました。CAPTCHA / 2段階認証が未完了の可能性があります。');
  }
  logger.info(`ログイン完了確認: ${finalUrl}`);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run the interactive login flow:
 *   1. Launch a visible (headful) browser — always, regardless of HEADLESS env
 *   2. Wait for the user to complete login (incl. CAPTCHA) in the GUI
 *   3. Save the session to disk
 *
 * Called only from `npm run login`.
 */
async function runLoginFlow() {
  // Always headful for manual login regardless of HEADLESS env var
  const browser = await launchBrowser({ headless: false });
  const context = await createContext(browser, { forLogin: true });
  const page = await context.newPage();

  try {
    await performLogin(page);
    await saveSession(context);
    logger.info('セッションファイル書き込み完了。検証中...');
  } finally {
    await context.close().catch(() => null);
    await browser.close().catch(() => null);
  }

  // ── Verify the saved session file with a brand-new browser context ──────────
  // This is the only reliable test: load the exact file that was just written,
  // navigate to the seller top, and confirm we are NOT redirected to login.
  const verifyBrowser = await launchBrowser({ headless: true });
  try {
    const verifyContext = await verifyBrowser.newContext({
      storageState: SESSION_FILE,
      viewport: { width: 1280, height: 800 },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
    });
    const verifyPage = await verifyContext.newPage();

    await verifyPage.goto(TIKTOK_SELLER_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await verifyPage.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => null);
    await verifyPage.waitForTimeout(1000);

    const verifyUrl = verifyPage.url();
    await verifyContext.close().catch(() => null);

    if (isLoginUrl(verifyUrl)) {
      // Delete the invalid session file so stale data doesn't interfere next time
      fs.rmSync(SESSION_FILE, { force: true });
      throw new Error(
        'セッション検証に失敗しました（保存後もログインページに遷移します）。\n' +
        '再度 npm run login を実行し、ダッシュボードが完全に表示された状態で待ってください。'
      );
    }

    logger.info('セッション検証OK。次回から自動ログインが使用されます。');
  } finally {
    await verifyBrowser.close().catch(() => null);
  }
}

/**
 * Get an authenticated page, reusing a saved session if valid.
 * Falls back to runLoginFlow() if the session has expired.
 */
async function getAuthenticatedPage(targetUrl = TIKTOK_SELLER_URL) {
  const browser = await launchBrowser({ headless: process.env.HEADLESS === 'true' });
  const context = await createContext(browser, { forLogin: false });
  const page = await context.newPage();

  const loggedIn = await isLoggedIn(page, targetUrl);

  if (!loggedIn) {
    logger.warn('セッション期限切れ。再ログインが必要です。');
    await context.close().catch(() => null);
    await browser.close().catch(() => null);

    // Re-run the full interactive login flow, then retry
    await runLoginFlow();
    return getAuthenticatedPage(targetUrl);
  }

  logger.info('セッション有効。自動ログイン成功。');
  return { browser, context, page };
}

module.exports = {
  launchBrowser,
  createContext,
  saveSession,
  isLoggedIn,
  performLogin,
  runLoginFlow,
  getAuthenticatedPage,
  TIKTOK_SELLER_URL,
  TIKTOK_AFFILIATE_URL,
};
