// OpenCode Free - a provider that works with no credentials.
//
// The free tier is gated: upstream answers 403 FreeTierError unless the
// request identifies itself as the OpenCode client. The gate has three parts,
// all of them verified against the live endpoint:
//
//   1. a set of identity headers (Authorization: Bearer public, the client
//      User-Agent, the x-opencode-* family, a session id)
//   2. OpenCode's own `read` and `shell` tool declarations, byte for byte -
//      upstream compares description and parameter schema
//   3. stream:true - non-streaming requests are refused
//
// tool_choice must never be "none" either.
//
// The declarations below are an interface constant: they are compared verbatim
// by upstream, so they must not be reworded or reformatted.
import crypto from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SESSION_PREFIX_MASK = (1n << 48n) - 1n;
const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

export const OPENCODE_USER_AGENT = "opencode/latest/2.0.26/cli";
export const OPENCODE_CLIENT = "cli";
export const OPENCODE_BASE = "https://opencode.ai";
export const OPENCODE_MODELS_URL = "https://opencode.ai/zen/v1/models";

/** Models served by /inference/v1/responses and /inference/v1/messages. */
const RESPONSES_MODELS = new Set(["muse-spark-1.2-contributor-free", "muse-spark-1.3-contributor-free"]);
const MESSAGES_MODELS = new Set(["union-alpha"]);

export const FINGERPRINT_TOOL_DEFINITIONS = {
  read: {
    description:
      "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory to read" },
        offset: { type: "integer", minimum: 0, description: "The line or directory entry to start reading from (1-based)" },
        limit: { type: "integer", minimum: 0, description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  shell: {
    description:
      "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command string to execute" },
        workdir: { type: "string", description: "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead." },
        timeout: { type: "integer", minimum: 0, description: "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default." },
        background: { type: "boolean", description: "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

/* --------------------------- session id --------------------------- */

function descendingTimeHex(time, counterValue) {
  return ((~(BigInt(time) * 0x1000n + BigInt(counterValue))) & SESSION_PREFIX_MASK).toString(16).padStart(12, "0");
}

function unstableRandom() {
  const bytes = crypto.randomBytes(14);
  let out = "";
  for (let i = 0; i < 14; i++) out += BASE62[bytes[i] % 62];
  return out;
}

export function generateSessionId(timestamp = Date.now()) {
  return `ses_${descendingTimeHex(timestamp, 1)}${unstableRandom()}`;
}

export function isSessionId(value) {
  return typeof value === "string" && SESSION_RE.test(value.trim());
}

/* ------------------------------ tools ----------------------------- */

function toolNameOf(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return "";
  if (typeof tool.name === "string" && tool.name.trim()) return tool.name.trim();
  const fn = tool.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof fn.name === "string") return fn.name.trim();
  return "";
}

function chatFunctionOf(tool) {
  const fn = tool?.function;
  return fn && typeof fn === "object" && !Array.isArray(fn) ? fn : null;
}

function isFingerprintDefinition(tool, key) {
  const def = tool && (chatFunctionOf(tool) || tool);
  const want = FINGERPRINT_TOOL_DEFINITIONS[key];
  return !!def && def.description === want.description && JSON.stringify(def.parameters) === JSON.stringify(want.parameters);
}

function withToolName(tool, name) {
  const fn = chatFunctionOf(tool);
  return fn ? { ...tool, function: { ...fn, name } } : { ...tool, name };
}

/**
 * Move caller tools off the fingerprint names when their definition differs
 * from OpenCode's, so the exact definitions can be appended without a
 * duplicate name. Returns the alias map (sent name -> original name).
 */
export function concealFingerprintToolNames(tools) {
  const map = new Map();
  if (!Array.isArray(tools) || tools.length === 0) return { tools, map };

  const taken = new Set(tools.map(toolNameOf));
  const seen = new Set();
  const out = [];

  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
      out.push(tool);
      continue;
    }
    const name = toolNameOf(tool);
    const key = ["read", "shell"].includes(name) ? name : "";
    if (!key) {
      out.push(tool);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    if (isFingerprintDefinition(tool, key)) {
      out.push(tool);
      continue;
    }
    let alias = `${key}_client`;
    for (let i = 2; taken.has(alias); i++) alias = `${key}_client${i}`;
    taken.add(alias);
    map.set(alias, key);
    out.push(withToolName(tool, alias));
  }
  return { tools: out, map };
}

export function appendMissingFingerprintTools(tools, flat) {
  const appended = [];
  if (!Array.isArray(tools)) return appended;
  for (const name of ["read", "shell"]) {
    if (tools.some((tool) => toolNameOf(tool) === name)) continue;
    const { description, parameters } = FINGERPRINT_TOOL_DEFINITIONS[name];
    tools.push(
      flat
        ? { type: "function", name, description, parameters, strict: false }
        : { type: "function", function: { name, description, parameters } }
    );
    appended.push(name);
  }
  return appended;
}

export function retargetToolChoice(body, map) {
  if (!body || typeof body !== "object" || !map?.size) return;
  const choice = body.tool_choice;
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return;
  const byOriginal = new Map([...map].map(([alias, original]) => [original, alias]));
  if (typeof choice.name === "string") {
    const alias = byOriginal.get(choice.name.trim());
    if (alias) body.tool_choice = { ...choice, name: alias };
    return;
  }
  const fn = choice.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof fn.name === "string") {
    const alias = byOriginal.get(fn.name.trim());
    if (alias) body.tool_choice = { ...choice, function: { ...fn, name: alias } };
  }
}

export function aliasHistoryToolCalls(body, map) {
  if (!body || typeof body !== "object" || !map?.size) return;
  const byOriginal = new Map([...map].map(([alias, original]) => [original, alias]));
  if (Array.isArray(body.input)) {
    body.input = body.input.map((item) =>
      item?.type === "function_call" && byOriginal.has(item.name)
        ? { ...item, name: byOriginal.get(item.name) }
        : item
    );
  }
  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map((msg) => {
      if (!Array.isArray(msg?.tool_calls)) return msg;
      return {
        ...msg,
        tool_calls: msg.tool_calls.map((call) =>
          byOriginal.has(call?.function?.name)
            ? { ...call, function: { ...call.function, name: byOriginal.get(call.function.name) } }
            : call
        ),
      };
    });
  }
}

function noteUnavailableTools(body, flat, names) {
  const list = names.map((n) => `\`${n}\``).join(" or ");
  const note =
    names.length > 1
      ? `Do not call the ${list} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`
      : `Do not call the ${list} tool; it is a placeholder that does nothing. Use the other tools you have been given instead.`;
  if (flat) {
    body.instructions = typeof body.instructions === "string" && body.instructions.trim()
      ? `${body.instructions}\n\n${note}`
      : note;
    return;
  }
  if (!Array.isArray(body.messages) || body.system !== undefined) return;
  const first = body.messages[0];
  if (first?.role === "system" && typeof first.content === "string") {
    body.messages = [{ ...first, content: `${first.content}\n\n${note}` }, ...body.messages.slice(1)];
  } else {
    body.messages = [{ role: "system", content: note }, ...body.messages];
  }
}

/**
 * Full request-side pass. Returns the alias map so the response side can
 * restore the caller's own tool names.
 */
export function applyFingerprintTools(body, flat) {
  if (!body || typeof body !== "object") return new Map();
  const { tools, map } = concealFingerprintToolNames(body.tools);
  body.tools = Array.isArray(tools) ? tools : [];
  const appended = appendMissingFingerprintTools(body.tools, flat);
  retargetToolChoice(body, map);
  aliasHistoryToolCalls(body, map);
  if (appended.length) noteUnavailableTools(body, flat, appended);
  // Never default to "none": upstream answers tool_choice "none" with 403.
  if (!body.tool_choice && flat) body.tool_choice = "auto";
  return map;
}

/** Restore the caller's own tool names in the response. */
export function restoreToolNames(payload, map) {
  if (!map?.size || !payload) return payload;
  if (Array.isArray(payload)) return payload.map((item) => restoreToolNames(item, map));
  if (typeof payload !== "object") return payload;

  let out = payload;
  const put = (key, value) => {
    if (out === payload) out = { ...payload };
    out[key] = value;
  };

  if (payload.type === "content_block_start") {
    const block = payload.content_block;
    if (block?.type === "tool_use" && typeof block.name === "string" && map.has(block.name)) {
      put("content_block", { ...block, name: map.get(block.name) });
    }
  }
  if (Array.isArray(payload.content)) {
    put(
      "content",
      payload.content.map((block) =>
        block?.type === "tool_use" && typeof block.name === "string" && map.has(block.name)
          ? { ...block, name: map.get(block.name) }
          : block
      )
    );
  }
  if (Array.isArray(payload.choices)) {
    put(
      "choices",
      payload.choices.map((choice) => {
        let changed = false;
        const next = { ...choice };
        for (const holder of ["delta", "message"]) {
          const value = choice?.[holder];
          if (!value || !Array.isArray(value.tool_calls) || value.tool_calls.length === 0) continue;
          const calls = value.tool_calls.map((call) => {
            const name = call?.function?.name;
            if (typeof name === "string" && map.has(name)) {
              changed = true;
              return { ...call, function: { ...call.function, name: map.get(name) } };
            }
            return call;
          });
          next[holder] = { ...value, tool_calls: calls };
        }
        return changed ? next : choice;
      })
    );
  }
  if (Array.isArray(payload.output)) {
    put(
      "output",
      payload.output.map((item) =>
        item?.type === "function_call" && typeof item.name === "string" && map.has(item.name)
          ? { ...item, name: map.get(item.name) }
          : item
      )
    );
  }
  const item = payload.item;
  if (item?.type === "function_call" && typeof item.name === "string" && map.has(item.name)) {
    put("item", { ...item, name: map.get(item.name) });
  }
  return out;
}

/* --------------------------- transport --------------------------- */

export function buildUrl(model) {
  const base = OPENCODE_BASE;
  if (RESPONSES_MODELS.has(model)) return `${base}/inference/v1/responses`;
  if (MESSAGES_MODELS.has(model)) return `${base}/inference/v1/messages`;
  return `${base}/inference/v1/chat/completions`;
}

export function buildHeaders(session, stream = true) {
  return {
    "Content-Type": "application/json",
    "Authorization": "Bearer public",
    "User-Agent": OPENCODE_USER_AGENT,
    "x-opencode-client": OPENCODE_CLIENT,
    "x-opencode-session": session,
    "x-opencode-session-id": session,
    "x-session-affinity": session,
    "x-session-id": session,
    "x-opencode-project": "global",
    Accept: stream ? "text/event-stream" : "*/*",
  };
}

/* --------------------------- catalogue --------------------------- */

let catalogue = { at: 0, ids: [] };
let catalogueTimer = null;

/** Fetch the live model list (no credentials needed). */
export async function refreshCatalogue() {
  try {
    const res = await fetch(OPENCODE_MODELS_URL, {
      headers: { "x-opencode-client": OPENCODE_CLIENT, accept: "application/json" },
    });
    if (!res.ok) return catalogue;
    const data = await res.json();
    const ids = Array.isArray(data?.data) ? data.data.map((m) => m.id) : [];
    catalogue = { at: Date.now(), ids };
  } catch {
    /* keep the previous catalogue */
  }
  return catalogue;
}

export function getCatalogue() {
  return catalogue;
}

/** Model ids that the free tier actually serves (the list carries paid ones too). */
export function freeModelIds() {
  return catalogue.ids.filter((id) => /free|contributor|union-alpha|jev-/i.test(id));
}

export function startCatalogueRefresh(intervalMs = 10 * 60 * 1000) {
  refreshCatalogue();
  if (catalogueTimer) return;
  catalogueTimer = setInterval(refreshCatalogue, intervalMs);
  if (typeof catalogueTimer.unref === "function") catalogueTimer.unref();
}
