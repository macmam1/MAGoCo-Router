// Backups: a consistent snapshot of the whole database, and a restore that
// does not need a restart.
import fs from "node:fs";
import path from "node:path";
import { db, nowIso } from "./db.js";

function dataDir() {
  return process.env.DATA_DIR || path.join(process.cwd(), "data");
}

export function backupDir() {
  const dir = path.join(dataDir(), "backups");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function databaseFile() {
  const dir = dataDir();
  for (const name of ["db/data.sqlite", "data.sqlite", "router.db"]) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return path.join(dir, "db", "data.sqlite");
}

export function createBackup({ label = "" } = {}) {
  const stamp = nowIso().replace(/[:.]/g, "-");
  const id = `backup-${stamp}`;
  const file = path.join(backupDir(), `${id}.sqlite`);
  // VACUUM INTO writes a consistent copy even while the database is in use.
  db.prepare("VACUUM INTO ?").run(file);
  const size = fs.statSync(file).size;
  db.prepare(
    "INSERT INTO backups (id, label, file, size, createdAt) VALUES (?, ?, ?, ?, ?)"
  ).run(id, label, file, size, nowIso());
  return { id, label, file, size, createdAt: nowIso() };
}

export function listBackups() {
  return db.prepare("SELECT id, label, size, createdAt FROM backups ORDER BY createdAt DESC").all();
}

export function backupPath(id) {
  const row = db.prepare("SELECT * FROM backups WHERE id = ?").get(id);
  if (!row) return null;
  if (!fs.existsSync(row.file)) return null;
  return row.file;
}

export function deleteBackup(id) {
  const row = db.prepare("SELECT * FROM backups WHERE id = ?").get(id);
  if (!row) return false;
  try {
    if (fs.existsSync(row.file)) fs.unlinkSync(row.file);
  } catch {}
  return db.prepare("DELETE FROM backups WHERE id = ?").run(id).changes > 0;
}

// Restore: copy the snapshot over the live tables, so the running process
// keeps working and no restart is needed.
export function restoreBackup(id) {
  const file = backupPath(id);
  if (!file) return { error: "backup not found" };
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);
  const source = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  void source;
  const attached = `restore_${Date.now()}`;
  try {
    db.prepare(`ATTACH DATABASE ? AS ${attached}`).run(file);
    for (const table of tables) {
      const columns = db.prepare(`PRAGMA ${attached}.table_info(${table})`).all().map((c) => c.name);
      if (!columns.length) continue;
      const liveColumns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      const shared = columns.filter((c) => liveColumns.includes(c));
      if (!shared.length) continue;
      const list = shared.join(", ");
      db.prepare(`DELETE FROM ${table}`).run();
      db.prepare(`INSERT INTO ${table} (${list}) SELECT ${list} FROM ${attached}.${table}`).run();
    }
    return { restored: true, tables: tables.length };
  } catch (err) {
    return { error: String(err.message || err) };
  } finally {
    try {
      db.prepare(`DETACH DATABASE ${attached}`).run();
    } catch {}
  }
}

export function scheduleBackups(intervalMs = 6 * 3600_000) {
  try {
    createBackup({ label: "scheduled" });
  } catch {}
  const timer = setInterval(() => {
    try {
      createBackup({ label: "scheduled" });
    } catch {}
  }, intervalMs);
  timer.unref?.();
  return timer;
}
