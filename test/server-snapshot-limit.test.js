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
