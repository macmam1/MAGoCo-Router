// Key pool - a rotating set of credentials for one provider.
//
// The pool answers three questions the router needs on every request:
//   * which key should I try next        -> pickKey()
//   * is this key still good              -> report()
//   * what provider does this key belong to -> identify()
//
// Keys are stored sealed (AES-256-GCM) and never leave the database in
// plaintext, not even in the dashboard API.
import crypto from "node:crypto";
import { db, nowIso, getSettings, updateSettings } from "./db.js";

/* ------------------------------------------------------------------ */
/* sealing                                                             */
/* ------------------------------------------------------------------ */

function poolKeyMaterial() {
  const secret = process.env.JWT_SECRET || getSettings().__poolSecret || "magoco-router-key-pool";
  return crypto.createHash("sha256").update(String(secret)).digest();
}

export function seal(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", poolKeyMaterial(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${enc.toString("base64url")}`;
}

// A deterministic fingerprint of a key, so the pool can find a row again
// even though the stored ciphertext changes every time it is sealed.
export function keyHash(provider, key) {
  return crypto.createHash("sha256").update(`${provider}:${String(key || "").trim()}`).digest("hex");
}

export function open(sealed) {
  if (!sealed) return "";
  if (!String(sealed).startsWith("v1.")) return String(sealed);
  try {
    const [, iv, tag, data] = String(sealed).split(".");
    const decipher = crypto.createDecipheriv("aes-256-gcm", poolKeyMaterial(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ */
/* provider fingerprints                                                */
/* ------------------------------------------------------------------ */

// A key format alone rarely identifies the provider - "sk-..." is used by half
// the industry - so the fingerprint only produces candidates and the probe
// below decides.
export const FINGERPRINTS = [
  { id: "anthropic", re: /^sk-ant-[A-Za-z0-9_-]{20,}$/, baseUrl: "https://api.anthropic.com", modelsPath: "/v1/models", header: "x-api-key", prefix: "", chatPath: "/v1/messages" },
  { id: "openrouter", re: /^sk-or-v1-[A-Za-z0-9]{64}$/, baseUrl: "https://openrouter.ai/api/v1", modelsPath: "/models", header: "authorization", prefix: "Bearer ", chatPath: "/chat/completions" },
  { id: "groq", re: /^gsk_[A-Za-z0-9]{40,}$/, baseUrl: "https://api.groq.com/openai/v1", modelsPath: "/models", header: "authorization", prefix: "Bearer ", chatPath: "/chat/completions" },
  { id: "cerebras", re: /^csk-[A-Za-z0-9_-]{20,}$/, baseUrl: "https://api.cerebras.ai/v1", modelsPath: "/models", header: "authorization", prefix: "Bearer ", chatPath: "/chat/completions" },
  { id: "nvidia", re: /^nvapi-[A-Za-z0-9_-]{20,}$/, baseUrl: "https://integrate.api.nvidia.com/v1", modelsPath: "/models", header: "authorization", prefix: "Bearer ", chatPath: "/chat/completions" },
  { id: "huggingface", re: /^hf_[A-Za-z0-9]{30,}$/, baseUrl: "https://router.huggingface.co/v1", modelsPath: "/models", header: "authorization", prefix: "Bearer ", chatPath: "/chat/completions" },
  { id: "google", re: /^AIza[0-9A-Za-z_-]{35}$/, baseUrl: "https://generativelanguage.googleapis.com/v1beta", modelsPath: "/models", header: "x-goog-api-key", prefix: "", chatPath: "/openai/chat/completions" },
  { id: "modelscope", re: /^ms-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, baseUrl: "https://api-inference.modelscope.cn/v1", modelsPath: "/models", header: "authorization", prefix: "Bearer ", chatPath: "/chat/completions" },
  { id: "cohere", re: /^co_[A-Za-z0-9]{40,}$/, baseUrl: "https://api.cohere.com/v2", modelsPath: "/models", header: "authorization", prefix: "Bearer ", chatPath: "/chat" },
  { id: "xai", re: /^xai-[A-Za-z0-9]{60,}$/, baseUrl: "https://api.x.ai/v1", modelsPath: "/models", header: "authorization", prefix: "Bearer ", chatPath: "/chat/completions" },
  { id: "deepseek", re: /^sk-[a-f0-9]{32}$/, baseUrl: "https://api.deepseek.com/v1", modelsPath: "/models", header: "authorization", prefix: "Bearer ", chatPath: "/chat/completions" },
  { id: "siliconflow", re: /^sk-[A-Za-z0-9]{20,}$/, baseUrl: "https://api.siliconflow.cn/v1", modelsPath: "/models", header: "authorization", prefix: "Bearer ", chatPath: "/chat/completions" },
  { id: "openai", re: /^sk-(proj-)?[A-Za-z0-9_-]{32,}$/, baseUrl: "https://api.openai.com/v1", modelsPath: "/models", header: "authorization", prefix: "Bearer ", chatPath: "/chat/completions" },
  { id: "llm7", re: /^llm7-[A-Za-z0-9]{32,}$/, baseUrl: "https://api.llm7.io/v1", modelsPath: "/models", header: "authorization", prefix: "Bearer ", chatPath: "/chat/completions" },
  { id: "zhipu", re: /^[a-f0-9]{32}\.[a-f0-9]{32}$/i, baseUrl: "https://open.bigmodel.cn/api/paas/v4", modelsPath: "/models", header: "authorization", prefix: "Bearer ", chatPath: "/chat/completions" },
  { id: "sambanova", re: /^[A-Za-z0-9]{48}$/, baseUrl: "https://api.sambanova.ai/v1", modelsPath: "/models", header: "authorization", prefix: "Bearer ", chatPath: "/chat/completions" },
  { id: "mistral", re: /^[A-Za-z0-9]{32}$/, baseUrl: "https://api.mistral.ai/v1", modelsPath: "/models", header: "authorization", prefix: "Bearer ", chatPath: "/chat/completions" },
];

const GENERIC_KEY_RE = /\b(?:sk-|gsk_|csk-|nvapi-|hf_|co_|xai-|llm7-|ms-)[A-Za-z0-9_-]{16,}\b|\bAIza[0-9A-Za-z_-]{35}\b/gi;

export function guessProvider(key) {
  const k = String(key || "").trim();
  for (const fp of FINGERPRINTS) {
    if (fp.re.test(k)) return fp.id;
  }
  return "";
}

export function fingerprint(id) {
  return FINGERPRINTS.find((f) => f.id === id) || null;
}

/* ------------------------------------------------------------------ */
/* probing                                                             */
/* ------------------------------------------------------------------ */

export async function probeKey(providerId, key, timeoutMs = 12000, { confirm = true } = {}) {
  const fp = fingerprint(providerId);
  if (!fp) return { ok: false, status: 0, kind: "unknown", detail: "unknown provider" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let catalogue = [];
  let first;
  try {
    const res = await fetch(`${fp.baseUrl}${fp.modelsPath}`, {
      method: "GET",
      headers: { [fp.header]: `${fp.prefix}${key}`, accept: "application/json" },
      signal: controller.signal,
    });
    const text = await res.text().catch(() => "");
    if (res.status === 200) {
      first = { ok: true, status: 200, kind: "working", detail: "accepted" };
      try {
        const parsed = JSON.parse(text);
        catalogue = (parsed?.data || parsed?.models || []).map((m) => m?.id || m?.name).filter(Boolean);
      } catch {}
    } else if (res.status === 401) return { ok: false, status: 401, kind: "invalid", detail: "key rejected" };
    else if (res.status === 403) return { ok: true, status: 403, kind: "restricted", detail: "accepted but restricted" };
    else if (res.status === 429) return { ok: true, status: 429, kind: "throttled", detail: "rate limited" };
    else if (res.status === 402) return { ok: true, status: 402, kind: "exhausted", detail: "out of credit" };
    else if (res.status === 404) return { ok: false, status: 404, kind: "wrong_provider", detail: "endpoint does not know this provider" };
    else return { ok: false, status: res.status, kind: "unknown", detail: text.slice(0, 120) };
  } catch (err) {
    return { ok: false, status: 0, kind: "unreachable", detail: String(err.message || err).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }

  // A catalogue endpoint can be public, so it cannot prove the key works.
  // One token of real inference is the only honest confirmation.
  if (confirm && first.ok && catalogue.length) {
    const chat = await chatProbe(fp, key, catalogue[0]);
    if (chat.kind === "invalid" || chat.kind === "exhausted" || chat.kind === "restricted" || chat.kind === "throttled") {
      return { ...chat, catalogue: catalogue.length };
    }
    first.detail = chat.detail || "accepted";
    first.catalogue = catalogue.length;
  }
  return first;
}

async function chatProbe(fp, key, model) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(`${fp.baseUrl}${fp.chatPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", [fp.header]: `${fp.prefix}${key}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: false }),
      signal: controller.signal,
    });
    const text = await res.text().catch(() => "");
    if (res.status === 200) return { ok: true, status: 200, kind: "working", detail: "inference accepted" };
    if (res.status === 401) return { ok: false, status: 401, kind: "invalid", detail: "key rejected on inference" };
    if (res.status === 402) return { ok: true, status: 402, kind: "exhausted", detail: "out of credit" };
    if (res.status === 403) return { ok: true, status: 403, kind: "restricted", detail: "inference restricted" };
    if (res.status === 429) return { ok: true, status: 429, kind: "throttled", detail: "rate limited" };
    // the model may be the problem, not the key - keep the key as usable
    return { ok: true, status: res.status, kind: "working", detail: `inference answered ${res.status}`, inconclusive: true };
  } catch (err) {
    return { ok: true, status: 0, kind: "working", detail: "catalogue only", inconclusive: true };
  } finally {
    clearTimeout(timer);
  }
}

// Try every plausible provider until one accepts the key.
export async function identifyProvider(key, preferred) {
  const guess = preferred || guessProvider(key);
  const candidates = [];
  if (guess) candidates.push(guess);
  for (const fp of FINGERPRINTS) if (fp.id !== guess) candidates.push(fp.id);

  let firstInvalid = null;
  for (const id of candidates) {
    const res = await probeKey(id, key);
    if (res.kind === "wrong_provider" || res.kind === "unreachable") continue;
    if (res.ok) return { provider: id, ...res, confident: id === guess || res.status !== 401 };
    if (!firstInvalid) firstInvalid = { provider: id, ...res };
    // 401 on a guessed provider is still a useful signal: the endpoint exists
    if (res.status === 401 && id === guess) break;
  }
  if (firstInvalid) return { ...firstInvalid, confident: false };
  return { provider: guess || "unknown", ok: false, status: 0, kind: "unidentified", detail: "no provider accepted this key", confident: false };
}

/* ------------------------------------------------------------------ */
/* pool storage                                                        */
/* ------------------------------------------------------------------ */

function ensurePoolSecret() {
  const s = getSettings();
  if (!s.__poolSecret) {
    updateSettings({ __poolSecret: crypto.randomBytes(24).toString("hex") });
  }
}

function rowToEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    key: open(row.sealedKey),
    source: row.source || "",
    label: row.label || "",
    status: row.status,
    statusText: row.statusText || "",
    checkedAt: row.checkedAt || null,
    lastUsedAt: row.lastUsedAt || null,
    uses: row.uses || 0,
    failures: row.failures || 0,
    cooldownUntil: row.cooldownUntil || null,
    meta: row.meta ? JSON.parse(row.meta) : {},
  };
}

export function addKey({ provider, key, source = "", label = "", status = "unknown", statusText = "", meta = null }) {
  ensurePoolSecret();
  const clean = String(key || "").trim();
  if (!clean) return { added: false, reason: "empty key" };
  const id = crypto.randomUUID();
  const existing = db
    .prepare("SELECT id FROM key_pool WHERE provider = ? AND keyHash = ?")
    .get(provider, keyHash(provider, clean));
  if (existing) return { added: false, reason: "duplicate", id: existing.id };
  db.prepare(
    "INSERT INTO key_pool (id, provider, sealedKey, keyHash, source, label, status, statusText, checkedAt, uses, failures, meta, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)"
  ).run(id, provider, seal(clean), keyHash(provider, clean), source, label, status, statusText, nowIso(), JSON.stringify(meta || {}), nowIso());
  return { added: true, id, provider };
}

export function removeKey(id) {
  return db.prepare("DELETE FROM key_pool WHERE id = ?").run(id).changes > 0;
}

export function listPool(provider = "") {
  const rows = provider
    ? db.prepare("SELECT * FROM key_pool WHERE provider = ? ORDER BY provider, createdAt").all(provider)
    : db.prepare("SELECT * FROM key_pool ORDER BY provider, createdAt").all();
  return rows.map(rowToEntry);
}

export function poolStats() {
  const rows = db.prepare("SELECT provider, status, COUNT(*) AS n FROM key_pool GROUP BY provider, status").all();
  const out = {};
  for (const r of rows) {
    out[r.provider] = out[r.provider] || { total: 0 };
    out[r.provider].total += r.n;
    out[r.provider][r.status] = (out[r.provider][r.status] || 0) + r.n;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* rotation                                                            */
/* ------------------------------------------------------------------ */

function isUsable(row) {
  if (row.status === "dead") return false;
  if (row.cooldownUntil && row.cooldownUntil > nowIso()) return false;
  return true;
}

// Fair rotation: the least recently used usable key wins, so no single key
// burns the whole quota.
export function pickKey(provider, limit = 3) {
  const rows = db
    .prepare("SELECT * FROM key_pool WHERE provider = ? AND status != 'dead'")
    .all(provider);
  const usable = rows.filter(isUsable);
  usable.sort((a, b) => {
    const au = a.lastUsedAt || "";
    const bu = b.lastUsedAt || "";
    if (au !== bu) return au < bu ? -1 : 1;
    return (a.uses || 0) - (b.uses || 0);
  });
  return usable.slice(0, limit).map(rowToEntry);
}

export function reportKey(provider, key, { status, retryAfter, error } = {}) {
  if (!provider || !key) return;
  const row = db.prepare("SELECT * FROM key_pool WHERE provider = ? AND keyHash = ?").get(provider, keyHash(provider, key));
  if (!row) return;
  const now = nowIso();
  const patch = { uses: (row.uses || 0) + (status && status < 400 ? 1 : 0), failures: row.failures || 0, lastUsedAt: now };
  if (status === 401 || status === 403) {
    patch.status = "dead";
    patch.statusText = error || `rejected with ${status}`;
    patch.failures = (row.failures || 0) + 1;
  } else if (status === 429) {
    patch.status = "throttled";
    patch.statusText = error || "rate limited";
    patch.cooldownUntil = new Date(Date.now() + retryAfterMs(retryAfter)).toISOString();
  } else if (status && status >= 500) {
    patch.status = row.status === "working" ? "working" : "unknown";
    patch.statusText = error || `upstream ${status}`;
  } else if (status && status < 400) {
    patch.status = "working";
    patch.statusText = "";
    patch.cooldownUntil = null;
  }
  db.prepare(
    "UPDATE key_pool SET status = ?, statusText = ?, checkedAt = ?, lastUsedAt = ?, uses = ?, failures = ?, cooldownUntil = ? WHERE id = ?"
  ).run(
    patch.status || row.status,
    patch.statusText || row.statusText || "",
    now,
    patch.lastUsedAt,
    patch.uses,
    patch.failures,
    patch.cooldownUntil ?? row.cooldownUntil ?? null,
    row.id
  );
}

function retryAfterMs(retryAfter) {
  const secs = Number(retryAfter);
  if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, 30 * 60 * 1000);
  return 60 * 1000;
}

export async function validateKey(id) {
  const row = db.prepare("SELECT * FROM key_pool WHERE id = ?").get(id);
  if (!row) return null;
  const entry = rowToEntry(row);
  const res = await probeKey(entry.provider, entry.key);
  const status = res.ok ? "working" : res.kind === "invalid" ? "dead" : "unknown";
  db.prepare("UPDATE key_pool SET status = ?, statusText = ?, checkedAt = ? WHERE id = ?").run(status, res.detail || "", nowIso(), id);
  return { ...entry, status, statusText: res.detail || "", probe: res };
}

export async function validateAll(provider = "") {
  const entries = listPool(provider);
  const results = [];
  for (const e of entries) {
    const r = await validateKey(e.id);
    if (r) results.push(r);
  }
  return results;
}

/* ------------------------------------------------------------------ */
/* ingestion                                                           */
/* ------------------------------------------------------------------ */

// Pull candidate keys out of arbitrary text: a key per line, a JSON array, a
// JSON object, a .env file, a shell script - all of it works.
export function extractKeys(text) {
  const found = new Set();
  const raw = String(text || "");
  for (const m of raw.matchAll(GENERIC_KEY_RE)) found.add(m[0]);
  for (const fp of FINGERPRINTS) {
    const re = new RegExp(fp.re.source, "g");
    for (const m of raw.matchAll(re)) found.add(m[0]);
  }
  return [...found];
}

export function ingestText(text, { source = "manual", provider = "" } = {}) {
  const keys = extractKeys(text);
  const added = [];
  const skipped = [];
  for (const key of keys) {
    const p = provider || guessProvider(key) || "unknown";
    const res = addKey({ provider: p, key, source });
    if (res.added) added.push({ id: res.id, provider: p, key: mask(key) });
    else skipped.push({ reason: res.reason, provider: p, key: mask(key) });
  }
  return { found: keys.length, added, skipped };
}

export function mask(key) {
  const k = String(key || "");
  if (k.length <= 10) return k.slice(0, 3) + "…";
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}

// Fetch a source that publishes keys for others to use and add whatever is
// still alive. Sources are plain text or JSON.
export async function ingestSource(url, { provider = "", label = "" } = {}) {
  const res = await fetch(url, { headers: { accept: "application/json, text/plain, */*" } });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, error: text.slice(0, 160) };
  }
  let body = text;
  if ((res.headers.get("content-type") || "").includes("json")) {
    try {
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.keys)
          ? parsed.keys
          : Object.values(parsed).flat();
      body = list
        .map((k) => (typeof k === "string" ? k : k?.key || k?.apiKey || ""))
        .filter(Boolean)
        .join("\n");
    } catch {
      /* keep the raw text */
    }
  }
  const result = ingestText(body, { source: url, provider });
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO key_pool_sources (id, url, provider, label, enabled, lastSyncAt, addedAt) VALUES (?, ?, ?, ?, 1, ?, ?) ON CONFLICT(url) DO UPDATE SET lastSyncAt = excluded.lastSyncAt, label = excluded.label"
  ).run(id, url, provider, label, nowIso(), nowIso());
  return { ok: true, ...result };
}

export function listSources() {
  return db.prepare("SELECT * FROM key_pool_sources ORDER BY addedAt").all();
}

export function removeSource(id) {
  return db.prepare("DELETE FROM key_pool_sources WHERE id = ?").run(id).changes > 0;
}
