// Server-sent-event handling.
//
// The keyless free tier answers with a stream even when the client did not ask
// for one, so a non-streaming client needs the stream folded back into a
// single JSON body.

/** Parse an SSE byte stream into its events. */
export async function* sseEvents(body) {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = [];
        for (const line of raw.split("\n")) {
          if (line.startsWith("data:")) data.push(line.slice(5).trim());
        }
        if (data.length) yield data.join("\n");
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith("data:")) yield tail.slice(5).trim();
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

/** Fold a chat-completions SSE stream into one JSON payload. */
export async function aggregateChatStream(body, { model, requestedModel } = {}) {
  const content = [];
  const toolCalls = new Map();
  let role = "assistant";
  let finishReason = "stop";
  let usage = null;

  for await (const data of sseEvents(body)) {
    if (data === "[DONE]") break;
    let payload;
    try { payload = JSON.parse(data); } catch { continue; }
    if (payload.usage) usage = payload.usage;
    const choice = payload.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || choice.message || {};
    if (delta.role) role = delta.role;
    if (typeof delta.content === "string" && delta.content) content.push(delta.content);
    for (const call of delta.tool_calls || []) {
      const id = call.id || `call_${toolCalls.size}`;
      const existing = toolCalls.get(id) || { id, type: "function", function: { name: "", arguments: "" } };
      if (call.function?.name) existing.function.name = call.function.name;
      if (call.function?.arguments) existing.function.arguments += call.function.arguments;
      toolCalls.set(id, existing);
    }
  }

  const message = { role, content: content.join("") || null };
  if (toolCalls.size) message.tool_calls = [...toolCalls.values()];
  return {
    id: `chatcmpl-${Date.now().toString(36)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || requestedModel,
    choices: [{ index: 0, message, finish_reason: toolCalls.size ? "tool_calls" : finishReason }],
    usage,
  };
}

/** Fold an Anthropic SSE stream into one message payload. */
export async function aggregateMessagesStream(body, { model } = {}) {
  const blocks = [];
  let stopReason = "end_turn";
  let usage = null;

  for await (const data of sseEvents(body)) {
    if (data === "[DONE]") break;
    let event;
    try { event = JSON.parse(data); } catch { continue; }
    if (event.type === "content_block_start" && event.content_block?.type === "text") {
      blocks.push({ type: "text", text: "" });
    } else if (event.type === "content_block_delta") {
      const block = blocks[event.index ?? blocks.length - 1];
      if (block && typeof event.delta?.text === "string") block.text += event.delta.text;
    } else if (event.type === "message_delta" && event.delta?.stop_reason) {
      stopReason = event.delta.stop_reason;
    } else if (event.usage) {
      usage = event.usage;
    }
  }

  return {
    id: `msg_${Date.now().toString(36)}`,
    type: "message",
    role: "assistant",
    model,
    content: blocks.length ? blocks : [{ type: "text", text: "" }],
    stop_reason: stopReason,
    usage: usage ? { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } : undefined,
  };
}
