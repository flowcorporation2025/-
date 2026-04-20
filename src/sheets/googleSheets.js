'use strict';
const { google } = require('googleapis');
const path = require('path');
const dayjs = require('dayjs');
const logger = require('../utils/logger');

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_ID;
const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

// ── Sheet definitions ─────────────────────────────────────────────────────────
const SHEETS = {
  DAILY: {
    name: '日次データ',
    headers: ['日付', '招待数①', '招待数②', '合計招待数', '実行時刻', 'エラー'],
  },
  SALES: {
    name: '売上データ',
    headers: ['日付', '承諾数', '承諾率(%)', '売上転換率(%)', '売上金額(¥)', 'GMV(¥)', '前週比売上(%)', '前月比売上(%)'],
  },
  VIOLATIONS: {
    name: '違反履歴',
    headers: ['商品ID', '商品名', '違反種別', '検知日時', '再申請日時', '復旧日時', '復旧時間(分)', 'ステータス'],
  },
  WEEKLY: {
    name: '週次サマリー',
    headers: ['週', '開始日', '終了日', '総招待数', '承諾率(%)', '売上転換率(%)', '売上金額(¥)', 'GMV(¥)', '違反件数', '平均復旧時間(分)', 'AI改善提案'],
  },
  MONTHLY: {
    name: '月次サマリー',
    headers: ['年月', '総招待数', '承諾率(%)', '売上転換率(%)', '売上金額(¥)', 'GMV(¥)', '違反件数', '平均復旧時間(分)', 'AI改善提案'],
  },
};

// ── Auth & client (singleton) ─────────────────────────────────────────────────
let _sheetsApi = null;

async function getSheetsApi() {
  if (_sheetsApi) return _sheetsApi;

  if (!SPREADSHEET_ID) throw new Error('GOOGLE_SHEETS_ID が未設定です');
  if (!KEY_FILE) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY が未設定です');

  const auth = new google.auth.GoogleAuth({
    keyFile: path.resolve(KEY_FILE),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  _sheetsApi = google.sheets({ version: 'v4', auth });
  logger.info('Google Sheets API 認証完了');
  return _sheetsApi;
}

function getSpreadsheetUrl() {
  return `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}`;
}

// ── Sheet initialization ──────────────────────────────────────────────────────

async function initSheets() {
  const api = await getSheetsApi();

  // Get existing sheet titles
  const meta = await api.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existing = new Set(meta.data.sheets.map((s) => s.properties.title));

  // Create any missing sheets
  const toCreate = Object.values(SHEETS).filter((s) => !existing.has(s.name));
  if (toCreate.length > 0) {
    await api.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: toCreate.map((s) => ({
          addSheet: { properties: { title: s.name } },
        })),
      },
    });
    logger.info(`シート作成: ${toCreate.map((s) => s.name).join(', ')}`);
  }

  // Ensure header row exists in each sheet
  for (const sheet of Object.values(SHEETS)) {
    const res = await api.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheet.name}!A1:Z1`,
    });
    const firstRow = res.data.values?.[0] ?? [];
    if (firstRow.length === 0 || firstRow[0] !== sheet.headers[0]) {
      await api.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${sheet.name}!A1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [sheet.headers] },
      });
      logger.info(`ヘッダー設定: ${sheet.name}`);
    }
  }

  logger.info('Google Sheets 初期化完了');
}

// ── Generic helpers ───────────────────────────────────────────────────────────

async function appendRow(sheetName, values) {
  const api = await getSheetsApi();
  await api.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:Z`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [values] },
  });
}

// Returns all data rows as objects keyed by header name
async function getSheetData(sheetName) {
  const api = await getSheetsApi();
  const res = await api.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:Z`,
  });
  const rows = res.data.values ?? [];
  if (rows.length < 2) return [];
  const [headers, ...dataRows] = rows;
  return dataRows.map((row) =>
    Object.fromEntries(headers.map((h, i) => [h, row[i] ?? '']))
  );
}

// Update a specific row by its 1-based sheet row number
async function updateRow(sheetName, rowNumber, startCol, values) {
  const api = await getSheetsApi();
  await api.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!${startCol}${rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [values] },
  });
}

// ── Sheet① Daily invite data ──────────────────────────────────────────────────

async function appendDailyRow(data) {
  const row = [
    data.date,
    data.letter1Sent,
    data.letter2Sent,
    data.totalSent,
    data.runTime ?? dayjs().format('HH:mm:ss'),
    data.error ?? '',
  ];
  await appendRow(SHEETS.DAILY.name, row);
  logger.info(`日次データ記録: ${data.date} / 招待${data.totalSent}人`);
}

// ── Sheet② Sales data ─────────────────────────────────────────────────────────

async function appendSalesRow(data) {
  const row = [
    data.date,
    data.accepted ?? '',
    data.acceptanceRate ?? '',
    data.conversionRate ?? '',
    data.salesAmount ?? '',
    data.gmv ?? '',
    data.weekOverWeekSales ?? '',
    data.weekOverWeekGmv ?? '',
  ];
  await appendRow(SHEETS.SALES.name, row);
  logger.info(`売上データ記録: ${data.date}`);
}

// ── Sheet③ Violation history ──────────────────────────────────────────────────

async function appendViolationRow(data) {
  const row = [
    data.productId,
    data.productName ?? '',
    data.violationType ?? '',
    data.detectedAt ?? dayjs().format('YYYY-MM-DD HH:mm:ss'),
    '',   // 再申請日時 (filled on reapply)
    '',   // 復旧日時 (filled on recovery)
    '',   // 復旧時間(分) (filled on recovery)
    'submitted',
  ];
  await appendRow(SHEETS.VIOLATIONS.name, row);
  logger.info(`違反履歴記録: ${data.productName} (${data.productId})`);
}

async function updateViolationRow(productId, updateData) {
  const api = await getSheetsApi();

  // Read all violation rows to find the matching one
  const res = await api.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEETS.VIOLATIONS.name}!A:H`,
  });
  const rows = res.data.values ?? [];

  // Find row index (0=header, 1=first data row)
  const rowIndex = rows.findIndex(
    (r, i) => i > 0 && r[0] === productId && r[7] === 'submitted'
  );
  if (rowIndex === -1) {
    logger.warn(`違反行が見つかりません: ${productId}`);
    return false;
  }

  // Sheet row number (1-based, header is row 1)
  const sheetRow = rowIndex + 1;

  // Update columns E–H (再申請日時, 復旧日時, 復旧時間, ステータス)
  await updateRow(SHEETS.VIOLATIONS.name, sheetRow, 'E', [
    updateData.reappliedAt ?? '',
    updateData.recoveryAt ?? '',
    updateData.recoveryMinutes ?? '',
    updateData.status,
  ]);

  logger.info(`違反行更新: ${productId} → ${updateData.status}`);
  return true;
}

// ── Sheet④ Weekly summary ─────────────────────────────────────────────────────

async function appendWeeklySummaryRow(data) {
  const row = [
    data.weekLabel,
    data.startDate,
    data.endDate,
    data.totalInvited,
    data.acceptanceRate ?? '',
    data.conversionRate ?? '',
    data.totalSales ?? '',
    data.totalGmv ?? '',
    data.totalViolations,
    data.avgRecoveryMin ?? '',
    data.aiComment ?? '',
  ];
  await appendRow(SHEETS.WEEKLY.name, row);
  logger.info(`週次サマリー記録: ${data.weekLabel}`);
}

// ── Sheet⑤ Monthly summary ───────────────────────────────────────────────────

async function appendMonthlySummaryRow(data) {
  const row = [
    data.monthLabel,
    data.totalInvited,
    data.acceptanceRate ?? '',
    data.conversionRate ?? '',
    data.totalSales ?? '',
    data.totalGmv ?? '',
    data.totalViolations,
    data.avgRecoveryMin ?? '',
    data.aiComment ?? '',
  ];
  await appendRow(SHEETS.MONTHLY.name, row);
  logger.info(`月次サマリー記録: ${data.monthLabel}`);
}

module.exports = {
  initSheets,
  getSpreadsheetUrl,
  getSheetData,
  appendDailyRow,
  appendSalesRow,
  appendViolationRow,
  updateViolationRow,
  appendWeeklySummaryRow,
  appendMonthlySummaryRow,
  SHEETS,
};
