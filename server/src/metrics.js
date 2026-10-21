// Response cache, rate limits, pricing and health metrics.
import crypto from "node:crypto";
import { db, nowIso } from "./db.js";

/* ------------------------------------------------------------------ */
/* response cache                                                      */
/* ------------------------------------------------------------------ */

const DEFAULT_TTL_MS = 5 * 60_000;

function cacheKey(provider, model, body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const normalized = JSON.stringify({
    m: model,
    s: messages.map((x) => [x.role, x.content]),
    t: body?.tools ? 1 : 0,
  });
  return crypto.createHash("sha256").update(`${provider}:${normalized}`).digest("hex");
}

export function cacheGet(provider, model, body) {
  const key = cacheKey(provider, model, body);
  const row = db.prepare("SELECT * FROM cache_entries WHERE key = ?").get(key);
  if (!row) return null;
  if (row.expiresAt && row.expiresAt <= nowIso()) {
    db.prepare("DELETE FROM cache_entries WHERE key = ?").run(key);
    return null;
  }
  db.prepare("UPDATE cache_entries SET hits = hits + 1, lastHitAt = ? WHERE key = ?").run(nowIso(), key);
  try {
    return { ...JSON.parse(row.payload), _cached: true };
  } catch {
    return null;
  }
}

export function cacheSet(provider, model, body, payload, ttlMs = DEFAULT_TTL_MS) {
  try {
    const key = cacheKey(provider, model, body);
    db.prepare(
      "INSERT INTO cache_entries (key, provider, model, payload, hits, createdAt, expiresAt, lastHitAt) VALUES (?, ?, ?, ?, 0, ?, ?, NULL) ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, createdAt = excluded.createdAt, expiresAt = excluded.expiresAt"
    ).run(key, provider, model, JSON.stringify(payload), nowIso(), new Date(Date.now() + ttlMs).toISOString());
  } catch {}
}

export function cacheStats() {
  const rows = db.prepare("SELECT provider, COUNT(*) AS entries, SUM(hits) AS hits FROM cache_entries GROUP BY provider").all();
  const totals = db.prepare("SELECT COUNT(*) AS entries, COALESCE(SUM(hits),0) AS hits FROM cache_entries").get();
  return { totals, byProvider: rows };
}

export function cacheClear() {
  return db.prepare("DELETE FROM cache_entries").run().changes;
}

/* ------------------------------------------------------------------ */
/* rate limits                                                         */
/* ------------------------------------------------------------------ */

export function checkRateLimit(apiKeyId, { rpm = 60, tpm = 0 } = {}) {
  if (!apiKeyId) return { allowed: true };
  const row = db.prepare("SELECT * FROM rate_limits WHERE key = ?").get(apiKeyId);
  if (!row) return { allowed: true };
  const now = Date.now();
  const windowStart = new Date(now - 60_000).toISOString();
  const calls = db.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE apiKeyId = ? AND ts >= ?").get(apiKeyId, windowStart).n;
  if (row.rpm > 0 && calls >= row.rpm) {
    return { allowed: false, reason: "rate limit reached", retryAfter: 60, calls, limit: row.rpm };
  }
  if (row.tpm > 0) {
    const tokens = db.prepare("SELECT COALESCE(SUM(promptTokens + outputTokens),0) AS n FROM usage_events WHERE apiKeyId = ? AND ts >= ?").get(apiKeyId, windowStart).n;
    if (tokens >= row.tpm) return { allowed: false, reason: "token limit reached", retryAfter: 60, tokens, limit: row.tpm };
  }
  return { allowed: true, calls };
}

export function setRateLimit(apiKeyId, { rpm = 0, tpm = 0 } = {}) {
  db.prepare("INSERT INTO rate_limits (key, rpm, tpm, updatedAt) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET rpm = excluded.rpm, tpm = excluded.tpm, updatedAt = excluded.updatedAt").run(
    apiKeyId,
    Number(rpm) || 0,
    Number(tpm) || 0,
    nowIso()
  );
  return { apiKeyId, rpm: Number(rpm) || 0, tpm: Number(tpm) || 0 };
}

export function listRateLimits() {
  return db.prepare("SELECT * FROM rate_limits ORDER BY updatedAt DESC").all();
}

/* ------------------------------------------------------------------ */
/* pricing                                                             */
/* ------------------------------------------------------------------ */

export function setPrice({ provider, model = "*", inputPerMillion = 0, outputPerMillion = 0 }) {
  db.prepare("INSERT INTO pricing (provider, model, inputPerMillion, outputPerMillion, updatedAt) VALUES (?, ?, ?, ?, ?) ON CONFLICT(provider, model) DO UPDATE SET inputPerMillion = excluded.inputPerMillion, outputPerMillion = excluded.outputPerMillion, updatedAt = excluded.updatedAt").run(
    provider,
    model,
    Number(inputPerMillion) || 0,
    Number(outputPerMillion) || 0,
    nowIso()
  );
  return { provider, model };
}

export function listPrices() {
  return db.prepare("SELECT * FROM pricing ORDER BY provider, model").all();
}

export function costOf(provider, model, promptTokens = 0, outputTokens = 0) {
  const exact = db.prepare("SELECT * FROM pricing WHERE provider = ? AND model = ?").get(provider, model);
  const row = exact || db.prepare("SELECT * FROM pricing WHERE provider = ? AND model = '*'").get(provider);
  if (!row) return 0;
  const input = (Number(promptTokens) / 1_000_000) * Number(row.inputPerMillion);
  const output = (Number(outputTokens) / 1_000_000) * Number(row.outputPerMillion);
  return Number((input + output).toFixed(6));
}

/* ------------------------------------------------------------------ */
/* health metrics                                                      */
/* ------------------------------------------------------------------ */

export function healthSnapshot() {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const calls = db.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE ts >= ?").get(since).n;
  const errors = db.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE ts >= ? AND status >= 400").get(since).n;
  const latencies = db.prepare("SELECT durationMs FROM request_log WHERE status < 400 AND durationMs IS NOT NULL ORDER BY id DESC LIMIT 500").all().map((r) => r.durationMs);
  latencies.sort((a, b) => a - b);
  const pct = (p) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor((latencies.length - 1) * p))] : 0);
  const providers = db.prepare(
    "SELECT provider, COUNT(*) AS calls, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors, COALESCE(SUM(promptTokens),0) AS promptTokens, COALESCE(SUM(outputTokens),0) AS outputTokens FROM usage_events WHERE ts >= ? GROUP BY provider ORDER BY calls DESC"
  ).all(since);
  for (const p of providers) {
    p.cost = providers.reduce((a, x) => a + 0, 0);
    const exact = db.prepare("SELECT * FROM pricing WHERE provider = ? AND model = '*'").get(p.provider);
    if (exact) {
      p.cost = Number(((p.promptTokens / 1e6) * Number(exact.inputPerMillion) + (p.outputTokens / 1e6) * Number(exact.outputPerMillion)).toFixed(4));
    }
  }
  return {
    calls,
    errors,
    errorRate: calls ? Number((errors / calls).toFixed(4)) : 0,
    latency: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99) },
    providers,
    uptime: calls ? Number((1 - errors / calls).toFixed(4)) : 1,
  };
}

/* ------------------------------------------------------------------ */
/* timeline and export                                                 */
/* ------------------------------------------------------------------ */

export function usageTimeline(days = 7) {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const rows = db
    .prepare("SELECT substr(ts, 1, 10) AS day, COUNT(*) AS calls, SUM(promptTokens) AS promptTokens, SUM(outputTokens) AS outputTokens, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors FROM usage_events WHERE ts >= ? GROUP BY day ORDER BY day")
    .all(since);
  const byKey = db
    .prepare("SELECT apiKeyId, COUNT(*) AS calls, SUM(promptTokens + outputTokens) AS tokens FROM usage_events WHERE ts >= ? GROUP BY apiKeyId ORDER BY calls DESC LIMIT 20")
    .all(since);
  const byModel = db
    .prepare("SELECT provider, model, COUNT(*) AS calls, SUM(promptTokens + outputTokens) AS tokens FROM usage_events WHERE ts >= ? GROUP BY provider, model ORDER BY calls DESC LIMIT 20")
    .all(since);
  return { days, timeline: rows, byKey, byModel };
}

export function usageCsv(days = 30) {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const rows = db
    .prepare("SELECT ts, provider, model, apiKeyId, status, promptTokens, outputTokens, error FROM usage_events WHERE ts >= ? ORDER BY id DESC")
    .all(since);
  const head = "ts,provider,model,apiKeyId,status,promptTokens,outputTokens,error";
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const body = rows.map((r) => [r.ts, r.provider, r.model, r.apiKeyId, r.status, r.promptTokens, r.outputTokens, r.error].map(esc).join(","));
  return [head, ...body].join("\n");
}
