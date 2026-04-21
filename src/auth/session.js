const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const logger = require('../utils/logger');

const SESSION_DIR = path.join(process.cwd(), 'data', 'sessions');
const SESSION_FILE = path.join(SESSION_DIR, 'tiktok_session.json');

const TIKTOK_SELLER_URL = 'https://seller.tiktokglobalshop.com';
const TIKTOK_AFFILIATE_URL = 'https://affiliate.tiktokglobalshop.com';

const LOGIN_URL_PATTERNS = ['login', 'passport', 'account/login', 'auth/login', 'signin'];

function isLoginUrl(url) {
  return LOGIN_URL_PATTERNS.some((p) => url.toLowerCase().includes(p));
}

function isDashboardUrl(urlStr) {
  try {
    const { hostname } = new URL(urlStr);
    const isSellerDomain = /^seller(-\w+)?\.tiktokglobalshop\.com$/.test(hostname);
    return isSellerDomain && !isLoginUrl(urlStr);
  } catch {
    return false;
  }
}

function waitForEnter() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('', () => {
      rl.close();
      resolve();
    });
  });
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
    // Wait for SPA client-side redirects to complete before checking the URL
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => null);
    await page.waitForTimeout(1000);
    return isDashboardUrl(page.url());
  } catch {
    return false;
  }
}

async function performLogin(page) {
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info('  手動ログインモード');
  logger.info('  ブラウザが開きます。TikTok Shopにログインしてください。');
  logger.info('  CAPTCHA・2段階認証も画面上で完了させてください。');
  logger.info('  ダッシュボードが表示されたら、このターミナルで Enter を押してください。');
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  await page.goto(TIKTOK_SELLER_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
    .catch((err) => logger.warn(`初期ナビゲーションエラー (無視): ${err.message}`));

  logger.info('ログインが完了したら Enter を押してください...');
  await waitForEnter();
  logger.info(`Enter 検知。現在のURL: ${page.url()}`);
}

// ── Public API ────────────────────────────────────────────────────────────────

async function runLoginFlow() {
  const browser = await launchBrowser({ headless: false });
  const context = await createContext(browser, { forLogin: true });
  const page = await context.newPage();

  // ブラウザはセッション保存が完全に完了するまで閉じない
  try {
    await performLogin(page);
    logger.info('セッションを保存中...');
    await saveSession(context);
    logger.info('セッション保存完了。ブラウザを閉じます。');
  } finally {
    await context.close().catch(() => null);
    await browser.close().catch(() => null);
  }

  // 保存したセッションファイルを別の新規ブラウザで検証
  logger.info('セッションを検証中...');
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
      fs.rmSync(SESSION_FILE, { force: true });
      throw new Error(
        'セッション検証に失敗しました（保存後もログインページに遷移します）。\n' +
        'ダッシュボードが完全に表示された状態で Enter を押してください。'
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
