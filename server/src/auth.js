// Two independent auth surfaces:
//  * client API keys  - what Claude Code / Codex / curl send on /v1/*
//  * dashboard session - a JWT cookie for the web UI
import crypto from "node:crypto";
import { db, nowIso } from "./db.js";

const CLIENT_KEY_HEADER = "x-magoco-key";
// The header this project used under an earlier name still works, so old
// clients keep running. It is not advertised anywhere.
const LEGACY_KEY_HEADERS = ["x-9router-key"];

export function extractClientKey(request) {
  const headers = request.headers || {};
  const header = headers[CLIENT_KEY_HEADER];
  if (header) return String(header).trim();
  for (const legacy of LEGACY_KEY_HEADERS) {
    if (headers[legacy]) return String(headers[legacy]).trim();
  }
  const auth = headers["authorization"];
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  return "";
}

export function findApiKey(raw) {
  if (!raw) return null;
  // The bootstrap key from the environment works even before any key exists in
  // the database, so a fresh deployment is usable straight away.
  const bootstrap = String(process.env.REQUIRE_API_KEY || "").trim();
  if (bootstrap && raw === bootstrap) {
    return { id: "env-bootstrap", key: raw, name: "bootstrap", machineId: null, isActive: 1 };
  }
  const row = db
    .prepare("SELECT id, key, name, machineId, isActive FROM api_keys WHERE key = ?")
    .get(raw);
  if (!row || row.isActive !== 1) return null;
  return row;
}

export function createApiKey({ name = "", machineId = null } = {}) {
  const id = crypto.randomUUID();
  const key = `sk-magoco-${crypto.randomBytes(24).toString("hex")}`;
  db.prepare(
    "INSERT INTO api_keys (id, key, name, machineId, isActive, createdAt) VALUES (?, ?, ?, ?, 1, ?)"
  ).run(id, key, name, machineId, nowIso());
  return { id, key, name, machineId, createdAt: nowIso() };
}

export function listApiKeys() {
  return db
    .prepare("SELECT id, key, name, machineId, isActive, createdAt FROM api_keys ORDER BY createdAt DESC")
    .all();
}

export function deleteApiKey(id) {
  return db.prepare("DELETE FROM api_keys WHERE id = ?").run(id).changes > 0;
}

/* ------------------------------------------------------------------ */
/* dashboard session (JWT in an httpOnly cookie)                        */
/* ------------------------------------------------------------------ */

function sessionSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  // Deterministic fallback so every bundle in the process agrees on it.
  return crypto.createHash("sha256").update("magoco-router-session").digest("hex");
}

const SESSION_MAX_AGE = 60 * 60 * 12;

export function createSessionToken() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "HS256", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const body = b64({ authenticated: true, iat: now, exp: now + SESSION_MAX_AGE });
  const sig = crypto.createHmac("sha256", sessionSecret()).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

export function verifySessionToken(token) {
  if (!token) return false;
  const parts = String(token).split(".");
  if (parts.length !== 3) return false;
  const expected = crypto.createHmac("sha256", sessionSecret()).update(`${parts[0]}.${parts[1]}`).digest("base64url");
  const a = Buffer.from(expected);
  const b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload.authenticated === true && (!payload.exp || payload.exp * 1000 > Date.now());
  } catch {
    return false;
  }
}

export function dashboardPassword() {
  return process.env.INITIAL_PASSWORD || "123456";
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
