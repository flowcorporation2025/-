const { sendAlert } = require('./chatwork');
const logger = require('../utils/logger');

function jstNow() {
  return new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

async function notifyProductViolation(product) {
  const message = [
    '[商品違反検知]',
    `商品名: ${product.productName}`,
    `商品ID: ${product.productId}`,
    `違反種別: ${product.violationType ?? '不明'}`,
    `検知時刻: ${jstNow()}`,
    '→ 再申請ボタンを自動クリックしました',
  ].join('\n');
  await sendAlert(message);
  logger.info(`違反通知送信: ${product.productName}`);
}

async function notifyProductRecovered(product) {
  const message = [
    '[商品復旧完了]',
    `商品名: ${product.productName}`,
    `商品ID: ${product.productId}`,
    `復旧時刻: ${jstNow()}`,
  ].join('\n');
  await sendAlert(message);
  logger.info(`復旧通知送信: ${product.productName}`);
}

async function notifyInvitationSummary(stats) {
  const message = [
    '[クリエイター招待完了]',
    `招待状①: ${stats.letter1Sent}人`,
    `招待状②: ${stats.letter2Sent}人`,
    `合計: ${stats.totalSent}人`,
    `実行日: ${stats.runDate}`,
  ].join('\n');
  await sendAlert(message);
}

async function notifyError(context, error) {
  const message = [
    '[エラー発生]',
    `処理: ${context}`,
    `エラー: ${error.message}`,
    `発生時刻: ${jstNow()}`,
  ].join('\n');
  await sendAlert(message);
  logger.error(`エラー通知送信: ${context}`);
}

module.exports = {
  notifyProductViolation,
  notifyProductRecovered,
  notifyInvitationSummary,
  notifyError,
};
