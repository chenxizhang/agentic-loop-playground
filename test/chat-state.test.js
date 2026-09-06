import test from "node:test";
import assert from "node:assert/strict";
import { createChatLedger, createPaintQueue, toolDetailPreview, matchesOperation, createOperationTracker } from "../public/chat-state.js";

test("message identities preserve whitespace, final replacement and replay deduplication", () => {
  const ledger = createChatLedger();
  ledger.apply({ id: 1, type: "assistant.delta", data: { messageId: "a", content: " \n" } });
  ledger.apply({ id: 2, type: "assistant.delta", data: { messageId: "a", content: "Hello" } });
  assert.equal(ledger.messages.get("a").content, " \nHello");
  ledger.apply({ id: 3, type: "assistant.message", data: { messageId: "a", content: " \nHello!" } });
  assert.equal(ledger.apply({ id: 3, type: "assistant.message", data: { messageId: "a", content: "duplicate" } }), null);
  ledger.apply({ id: 4, type: "assistant.message", data: { messageId: "tool-only", content: "" } });
  assert.equal([...ledger.messages.values()].filter((message) => message.content.trim()).length, 1);
  assert.equal(ledger.messages.get("a").content, " \nHello!");
});

test("same-named concurrent tools stay correlated and retain arguments on completion", () => {
  const ledger = createChatLedger();
  for (const id of ["one", "two"]) {
    ledger.apply({ type: "tool.started", data: { toolCallId: id, toolName: "read", arguments: { path: `${id}.js` } } });
  }
  ledger.apply({ type: "tool.completed", data: { toolCallId: "two", result: "contents", success: true } });
  assert.equal(ledger.tools.get("one").state, "running");
  assert.deepEqual(ledger.tools.get("two").arguments, { path: "two.js" });
  assert.equal(ledger.tools.get("two").state, "completed");
});

test("snapshots reconcile exact content, tools and cursor without duplicating later events", () => {
  const ledger = createChatLedger();
  const snapshot = { cursor: 20, messages: [{ id: "m", role: "assistant", content: "partial", complete: false }], tools: [] };
  ledger.apply({ type: "chat.snapshot", data: snapshot });
  assert.equal(ledger.apply({ id: 19, type: "assistant.delta", data: { messageId: "m", content: "stale" } }), null);
  ledger.apply({ id: 21, type: "assistant.delta", data: { messageId: "m", content: " continued" } });
  assert.equal(ledger.messages.get("m").content, "partial continued");
  assert.equal(ledger.apply({ type: "chat.snapshot", data: snapshot }), null);
});

test("4096 deltas queue one paint and retain all 64KiB", () => {
  const ledger = createChatLedger();
  const frames = [];
  const paints = [];
  const queue = createPaintQueue((keys) => paints.push(keys), {
    requestFrame: (callback) => { frames.push(callback); return frames.length; },
    cancelFrame() {},
    now: () => 0
  });
  for (let index = 0; index < 4096; index++) {
    const change = ledger.apply({ type: "assistant.delta", data: { messageId: "burst", content: "0123456789abcdef" } });
    queue.add(change.message);
  }
  assert.equal(frames.length, 1);
  frames[0]();
  assert.deepEqual(paints, [["burst"]]);
  assert.equal(ledger.messages.get("burst").content, "0123456789abcdef".repeat(4096));
});

test("paint queue throttles high-refresh callbacks and cancellation clears pending work", () => {
  let time = 0;
  const frames = new Map();
  const timers = new Map();
  let id = 0;
  const paints = [];
  const queue = createPaintQueue((keys) => paints.push(keys), {
    now: () => time,
    requestFrame: (callback) => { frames.set(++id, callback); return id; },
    cancelFrame: (key) => frames.delete(key),
    setTimer: (callback, delay) => { timers.set(++id, { callback, delay }); return id; },
    clearTimer: (key) => timers.delete(key)
  });

  function frame() {
    const [key, callback] = frames.entries().next().value;
    frames.delete(key);
    callback();
  }
  queue.add("a");
  frame();
  time = 4;
  queue.add("b");
  frame();
  assert.equal(paints.length, 1);
  assert.equal([...timers.values()][0].delay, 12);
  queue.cancel();
  assert.equal(timers.size, 0);
  assert.equal(frames.size, 0);
});

test("tool previews bound strings and nested objects before serializing them", () => {
  const value = { result: "X".repeat(5_000_000), trailing: Array(10_000).fill("not rendered") };
  const text = toolDetailPreview(value);
  assert.ok(text.length < 17000);
  assert.match(text, /5000000 characters total/);
  assert.match(text, /Preview truncated/);
  assert.doesNotMatch(text, /not rendered/);
});

test("tool previews bound property keys and escaped output as well as values", () => {
  for (const value of [{ ["K".repeat(5_000_000)]: "x" }, { nested: "\0".repeat(5_000_000) }]) {
    assert.ok(toolDetailPreview(value).length <= 17000, "serialized preview must retain its output bound");
  }
});

test("delayed terminal events cannot settle a newer accepted operation", () => {
  const pending = { sessionId: "session-b", generation: 2, operationId: "operation-b" };
  assert.equal(matchesOperation(pending, { sessionId: "session-a", generation: 1, operationId: "operation-a" }), false);
  assert.equal(matchesOperation(pending, { ...pending, operationId: "operation-a" }), false);
  assert.equal(matchesOperation(pending, { ...pending, sessionId: "session-a" }), false);
  assert.equal(matchesOperation(pending, { ...pending, generation: 1 }), false);
  assert.equal(matchesOperation(pending, pending), true);
});

test("operation tracking reconciles terminal-before-ACK and stale-idle-after-new-ACK", () => {
  const tracker = createOperationTracker();
  const first = { operationId: "first", generation: 1 };
  const second = { operationId: "second", generation: 1 };
  tracker.observe(first);
  tracker.accept(first);
  assert.equal(tracker.waiting, false);
  tracker.accept(second);
  tracker.observe(first);
  assert.equal(tracker.waiting, true);
  tracker.observe(second);
  assert.equal(tracker.waiting, false);
  tracker.clear();
  tracker.accept({ ...first, generation: 2 });
  tracker.observe(first);
  assert.equal(tracker.waiting, true);
});
