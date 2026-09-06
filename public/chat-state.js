export function createChatLedger() {
  const messages = new Map();
  const tools = new Map();
  let cursor = 0;
  let fallbackMessage = null;
  let fallbackIndex = 0;

  function messageId(data, final) {
    if (data.messageId) return data.messageId;
    fallbackMessage ??= `message-${++fallbackIndex}`;
    const id = fallbackMessage;
    if (final) fallbackMessage = null;
    return id;
  }

  return {
    messages,
    tools,
    apply(event) {
      const data = event.data ?? {};
      if (event.type === "chat.snapshot") {
        if (Number(data.cursor) < cursor) return null;
        messages.clear();
        tools.clear();
        for (const message of data.messages ?? []) messages.set(message.id, { ...message });
        for (const tool of data.tools ?? []) tools.set(tool.toolCallId, { ...tool });
        cursor = Number(data.cursor) || 0;
        fallbackMessage = null;
        return { snapshot: true };
      }
      const sequence = Number(event.id ?? event.sequence);
      if (sequence && sequence <= cursor) return null;
      if (sequence) cursor = sequence;
      if (event.type === "chat.reset") {
        messages.clear();
        tools.clear();
        fallbackMessage = null;
        return { snapshot: true };
      }
      if (event.type === "user.message" || event.type === "assistant.delta" || event.type === "assistant.message") {
        const user = event.type === "user.message";
        const final = event.type !== "assistant.delta";
        const id = user ? data.messageId ?? `user-${++fallbackIndex}` : messageId(data, final);
        const previous = messages.get(id);
        const content = typeof data.content === "string" ? data.content : "";
        const record = {
          id,
          role: user ? "user" : "assistant",
          content: final ? content : (previous?.content ?? "") + content,
          complete: final
        };
        messages.set(id, record);
        return { message: id };
      }
      if (event.type === "tool.started" || event.type === "tool.completed") {
        const id = data.toolCallId;
        if (!id) throw new Error("Tool event is missing its call identity.");
        const record = {
          ...tools.get(id),
          ...data,
          state: event.type === "tool.started" ? "running" : data.success === false ? "failed" : "completed"
        };
        tools.set(id, record);
        return { tool: id };
      }
      return {};
    }
  };
}

export function createPaintQueue(paint, {
  requestFrame = requestAnimationFrame,
  cancelFrame = cancelAnimationFrame,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = () => performance.now(),
  interval = 16
} = {}) {
  const dirty = new Set();
  let frame = null;
  let timer = null;
  let lastPaint = -Infinity;

  function flush() {
    frame = null;
    const delay = interval - (now() - lastPaint);
    if (delay > 0) {
      timer = setTimer(() => {
        timer = null;
        frame = requestFrame(flush);
      }, delay);
      return;
    }
    const keys = [...dirty];
    dirty.clear();
    lastPaint = now();
    paint(keys);
  }

  return {
    add(key) {
      dirty.add(key);
      if (frame === null && timer === null) frame = requestFrame(flush);
    },
    cancel() {
      if (frame !== null) cancelFrame(frame);
      if (timer !== null) clearTimer(timer);
      frame = null;
      timer = null;
      dirty.clear();
    }
  };
}

export function toolDetailPreview(value, limit = 16384) {
  let remaining = limit;
  let truncated = false;
  const seen = new WeakSet();
  function preview(item, depth = 0) {
    if (remaining <= 0 || depth > 6) {
      truncated = true;
      return "[preview limit]";
    }
    if (typeof item === "string") {
      const text = item.slice(0, remaining);
      remaining -= text.length;
      if (text.length < item.length) {
        truncated = true;
        return `${text} [${item.length} characters total]`;
      }
      return text;
    }
    if (item === null || typeof item !== "object") return item;
    if (seen.has(item)) return "[circular]";
    seen.add(item);
    const result = Array.isArray(item) ? [] : {};
    let count = 0;
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      if (++count > 100 || remaining <= 0) {
        truncated = true;
        break;
      }
      remaining -= key.length + 4;
      result[key] = preview(item[key], depth + 1);
    }
    return result;
  }
  const bounded = preview(value);
  const text = typeof bounded === "string" ? bounded : JSON.stringify(bounded, null, 2);
  return `${text ?? ""}${truncated ? `\n[Preview truncated to a ${limit}-character budget.]` : ""}`;
}
