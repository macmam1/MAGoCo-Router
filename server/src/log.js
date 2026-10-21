// Request log - one row per API call, so the dashboard can show recent traffic.
import { db, nowIso } from "./db.js";

export function logRequest({ method, path, model, provider, status, durationMs, detail }) {
  try {
    if (path && !path.startsWith("/api/")) return;
    if (path && path.startsWith("/api/logs")) return;
    db.prepare(
      "INSERT INTO request_log (ts, method, path, model, provider, status, durationMs, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(nowIso(), method || null, path || null, model || null, provider || null, status || null, durationMs || null, detail || null);
  } catch {
    /* logging must never break a request */
  }
}
