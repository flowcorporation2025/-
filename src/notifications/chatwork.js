const axios = require('axios');
const logger = require('../utils/logger');

const CHATWORK_API_TOKEN = process.env.CHATWORK_API_TOKEN;
const CHATWORK_ROOM_ID = process.env.CHATWORK_ROOM_ID;
const CHATWORK_REPORT_ROOM_ID = process.env.CHATWORK_REPORT_ROOM_ID ?? CHATWORK_ROOM_ID;

const CW_BASE = 'https://api.chatwork.com/v2';

async function postMessage(roomId, body) {
  if (!CHATWORK_API_TOKEN || !roomId) {
    logger.warn('Chatwork設定が不足しています (CHATWORK_API_TOKEN / CHATWORK_ROOM_ID)');
    return null;
  }
  try {
    const res = await axios.post(
      `${CW_BASE}/rooms/${roomId}/messages`,
      new URLSearchParams({ body, self_unread: '0' }),
      {
        headers: {
          'X-ChatWorkToken': CHATWORK_API_TOKEN,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 15000,
      }
    );
    logger.info(`Chatwork送信完了 (room: ${roomId}, message_id: ${res.data.message_id})`);
    return res.data.message_id;
  } catch (err) {
    const detail = err.response?.data ?? err.message;
    logger.error(`Chatwork送信失敗: ${JSON.stringify(detail)}`);
    return null;
  }
}

// Send alert to the main operations room
async function sendAlert(message) {
  return postMessage(CHATWORK_ROOM_ID, message);
}

// Send weekly/monthly reports to the designated report room
async function sendReport(message) {
  return postMessage(CHATWORK_REPORT_ROOM_ID, message);
}

module.exports = { sendAlert, sendReport, postMessage };
