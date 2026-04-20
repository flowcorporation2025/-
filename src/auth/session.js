const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

const SESSION_DIR = path.join(process.cwd(), 'data', 'sessions');
const SESSION_FILE = path.join(SESSION_DIR, 'tiktok_session.json');

const TIKTOK_SELLER_URL = 'https://seller.tiktokglobalshop.com';
const TIKTOK_AFFILIATE_URL = 'https://affiliate.tiktokglobalshop.com';

async function launchBrowser(headless = false) {
  const browser = await chromium.launch({
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  return browser;
}

async function createContext(browser) {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }

  const contextOptions = {
    viewport: { width: 1280, height: 800 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  };

  if (fs.existsSync(SESSION_FILE)) {
    logger.info('既存セッションを読み込み中...');
    contextOptions.storageState = SESSION_FILE;
  }

  const context = await browser.newContext(contextOptions);

  // Block unnecessary resources to speed up
  await context.route('**/*.{png,jpg,jpeg,gif,webp,svg,ico,woff,woff2,ttf}', (route) =>
    route.abort()
  );

  return context;
}

async function saveSession(context) {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }
  await context.storageState({ path: SESSION_FILE });
  logger.info(`セッションを保存しました: ${SESSION_FILE}`);
}

async function isLoggedIn(page, targetUrl = TIKTOK_SELLER_URL) {
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    const currentUrl = page.url();
    // If redirected to login page, session is invalid
    if (currentUrl.includes('login') || currentUrl.includes('passport')) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function performLogin(page) {
  logger.info('手動ログインモード: ブラウザでTikTokにログインしてください。');
  logger.info(`ログインURL: ${TIKTOK_SELLER_URL}`);
  await page.goto(TIKTOK_SELLER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  logger.info('ログインが完了したらEnterキーを押してください...');
  await new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve();
    });
  });
}

async function getAuthenticatedPage(targetUrl = TIKTOK_SELLER_URL) {
  const browser = await launchBrowser(process.env.HEADLESS === 'true');
  const context = await createContext(browser);
  const page = await context.newPage();

  const loggedIn = await isLoggedIn(page, targetUrl);

  if (!loggedIn) {
    logger.warn('セッションが無効です。手動ログインが必要です。');
    await performLogin(page);
    await saveSession(context);

    const recheck = await isLoggedIn(page, targetUrl);
    if (!recheck) {
      throw new Error('ログインに失敗しました。再試行してください。');
    }
  } else {
    logger.info('セッション有効。自動ログイン成功。');
  }

  return { browser, context, page };
}

module.exports = {
  launchBrowser,
  createContext,
  saveSession,
  isLoggedIn,
  performLogin,
  getAuthenticatedPage,
  TIKTOK_SELLER_URL,
  TIKTOK_AFFILIATE_URL,
};
