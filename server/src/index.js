// MAGoCo Router - HTTP entry point.
//
// Listens on 0.0.0.0:7860 (ModelScope requires 7860 for Docker studios).
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, getSettings, updateSettings, nowIso } from "./db.js";
import { logRequest } from "./log.js";
import * as keyPool from "./keypool.js";
import * as routing from "./routing.js";
import * as metrics from "./metrics.js";
import * as settings from "./settings.js";
import * as backup from "./backup.js";
import * as telegram from "./telegram.js";
import * as session from "./session.js";
import {
  createApiKey, createSessionToken, dashboardPassword, deleteApiKey,
  extractClientKey, findApiKey, listApiKeys, parseCookies, verifySessionToken,
} from "./auth.js";
import { BUILTIN_PROVIDERS, providerById } from "./providers.js";
import * as opencode from "./providers/opencode.js";
import { getRegistry, getCatalogue, allCatalogues, syncAll, syncRemoteRegistry, startRegistrySync, syncProviderModels } from "./registry.js";
import { dispatch, modelCatalogue, recordUsage, activeConnections } from "./router.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, "../../web");
const PORT = Number(process.env.PORT || 7860);
const HOST = process.env.HOST || "0.0.0.0";

/* ----------------------------- helpers ----------------------------- */

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "access-control-allow-origin": "*",
    ...extraHeaders,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 64 * 1024 * 1024) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function isDashboardAuthed(req) {
  const cookies = parseCookies(req.headers.cookie);
  return verifySessionToken(cookies.auth_token);
}

function requireClientKey(req, res) {
  const row = findApiKey(extractClientKey(req));
  if (!row) {
    json(res, 401, { error: { message: "missing or invalid API key", type: "unauthorized" } });
    return null;
  }
  return row;
}

function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = path.join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR)) {
    json(res, 403, { error: { message: "forbidden" } });
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      json(res, 404, { error: { message: "not found" } });
      return;
    }
    const ext = path.extname(file);
    const type = ext === ".html" ? "text/html; charset=utf-8" : ext === ".js" ? "text/javascript; charset=utf-8" : ext === ".css" ? "text/css; charset=utf-8" : "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(data);
  });
}

/* --------------------------- route table --------------------------- */

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

// --- LLM API (client API key) ---
function clientRateGuard(req, res) {
  const key = extractClientKey(req);
  if (!key) return true;
  const id = findApiKey(key)?.id;
  const limit = metrics.checkRateLimit(id);
  if (limit.allowed) return true;
  res.setHeader("retry-after", String(limit.retryAfter || 60));
  json(res, 429, { error: { message: limit.reason, type: "rate_limit_exceeded" } });
  return false;
}

route("POST", /^\/v1\/chat\/completions$/, async (req, res, _m, body) => {
  if (!clientRateGuard(req, res)) return;
  const key = requireClientKey(req, res);
  if (!key) return;
  const result = await dispatch({ clientProtocol: "openai", body, apiKeyId: key.id, headers: req.headers });
  if (result.stream) {
    res.writeHead(result.status, { ...result.headers, "access-control-allow-origin": "*" });
    result.stream.pipeTo(res).catch(() => {});
    return;
  }
  json(res, result.status, result.payload);
});

route("POST", /^\/v1\/messages$/, async (req, res, _m, body) => {
  if (!clientRateGuard(req, res)) return;
  const key = requireClientKey(req, res);
  if (!key) return;
  const result = await dispatch({ clientProtocol: "anthropic", body, apiKeyId: key.id, headers: req.headers });
  if (result.stream) {
    res.writeHead(result.status, { ...result.headers, "access-control-allow-origin": "*" });
    result.stream.pipeTo(res).catch(() => {});
    return;
  }
  json(res, result.status, result.payload);
});

route("GET", /^\/v1\/models$/, (req, res) => {
  const key = requireClientKey(req, res);
  if (!key) return;
  json(res, 200, { object: "list", data: modelCatalogue() });
});

// --- health / meta (public) ---
route("GET", /^\/api\/health$/, (req, res) => {
  json(res, 200, { ok: true, name: "MAGoCo Router", version: "0.0.1", time: nowIso() });
});

route("GET", /^\/api\/version$/, (req, res) => {
  json(res, 200, { currentVersion: "0.0.1", latestVersion: "0.0.1", hasUpdate: false });
});

route("GET", /^\/api\/providers\/registry$/, (req, res) => {
  const catalogues = allCatalogues();
  json(res, 200, {
    providers: getRegistry().map((p) => ({
      ...p,
      models: catalogues[p.id]?.ids || [],
      modelCount: (catalogues[p.id]?.ids || []).length,
      syncedAt: catalogues[p.id]?.at || null,
    })),
  });
});

route("POST", /^\/api\/providers\/sync$/, async (req, res, _m, body) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  const remote = await syncRemoteRegistry(body?.registryUrl);
  const results = await syncAll();
  json(res, 200, { remote, results });
});

// --- dashboard auth ---
route("POST", /^\/api\/auth\/login$/, async (req, res, _m, body) => {
  if (String(body.password || "") !== dashboardPassword()) {
    json(res, 401, { error: "Invalid password" });
    return;
  }
  const token = createSessionToken();
  json(res, 200, { success: true }, {
    "set-cookie": `auth_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${12 * 60 * 60}${process.env.AUTH_COOKIE_SECURE === "true" ? "; Secure" : ""}`,
  });
});

route("GET", /^\/api\/auth\/status$/, (req, res) => {
  json(res, 200, {
    requireLogin: true,
    hasPassword: !!dashboardPassword(),
    authenticated: isDashboardAuthed(req),
  });
});

route("POST", /^\/api\/auth\/logout$/, (req, res) => {
  json(res, 200, { success: true }, { "set-cookie": "auth_token=; Path=/; HttpOnly; Max-Age=0" });
});

// --- dashboard API (session) ---
route("GET", /^\/api\/keys$/, (req, res) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  json(res, 200, { keys: listApiKeys() });
});

route("POST", /^\/api\/keys$/, async (req, res, _m, body) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  json(res, 200, { key: createApiKey({ name: body.name || "" }) });
});

route("DELETE", /^\/api\/keys\/([\w-]+)$/, (req, res, m) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  json(res, 200, { deleted: deleteApiKey(m[1]) });
});

route("GET", /^\/api\/providers$/, (req, res) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  json(res, 200, { connections: activeConnections() });
});

route("POST", /^\/api\/providers$/, async (req, res, _m, body) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  if (!providerById(body.provider)) return json(res, 400, { error: "unknown provider" });
  const id = crypto.randomUUID();
  const payload = { ...(body.data || {}) };
  // Store the provider catalogue with the connection, so a model id can be
  // resolved to the right connection without a prefix.
  try {
    const record = getRegistry().find((r) => r.id === body.provider);
    if (record) {
      const cat = await syncProviderModels(record);
      if (cat?.ids?.length) payload.models = cat.ids.slice(0, 2000);
    }
  } catch {}
  const data = JSON.stringify(payload);
  db.prepare(
    "INSERT INTO provider_connections (id, provider, name, email, priority, isActive, data, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, body.provider, body.name || body.provider, body.email || null, Number(body.priority) || 0, body.isActive === false ? 0 : 1, data, nowIso(), nowIso());
  json(res, 200, { id });
});

route("DELETE", /^\/api\/providers\/([\w-]+)$/, (req, res, m) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  const n = db.prepare("DELETE FROM provider_connections WHERE id = ?").run(m[1]).changes;
  json(res, 200, { deleted: n > 0 });
});

route("GET", /^\/api\/settings$/, (req, res) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  json(res, 200, settings.allSettings());
});

route("PATCH", /^\/api\/settings$/, async (req, res, _m, body) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  const saved = settings.saveSettings(body);
  if ("registrySyncIntervalMs" in body) startRegistrySync(Number(body.registrySyncIntervalMs) || 3600000);
  json(res, 200, saved);
});

route("GET", /^\/api\/keypool$/, (req, res) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  json(res, 200, {
    keys: keyPool.listPool().map((k) => ({ ...k, key: keyPool.mask(k.key) })),
    stats: keyPool.poolStats(),
    sources: keyPool.listSources(),
  });
});

route("POST", /^\/api\/keypool\/import$/, (req, res, _m, body) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  const text = String(body.text || "");
  const result = keyPool.ingestText(text, { source: body.source || "manual", provider: body.provider || "" });
  json(res, 200, result);
});

route("POST", /^\/api\/keypool\/source$/, async (req, res, _m, body) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  const url = String(body.url || "").trim();
  if (!/^https?:\/\//i.test(url)) return json(res, 400, { error: "the source url must be http(s)" });
  const result = await keyPool.ingestSource(url, { provider: body.provider || "", label: body.label || "" });
  json(res, result.ok ? 200 : 400, result);
});

route("GET", /^\/api\/keypool\/sources$/, (req, res) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  json(res, 200, { sources: keyPool.listSources() });
});

route("DELETE", /^\/api\/keypool\/sources\/([\w-]+)$/, (req, res, m) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  json(res, 200, { deleted: keyPool.removeSource(m[1]) });
});

route("POST", /^\/api\/keypool\/validate$/, async (req, res, _m, body) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  if (body.id) {
    const result = await keyPool.validateKey(body.id);
    return json(res, result ? 200 : 404, result || { error: "not found" });
  }
  const results = await keyPool.validateAll(body.provider || "");
  json(res, 200, { results: results.map((r) => ({ ...r, key: keyPool.mask(r.key) })), stats: keyPool.poolStats() });
});

route("POST", /^\/api\/keypool\/identify$/, async (req, res, _m, body) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  const key = String(body.key || "").trim();
  if (!key) return json(res, 400, { error: "no key" });
  const result = await keyPool.identifyProvider(key, body.provider || "");
  json(res, 200, { ...result, key: keyPool.mask(key) });
});

route("DELETE", /^\/api\/keypool\/([\w-]+)$/, (req, res, m) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  json(res, 200, { deleted: keyPool.removeKey(m[1]) });
});

route("GET", /^\/api\/combos$/, (req, res) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  json(res, 200, { combos: routing.listCombos().map((c) => ({ ...c, members: JSON.parse(c.members || "[]") })) });
});

route("POST", /^\/api\/combos$/, (req, res, _m, body) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  const result = routing.createCombo(body);
  if (result.error) return json(res, 400, { error: result.error });
  json(res, 200, result);
});

route("PATCH", /^\/api\/combos\/([\w-]+)$/, (req, res, m, body) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  const result = routing.updateCombo(m[1], body);
  if (result.error) return json(res, 404, { error: result.error });
  json(res, 200, result);
});

route("DELETE", /^\/api\/combos\/([\w-]+)$/, (req, res, m) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  json(res, 200, { deleted: routing.deleteCombo(m[1]) });
});

route("GET", /^\/api\/strategies$/, (req, res) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  json(res, 200, { strategies: routing.listStrategies() });
});

route("GET", /^\/api\/health\/metrics$/, (req, res) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  json(res, 200, {
    ...metrics.healthSnapshot(),
    breakers: routing.breakerSnapshot(),
    lockouts: routing.lockoutSnapshot(),
    cache: metrics.cacheStats(),
  });
});

route("GET", /^\/api\/cache$/, (req, res) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  json(res, 200, metrics.cacheStats());
});

route("DELETE", /^\/api\/cache$/, (req, res) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  json(res, 200, { cleared: metrics.cacheClear() });
});

route("GET", /^\/api\/limits$/, (req, res) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  json(res, 200, { limits: metrics.listRateLimits() });
});

route("POST", /^\/api\/limits$/, (req, res, _m, body) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  json(res, 200, metrics.setRateLimit(body.apiKeyId || body.id, body));
});

route("GET", /^\/api\/pricing$/, (req, res) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  json(res, 200, { prices: metrics.listPrices() });
});

route("POST", /^\/api\/pricing$/, (req, res, _m, body) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  json(res, 200, metrics.setPrice(body));
});

route("GET", /^\/api\/aliases$/, (req, res) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  json(res, 200, { aliases: db.prepare("SELECT * FROM model_aliases ORDER BY name").all() });
});

route("POST", /^\/api\/aliases$/, (req, res, _m, body) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  const name = String(body.name || "").trim();
  const target = String(body.target || "").trim();
  if (!name || !target) return json(res, 400, { error: "name and target are required" });
  db.prepare("INSERT INTO model_aliases (name, target, createdAt) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET target = excluded.target").run(name, target, nowIso());
  json(res, 200, { name, target });
});

route("DELETE", /^\/api\/aliases\/([\w.-]+)$/, (req, res, m) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  json(res, 200, { deleted: db.prepare("DELETE FROM model_aliases WHERE name = ?").run(decodeURIComponent(m[1])).changes > 0 });
});

route("GET", /^\/api\/breaker$/, (req, res) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  json(res, 200, { breakers: routing.breakerSnapshot(), lockouts: routing.lockoutSnapshot() });
});

route("POST", /^\/api\/breaker\/reset$/, (req, res, _m, body) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  if (body?.key) db.prepare("DELETE FROM circuit_state WHERE key = ?").run(body.key);
  else db.prepare("DELETE FROM circuit_state").run();
  if (body?.model) routing.unlockModel(body.model);
  json(res, 200, { reset: true });
});

route("DELETE", /^\/api\/lockouts\/([\w.-]+)$/, (req, res, m) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  json(res, 200, { deleted: routing.unlockModel(decodeURIComponent(m[1])) });
});

route("GET", /^\/api\/backups$/, (req, res) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  json(res, 200, { backups: backup.listBackups() });
});

route("POST", /^\/api\/backups$/, (req, res, _m, body) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  try {
    const result = backup.createBackup({ label: body?.label || "manual" });
    json(res, 200, result);
  } catch (err) {
    json(res, 500, { error: { message: String(err.message || err) } });
  }
});

route("GET", /^\/api\/backups\/([\w.-]+)\/download$/, (req, res, m) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  const file = backup.backupPath(m[1]);
  if (!file) return json(res, 404, { error: { message: "backup not found" } });
  const data = fs.readFileSync(file);
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-disposition": `attachment; filename="${m[1]}.sqlite"`,
  });
  res.end(data);
});

route("POST", /^\/api\/backups\/([\w.-]+)\/restore$/, (req, res, m) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  const result = backup.restoreBackup(m[1]);
  if (result.error) return json(res, 400, { error: { message: result.error } });
  json(res, 200, result);
});

route("DELETE", /^\/api\/backups\/([\w.-]+)$/, (req, res, m) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  json(res, 200, { deleted: backup.deleteBackup(m[1]) });
});

route("GET", /^\/api\/telegram$/, (req, res) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  json(res, 200, telegram.status());
});

route("POST", /^\/api\/telegram$/, (req, res, _m, body) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  const result = telegram.saveConfig(body);
  if (body?.enabled) telegram.start();
  else telegram.stop();
  json(res, 200, result);
});

route("POST", /^\/api\/telegram\/test$/, async (req, res) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  json(res, 200, await telegram.testConnection());
});

route("GET", /^\/api\/sessions$/, (req, res) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  json(res, 200, { sessions: session.listSessions(), stats: session.sessionStats() });
});

route("DELETE", /^\/api\/sessions\/([\w.-]+)$/, (req, res, m) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  json(res, 200, { deleted: session.clearSession(decodeURIComponent(m[1])) });
});

route("GET", /^\/api\/logs$/, (req, res) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  const rows = db.prepare("SELECT * FROM request_log ORDER BY id DESC LIMIT 200").all();
  json(res, 200, { rows });
});

route("DELETE", /^\/api\/logs$/, (req, res) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  db.prepare("DELETE FROM request_log").run();
  json(res, 200, { cleared: true });
});

route("POST", /^\/api\/console$/, async (req, res, _m, body) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  const { dispatch } = await import("./router.js");
  const t0 = Date.now();
  const result = await dispatch({ clientProtocol: "openai", body, apiKeyId: null });
  logRequest({ method: "POST", path: "/api/console", model: body?.model, status: result.status, durationMs: Date.now() - t0, detail: result.payload?.error?.message || "" });
  json(res, result.status, result.payload);
});

route("GET", /^\/api\/usage\/timeline$/, (req, res) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  json(res, 200, metrics.usageTimeline(Number(req.query?.get("days")) || 7));
});

route("GET", /^\/api\/usage\/export$/, (req, res) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  const csv = metrics.usageCsv(Number(req.query?.get("days")) || 30);
  res.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="usage-${new Date().toISOString().slice(0, 10)}.csv"`,
  });
  res.end(csv);
});

route("GET", /^\/api\/usage\/summary$/, (req, res) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const calls = db.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE ts >= ?").get(since).n;
  const prompt = db.prepare("SELECT COALESCE(SUM(promptTokens),0) AS n FROM usage_events WHERE ts >= ?").get(since).n;
  const output = db.prepare("SELECT COALESCE(SUM(outputTokens),0) AS n FROM usage_events WHERE ts >= ?").get(since).n;
  const errs = db.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE ts >= ? AND status >= 400").get(since).n;
  json(res, 200, { calls, promptTokens: prompt, outputTokens: output, errors: errs });
});

route("GET", /^\/api\/usage\/stats$/, (req, res) => {
  if (!isDashboardAuthed(req)) return json(res, 401, { error: "Unauthorized" });
  const rows = db
    .prepare(
      "SELECT provider, model, status, COUNT(*) AS calls, SUM(promptTokens) AS promptTokens, SUM(outputTokens) AS outputTokens FROM usage_events WHERE ts >= ? GROUP BY provider, model, status ORDER BY calls DESC LIMIT 200"
    )
    .all(new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString());
  const totals = db
    .prepare("SELECT COUNT(*) AS calls, SUM(promptTokens) AS promptTokens, SUM(outputTokens) AS outputTokens FROM usage_events WHERE ts >= ?")
    .get(new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString());
  json(res, 200, { totals, rows });
});

/* ----------------------------- server ----------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    });
    res.end();
    return;
  }

  const __t0 = Date.now();
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.pattern.exec(pathname);
    if (!m) continue;
    try {
      let body = {};
      if (req.method !== "GET" && req.method !== "DELETE") {
        body = await readBody(req).catch(() => ({}));
      }
      await r.handler(req, res, m, body);
      logRequest({ method: req.method, path: pathname, status: res.statusCode, durationMs: Date.now() - __t0 });
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: { message: String(err && err.message ? err.message : err) } });
    }
    return;
  }

  if (pathname.startsWith("/api/")) {
    json(res, 404, { error: { message: "unknown endpoint" } });
    return;
  }

  serveStatic(req, res, pathname);
});

opencode.startCatalogueRefresh();
startRegistrySync(settings.numberSetting("registrySyncIntervalMs"));
backup.scheduleBackups(settings.numberSetting("backupIntervalMs"));
telegram.start();

server.listen(PORT, HOST, () => {
  console.log(`[magoco-router] listening on ${HOST}:${PORT}`);
});
