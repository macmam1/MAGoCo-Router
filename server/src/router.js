// The routing core: resolve a requested model to a concrete upstream, try the
// fallback chain when an attempt fails, translate between protocols and record
// usage.
import { db, nowIso } from "./db.js";
import { pickKey, reportKey as reportPoolKey } from "./keypool.js";
import { getCombo, orderTargets, isAvailable, reportSuccess, reportFailure, modelLocked, lockModel } from "./routing.js";
import { cacheGet, cacheSet } from "./metrics.js";
import { sessionId, remember, handoff } from "./session.js";
import { getSetting, boolSetting, numberSetting } from "./settings.js";
import { connectionShape, providerById } from "./providers.js";
import * as opencode from "./providers/opencode.js";
import { getRegistry, getCatalogue, transformFor } from "./registry.js";
import { aggregateChatStream, aggregateMessagesStream } from "./translate/sse.js";
import { toUpstream, toClient, toClientProtocol, upstreamUrl } from "./translate/index.js";

// Registry-backed providers that need no credentials are available from the first
// request: no setup, no registration. Their model lists come from the registry
// catalogue, so new upstream models show up on the next sync.
function keylessRegistryConnections() {
  return getRegistry()
    .filter((record) => record.auth?.type === "none" && record.group !== "local")
    .map((record) => ({
      id: record.id,
      provider: record.id,
      name: record.label,
      priority: 0,
      isActive: 1,
      baseUrl: record.baseUrl,
      apiKey: "",
      modelPrefix: "",
      models: getCatalogue(record.id).ids,
      protocol: record.protocol || "openai",
      authHeader: record.auth?.header || null,
      authPrefix: record.auth?.prefix || "",
      registry: record,
    }));
}

function listConnections() {
  return db
    .prepare(
      "SELECT id, provider, name, email, priority, isActive, data, createdAt, updatedAt FROM provider_connections ORDER BY priority ASC, createdAt ASC"
    )
    .all();
}

export function activeConnections() {
  // The keyless registry providers are already in the final shape - running them
  // through connectionShape() would drop their baseUrl, their model catalogue and
  // the registry record the transport needs.
  const keyless = keylessRegistryConnections().filter((c) => c.isActive === 1);
  const configured = listConnections()
    .filter((c) => c.isActive === 1)
    .map((c) => {
      let data = {};
      try {
        data = JSON.parse(c.data || "{}");
      } catch {}
      return connectionShape({ ...c, data });
    });
  return [...keyless, ...configured];
}

/**
 * Resolve "provider/model", "combo" or a bare model name into an ordered list
 * of upstream connections to try.
 */
export function resolveTargets(requestedModel, comboStrategy = "priority") {
  const connections = activeConnections();
  const model = String(requestedModel || "").trim();
  if (!model) return [];

  // exact id match first: some catalogues use prefixed ids such as
  // "openai/gpt-5.4-nano", which would otherwise be read as provider/model.
  const exact = connections.find((c) => (c.models || []).includes(model));
  if (exact) return [{ conn: exact, model, free: !!exact.registry }];

  // an alias points at another model name
  const alias = db.prepare("SELECT target FROM model_aliases WHERE name = ?").get(model);
  if (alias) return resolveTargets(alias.target, comboStrategy);

  // a combo is a named fallback chain
  const namedCombo = getCombo(model);
  if (namedCombo && namedCombo.isActive === 1) {
    const members = Array.isArray(namedCombo.members) ? namedCombo.members : [];
    const expanded = [];
    for (const member of members) {
      const sub = resolveTargets(member, comboStrategy);
      if (sub.length) expanded.push(...sub);
    }
    if (expanded.length) {
      const healthy = expanded.filter((t) => isAvailable(t.conn.provider));
      const list = healthy.length ? healthy : expanded;
      return orderTargets(list, namedCombo.strategy || comboStrategy);
    }
  }

  // the full id may be a catalogue entry of a configured connection
  const exactEverywhere = connections.filter((c) => (c.models || []).includes(model));
  if (exactEverywhere.length) {
    return exactEverywhere.map((conn) => ({ conn, model, free: !!conn.registry }));
  }

  // provider/model
  const slash = model.indexOf("/");
  if (slash > 0) {
    const provider = model.slice(0, slash);
    const rest = model.slice(slash + 1);
    const conn = connections.find((c) => c.provider === provider);
    if (conn) return [{ conn, model: rest || conn.modelPrefix || conn.defaultModel || "", free: !!conn.registry }];
    // The slash can belong to the model id itself (Qwen/Qwen2.5-7B-Instruct),
    // so the full id is tried on every configured connection.
    const asFullId = connections.filter((c) => !c.registry).map((c) => ({ conn: c, model, free: false }));
    if (asFullId.length) return asFullId;
    return [];
  }

  // bare model: the keyless registry providers first, then the configured ones.
  for (const conn of connections) {
    if (!conn.registry) continue;
    if ((conn.models || []).includes(model)) {
      return [{ conn, model, free: true }];
    }
  }
  const prefixed = connections.filter((c) => !c.registry && c.modelPrefix && model.startsWith(c.modelPrefix));
  if (prefixed.length) {
    return prefixed.map((conn) => ({ conn, model: model.slice(conn.modelPrefix.length).replace(/^\//, "") || conn.defaultModel || "", free: false }));
  }
  const exactMatches = connections.filter((c) => !c.registry && (c.models || []).includes(model));
  if (exactMatches.length) return exactMatches.map((conn) => ({ conn, model, free: false }));
  return connections
    .filter((c) => !c.registry)
    .map((conn) => ({ conn, model: conn.defaultModel || model, free: false }));
}

function buildHeaders(conn, keyOverride) {
  const headers = { "content-type": "application/json" };
  const key = keyOverride || conn.apiKey;
  if (key) {
    const header = conn.authHeader || "authorization";
    headers[header] = `${conn.authPrefix || ""}${key}`;
  }
  return headers;
}

// The key candidates for one connection: the healthy pool keys first, the
// connection key last. When the pool has nothing for this provider the
// connection key is used alone.
function keyCandidates(conn) {
  const list = [];
  try {
    for (const entry of pickKey(conn.provider, 3)) {
      if (entry.key) list.push({ key: entry.key, pooled: true });
    }
  } catch {}
  if (conn.apiKey) list.push({ key: conn.apiKey, pooled: false });
  if (!list.length) list.push({ key: "", pooled: false });
  return list.slice(0, 4);
}

const responseAliasMaps = new WeakMap();

export function recordUsage({ provider, model, apiKeyId, status, promptTokens, outputTokens, error }) {
  try {
    db.prepare(
      "INSERT INTO usage_events (ts, provider, model, apiKeyId, status, promptTokens, outputTokens, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(nowIso(), provider || null, model || null, apiKeyId || null, status || null, promptTokens || 0, outputTokens || 0, error || null);
  } catch {}
}

/**
 * Dispatch a chat request. `clientProtocol` is the protocol the caller speaks.
 * Returns { response, status }.
 */
export async function dispatch({ clientProtocol, body, apiKeyId, stream = false, headers = {} }) {
  const requestedModel = body?.model;
  if (modelLocked(String(requestedModel || ""))) {
    return {
      status: 429,
      payload: { error: { message: `model "${requestedModel}" is locked out after repeated failures`, type: "model_locked" } },
    };
  }
  const targets = boolSetting("autoFailover") ? resolveTargets(requestedModel, getSetting("defaultStrategy")) : resolveTargets(requestedModel).slice(0, 1);
  if (!targets.length) {
    return {
      status: 404,
      payload: { error: { message: `no upstream connection can serve model "${requestedModel}"`, type: "model_not_found" } },
    };
  }

  if (boolSetting("cacheEnabled") && !stream && body?.stream !== true) {
    const cached = cacheGet("cache", requestedModel, body);
    if (cached) {
      return { status: 200, payload: cached };
    }
  }
  const session = sessionId(headers || {}, body);
  const attempts = [];
  let handoffNote = null; // the last handoff that was actually sent
  for (const target of targets) {
    const conn = target.conn;
    const model = target.model || conn.defaultModel || requestedModel;
    const upstreamProtocol = conn.protocol || "openai";
    const isFree = target.free === true;
    const clientWantsStream = body?.stream === true;
    const transform = conn.registry ? transformFor(conn.registry) : null;

    let url;
    let payload;
    let headers;

    if (isFree && transform) {
      // Keyless provider: the provider module decides the endpoint, the headers
      // and any request transform (the OpenCode free tier needs both).
      url = transform.buildUrl(conn.registry, model);
      // the wire shape follows the endpoint, not the provider: one provider can
      // serve /chat/completions, /messages and /responses depending on the model
      const flat = url.endsWith("/responses");
      payload = { ...body, model, stream: true };
      const aliasMap = transform.applyRequest(payload, flat);
      headers = transform.buildHeaders(conn.registry, {
        session: opencode.generateSessionId(),
        stream: true,
      });
      responseAliasMaps.set(payload, aliasMap);
    } else {
      url = upstreamUrl(conn.baseUrl, upstreamProtocol, model, stream);
      payload = toUpstream(upstreamProtocol, body, model);
      headers = buildHeaders(conn);
    }

    // A model that is not reachable from this upstream must not break the
    // conversation: the handoff tells the new upstream what was said before.
    // It is computed per attempt - a target that fails must not consume it.
    if (session && boolSetting("relayContext")) {
      const note = handoff(session, model, conn.provider, body?.messages);
      if (note && Array.isArray(payload?.messages)) {
        payload = { ...payload, messages: [note, ...payload.messages] };
        handoffNote = note;
      }
    }

    // Try the key candidates in order. A key the pool rejected (401/403) or
    // that is throttled (429) is reported back and the next one takes over,
    // inside the same request.
    const candidates = keyCandidates(conn);
    let res = null;
    let lastError = "";
    let usedKey = null;
    for (const cand of candidates) {
      const attemptHeaders = cand.pooled
        ? { ...headers, [conn.authHeader || "authorization"]: `${conn.authPrefix || ""}${cand.key}` }
        : headers;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: attemptHeaders,
          body: JSON.stringify(payload),
        });
      } catch (err) {
        lastError = String(err.message || err);
        res = null;
        continue;
      }
      if (res.status !== 401 && res.status !== 403 && res.status !== 429) {
        usedKey = cand;
        break;
      }
      const text = await res.text().catch(() => "");
      if (cand.pooled) {
        reportPoolKey(conn.provider, cand.key, {
          status: res.status,
          retryAfter: res.headers.get("retry-after"),
          error: text.slice(0, 120),
        });
      }
      lastError = `key rejected with ${res.status}`;
      res = null;
    }

    try {
      if (!res) {
        attempts.push({ conn: conn.provider, status: 0, error: lastError || "no usable key" });
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        attempts.push({ conn: conn.provider, status: res.status, error: text.slice(0, 200) });
        if (res.status >= 500 || res.status === 429) reportFailure(conn.provider, text.slice(0, 120));
        continue;
      }
      reportSuccess(conn.provider);
      if (session) {
        try {
          remember(session, { model, provider: conn.provider, messages: body?.messages || [] });
        } catch {}
      }
      // The key that served the request is marked as working, so the rotation
      // keeps it in the pool and stops hammering it.
      if (usedKey?.pooled) {
        reportPoolKey(conn.provider, usedKey.key, { status: 200 });
      }
      const aliasMap = responseAliasMaps.get(payload);
      const upstreamType = res.headers.get("content-type") || "";
      let data = null;

      if (upstreamType.includes("text/event-stream")) {
        if (clientWantsStream) {
          // pass the stream straight through
          return {
            status: res.status,
            stream: res.body,
            headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
          };
        }
        if (url.endsWith("/messages")) {
          data = await aggregateMessagesStream(res.body, { model });
        } else {
          data = await aggregateChatStream(res.body, { model, requestedModel });
        }
      } else {
        data = await res.json().catch(() => null);
      }
      if (!data) {
        attempts.push({ conn: conn.provider, status: 502, error: "upstream returned a non-JSON body" });
        continue;
      }
      const usage = data.usage || data.usageMetadata || {};
      recordUsage({
        provider: conn.provider,
        model,
        apiKeyId,
        status: 200,
        promptTokens: usage.prompt_tokens || usage.input_tokens || usage.promptTokenCount || 0,
        outputTokens: usage.completion_tokens || usage.output_tokens || usage.candidatesTokenCount || 0,
      });
      let normalized = toClient(upstreamProtocol, data, requestedModel);
      if (!clientWantsStream) {
        try {
          cacheSet("cache", requestedModel, body, normalized, numberSetting("cacheTtlMs"));
        } catch {}
      }
      if (aliasMap && aliasMap.size) {
        normalized = transform ? transform.restoreResponse(normalized, aliasMap) : opencode.restoreToolNames(normalized, aliasMap);
      }
      return { status: 200, payload: toClientProtocol(clientProtocol, normalized, requestedModel) };
    } catch (err) {
      attempts.push({ conn: conn.provider, status: 502, error: String(err && err.message ? err.message : err) });
    }
  }

  recordUsage({ provider: null, model: requestedModel, apiKeyId, status: 502, error: "all upstreams failed" });
  return {
    status: 502,
    payload: {
      error: {
        message: "every upstream failed",
        type: "upstream_error",
        attempts,
      },
    },
  };
}

/** The catalogue we expose to clients. */
export function modelCatalogue() {
  const out = [];
  for (const conn of activeConnections()) {
    const models = (conn.models || []).length ? conn.models : conn.defaultModel ? [conn.defaultModel] : [];
    for (const m of models) {
      out.push({
        id: conn.modelPrefix ? `${conn.modelPrefix}/${m}` : `${conn.provider}/${m}`,
        object: "model",
        owned_by: conn.provider,
        created: Math.floor(Date.now() / 1000),
      });
    }
  }
  return out;
}
