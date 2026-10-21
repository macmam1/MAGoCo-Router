// MAGoCo Router - database layer (SQLite).
//
// The ModelScope studio keeps DATA_DIR on an object-storage FUSE mount, so the
// DB is opened with WAL disabled (journal_mode=DELETE) and the WAL is truncated
// on every start. On that mount a large WAL forces every lookup to re-scan it,
// which turned simple reads into multi-second queries.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const DB_DIR = path.join(DATA_DIR, "db");
const DB_FILE = path.join(DB_DIR, "data.sqlite");

fs.mkdirSync(DB_DIR, { recursive: true });

export const db = new Database(DB_FILE);
db.pragma("journal_mode = DELETE");
db.pragma("synchronous = NORMAL");
db.pragma("busy_timeout = 10000");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL DEFAULT '',
  machineId   TEXT,
  isActive    INTEGER NOT NULL DEFAULT 1,
  createdAt   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_connections (
  id                    TEXT PRIMARY KEY,
  provider              TEXT NOT NULL,
  name                  TEXT NOT NULL DEFAULT '',
  email                 TEXT,
  priority              INTEGER NOT NULL DEFAULT 0,
  isActive              INTEGER NOT NULL DEFAULT 1,
  data                  TEXT NOT NULL DEFAULT '{}',
  createdAt             TEXT NOT NULL,
  updatedAt             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_provider ON provider_connections(provider);

CREATE TABLE IF NOT EXISTS combos (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  members     TEXT NOT NULL DEFAULT '[]',
  isActive    INTEGER NOT NULL DEFAULT 1,
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL,
  provider      TEXT,
  model         TEXT,
  apiKeyId      TEXT,
  status        INTEGER,
  promptTokens  INTEGER NOT NULL DEFAULT 0,
  outputTokens  INTEGER NOT NULL DEFAULT 0,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events(ts);

CREATE TABLE IF NOT EXISTS request_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  method      TEXT,
  path        TEXT,
  model       TEXT,
  provider    TEXT,
  status      INTEGER,
  durationMs  INTEGER,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_log_ts ON request_log(ts);

CREATE TABLE IF NOT EXISTS key_pool (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,
  sealedKey     TEXT NOT NULL,
  keyHash       TEXT,
  source        TEXT,
  label         TEXT,
  status        TEXT NOT NULL DEFAULT "unknown",
  statusText    TEXT,
  checkedAt     TEXT,
  lastUsedAt    TEXT,
  uses          INTEGER NOT NULL DEFAULT 0,
  failures      INTEGER NOT NULL DEFAULT 0,
  cooldownUntil TEXT,
  meta          TEXT,
  createdAt     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_keypool_sealed ON key_pool(provider, sealedKey);

CREATE TABLE IF NOT EXISTS circuit_state (
  key       TEXT PRIMARY KEY,
  state     TEXT NOT NULL DEFAULT "closed",
  failures  INTEGER NOT NULL DEFAULT 0,
  openedAt  TEXT,
  until     TEXT,
  lastError TEXT
);

CREATE TABLE IF NOT EXISTS model_lockout (
  model    TEXT PRIMARY KEY,
  until    TEXT,
  reason   TEXT,
  createdAt TEXT
);

CREATE TABLE IF NOT EXISTS cache_entries (
  key       TEXT PRIMARY KEY,
  provider  TEXT,
  model     TEXT,
  payload   TEXT NOT NULL,
  hits      INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT,
  expiresAt TEXT,
  lastHitAt TEXT
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key       TEXT PRIMARY KEY,
  rpm       INTEGER NOT NULL DEFAULT 0,
  tpm       INTEGER NOT NULL DEFAULT 0,
  updatedAt TEXT
);

CREATE TABLE IF NOT EXISTS pricing (
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL DEFAULT "*",
  inputPerMillion   REAL NOT NULL DEFAULT 0,
  outputPerMillion  REAL NOT NULL DEFAULT 0,
  updatedAt         TEXT,
  PRIMARY KEY (provider, model)
);

CREATE TABLE IF NOT EXISTS sessions (
  id        TEXT PRIMARY KEY,
  model     TEXT,
  provider  TEXT,
  turns     TEXT,
  updatedAt TEXT
);

CREATE TABLE IF NOT EXISTS backups (
  id        TEXT PRIMARY KEY,
  label     TEXT,
  file      TEXT,
  size      INTEGER,
  createdAt TEXT
);

CREATE TABLE IF NOT EXISTS counters (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS model_aliases (
  name    TEXT PRIMARY KEY,
  target  TEXT NOT NULL,
  createdAt TEXT
);

CREATE TABLE IF NOT EXISTS key_pool_sources (
  id         TEXT PRIMARY KEY,
  url        TEXT NOT NULL UNIQUE,
  provider   TEXT,
  label      TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,
  lastSyncAt TEXT,
  addedAt    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  data  TEXT NOT NULL
);
`);

export const nowIso = () => new Date().toISOString();

// Older databases were created before a column existed: add it in place.
export function ensureColumn(table, column, definition) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
    }
  } catch {}
}

ensureColumn("combos", "description", "TEXT");
ensureColumn("combos", "strategy", "TEXT DEFAULT 'priority'");

export function getSettings() {
  const row = db.prepare("SELECT data FROM settings WHERE id = 1").get();
  if (!row) {
    const data = JSON.stringify({});
    db.prepare("INSERT INTO settings (id, data) VALUES (1, ?)").run(data);
    return {};
  }
  try {
    return JSON.parse(row.data);
  } catch {
    return {};
  }
}

export function updateSettings(patch) {
  const current = getSettings();
  const next = { ...current, ...patch };
  db.prepare("INSERT INTO settings (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(JSON.stringify(next));
  return next;
}
