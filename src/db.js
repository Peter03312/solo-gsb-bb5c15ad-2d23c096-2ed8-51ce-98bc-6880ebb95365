// SQLite 数据访问层。
// 所有“多记录集合”的写入都在单个事务内整体替换：
// 任何校验错误都会 ROLLBACK，不会留下部分数据。

import Database from 'better-sqlite3';
import { computeHash } from './solver.js';

export function openDb(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  hole_count INTEGER NOT NULL,
  tolerance REAL NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS hole_max (
  hole INTEGER PRIMARY KEY,
  max_mass REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS tubes (
  id TEXT PRIMARY KEY,
  mass REAL NOT NULL,
  ord INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tube_holes (
  tube_id TEXT NOT NULL REFERENCES tubes(id) ON DELETE CASCADE,
  hole INTEGER NOT NULL,
  PRIMARY KEY (tube_id, hole)
);

CREATE TABLE IF NOT EXISTS weights (
  mass REAL PRIMARY KEY,
  quantity INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  basis_hash TEXT NOT NULL,
  feasible INTEGER NOT NULL,
  reasons TEXT,
  result_json TEXT NOT NULL,
  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  basis_hash TEXT NOT NULL,
  feasible INTEGER NOT NULL,
  weight_count INTEGER,
  diff_sum REAL,
  config_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  reasons TEXT
);

-- 现场装载核验：一条发布记录至多一份（草稿或完成），UNIQUE 约束兜底。
-- version 为乐观锁：每次暂存自增，更新须携带旧版本以防覆盖他人修改。
-- 完成后 completed_at 置位、result_json 冻结，之后草稿与完成结果均不可改写。
CREATE TABLE IF NOT EXISTS verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  publication_id INTEGER NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  entries_json TEXT NOT NULL,
  completed_at TEXT,
  result_json TEXT,
  checks_json TEXT,
  diff_sum REAL,
  mass_sum REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (publication_id) REFERENCES publications(id)
);
`;

// ---------- 读取 ----------

export function loadData(db) {
  const cfg = db.prepare('SELECT hole_count, tolerance FROM config WHERE id = 1').get();
  if (!cfg) return null;
  const N = cfg.hole_count;
  const hmRows = db.prepare('SELECT hole, max_mass FROM hole_max').all();
  const holeMaxMass = new Array(N).fill(null);
  for (const r of hmRows) {
    if (r.hole >= 0 && r.hole < N) holeMaxMass[r.hole] = r.max_mass;
  }
  const tubes = db
    .prepare('SELECT id, mass, ord FROM tubes ORDER BY ord, rowid')
    .all()
    .map((t) => ({
      id: t.id,
      mass: t.mass,
      usableHoles: db
        .prepare('SELECT hole FROM tube_holes WHERE tube_id = ? ORDER BY hole')
        .pluck()
        .all(t.id),
    }));
  const weights = db
    .prepare('SELECT mass, quantity FROM weights ORDER BY mass')
    .all()
    .map((w) => ({ mass: w.mass, quantity: w.quantity }));
  return {
    holes: N,
    tolerance: cfg.tolerance,
    holeMaxMass,
    tubes,
    weights,
  };
}

export function currentHash(db) {
  const data = loadData(db);
  return data ? computeHash(data) : null;
}

export function getDraft(db) {
  const row = db.prepare('SELECT * FROM drafts WHERE id = 1').get();
  if (!row) return null;
  return {
    basisHash: row.basis_hash,
    feasible: !!row.feasible,
    reasons: row.reasons ? JSON.parse(row.reasons) : [],
    result: JSON.parse(row.result_json),
    computedAt: row.computed_at,
    stale: false, // 由调用方结合当前哈希填写
  };
}

export function listPublications(db) {
  return db
    .prepare(
      `SELECT id, created_at, basis_hash, feasible, weight_count, diff_sum, reasons
       FROM publications ORDER BY id DESC`,
    )
    .all()
    .map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      basisHash: r.basis_hash,
      feasible: !!r.feasible,
      weightCount: r.weight_count,
      diffSum: r.diff_sum,
      reasons: r.reasons ? JSON.parse(r.reasons) : [],
    }));
}

export function getPublication(db, id) {
  const row = db.prepare('SELECT * FROM publications WHERE id = ?').get(id);
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.created_at,
    basisHash: row.basis_hash,
    feasible: !!row.feasible,
    weightCount: row.weight_count,
    diffSum: row.diff_sum,
    reasons: row.reasons ? JSON.parse(row.reasons) : [],
    config: JSON.parse(row.config_json),
    result: JSON.parse(row.result_json),
  };
}

// ---------- 草稿 ----------

export function saveDraft(db, { basisHash, feasible, reasons, result }) {
  db.prepare(
    `INSERT INTO drafts (id, basis_hash, feasible, reasons, result_json)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       basis_hash = excluded.basis_hash,
       feasible = excluded.feasible,
       reasons = excluded.reasons,
       result_json = excluded.result_json,
       computed_at = datetime('now')`,
  ).run(basisHash, feasible ? 1 : 0, JSON.stringify(reasons ?? []), JSON.stringify(result));
}

// ---------- 发布（由 server 在单事务内调用） ----------

export function insertPublication(
  db,
  { basisHash, feasible, weightCount, diffSum, config, result, reasons },
) {
  const info = db
    .prepare(
      `INSERT INTO publications
         (basis_hash, feasible, weight_count, diff_sum, config_json, result_json, reasons)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      basisHash,
      feasible ? 1 : 0,
      weightCount ?? null,
      diffSum ?? null,
      JSON.stringify(config),
      JSON.stringify(result),
      JSON.stringify(reasons ?? []),
    );
  return info.lastInsertRowid;
}

// ---------- 现场核验 ----------

export function getVerificationRow(db, id) {
  return db.prepare('SELECT * FROM verifications WHERE id = ?').get(id);
}

export function getVerificationRowByPublication(db, publicationId) {
  return db
    .prepare('SELECT * FROM verifications WHERE publication_id = ?')
    .get(publicationId);
}

export function createVerification(db, publicationId, entries) {
  const info = db
    .prepare(
      `INSERT INTO verifications (publication_id, version, entries_json)
       VALUES (?, 1, ?)`,
    )
    .run(publicationId, JSON.stringify(entries));
  return getVerificationRow(db, info.lastInsertRowid);
}

// 乐观锁更新：仅当草稿未完成且 version 匹配时写入；返回 null 表示未命中。
export function updateVerificationEntries(db, id, expectedVersion, entries) {
  const info = db
    .prepare(
      `UPDATE verifications
         SET entries_json = ?, version = version + 1, updated_at = datetime('now')
       WHERE id = ? AND version = ? AND completed_at IS NULL`,
    )
    .run(JSON.stringify(entries), id, expectedVersion);
  return info.changes === 1 ? getVerificationRow(db, id) : null;
}

// 完成：冻结判定结果（同一事务内由 server 重读快照并判定后调用）。
export function completeVerification(db, id, { checks, diffSum, massSum }) {
  const info = db
    .prepare(
      `UPDATE verifications
         SET completed_at = datetime('now'),
             result_json = entries_json,
             checks_json = ?,
             diff_sum = ?,
             mass_sum = ?,
             updated_at = datetime('now')
       WHERE id = ? AND completed_at IS NULL`,
    )
    .run(JSON.stringify(checks), diffSum, massSum, id);
  return info.changes === 1 ? getVerificationRow(db, id) : null;
}

// 核验列表（连发布表取冻结依据与发布编号）
export function listVerificationRows(db) {
  return db
    .prepare(
      `SELECT v.*, p.basis_hash AS pub_basis_hash, p.feasible AS pub_feasible
         FROM verifications v
         JOIN publications p ON p.id = v.publication_id
        ORDER BY v.id DESC`,
    )
    .all();
}
