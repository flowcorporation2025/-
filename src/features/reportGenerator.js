const Anthropic = require('@anthropic-ai/sdk');
const dayjs = require('dayjs');
const db = require('../db/database');
const { sendReport } = require('../notifications/chatwork');
const logger = require('../utils/logger');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Formatting helpers ──────────────────────────────────────────

function fmt(n, prefix = '') {
  if (n == null || n === '') return 'N/A';
  return `${prefix}${Number(n).toLocaleString('ja-JP')}`;
}

function fmtPct(n) {
  if (n == null) return 'N/A';
  return `${Number(n).toFixed(1)}%`;
}

function diff(curr, prev, isPercent = false) {
  if (curr == null || prev == null) return '';
  const d = Number(curr) - Number(prev);
  const sign = d >= 0 ? '+' : '';
  return isPercent
    ? ` (前期比: ${sign}${d.toFixed(1)}%)`
    : ` (前期比: ${sign}${d.toLocaleString('ja-JP')})`;
}

function diffPct(curr, prev) {
  if (curr == null || prev == null || Number(prev) === 0) return '';
  const d = ((Number(curr) - Number(prev)) / Number(prev)) * 100;
  const sign = d >= 0 ? '+' : '';
  return ` (前期比: ${sign}${d.toFixed(1)}%)`;
}

// ── Claude API: AI analysis + improvement suggestions ───────────

async function generateAIComment(metrics, period) {
  if (!process.env.ANTHROPIC_API_KEY) {
    logger.warn('ANTHROPIC_API_KEY が未設定のため AI コメントをスキップします');
    return '（AI分析: ANTHROPIC_API_KEY が未設定です）';
  }

  const metricsText = JSON.stringify(metrics, null, 2);

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      system: [
        {
          type: 'text',
          text: `あなたはTikTok Shopのアフィリエイトマーケティング専門家です。
提供されたKPIデータを分析し、以下の形式で日本語レポートコメントを生成してください。

出力フォーマット（300文字程度）:
- 今期の主要な変化を1〜2文で端的に説明する
- 良かった点と課題点をそれぞれ指摘する
- 来期の具体的な改善アクションを1〜2つ提案する
- 数値はそのまま引用して説明に使う

トーン: 実務的・簡潔・前向き`,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: `以下は${period}のTikTok Shop運用KPIです。分析と改善提案をお願いします。\n\n${metricsText}`,
        },
      ],
    });

    return response.content[0].text.trim();
  } catch (err) {
    logger.error(`Claude API エラー: ${err.message}`);
    return `（AI分析の生成に失敗しました: ${err.message}）`;
  }
}

// ── Weekly Report ───────────────────────────────────────────────

async function runWeeklyReport() {
  const now = dayjs().tz ? dayjs() : dayjs();
  const weekLabel = now.format('YYYY年M月D日') + '週';
  logger.info(`=== 週次レポート生成: ${weekLabel} ===`);

  const curr = db.getWeeklyStats(0);   // this week (Mon–today)
  const prev = db.getWeeklyStats(1);   // last week

  // Violation stats: this week vs last week
  const currWeekStart = now.day(1).format('YYYY-MM-DD');
  const prevWeekStart = now.day(1).subtract(7, 'day').format('YYYY-MM-DD');
  const currVio = db.getViolationStatsForPeriod(currWeekStart, now.format('YYYY-MM-DD 23:59:59'));
  const prevVio = db.getViolationStatsForPeriod(prevWeekStart, currWeekStart);

  const metricsForAI = {
    period: `週次 (${weekLabel})`,
    招待数: { 今週: curr.total_invited, 先週: prev.total_invited },
    承諾率: { 今週: `${curr.acceptance_rate}%`, 先週: `${prev.acceptance_rate}%` },
    売上転換率: { 今週: `${curr.conversion_rate}%`, 先週: `${prev.conversion_rate}%` },
    売上金額: { 今週: `¥${curr.total_sales}`, 先週: `¥${prev.total_sales}` },
    GMV: { 今週: `¥${curr.total_gmv}`, 先週: `¥${prev.total_gmv}` },
    商品違反件数: { 今週: currVio.total_violations, 先週: prevVio.total_violations },
    平均復旧時間: {
      今週: currVio.avg_recovery_minutes ? `${currVio.avg_recovery_minutes}分` : 'N/A',
      先週: prevVio.avg_recovery_minutes ? `${prevVio.avg_recovery_minutes}分` : 'N/A',
    },
  };

  const aiComment = await generateAIComment(metricsForAI, '週次');

  const lines = [
    `[TikTok Shop] 週次レポート (${weekLabel})`,
    '=' .repeat(40),
    '',
    '■ クリエイター招待実績',
    `招待数      : ${fmt(curr.total_invited)}人${diff(curr.total_invited, prev.total_invited)}`,
    `承諾率      : ${fmtPct(curr.acceptance_rate)}${diff(curr.acceptance_rate, prev.acceptance_rate, true)}`,
    `売上転換率  : ${fmtPct(curr.conversion_rate)}${diff(curr.conversion_rate, prev.conversion_rate, true)}`,
    `売上金額    : ${fmt(curr.total_sales, '¥')}${diffPct(curr.total_sales, prev.total_sales)}`,
    `GMV        : ${fmt(curr.total_gmv, '¥')}${diffPct(curr.total_gmv, prev.total_gmv)}`,
    '',
    '■ 商品ガイドライン違反',
    `違反検知    : ${fmt(currVio.total_violations)}件${diff(currVio.total_violations, prevVio.total_violations)}`,
    `復旧済み    : ${fmt(currVio.recovered_count)}件`,
    `平均復旧時間: ${currVio.avg_recovery_minutes ?? 'N/A'}分${diff(currVio.avg_recovery_minutes, prevVio.avg_recovery_minutes)}`,
    '',
    '■ AIによる分析・改善提案',
    aiComment,
    '',
    `生成日時: ${dayjs().format('YYYY-MM-DD HH:mm')} JST`,
  ];

  const message = lines.join('\n');
  await sendReport(message);
  logger.info('週次レポートをChatworkに送信しました');
  return message;
}

// ── Monthly Report ──────────────────────────────────────────────

async function runMonthlyReport() {
  const now = dayjs();
  const monthLabel = now.subtract(1, 'month').format('YYYY年M月');
  logger.info(`=== 月次レポート生成: ${monthLabel} ===`);

  const curr = db.getMonthlyStats(1);   // last month
  const prev = db.getMonthlyStats(2);   // month before last

  const currMonthStart = now.subtract(1, 'month').startOf('month').format('YYYY-MM-DD');
  const currMonthEnd   = now.startOf('month').format('YYYY-MM-DD');
  const prevMonthStart = now.subtract(2, 'month').startOf('month').format('YYYY-MM-DD');

  const currVio = db.getViolationStatsForPeriod(currMonthStart, currMonthEnd);
  const prevVio = db.getViolationStatsForPeriod(prevMonthStart, currMonthStart);

  const metricsForAI = {
    period: `月次 (${monthLabel})`,
    招待数: { 今月: curr.total_invited, 先月: prev.total_invited },
    承諾率: { 今月: `${curr.acceptance_rate}%`, 先月: `${prev.acceptance_rate}%` },
    売上転換率: { 今月: `${curr.conversion_rate}%`, 先月: `${prev.conversion_rate}%` },
    売上金額: { 今月: `¥${curr.total_sales}`, 先月: `¥${prev.total_sales}` },
    GMV: { 今月: `¥${curr.total_gmv}`, 先月: `¥${prev.total_gmv}` },
    商品違反件数: { 今月: currVio.total_violations, 先月: prevVio.total_violations },
    平均復旧時間: {
      今月: currVio.avg_recovery_minutes ? `${currVio.avg_recovery_minutes}分` : 'N/A',
      先月: prevVio.avg_recovery_minutes ? `${prevVio.avg_recovery_minutes}分` : 'N/A',
    },
  };

  const aiComment = await generateAIComment(metricsForAI, '月次');

  const lines = [
    `[TikTok Shop] 月次レポート (${monthLabel})`,
    '='.repeat(40),
    '',
    '■ クリエイター招待実績',
    `招待数      : ${fmt(curr.total_invited)}人${diff(curr.total_invited, prev.total_invited)}`,
    `承諾率      : ${fmtPct(curr.acceptance_rate)}${diff(curr.acceptance_rate, prev.acceptance_rate, true)}`,
    `売上転換率  : ${fmtPct(curr.conversion_rate)}${diff(curr.conversion_rate, prev.conversion_rate, true)}`,
    `売上金額    : ${fmt(curr.total_sales, '¥')}${diffPct(curr.total_sales, prev.total_sales)}`,
    `GMV        : ${fmt(curr.total_gmv, '¥')}${diffPct(curr.total_gmv, prev.total_gmv)}`,
    '',
    '■ 商品ガイドライン違反',
    `違反検知    : ${fmt(currVio.total_violations)}件${diff(currVio.total_violations, prevVio.total_violations)}`,
    `復旧済み    : ${fmt(currVio.recovered_count)}件`,
    `平均復旧時間: ${currVio.avg_recovery_minutes ?? 'N/A'}分${diff(currVio.avg_recovery_minutes, prevVio.avg_recovery_minutes)}`,
    '',
    '■ AIによる分析・改善提案',
    aiComment,
    '',
    `生成日時: ${now.format('YYYY-MM-DD HH:mm')} JST`,
  ];

  const message = lines.join('\n');
  await sendReport(message);
  logger.info('月次レポートをChatworkに送信しました');
  return message;
}

module.exports = { runWeeklyReport, runMonthlyReport };
