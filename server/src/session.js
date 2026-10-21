// Sessions and context relay.
//
// A client that talks to several models in a row (Claude Code, Cursor, an
// agent loop) should not lose the conversation when the router has to switch
// to another model or provider. Every session keeps the recent turns, and
// when a failover happens the new upstream receives a compact handoff of what
// was said before.
import crypto from "node:crypto";
import { db, nowIso } from "./db.js";

const MAX_TURNS = 12;
const MAX_CHARS = 6000;

export function sessionId(headers = {}, body = {}) {
  const h = headers || {};
  const candidates = [
    h["x-magoco-session"],
    h["x-session-id"],
    h["x-magoco-conversation"],
    body?.metadata?.session_id,
    body?.user,
  ];
  for (const c of candidates) {
    if (c) return String(c).slice(0, 120);
  }
  return null;
}

function load(session) {
  if (!session) return null;
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(session);
  if (!row) return null;
  try {
    return { id: row.id, model: row.model, provider: row.provider, turns: JSON.parse(row.turns || "[]") };
  } catch {
    return null;
  }
}

export function remember(session, { model, provider, messages }) {
  if (!session || !Array.isArray(messages) || !messages.length) return;
  const incoming = messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .map((m) => ({ role: m.role, content: String(m.content ?? "").slice(0, 2000) }));
  if (!incoming.length) return;

  // The conversation is accumulated, not replaced: a client that only sends the
  // newest turn must not erase the earlier ones.
  const current = load(session);
  const known = new Set((current?.turns || []).map((t) => `${t.role}:${t.content}`));
  const merged = [...(current?.turns || [])];
  for (const turn of incoming) {
    const fingerprint = `${turn.role}:${turn.content}`;
    if (known.has(fingerprint)) continue;
    known.add(fingerprint);
    merged.push(turn);
  }
  const turns = merged.slice(-MAX_TURNS);
  db.prepare(
    "INSERT INTO sessions (id, model, provider, turns, updatedAt) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET model = excluded.model, provider = excluded.provider, turns = excluded.turns, updatedAt = excluded.updatedAt"
  ).run(session, model || null, provider || null, JSON.stringify(turns), nowIso());
}

// The handoff block that is prepended when the router has to serve the
// request from another model, or when the client sends only the last turn
// and the earlier turns would otherwise be lost.
export function handoff(session, nextModel, nextProvider, requestMessages) {
  const s = load(session);
  if (!s || !s.turns.length) return null;

  // If the client already sent the earlier turns, nothing is missing.
  const sent = JSON.stringify(
    (requestMessages || []).map((m) => [m?.role, String(m?.content ?? "").slice(0, 80)])
  );
  const firstUser = s.turns.find((t) => t.role === "user");
  if (firstUser && sent.includes(firstUser.content.slice(0, 80))) return null;
  let text = "";
  for (const turn of s.turns) {
    const who = turn.role === "user" ? "User" : "Assistant";
    text += `${who}: ${turn.content}\n`;
  }
  if (text.length > MAX_CHARS) text = `…${text.slice(-MAX_CHARS)}`;
  return {
    role: "system",
    content:
      `The conversation continues from another model${nextModel ? ` (${nextModel})` : ""}. ` +
      `Earlier turns:\n${text}`,
  };
}

export function listSessions(limit = 50) {
  return db
    .prepare("SELECT id, model, provider, updatedAt, length(turns) AS size FROM sessions ORDER BY updatedAt DESC LIMIT ?")
    .all(limit);
}

export function clearSession(session) {
  return db.prepare("DELETE FROM sessions WHERE id = ?").run(session).changes > 0;
}

export function sessionStats() {
  const rows = db.prepare("SELECT COUNT(*) AS n FROM sessions").get();
  return { sessions: rows.n };
}

export function newId() {
  return crypto.randomBytes(8).toString("hex");
}
