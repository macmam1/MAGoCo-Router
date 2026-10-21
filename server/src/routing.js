// Routing: strategies, combos, resilience.
//
// A combo is a named, ordered list of targets ("provider/model" or a bare
// model id). A request may name a combo instead of a model, and the router
// walks the list with the configured strategy until one target answers.
import { db, nowIso } from "./db.js";
import { numberSetting } from "./settings.js";

/* ------------------------------------------------------------------ */
/* strategies                                                          */
/* ------------------------------------------------------------------ */

export const STRATEGIES = [
  { id: "priority", label: "Priority", hint: "first healthy target wins" },
  { id: "round-robin", label: "Round robin", hint: "rotate through the targets" },
  { id: "least-used", label: "Least used", hint: "the target with the fewest calls" },
  { id: "fill-first", label: "Fill first", hint: "stay on one target until it fails" },
  { id: "random", label: "Random", hint: "pick a healthy target at random" },
  { id: "cost-optimized", label: "Cost optimized", hint: "cheapest healthy target first" },
  { id: "failover", label: "Failover", hint: "in order, always the same order" },
];

export function listStrategies() {
  return STRATEGIES;
}

/* ------------------------------------------------------------------ */
/* combos                                                              */
/* ------------------------------------------------------------------ */

export function listCombos() {
  return db.prepare("SELECT * FROM combos ORDER BY name").all();
}

export function getCombo(name) {
  if (!name) return null;
  const row = db.prepare("SELECT * FROM combos WHERE name = ?").get(name);
  if (!row) return null;
  let members = [];
  try {
    members = JSON.parse(row.members || "[]");
  } catch {}
  return { ...row, members };
}

export function createCombo({ name, members = [], strategy = "priority", description = "" }) {
  const clean = String(name || "").trim();
  if (!clean) return { error: "the combo needs a name" };
  if (!Array.isArray(members) || !members.length) return { error: "the combo needs at least one target" };
  const existing = db.prepare("SELECT id FROM combos WHERE name = ?").get(clean);
  if (existing) return { error: "a combo with that name exists" };
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO combos (id, name, description, members, strategy, isActive, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 1, ?, ?)"
  ).run(id, clean, description, JSON.stringify(members), strategy, nowIso(), nowIso());
  return { id, name: clean };
}

export function updateCombo(id, patch) {
  const row = db.prepare("SELECT * FROM combos WHERE id = ?").get(id);
  if (!row) return { error: "not found" };
  db.prepare("UPDATE combos SET name = ?, description = ?, members = ?, strategy = ?, isActive = ?, updatedAt = ? WHERE id = ?").run(
    patch.name || row.name,
    patch.description ?? row.description,
    patch.members ? JSON.stringify(patch.members) : row.members,
    patch.strategy || row.strategy,
    patch.isActive === false ? 0 : patch.isActive === true ? 1 : row.isActive,
    nowIso(),
    id
  );
  return { updated: true };
}

export function deleteCombo(id) {
  return db.prepare("DELETE FROM combos WHERE id = ?").run(id).changes > 0;
}

/* ------------------------------------------------------------------ */
/* resilience: circuit breaker + model lockout                         */
/* ------------------------------------------------------------------ */

const BREAKER_THRESHOLD = () => numberSetting("breakerThreshold");
const BREAKER_COOLDOWN_MS = () => numberSetting("breakerCooldownMs") * 1;

export function breakerState(key) {
  const row = db.prepare("SELECT * FROM circuit_state WHERE key = ?").get(key);
  if (!row) return { state: "closed", failures: 0, openedAt: null, until: null };
  if (row.state === "open" && row.until && row.until <= nowIso()) {
    // the cooldown is over: half-open, the next call decides
    db.prepare("UPDATE circuit_state SET state = 'half-open' WHERE key = ?").run(key);
    return { state: "half-open", failures: row.failures, openedAt: row.openedAt, until: row.until };
  }
  return { state: row.state, failures: row.failures, openedAt: row.openedAt, until: row.until };
}

export function isAvailable(key) {
  const s = breakerState(key);
  return s.state !== "open";
}

export function reportSuccess(key) {
  db.prepare("INSERT INTO circuit_state (key, state, failures, openedAt, until) VALUES (?, 'closed', 0, NULL, NULL) ON CONFLICT(key) DO UPDATE SET state = 'closed', failures = 0, until = NULL").run(key);
}

export function reportFailure(key, error = "") {
  const s = breakerState(key);
  const failures = (s.failures || 0) + 1;
  if (failures >= BREAKER_THRESHOLD()) {
    const until = new Date(Date.now() + numberSetting("breakerCooldownMs")).toISOString();
    db.prepare("INSERT INTO circuit_state (key, state, failures, openedAt, until, lastError) VALUES (?, 'open', ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET state = 'open', failures = excluded.failures, openedAt = excluded.openedAt, until = excluded.until, lastError = excluded.lastError").run(
      key,
      failures,
      nowIso(),
      until,
      String(error).slice(0, 200)
    );
    return { state: "open", until };
  }
  db.prepare("INSERT INTO circuit_state (key, state, failures, openedAt, until, lastError) VALUES (?, 'closed', ?, NULL, NULL, ?) ON CONFLICT(key) DO UPDATE SET failures = excluded.failures, lastError = excluded.lastError").run(
    key,
    failures,
    String(error).slice(0, 200)
  );
  return { state: "closed", failures };
}

export function breakerSnapshot() {
  return db.prepare("SELECT * FROM circuit_state ORDER BY state DESC, failures DESC").all();
}

// A model that fails everywhere is locked out for a while, so the router does
// not keep trying it on every request.
const LOCKOUT_MS = () => numberSetting("modelLockoutMs");

export function modelLocked(model) {
  const row = db.prepare("SELECT * FROM model_lockout WHERE model = ?").get(model);
  if (!row) return false;
  if (row.until && row.until <= nowIso()) {
    db.prepare("DELETE FROM model_lockout WHERE model = ?").run(model);
    return false;
  }
  return true;
}

export function lockModel(model, error = "") {
  db.prepare("INSERT INTO model_lockout (model, until, reason, createdAt) VALUES (?, ?, ?, ?) ON CONFLICT(model) DO UPDATE SET until = excluded.until, reason = excluded.reason").run(
    model,
    new Date(Date.now() + LOCKOUT_MS()).toISOString(),
    String(error).slice(0, 200),
    nowIso()
  );
}

export function unlockModel(model) {
  return db.prepare("DELETE FROM model_lockout WHERE model = ?").run(model).changes > 0;
}

export function lockoutSnapshot() {
  return db.prepare("SELECT * FROM model_lockout ORDER BY until DESC").all();
}

/* ------------------------------------------------------------------ */
/* ordering                                                            */
/* ------------------------------------------------------------------ */

function targetCost(target) {
  const price = db.prepare("SELECT * FROM pricing WHERE provider = ? AND model = ?").get(target.conn.provider, target.model);
  if (price) return Number(price.inputPerMillion) + Number(price.outputPerMillion);
  const provider = db.prepare("SELECT * FROM pricing WHERE provider = ? AND model = '*'").get(target.conn.provider);
  if (provider) return Number(provider.inputPerMillion) + Number(provider.outputPerMillion);
  // unknown price: treat keyless as free, everything else as expensive
  return target.conn.registry ? 0 : 1000;
}

export function orderTargets(targets, strategy = "priority") {
  const list = [...targets];
  switch (strategy) {
    case "round-robin": {
      const counter = db.prepare("SELECT value FROM counters WHERE key = ?").get("rr:combo");
      const n = counter ? Number(counter.value) : 0;
      db.prepare("INSERT INTO counters (key, value) VALUES ('rr:combo', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(n + 1));
      const k = n % list.length;
      return list.slice(k).concat(list.slice(0, k));
    }
    case "random": {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
      return list;
    }
    case "least-used": {
      return list.sort((a, b) => (a.conn.usageCount || 0) - (b.conn.usageCount || 0));
    }
    case "fill-first":
      return list;
    case "cost-optimized":
      return list.sort((a, b) => targetCost(a) - targetCost(b));
    case "failover":
    case "priority":
    default:
      return list;
  }
}
