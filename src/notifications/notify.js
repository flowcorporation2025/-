const axios = require('axios');
const logger = require('../utils/logger');

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const LINE_NOTIFY_TOKEN = process.env.LINE_NOTIFY_TOKEN;

async function sendSlack(message, options = {}) {
  if (!SLACK_WEBHOOK_URL) return;
  try {
    const payload = {
      text: message,
      ...(options.blocks && { blocks: options.blocks }),
      ...(options.username && { username: options.username }),
      icon_emoji: options.icon_emoji ?? ':robot_face:',
    };
    await axios.post(SLACK_WEBHOOK_URL, payload, { timeout: 10000 });
    logger.info('Slack通知送信完了');
  } catch (err) {
    logger.error(`Slack通知失敗: ${err.message}`);
  }
}

async function sendLine(message) {
  if (!LINE_NOTIFY_TOKEN) return;
  try {
    await axios.post(
      'https://notify-api.line.me/api/notify',
      new URLSearchParams({ message }),
      {
        headers: { Authorization: `Bearer ${LINE_NOTIFY_TOKEN}` },
        timeout: 10000,
      }
    );
    logger.info('LINE通知送信完了');
  } catch (err) {
    logger.error(`LINE通知失敗: ${err.message}`);
  }
}

async function notify(message, options = {}) {
  const tasks = [];
  if (SLACK_WEBHOOK_URL) tasks.push(sendSlack(message, options));
  if (LINE_NOTIFY_TOKEN) tasks.push(sendLine(message));
  if (tasks.length === 0) {
    logger.warn('通知先が設定されていません (SLACK_WEBHOOK_URL / LINE_NOTIFY_TOKEN)');
    return;
  }
  await Promise.allSettled(tasks);
}

async function notifyProductViolation(product) {
  const message = [
    `🚨 【商品違反検知】`,
    `商品名: ${product.productName}`,
    `商品ID: ${product.productId}`,
    `違反種別: ${product.violationType ?? '不明'}`,
    `検知時刻: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`,
    `→ 再申請ボタンを自動クリックしました`,
  ].join('\n');
  await notify(message, { icon_emoji: ':warning:' });
}

async function notifyProductRecovered(product) {
  const message = [
    `✅ 【商品復旧完了】`,
    `商品名: ${product.productName}`,
    `商品ID: ${product.productId}`,
    `復旧時刻: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`,
  ].join('\n');
  await notify(message, { icon_emoji: ':white_check_mark:' });
}

async function notifyInvitationSummary(stats) {
  const message = [
    `📨 【クリエイター招待完了】`,
    `招待状①: ${stats.letter1Sent}人`,
    `招待状②: ${stats.letter2Sent}人`,
    `合計: ${stats.totalSent}人`,
    `実行日: ${stats.runDate}`,
  ].join('\n');
  await notify(message, { icon_emoji: ':mega:' });
}

async function notifyError(context, error) {
  const message = [
    `❌ 【エラー発生】`,
    `処理: ${context}`,
    `エラー: ${error.message}`,
    `発生時刻: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`,
  ].join('\n');
  await notify(message, { icon_emoji: ':x:' });
}

module.exports = {
  notify,
  notifyProductViolation,
  notifyProductRecovered,
  notifyInvitationSummary,
  notifyError,
};
