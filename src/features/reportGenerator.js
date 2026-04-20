'use strict';
const Anthropic = require('@anthropic-ai/sdk');
const dayjs = require('dayjs');
const sheets = require('../sheets/googleSheets');
const { sendReport } = require('../notifications/chatwork');
const logger = require('../utils/logger');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Date range helpers ────────────────────────────────────────────────────────

function getWeekRange(weeksAgo = 0) {
  const now = dayjs();
  // Monday = start of week in Japan
  const dow = now.day(); // 0=Sun
  const daysToMonday = dow === 0 ? 6 : dow - 1;
  const monday = now.subtract(daysToMonday + weeksAgo * 7, 'day').startOf('day');
  const sunday = monday.add(6, 'day').endOf('day');
  return { start: monday, end: sunday };
}

function getMonthRange(monthsAgo = 0) {
  const target = dayjs().subtract(monthsAgo, 'month');
  return {
    start: target.startOf('month'),
    end: target.endOf('month'),
  };
}

function inRange(dateStr, start, end) {
  if (!dateStr) return false;
  const d = dayjs(dateStr);
  return d.isValid() && !d.isBefore(start) && !d.isAfter(end);
}

// ── Data aggregation ──────────────────────────────────────────────────────────

function aggregateInvites(dailyRows, start, end) {
  const rows = dailyRows.filter((r) => inRange(r['日付'], start, end));
  return rows.reduce((sum, r) => sum + (parseInt(r['合計招待数']) || 0), 0);
}

function aggregateSales(salesRows, start, end) {
  const rows = salesRows.filter((r) => inRange(r['日付'], start, end));
  if (rows.length === 0) {
    return { accepted: 0, acceptanceRate: null, conversionRate: null, totalSales: 0, totalGmv: 0 };
  }
  const accepted      = rows.reduce((s, r) => s + (parseInt(r['承諾数']) || 0), 0);
  const totalSales    = rows.reduce((s, r) => s + (parseInt(r['売上金額(¥)']) || 0), 0);
  const totalGmv      = rows.reduce((s, r) => s + (parseInt(r['GMV(¥)']) || 0), 0);
  const invited       = aggregateInvites([], start, end); // placeholder if called separately
  const acceptanceRate = rows[0]?.['承諾率(%)'] || null; // use latest day's rate as proxy
  const conversionRate = rows[0]?.['売上転換率(%)'] || null;
  return { accepted, acceptanceRate, conversionRate, totalSales, totalGmv };
}

function aggregateViolations(violationRows, start, end) {
  const rows = violationRows.filter((r) => inRange(r['検知日時'], start, end));
  const recovered = rows.filter((r) => r['ステータス'] === 'recovered');
  const recoveryMins = recovered
    .map((r) => parseFloat(r['復旧時間(分)']))
    .filter((v) => !isNaN(v));
  const avgRecovery =
    recoveryMins.length > 0
      ? (recoveryMins.reduce((s, v) => s + v, 0) / recoveryMins.length).toFixed(1)
      : null;
  return { total: rows.length, recovered: recovered.length, avgRecovery };
}

// Full aggregation for a period using data from all Sheets
async function aggregatePeriod(start, end) {
  const [dailyRows, salesRows, violationRows] = await Promise.all([
    sheets.getSheetData('日次データ'),
    sheets.getSheetData('売上データ'),
    sheets.getSheetData('違反履歴'),
  ]);

  const totalInvited = aggregateInvites(dailyRows, start, end);
  const sales = aggregateSales(salesRows, start, end);
  const violations = aggregateViolations(violationRows, start, end);

  return { totalInvited, ...sales, violations };
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmtYen(n) {
  if (n == null || n === '') return 'データなし';
  const v = Number(n);
  if (v >= 1_000_000) return `${(v / 10_000).toFixed(0)}万円`;
  return `¥${v.toLocaleString('ja-JP')}`;
}

function fmtPct(n) {
  if (n == null || n === '') return 'N/A';
  return `${Number(n).toFixed(1)}%`;
}

function fmtDiff(curr, prev, isYen = false) {
  if (curr == null || prev == null || Number(prev) === 0) return '';
  const pct = ((Number(curr) - Number(prev)) / Number(prev)) * 100;
  const sign = pct >= 0 ? '+' : '';
  return `（先週比${sign}${pct.toFixed(0)}%）`;
}

function fmtDiffPt(curr, prev) {
  if (curr == null || prev == null) return '';
  const d = Number(curr) - Number(prev);
  const sign = d >= 0 ? '+' : '';
  return `（先週比${sign}${d.toFixed(1)}%）`;
}

// ── Claude API: AI comment ────────────────────────────────────────────────────

async function generateAIComment(metrics, period) {
  if (!process.env.ANTHROPIC_API_KEY) {
    logger.warn('ANTHROPIC_API_KEY 未設定 → AI分析をスキップ');
    return '（AI分析: ANTHROPIC_API_KEY が未設定です）';
  }
  try {
    const res = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: [
        {
          type: 'text',
          text: `あなたはTikTok Shopアフィリエイトの運用コンサルタントです。
提供されたKPIデータを分析し、300字以内の日本語で以下を出力してください。
1. 今期の重要な変化（数値を引用）
2. 改善すべき課題（具体的に1点）
3. 来週/来月の推奨アクション（具体的に1〜2つ）
トーン：実務的・簡潔・前向き`,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: `${period}のKPIです。分析と改善提案をお願いします。\n${JSON.stringify(metrics, null, 2)}`,
        },
      ],
    });
    return res.content[0].text.trim();
  } catch (err) {
    logger.error(`Claude API エラー: ${err.message}`);
    return `（AI分析の生成に失敗: ${err.message}）`;
  }
}

// ── Weekly Report ─────────────────────────────────────────────────────────────

async function runWeeklyReport() {
  const { start: s0, end: e0 } = getWeekRange(0); // this week
  const { start: s1, end: e1 } = getWeekRange(1); // last week

  const weekLabel = `${s0.format('YYYY/MM/DD')}〜${e0.format('MM/DD')}`;
  logger.info(`=== 週次レポート生成: ${weekLabel} ===`);

  const [curr, prev] = await Promise.all([
    aggregatePeriod(s0, e0),
    aggregatePeriod(s1, e1),
  ]);

  const metricsForAI = {
    期間: weekLabel,
    招待数:     { 今週: curr.totalInvited,          先週: prev.totalInvited },
    承諾率:     { 今週: curr.acceptanceRate + '%',   先週: prev.acceptanceRate + '%' },
    売上転換率: { 今週: curr.conversionRate + '%',   先週: prev.conversionRate + '%' },
    売上金額:   { 今週: fmtYen(curr.totalSales),     先週: fmtYen(prev.totalSales) },
    GMV:        { 今週: fmtYen(curr.totalGmv),       先週: fmtYen(prev.totalGmv) },
    違反件数:   { 今週: curr.violations.total,       先週: prev.violations.total },
    平均復旧時間: {
      今週: curr.violations.avgRecovery ? `${curr.violations.avgRecovery}分` : 'N/A',
      先週: prev.violations.avgRecovery ? `${prev.violations.avgRecovery}分` : 'N/A',
    },
  };

  const aiComment = await generateAIComment(metricsForAI, '週次');

  // ── Chatwork message (spec format) ────────────────────────────
  const acceptanceDiff = fmtDiffPt(curr.acceptanceRate, prev.acceptanceRate).replace('先週比', '');
  const salesDiff      = fmtDiff(curr.totalSales, prev.totalSales);
  const gmvDiff        = prev.totalGmv && curr.totalGmv
    ? `${((curr.totalGmv - prev.totalGmv) / prev.totalGmv * 100).toFixed(0)}%`
    : 'N/A';
  const gmvSign        = curr.totalGmv >= prev.totalGmv ? '+' : '';

  const message = [
    `【週次レポート】${weekLabel}`,
    `招待数：${curr.totalInvited}人 / 承諾率：${fmtPct(curr.acceptanceRate)}${acceptanceDiff}`,
    `売上金額：${fmtYen(curr.totalSales)}${salesDiff}`,
    `GMV変化：${gmvSign}${gmvDiff}`,
    `商品落ち：${curr.violations.total}件（平均復旧時間${curr.violations.avgRecovery ?? 'N/A'}分）`,
    '',
    '【改善提案】',
    aiComment,
    '',
    `詳細はこちら→ ${sheets.getSpreadsheetUrl()}`,
  ].join('\n');

  await sendReport(message);
  logger.info('週次レポートをChatworkに送信しました');

  // ── Sheet④に記録 ──────────────────────────────────────────────
  await sheets.appendWeeklySummaryRow({
    weekLabel,
    startDate: s0.format('YYYY-MM-DD'),
    endDate:   e0.format('YYYY-MM-DD'),
    totalInvited:   curr.totalInvited,
    acceptanceRate: curr.acceptanceRate,
    conversionRate: curr.conversionRate,
    totalSales:     curr.totalSales,
    totalGmv:       curr.totalGmv,
    totalViolations: curr.violations.total,
    avgRecoveryMin:  curr.violations.avgRecovery,
    aiComment,
  });

  return message;
}

// ── Monthly Report ────────────────────────────────────────────────────────────

async function runMonthlyReport() {
  const { start: s0, end: e0 } = getMonthRange(1); // last month
  const { start: s1, end: e1 } = getMonthRange(2); // month before last

  const monthLabel = s0.format('YYYY年M月');
  logger.info(`=== 月次レポート生成: ${monthLabel} ===`);

  const [curr, prev] = await Promise.all([
    aggregatePeriod(s0, e0),
    aggregatePeriod(s1, e1),
  ]);

  const metricsForAI = {
    期間: monthLabel,
    招待数:     { 今月: curr.totalInvited,          先月: prev.totalInvited },
    承諾率:     { 今月: curr.acceptanceRate + '%',   先月: prev.acceptanceRate + '%' },
    売上転換率: { 今月: curr.conversionRate + '%',   先月: prev.conversionRate + '%' },
    売上金額:   { 今月: fmtYen(curr.totalSales),     先月: fmtYen(prev.totalSales) },
    GMV:        { 今月: fmtYen(curr.totalGmv),       先月: fmtYen(prev.totalGmv) },
    違反件数:   { 今月: curr.violations.total,       先月: prev.violations.total },
    平均復旧時間: {
      今月: curr.violations.avgRecovery ? `${curr.violations.avgRecovery}分` : 'N/A',
      先月: prev.violations.avgRecovery ? `${prev.violations.avgRecovery}分` : 'N/A',
    },
  };

  const aiComment = await generateAIComment(metricsForAI, '月次');

  const acceptanceDiff = fmtDiffPt(curr.acceptanceRate, prev.acceptanceRate).replace('先週比', '先月比');
  const salesDiff      = fmtDiff(curr.totalSales, prev.totalSales).replace('先週比', '先月比');
  const gmvPct = prev.totalGmv && curr.totalGmv
    ? `${((curr.totalGmv - prev.totalGmv) / prev.totalGmv * 100).toFixed(0)}%`
    : 'N/A';
  const gmvSign = curr.totalGmv >= prev.totalGmv ? '+' : '';

  const message = [
    `【月次レポート】${monthLabel}`,
    `招待数：${curr.totalInvited}人 / 承諾率：${fmtPct(curr.acceptanceRate)}${acceptanceDiff}`,
    `売上金額：${fmtYen(curr.totalSales)}${salesDiff}`,
    `GMV変化：${gmvSign}${gmvPct}`,
    `商品落ち：${curr.violations.total}件（平均復旧時間${curr.violations.avgRecovery ?? 'N/A'}分）`,
    '',
    '【改善提案】',
    aiComment,
    '',
    `詳細はこちら→ ${sheets.getSpreadsheetUrl()}`,
  ].join('\n');

  await sendReport(message);
  logger.info('月次レポートをChatworkに送信しました');

  // ── Sheet⑤に記録 ──────────────────────────────────────────────
  await sheets.appendMonthlySummaryRow({
    monthLabel,
    totalInvited:    curr.totalInvited,
    acceptanceRate:  curr.acceptanceRate,
    conversionRate:  curr.conversionRate,
    totalSales:      curr.totalSales,
    totalGmv:        curr.totalGmv,
    totalViolations: curr.violations.total,
    avgRecoveryMin:  curr.violations.avgRecovery,
    aiComment,
  });

  return message;
}

module.exports = { runWeeklyReport, runMonthlyReport };
