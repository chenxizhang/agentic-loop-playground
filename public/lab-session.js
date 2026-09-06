export function sameConversation(left, right) {
  return Boolean(left && right && left.workspaceId === right.workspaceId &&
    left.labId === right.labId && left.conversationId === right.conversationId &&
    left.generation === right.generation);
}

export function conversationStorageKey(route, kind) {
  return `loop:${route.workspaceId}:${route.labId}:${route.conversationId}:${kind}`;
}

export function visibleSnapshot(snapshot, hiddenIds = []) {
  const hidden = new Set(hiddenIds);
  return {
    ...snapshot,
    messages: (snapshot.messages ?? []).filter((message) => !hidden.has(message.id)),
    tools: (snapshot.tools ?? []).filter((tool) => !hidden.has(tool.toolCallId))
  };
}

export function prepareDelivery(previous, prompt, createId = () => crypto.randomUUID()) {
  if (previous !== null && (typeof previous !== "object" ||
      typeof previous.requestId !== "string" || typeof previous.prompt !== "string")) {
    throw new Error("Saved delivery state is invalid. Inspect /status or start a new conversation before retrying.");
  }
  return previous?.prompt === prompt ? previous : { requestId: createId(), prompt };
}
