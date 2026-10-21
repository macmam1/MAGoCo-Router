// Telegram control bot.
//
// The same router, driven from a chat window: status, models, a working chat
// with any model, combos, keys, usage, health, logs, backups and settings.
//
// Access is limited to the allow-listed user ids. Nothing here can reach the
// network before a token is configured.
import { db, getSettings, updateSettings, nowIso } from "./db.js";
import { dispatch } from "./router.js";
import * as keyPool from "./keypool.js";
import * as metrics from "./metrics.js";
import * as routing from "./routing.js";
import { createBackup, listBackups, restoreBackup } from "./backup.js";

const API = "https://api.telegram.org";

function config() {
  const s = getSettings();
  return {
    token: String(process.env.TELEGRAM_BOT_TOKEN || s.telegramToken || "").trim(),
    users: String(process.env.TELEGRAM_ALLOWED_USERS || s.telegramUsers || "")
      .split(/[,\s]+/)
      .map((x) => x.trim())
      .filter(Boolean),
    enabled: String(s.telegramEnabled ?? "false") === "true" || !!process.env.TELEGRAM_BOT_TOKEN,
  };
}

export function status() {
  const c = config();
  return { enabled: c.enabled, configured: !!c.token, allowList: c.users.length };
}

export function saveConfig({ token, users, enabled }) {
  const patch = {};
  if (token !== undefined) patch.telegramToken = String(token || "").trim();
  if (users !== undefined) patch.telegramUsers = Array.isArray(users) ? users.join(",") : String(users || "");
  if (enabled !== undefined) patch.telegramEnabled = enabled ? "true" : "false";
  updateSettings(patch);
  return status();
}

async function api(token, method, payload) {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) throw new Error(data?.description || `telegram ${method} failed`);
  return data.result;
}

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

function split(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean);
}

async function handleCommand(chatId, text) {
  const [cmd, ...rest] = split(text);
  const arg = rest.join(" ");
  switch (cmd) {
    case "/start":
    case "/help": {
      return `MAGoCo Router

/status - gateway health and traffic
/models - what can be served right now
/use <model> - pick the model for /chat
/chat <text> - talk to the selected model
/combos - list the fallback chains
/keys - list the client keys
/providers - list the providers
/usage - tokens and calls
/health - breakers and lockouts
/logs - the last requests
/backup - take a snapshot
/restore <id> - restore a snapshot
/settings - show the configuration`;
    }
    case "/status": {
      const h = metrics.healthSnapshot();
      const s = getSettings();
      return `MAGoCo Router - ${h.uptime * 100}% up
calls 24h: ${h.calls}   errors: ${h.errors}
p95: ${h.latency.p95}ms
models: ${s.__modelCount || "?"}
providers: ${h.providers.length}`;
    }
    case "/models": {
      const rows = db
        .prepare("SELECT provider, COUNT(*) AS n FROM usage_events WHERE ts >= ? GROUP BY provider")
        .all(new Date(Date.now() - 86400000).toISOString());
      const { allCatalogues } = await import("./registry.js");
      const cat = allCatalogues();
      const lines = Object.entries(cat)
        .filter(([, v]) => v.ids?.length)
        .map(([k, v]) => `${k}: ${v.ids.length} models`);
      return lines.length ? `Models available\n${lines.join("\n")}` : "No catalogues synced yet.";
    }
    case "/use": {
      if (!arg) return "Which model? /use beam-free";
      updateSettings({ telegramModel: arg });
      return `Model set to ${arg}. Now: /chat hello`;
    }
    case "/chat": {
      const model = getSettings().telegramModel || "beam-free";
      const prompt = arg || "Say hi in one word.";
      const result = await dispatch({
        clientProtocol: "openai",
        body: { model, messages: [{ role: "user", content: prompt }], stream: false },
        apiKeyId: "telegram",
      });
      if (result.status !== 200) return `Failed (${result.status}): ${result.payload?.error?.message || "unknown error"}`;
      const text = result.payload?.choices?.[0]?.message?.content || "(empty answer)";
      return `${text}`;
    }
    case "/combos": {
      const combos = routing.listCombos();
      if (!combos.length) return "No combos yet.";
      return combos.map((c) => `${c.name} [${c.strategy}] -> ${(JSON.parse(c.members || "[]") || []).join(", ")}`).join("\n");
    }
    case "/keys": {
      const { listApiKeys } = await import("./auth.js");
      return listApiKeys().map((k) => `${k.name || "key"}: ${k.key.slice(0, 14)}…`).join("\n") || "No keys.";
    }
    case "/providers": {
      const { getRegistry } = await import("./registry.js");
      return getRegistry().map((p) => `${p.label} (${p.group})`).join("\n");
    }
    case "/usage": {
      const rows = db
        .prepare("SELECT provider, COUNT(*) AS calls, SUM(promptTokens) AS p, SUM(outputTokens) AS o FROM usage_events WHERE ts >= ? GROUP BY provider ORDER BY calls DESC")
        .all(new Date(Date.now() - 86400000).toISOString());
      if (!rows.length) return "No traffic in the last 24 hours.";
      return `Usage 24h\n${rows.map((r) => `${r.provider}: ${r.calls} calls, ${(r.p || 0) + (r.o || 0)} tokens`).join("\n")}`;
    }
    case "/health": {
      const b = routing.breakerSnapshot();
      const l = routing.lockoutSnapshot();
      if (!b.length && !l.length) return "Everything is healthy.";
      return `Breakers\n${b.map((x) => `${x.key}: ${x.state} (${x.failures})`).join("\n")}\nLockouts\n${l.map((x) => `${x.model}: until ${x.until}`).join("\n")}`;
    }
    case "/logs": {
      const rows = db.prepare("SELECT ts, method, path, status FROM request_log ORDER BY id DESC LIMIT 12").all();
      return rows.map((r) => `${r.ts.slice(11, 19)} ${r.method} ${r.path} ${r.status}`).join("\n") || "No logs.";
    }
    case "/backup": {
      const b = createBackup({ label: "telegram" });
      return `Backup ${b.id} (${Math.round(b.size / 1024)} KB)`;
    }
    case "/restore": {
      if (!arg) return "Which backup? /restore backup-2026-…";
      const r = restoreBackup(arg);
      return r.error ? `Failed: ${r.error}` : `Restored ${arg} (${r.tables} tables).`;
    }
    case "/settings": {
      const s = getSettings();
      const keys = Object.keys(s).filter((k) => !k.startsWith("__"));
      return keys.length ? keys.map((k) => `${k} = ${JSON.stringify(s[k])}`).join("\n") : "No settings yet.";
    }
    default:
      return `Unknown command ${cmd}. /help for the list.`;
  }
}

let poller = null;

export function start() {
  const c = config();
  if (!c.enabled || !c.token) return { started: false, reason: "not configured" };
  stop();
  let offset = 0;
  const tick = async () => {
    try {
      const updates = await api(c.token, "getUpdates", { offset, timeout: 25, allowed_updates: ["message"] });
      for (const update of updates) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg) continue;
        const chatId = String(msg.chat?.id || "");
        if (c.users.length && !c.users.includes(chatId)) {
          await api(c.token, "sendMessage", { chat_id: chatId, text: "This bot is not available for your account." }).catch(() => {});
          continue;
        }
        const text = String(msg.text || "").trim();
        if (!text) continue;
        const reply = await handleCommand(chatId, text).catch((err) => `Error: ${err.message}`);
        await api(c.token, "sendMessage", { chat_id: chatId, text: reply, disable_web_page_preview: true }).catch(() => {});
      }
    } catch {
      /* keep polling */
    }
  };
  poller = setInterval(tick, 1500);
  tick();
  return { started: true };
}

export function stop() {
  if (poller) clearInterval(poller);
  poller = null;
  return { stopped: true };
}

export function testConnection() {
  const c = config();
  if (!c.token) return { ok: false, error: "no token" };
  return api(c.token, "getMe", {}).then((r) => ({ ok: true, bot: r.username })).catch((e) => ({ ok: false, error: e.message }));
}

