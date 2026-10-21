// Provider registry.
//
// Every provider is described by one adapter record so the router can dispatch
// a request without a per-provider code path. "protocol" decides the wire
// format, "baseUrl" where the upstream lives, "models" the catalogue we expose.
export const PROTOCOLS = {
  openai: {
    label: "OpenAI compatible",
    chatPath: "/chat/completions",
    modelsPath: "/models",
    listModels: true,
  },
  anthropic: {
    label: "Anthropic compatible",
    chatPath: "/messages",
    modelsPath: "/models",
    listModels: false,
  },
  gemini: {
    label: "Gemini compatible",
    chatPath: "/v1beta/models/{model}:generateContent",
    modelsPath: "/v1beta/models",
    listModels: true,
  },
};

export const BUILTIN_PROVIDERS = [
  {
    id: "openai",
    label: "OpenAI",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    authHeader: "authorization",
    authPrefix: "Bearer ",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-5",
    authHeader: "x-api-key",
    authPrefix: "",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    protocol: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    defaultModel: "gemini-2.5-flash",
    authHeader: "x-goog-api-key",
    authPrefix: "",
  },
  {
    id: "openai-compatible",
    label: "OpenAI compatible (custom)",
    protocol: "openai",
    baseUrl: "",
    defaultModel: "",
    authHeader: "authorization",
    authPrefix: "Bearer ",
    custom: true,
  },
  {
    id: "anthropic-compatible",
    label: "Anthropic compatible (custom)",
    protocol: "anthropic",
    baseUrl: "",
    defaultModel: "",
    authHeader: "x-api-key",
    authPrefix: "",
    custom: true,
  },
];

export const BUILTIN_MAP = new Map(BUILTIN_PROVIDERS.map((p) => [p.id, p]));

export function providerById(id) {
  if (BUILTIN_MAP.has(id)) return BUILTIN_MAP.get(id);
  // The registry knows more providers than the static table - a connection may
  // point at any of them.
  const record = registryRecord(id);
  if (record) {
    return {
      protocol: record.protocol || "openai",
      baseUrl: record.baseUrl || "",
      authHeader: record.auth?.header || (record.auth?.type === "none" ? "" : "authorization"),
      authPrefix: record.auth?.prefix ?? (record.auth?.type === "none" ? "" : "Bearer "),
      chatPath: record.chatPath || "/chat/completions",
      registry: record,
    };
  }
  return null;
}

// The registry is loaded lazily: providers.js and registry.js would otherwise
// import each other in a cycle.
let registryCache = null;
function registryRecord(id) {
  if (registryCache === null) {
    try {
      registryCache = globalThis.__magocoRegistry || [];
    } catch {
      registryCache = [];
    }
  }
  return registryCache.find((r) => r.id === id) || null;
}
export function setRegistryCache(records) {
  registryCache = Array.isArray(records) ? records : [];
}

/** A connection stores the secrets; the provider record holds the static shape. */
export function connectionShape(conn) {
  const base = providerById(conn.provider) || {
    protocol: "openai",
    baseUrl: conn.data?.baseUrl || "",
    authHeader: "authorization",
    authPrefix: "Bearer ",
  };
  const data = conn.data || {};
  return {
    ...base,
    id: conn.id,
    provider: conn.provider,
    name: conn.name,
    baseUrl: data.baseUrl || base.baseUrl || "",
    apiKey: data.apiKey || "",
    modelPrefix: data.modelPrefix || "",
    models: Array.isArray(data.models) ? data.models : [],
  };
}
