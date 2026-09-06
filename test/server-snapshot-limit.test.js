import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createSseSubscriber } from "../src/server-app.js";

test("a writable subscriber must recover a valid history larger than the pending queue budget", () => {
  const response = new EventEmitter();
  response.writableLength = 0;
  response.write = () => true;
  response.destroy = () => {};
  const subscriber = createSseSubscriber(response);
  try {
    subscriber.send({
      id: 1,
      type: "chat.snapshot",
      data: {
        cursor: 1,
        messages: Array.from({ length: 4 }, (_, index) => ({
          id: `message-${index}`, role: "assistant", content: "x".repeat(65536), complete: true
        })),
        tools: [],
        permissions: []
      }
    });

    assert.equal(subscriber.stats.closed, false, "valid history must not be mistaken for a slow-consumer queue");
  } finally {
    subscriber.close();
  }
});

test("a large initial snapshot does not consume ordinary queued-event credit", () => {
  const response = new EventEmitter();
  response.writableLength = 16;
  response.write = (frame) => { response.writableLength += Buffer.byteLength(frame); return false; };
  response.destroy = () => {};
  const subscriber = createSseSubscriber(response, { maxQueueBytes: 1024, maxSnapshotBytes: 8192 });
  try {
    subscriber.send({ id: 1, type: "chat.snapshot", data: { content: "x".repeat(4096) } });
    subscriber.send({ id: 2, type: "chat.status", data: { busy: false } });
    assert.equal(subscriber.stats.closed, false);
    assert.ok(subscriber.stats.queuedBytes > 0 && subscriber.stats.queuedBytes <= 1024);
    assert.ok(subscriber.stats.snapshotBytes > 4096);
    subscriber.send({ id: 3, type: "chat.snapshot", data: { content: "x".repeat(4096) } });
    assert.equal(subscriber.stats.closed, true, "only the first snapshot receives its separate budget");
  } finally {
    subscriber.close();
  }
});

test("an initial snapshot larger than its explicit limit is rejected", () => {
  const response = new EventEmitter();
  response.writableLength = 0;
  response.write = () => { throw new Error("Oversized snapshot must not be written"); };
  response.destroy = () => {};
  const subscriber = createSseSubscriber(response, { maxSnapshotBytes: 100 });
  subscriber.send({ id: 1, type: "chat.snapshot", data: { content: "x".repeat(101) } });
  assert.equal(subscriber.stats.closed, true);
});

test("tiny delta bursts coalesce under backpressure without losing content or ordering", () => {
  const response = new EventEmitter();
  const frames = [];
  let writable = false;
  response.writableLength = 0;
  response.write = (frame) => { frames.push(frame); return writable; };
  response.destroy = () => {};
  const subscriber = createSseSubscriber(response);
  try {
    subscriber.send({ id: 1, type: "chat.status", data: { busy: true } });
    for (let index = 0; index < 4096; index++) {
      subscriber.send({
        id: index + 2, type: "assistant.delta", operationId: "operation",
        data: { messageId: "message", content: "0123456789abcdef" }
      });
    }
    subscriber.send({ id: 4098, type: "session.idle", data: {} });
    assert.equal(subscriber.stats.closed, false);
    assert.ok(subscriber.stats.highWaterMark < 70 * 1024);
    writable = true;
    response.emit("drain");
    assert.equal(subscriber.stats.queuedBytes, 0);
    assert.equal(frames.length, 3);
    const delta = JSON.parse(frames[1].split("\n").find((line) => line.startsWith("data: ")).slice(6));
    assert.equal(delta.id, 4097);
    assert.equal(delta.data.content, "0123456789abcdef".repeat(4096));
    assert.match(frames[2], /event: session.idle/);
  } finally {
    subscriber.close();
  }
});
