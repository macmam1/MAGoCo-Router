// Request/response translation between the client protocol and the upstream
// protocol. Only the shapes MAGoCo Router needs are handled: chat completions
// with text content plus tool calls.
import { PROTOCOLS } from "../providers.js";

/** client -> upstream */
export function toUpstream(protocol, body, model) {
  if (protocol === "anthropic") {
    const messages = (body.messages || []).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: Array.isArray(m.content)
        ? m.content
        : [{ type: "text", text: String(m.content ?? "") }],
    }));
    const out = {
      model,
      max_tokens: body.max_tokens || body.max_completion_tokens || 4096,
      messages,
      stream: !!body.stream,
    };
    if (body.temperature != null) out.temperature = body.temperature;
    if (body.top_p != null) out.top_p = body.top_p;
    if (body.tools?.length) {
      out.tools = body.tools.map((t) => ({
        name: t.function?.name || t.name,
        description: t.function?.description || t.description || "",
        input_schema: t.function?.parameters || t.parameters || { type: "object" },
      }));
    }
    if (body.tool_choice) {
      const tc = body.tool_choice;
      out.tool_choice = typeof tc === "string" ? { type: tc } : tc;
    }
    return out;
  }

  if (protocol === "gemini") {
    const contents = (body.messages || []).map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: Array.isArray(m.content)
        ? m.content.map((c) => (c.type === "text" ? { text: c.text } : { functionCall: c.function })).filter(Boolean)
        : [{ text: String(m.content ?? "") }],
    }));
    const out = { contents, generationConfig: {} };
    if (body.temperature != null) out.generationConfig.temperature = body.temperature;
    if (body.top_p != null) out.generationConfig.topP = body.top_p;
    if (body.max_tokens) out.generationConfig.maxOutputTokens = body.max_tokens;
    return out;
  }

  // openai -> openai
  const out = { ...body, model };
  return out;
}

/** upstream -> client */
export function toClient(protocol, payload, requestedModel) {
  if (protocol === "anthropic") {
    const parts = [];
    for (const block of payload.content || []) {
      if (block.type === "text") parts.push({ type: "text", text: block.text });
      else if (block.type === "tool_use") {
        parts.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
      }
    }
    return {
      id: payload.id,
      type: "message",
      role: "assistant",
      model: payload.model || requestedModel,
      content: parts,
      stop_reason: payload.stop_reason,
      stop_sequence: payload.stop_sequence,
      usage: payload.usage
        ? { input_tokens: payload.usage.input_tokens, output_tokens: payload.usage.output_tokens }
        : undefined,
    };
  }

  if (protocol === "gemini") {
    const text = (payload.candidates?.[0]?.content?.parts || [])
      .filter((p) => typeof p.text === "string")
      .map((p) => p.text)
      .join("");
    const toolCalls = (payload.candidates?.[0]?.content?.parts || [])
      .filter((p) => p.functionCall)
      .map((p, i) => ({
        id: `call_${i}`,
        type: "function",
        function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) },
      }));
    const message = { role: "assistant", content: text || null };
    if (toolCalls.length) message.tool_calls = toolCalls;
    return {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: [{ index: 0, message, finish_reason: toolCalls.length ? "tool_calls" : "stop" }],
      usage: payload.usageMetadata
        ? {
            prompt_tokens: payload.usageMetadata.promptTokenCount,
            completion_tokens: payload.usageMetadata.candidatesTokenCount,
            total_tokens: payload.usageMetadata.totalTokenCount,
          }
        : undefined,
    };
  }

  // openai -> openai
  return payload;
}

export function upstreamUrl(baseUrl, protocol, model, stream) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const spec = PROTOCOLS[protocol] || PROTOCOLS.openai;
  if (protocol === "gemini") {
    return `${base}/v1beta/models/${encodeURIComponent(model)}:${stream ? "streamGenerateContent" : "generateContent"}`;
  }
  return `${base}${spec.chatPath}`;
}

/** OpenAI-shaped payload -> Anthropic-shaped payload (the client speaks Anthropic). */
export function openAiToAnthropic(payload, model) {
  const choice = payload.choices?.[0];
  const msg = choice?.message || {};
  const content = [];
  if (typeof msg.content === "string" && msg.content) content.push({ type: "text", text: msg.content });
  for (const tc of msg.tool_calls || []) {
    content.push({
      type: "tool_use",
      id: tc.id,
      name: tc.function?.name,
      input: (() => {
        try { return JSON.parse(tc.function?.arguments || "{}"); } catch { return {}; }
      })(),
    });
  }
  return {
    id: payload.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: payload.model || model,
    content: content.length ? content : [{ type: "text", text: "" }],
    stop_reason: choice?.finish_reason === "tool_calls" ? "tool_use" : choice?.finish_reason || "end_turn",
    usage: payload.usage
      ? { input_tokens: payload.usage.prompt_tokens, output_tokens: payload.usage.completion_tokens }
      : undefined,
  };
}

/** Final shaping: the payload was normalised to OpenAI, now convert to the client's protocol. */
export function toClientProtocol(clientProtocol, payload, model) {
  if (clientProtocol === "anthropic") return openAiToAnthropic(payload, model);
  return payload;
}
