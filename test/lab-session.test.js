import test from "node:test";
import assert from "node:assert/strict";
import { sameConversation, conversationStorageKey, visibleSnapshot, prepareDelivery } from "../public/lab-session.js";
import { createChatLedger } from "../public/chat-state.js";

const route = { workspaceId: "workspace", labId: "01", conversationId: "conversation", generation: 1 };

test("browser routes reject another workspace, lab, conversation or generation", () => {
  assert.equal(sameConversation(route, { ...route }), true);
  for (const field of Object.keys(route)) {
    assert.equal(sameConversation(route, { ...route, [field]: "other" }), false);
  }
  assert.equal(sameConversation(null, route), false);
});

test("draft and view storage is workspace/lab/conversation scoped", () => {
  const key = conversationStorageKey(route, "draft");
  for (const field of ["workspaceId", "labId", "conversationId"]) {
    assert.notEqual(key, conversationStorageKey({ ...route, [field]: "other" }, "draft"));
  }
  assert.notEqual(key, conversationStorageKey(route, "hidden"));
});

test("clearing the view does not mutate durable transcript or hide new content", () => {
  const original = {
    messages: [{ id: "old", content: "retained" }, { id: "new", content: "visible" }],
    tools: [{ toolCallId: "tool", result: "retained" }]
  };
  const view = visibleSnapshot(original, ["old", "tool"]);
  assert.deepEqual(view.messages.map((message) => message.id), ["new"]);
  assert.deepEqual(view.tools, []);
  assert.equal(original.messages.length, 2);
  assert.equal(original.tools.length, 1);
});

test("explicit lab navigation resets a prior conversation's sequence fence", () => {
  const ledger = createChatLedger();
  ledger.apply({ type: "chat.snapshot", data: { cursor: 100, messages: [{ id: "a", content: "Lab A" }] } });
  ledger.reset();
  assert.ok(ledger.apply({ type: "chat.snapshot", data: { cursor: 1, messages: [{ id: "b", content: "Lab B" }] } }));
  assert.deepEqual([...ledger.messages.keys()], ["b"]);
});

test("an unconfirmed delivery reuses its key only for the same exact prompt", () => {
  const first = prepareDelivery(null, "  Preserve my prompt\n", () => "first");
  assert.equal(prepareDelivery(first, "  Preserve my prompt\n", () => "unused"), first);
  assert.deepEqual(prepareDelivery(first, "New prompt", () => "second"), { requestId: "second", prompt: "New prompt" });
  assert.throws(() => prepareDelivery({ requestId: 1 }, "prompt"), /Saved delivery state is invalid/);
});
