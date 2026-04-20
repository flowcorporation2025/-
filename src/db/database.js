const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'tiktok_bot.db');

let db;

function getDb() {
  if (!db) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
    migrate();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS creator_invitations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      creator_id TEXT NOT NULL,
      creator_name TEXT,
      creator_handle TEXT,
      avg_views INTEGER,
      gmv INTEGER,
      engagement_rate REAL,
      invitation_letter INTEGER NOT NULL CHECK(invitation_letter IN (1, 2)),
      invited_at TEXT NOT NULL,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'rejected', 'expired')),
      accepted_at TEXT,
      sales_amount INTEGER DEFAULT 0,
      gmv_amount INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS invitation_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date TEXT NOT NULL,
      letter1_sent INTEGER DEFAULT 0,
      letter2_sent INTEGER DEFAULT 0,
      total_sent INTEGER DEFAULT 0,
      letter1_target INTEGER DEFAULT 50,
      letter2_target INTEGER DEFAULT 50,
      total_sales INTEGER DEFAULT 0,
      total_gmv INTEGER DEFAULT 0,
      completed INTEGER DEFAULT 0,
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS product_violations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      product_name TEXT,
      violation_type TEXT,
      detected_at TEXT NOT NULL,
      reapplied_at TEXT,
      reapply_status TEXT DEFAULT 'pending' CHECK(reapply_status IN ('pending', 'submitted', 'recovered', 'failed')),
      notified INTEGER DEFAULT 0,
      recovery_at TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS product_monitor_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      checked_at TEXT NOT NULL,
      total_products INTEGER DEFAULT 0,
      violated_count INTEGER DEFAULT 0,
      reapplied_count INTEGER DEFAULT 0,
      error_message TEXT
    );
  `);
  logger.info('データベース初期化完了');
}

// Idempotent column additions for existing databases
function migrate() {
  const alterations = [
    `ALTER TABLE creator_invitations ADD COLUMN gmv_amount INTEGER DEFAULT 0`,
    `ALTER TABLE invitation_runs ADD COLUMN total_sales INTEGER DEFAULT 0`,
    `ALTER TABLE invitation_runs ADD COLUMN total_gmv INTEGER DEFAULT 0`,
  ];
  for (const sql of alterations) {
    try {
      db.exec(sql);
    } catch {
      // Column already exists — safe to ignore
    }
  }
}

// ── Creator Invitation ──────────────────────────────────────────

function startInvitationRun(runDate) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO invitation_runs (run_date, created_at)
    VALUES (?, datetime('now'))
  `).run(runDate);
  return result.lastInsertRowid;
}

function updateInvitationRun(runId, data) {
  const db = getDb();
  db.prepare(`
    UPDATE invitation_runs
    SET letter1_sent = ?, letter2_sent = ?, total_sent = ?,
        total_sales = ?, total_gmv = ?, completed = ?, error_message = ?
    WHERE id = ?
  `).run(
    data.letter1Sent ?? 0,
    data.letter2Sent ?? 0,
    data.totalSent ?? 0,
    data.totalSales ?? 0,
    data.totalGmv ?? 0,
    data.completed ? 1 : 0,
    data.errorMessage ?? null,
    runId
  );
}

function recordInvitation(data) {
  const db = getDb();
  db.prepare(`
    INSERT INTO creator_invitations
      (creator_id, creator_name, creator_handle, avg_views, gmv, engagement_rate,
       invitation_letter, invited_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), 'pending')
  `).run(
    data.creatorId,
    data.creatorName ?? null,
    data.creatorHandle ?? null,
    data.avgViews ?? null,
    data.gmv ?? null,
    data.engagementRate ?? null,
    data.invitationLetter
  );
}

function updateInvitationStatus(creatorId, status, salesAmount = 0, gmvAmount = 0) {
  const db = getDb();
  db.prepare(`
    UPDATE creator_invitations
    SET status = ?,
        accepted_at = CASE WHEN ? = 'accepted' THEN datetime('now') ELSE accepted_at END,
        sales_amount = ?,
        gmv_amount = ?,
        updated_at = datetime('now')
    WHERE creator_id = ? AND status = 'pending'
  `).run(status, status, salesAmount, gmvAmount, creatorId);
}

function wasInvitedRecently(creatorId, withinDays = 30) {
  const db = getDb();
  const row = db.prepare(`
    SELECT 1 FROM creator_invitations
    WHERE creator_id = ? AND invited_at >= datetime('now', '-' || ? || ' days')
    LIMIT 1
  `).get(creatorId, withinDays);
  return !!row;
}

// ── Reporting Queries ───────────────────────────────────────────

function getInvitationStats(days = 30) {
  const db = getDb();
  return db.prepare(`
    SELECT
      COUNT(*) AS total_invited,
      SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
      SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
      ROUND(
        100.0 * SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) / MAX(COUNT(*), 1), 2
      ) AS acceptance_rate,
      ROUND(
        100.0 * SUM(CASE WHEN sales_amount > 0 THEN 1 ELSE 0 END) / MAX(COUNT(*), 1), 2
      ) AS conversion_rate,
      SUM(sales_amount) AS total_sales,
      SUM(gmv_amount) AS total_gmv
    FROM creator_invitations
    WHERE invited_at >= datetime('now', '-' || ? || ' days')
  `).get(days);
}

function getWeeklyStats(weeksAgo = 0) {
  const db = getDb();
  // ISO week: Monday=start
  const offset = weeksAgo * 7;
  return db.prepare(`
    SELECT
      COUNT(*) AS total_invited,
      SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
      ROUND(
        100.0 * SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) / MAX(COUNT(*), 1), 2
      ) AS acceptance_rate,
      ROUND(
        100.0 * SUM(CASE WHEN sales_amount > 0 THEN 1 ELSE 0 END) / MAX(COUNT(*), 1), 2
      ) AS conversion_rate,
      COALESCE(SUM(sales_amount), 0) AS total_sales,
      COALESCE(SUM(gmv_amount), 0) AS total_gmv
    FROM creator_invitations
    WHERE invited_at >= datetime('now', 'weekday 1', '-' || (7 + ?) || ' days')
      AND invited_at <  datetime('now', 'weekday 1', '-' || ? || ' days')
  `).get(offset, offset);
}

function getMonthlyStats(monthsAgo = 0) {
  const db = getDb();
  return db.prepare(`
    SELECT
      COUNT(*) AS total_invited,
      SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
      ROUND(
        100.0 * SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) / MAX(COUNT(*), 1), 2
      ) AS acceptance_rate,
      ROUND(
        100.0 * SUM(CASE WHEN sales_amount > 0 THEN 1 ELSE 0 END) / MAX(COUNT(*), 1), 2
      ) AS conversion_rate,
      COALESCE(SUM(sales_amount), 0) AS total_sales,
      COALESCE(SUM(gmv_amount), 0) AS total_gmv
    FROM creator_invitations
    WHERE strftime('%Y-%m', invited_at) = strftime('%Y-%m', datetime('now', '-' || ? || ' months'))
  `).get(monthsAgo);
}

function getViolationStats(days = 7) {
  const db = getDb();
  return db.prepare(`
    SELECT
      COUNT(*) AS total_violations,
      SUM(CASE WHEN reapply_status = 'recovered' THEN 1 ELSE 0 END) AS recovered_count,
      SUM(CASE WHEN reapply_status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
      ROUND(
        AVG(
          CASE WHEN recovery_at IS NOT NULL AND reapplied_at IS NOT NULL
          THEN (julianday(recovery_at) - julianday(detected_at)) * 24 * 60
          END
        ), 1
      ) AS avg_recovery_minutes
    FROM product_violations
    WHERE detected_at >= datetime('now', '-' || ? || ' days')
  `).get(days);
}

function getViolationStatsForPeriod(startDate, endDate) {
  const db = getDb();
  return db.prepare(`
    SELECT
      COUNT(*) AS total_violations,
      SUM(CASE WHEN reapply_status = 'recovered' THEN 1 ELSE 0 END) AS recovered_count,
      ROUND(
        AVG(
          CASE WHEN recovery_at IS NOT NULL
          THEN (julianday(recovery_at) - julianday(detected_at)) * 24 * 60
          END
        ), 1
      ) AS avg_recovery_minutes
    FROM product_violations
    WHERE detected_at >= ? AND detected_at < ?
  `).get(startDate, endDate);
}

// ── Product Violation ───────────────────────────────────────────

function recordViolation(data) {
  const db = getDb();
  const existing = db.prepare(`
    SELECT id FROM product_violations
    WHERE product_id = ? AND reapply_status IN ('pending', 'submitted')
    LIMIT 1
  `).get(data.productId);

  if (existing) return existing.id;

  const result = db.prepare(`
    INSERT INTO product_violations
      (product_id, product_name, violation_type, detected_at, reapply_status)
    VALUES (?, ?, ?, datetime('now'), 'pending')
  `).run(data.productId, data.productName ?? null, data.violationType ?? null);
  return result.lastInsertRowid;
}

function updateViolationStatus(id, status, extra = {}) {
  const db = getDb();
  db.prepare(`
    UPDATE product_violations
    SET reapply_status = ?,
        reapplied_at = CASE WHEN ? = 'submitted' THEN datetime('now') ELSE reapplied_at END,
        recovery_at = CASE WHEN ? = 'recovered' THEN datetime('now') ELSE recovery_at END,
        notified = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(status, status, status, extra.notified ? 1 : 0, id);
}

function logMonitorRun(data) {
  const db = getDb();
  db.prepare(`
    INSERT INTO product_monitor_logs
      (checked_at, total_products, violated_count, reapplied_count, error_message)
    VALUES (datetime('now'), ?, ?, ?, ?)
  `).run(
    data.totalProducts ?? 0,
    data.violatedCount ?? 0,
    data.reappliedCount ?? 0,
    data.errorMessage ?? null
  );
}

function getViolationHistory(days = 7) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM product_violations
    WHERE detected_at >= datetime('now', '-' || ? || ' days')
    ORDER BY detected_at DESC
  `).all(days);
}

module.exports = {
  getDb,
  startInvitationRun,
  updateInvitationRun,
  recordInvitation,
  updateInvitationStatus,
  wasInvitedRecently,
  getInvitationStats,
  getWeeklyStats,
  getMonthlyStats,
  getViolationStats,
  getViolationStatsForPeriod,
  recordViolation,
  updateViolationStatus,
  logMonitorRun,
  getViolationHistory,
};
