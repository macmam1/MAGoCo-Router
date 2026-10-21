// Provider registry.
//
// One declarative record per provider. The records describe how to talk to the
// upstream and where to find the live model list, so model catalogues and
// provider updates can be synced instead of being hard-coded in the source.
//
//   auth.type   none | bearer | header | query
//   modelsUrl   a catalogue endpoint that answers an OpenAI-style model list
//   transform   an optional request transform (see providers/*.js)
//
// A remote registry can be configured (REGISTRY_URL env var, or the
// "registryUrl" setting) to update the provider definitions themselves.
import * as opencode from "./providers/opencode.js";
import * as pollinations from "./providers/pollinations.js";

export const REGISTRY_VERSION = 1;

/** The built-in provider list. */
export const BUILTIN_REGISTRY = [
  /* ------------------------- keyless, ready at once ------------------------- */
  {
    id: "opencode",
    label: "OpenCode Free",
    group: "free",
    protocol: "openai",
    baseUrl: "https://opencode.ai",
    chatPath: "/inference/v1/chat/completions",
    messagesPath: "/inference/v1/messages",
    responsesPath: "/inference/v1/responses",
    modelsUrl: "https://opencode.ai/zen/v1/models",
    auth: { type: "none" },
    transform: "opencode",
    docs: "https://opencode.ai/docs/zen/",
    note: "Free tier, no account. The upstream gates on client identity headers and an exact tool declaration, which the provider module adds automatically.",
  },
  {
    id: "pollinations",
    label: "Pollinations",
    group: "free",
    protocol: "openai",
    baseUrl: "https://gen.pollinations.ai/v1",
    chatPath: "/chat/completions",
    modelsUrl: "https://gen.pollinations.ai/v1/models",
    auth: { type: "none" },
    docs: "https://pollinations.ai/",
    note: "Keyless, OpenAI compatible. No registration.",
  },

  /* ------------------------------ key required ------------------------------ */
  { id: "openai", label: "OpenAI", group: "paid", protocol: "openai", baseUrl: "https://api.openai.com/v1", chatPath: "/chat/completions", modelsUrl: "https://api.openai.com/v1/models", auth: { type: "bearer", header: "authorization", prefix: "Bearer " }, docs: "https://platform.openai.com/api-keys" },
  { id: "anthropic", label: "Anthropic", group: "paid", protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1", chatPath: "/messages", modelsUrl: "https://api.anthropic.com/v1/models", auth: { type: "header", header: "x-api-key", prefix: "" }, docs: "https://console.anthropic.com/settings/keys" },
  { id: "gemini", label: "Google Gemini", group: "paid", protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com", chatPath: "/v1beta/models/{model}:generateContent", modelsUrl: "https://generativelanguage.googleapis.com/v1beta/models", auth: { type: "header", header: "x-goog-api-key", prefix: "" }, docs: "https://aistudio.google.com/apikey" },
  { id: "openrouter", label: "OpenRouter", group: "paid", protocol: "openai", baseUrl: "https://openrouter.ai/api/v1", chatPath: "/chat/completions", modelsUrl: "https://openrouter.ai/api/v1/models", auth: { type: "bearer", header: "authorization", prefix: "Bearer " }, docs: "https://openrouter.ai/keys" },
  { id: "deepseek", label: "DeepSeek", group: "paid", protocol: "openai", baseUrl: "https://api.deepseek.com/v1", chatPath: "/chat/completions", modelsUrl: "https://api.deepseek.com/models", auth: { type: "bearer", header: "authorization", prefix: "Bearer " }, docs: "https://platform.deepseek.com/api_keys" },
  { id: "groq", label: "Groq", group: "paid", protocol: "openai", baseUrl: "https://api.groq.com/openai/v1", chatPath: "/chat/completions", modelsUrl: "https://api.groq.com/openai/v1/models", auth: { type: "bearer", header: "authorization", prefix: "Bearer " }, docs: "https://console.groq.com/keys" },
  { id: "mistral", label: "Mistral", group: "paid", protocol: "openai", baseUrl: "https://api.mistral.ai/v1", chatPath: "/chat/completions", modelsUrl: "https://api.mistral.ai/v1/models", auth: { type: "bearer", header: "authorization", prefix: "Bearer " }, docs: "https://console.mistral.ai/api-keys" },
  { id: "xai", label: "xAI Grok", group: "paid", protocol: "openai", baseUrl: "https://api.x.ai/v1", chatPath: "/chat/completions", modelsUrl: "https://api.x.ai/v1/models", auth: { type: "bearer", header: "authorization", prefix: "Bearer " }, docs: "https://console.x.ai" },
  { id: "cerebras", label: "Cerebras", group: "paid", protocol: "openai", baseUrl: "https://api.cerebras.ai/v1", chatPath: "/chat/completions", modelsUrl: "https://api.cerebras.ai/v1/models", auth: { type: "bearer", header: "authorization", prefix: "Bearer " }, docs: "https://cloud.cerebras.ai" },
  { id: "together", label: "Together AI", group: "paid", protocol: "openai", baseUrl: "https://api.together.xyz/v1", chatPath: "/chat/completions", modelsUrl: "https://api.together.xyz/v1/models", auth: { type: "bearer", header: "authorization", prefix: "Bearer " }, docs: "https://api.together.ai/settings/api-keys" },
  { id: "fireworks", label: "Fireworks AI", group: "paid", protocol: "openai", baseUrl: "https://api.fireworks.ai/inference/v1", chatPath: "/chat/completions", modelsUrl: "https://api.fireworks.ai/inference/v1/models", auth: { type: "bearer", header: "authorization", prefix: "Bearer " }, docs: "https://fireworks.ai/account/api-keys" },
  { id: "siliconflow", label: "SiliconFlow", group: "paid", protocol: "openai", baseUrl: "https://api.siliconflow.cn/v1", chatPath: "/chat/completions", modelsUrl: "https://api.siliconflow.cn/v1/models", auth: { type: "bearer", header: "authorization", prefix: "Bearer " }, docs: "https://cloud.siliconflow.cn/account/ak" },
  { id: "nvidia", label: "NVIDIA NIM", group: "paid", protocol: "openai", baseUrl: "https://integrate.api.nvidia.com/v1", chatPath: "/chat/completions", modelsUrl: "https://integrate.api.nvidia.com/v1/models", auth: { type: "bearer", header: "authorization", prefix: "Bearer " }, docs: "https://build.nvidia.com" },
  { id: "huggingface", label: "Hugging Face", group: "paid", protocol: "openai", baseUrl: "https://router.huggingface.co/v1", chatPath: "/chat/completions", modelsUrl: "https://router.huggingface.co/v1/models", auth: { type: "bearer", header: "authorization", prefix: "Bearer " }, docs: "https://huggingface.co/settings/tokens" },
  { id: "moonshot", label: "Moonshot (Kimi)", group: "paid", protocol: "openai", baseUrl: "https://api.moonshot.cn/v1", chatPath: "/chat/completions", modelsUrl: "https://api.moonshot.cn/v1/models", auth: { type: "bearer", header: "authorization", prefix: "Bearer " }, docs: "https://platform.moonshot.cn/console/api-keys" },
  { id: "zhipu", label: "Zhipu GLM", group: "paid", protocol: "openai", baseUrl: "https://open.bigmodel.cn/api/paas/v4", chatPath: "/chat/completions", modelsUrl: "https://open.bigmodel.cn/api/paas/v4/models", auth: { type: "bearer", header: "authorization", prefix: "Bearer " }, docs: "https://open.bigmodel.cn/usercenter/apikeys" },
  { id: "ollama", label: "Ollama (local)", group: "local", protocol: "openai", baseUrl: "http://127.0.0.1:11434/v1", chatPath: "/chat/completions", modelsUrl: "http://127.0.01:11434/v1/models", auth: { type: "none" }, docs: "https://ollama.com" },
];

/* ------------------------------ transforms ------------------------------ */

const TRANSFORMS = {
  opencode: {
    buildUrl(record, model) {
      return opencode.buildUrl(model);
    },
    buildHeaders(record, { session, stream }) {
      return opencode.buildHeaders(session, stream);
    },
    applyRequest(body, flat) {
      return opencode.applyFingerprintTools(body, flat);
    },
    restoreResponse(payload, map) {
      return opencode.restoreToolNames(payload, map);
    },
  },
  pollinations: {
    buildUrl(record, model) {
      return `${record.baseUrl}${record.chatPath}`;
    },
    buildHeaders() {
      return pollinations.buildHeaders();
    },
    applyRequest() {
      return new Map();
    },
    restoreResponse(payload) {
      return payload;
    },
  },
};

export function transformFor(record) {
  return (record && record.transform && TRANSFORMS[record.transform]) || null;
}

/* -------------------------------- sync -------------------------------- */

let registry = BUILTIN_REGISTRY.slice();
const catalogues = new Map(); // provider id -> { ids, at }

export function getRegistry() {
  return registry;
}

export function getCatalogue(providerId) {
  return catalogues.get(providerId) || { ids: [], at: 0 };
}

export function allCatalogues() {
  return Object.fromEntries(catalogues);
}

/** Replace the provider definitions from a remote registry document. */
export function applyRegistryDocument(doc) {
  if (!doc || !Array.isArray(doc.providers)) return false;
  registry = doc.providers;
  return true;
}

/** Fetch the live model list of one provider. */
export async function syncProviderModels(record) {
  if (!record?.modelsUrl) return { ids: [], ok: false };
  try {
    const headers = { accept: "application/json" };
    if (record.id === "opencode") headers["x-opencode-client"] = "cli";
    const res = await fetch(record.modelsUrl, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ids: [], ok: false, status: res.status };
    const data = await res.json().catch(() => null);
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : null;
    const ids = (list || []).map((m) => (typeof m === "string" ? m : m?.id)).filter(Boolean);
    if (!ids.length) return { ids: [], ok: false };
    catalogues.set(record.id, { ids, at: Date.now() });
    return { ids, ok: true };
  } catch (err) {
    return { ids: [], ok: false, error: String(err && err.message ? err.message : err) };
  }
}

/** Sync every provider that exposes a catalogue. */
export async function syncAll() {
  const results = await Promise.all(
    registry.map(async (record) => {
      if (!record.modelsUrl) return { id: record.id, ok: null, models: 0 };
      const r = await syncProviderModels(record);
      return { id: record.id, ok: r.ok, models: r.ids.length, status: r.status };
    })
  );
  return results;
}

/** Pull a remote registry document, if one is configured. */
export async function syncRemoteRegistry(url) {
  if (!url) return { ok: false, skipped: true };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { ok: false, status: res.status };
    const doc = await res.json();
    const applied = applyRegistryDocument(doc);
    return { ok: applied, providers: registry.length };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

let timer = null;

/** Keep the catalogues warm. */
export function startRegistrySync(intervalMs = 15 * 60 * 1000) {
  setTimeout(() => { syncAll(); }, 500);
  if (timer) return;
  timer = setInterval(() => { syncAll(); }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
}
