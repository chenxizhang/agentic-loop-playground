import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSseSubscriber, createWorkshopServer } from "../src/server-app.js";
import { startChatTestServer } from "./helpers/chat-test-server.js";

const headers = { "Content-Type": "application/json", "X-Loop-Lab": "browser" };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function temporaryWorkspace(t) {
  const workspace = mkdtempSync(join(tmpdir(), "loop-http-chat-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  return workspace;
}

function post(url, route, body = {}, extraHeaders = {}) {
  return fetch(`${url}${route}`, { method: "POST", headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body) });
}

async function events(url) {
  const controller = new AbortController();
  const response = await fetch(`${url}/api/copilot/events`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(type) {
      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.split("\n").find((line) => line.startsWith("data: "));
          if (!data) continue;
          const event = JSON.parse(data.slice(6));
          assert.equal(frame.split("\n").find((line) => line.startsWith("id: ")), `id: ${event.id}`);
          if (!type || event.type === type) return event;
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error("SSE disconnected before the expected event.");
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    close() {
      controller.abort();
      return reader.cancel().catch((error) => {
        if (error.name !== "AbortError") throw error;
      });
    }
  };
}

test("real anonymous server remains live without the default SDK; start/send return 503", { timeout: 15_000 }, async (t) => {
  const workspace = temporaryWorkspace(t);
  const app = createWorkshopServer({ workspace });
  const url = await app.listen({ port: 0 });
  try {
    assert.equal((await fetch(`${url}/api/health`)).status, 200);
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await fetch(`${url}/api/lessons`)).status, 200);
    const status = await (await fetch(`${url}/api/copilot/status`)).json();
    assert.equal(status.state, "unavailable");
    assert.equal(status.code, "SDK_NOT_INSTALLED");
    for (const [route, body] of [["start", {}], ["message", { prompt: "Keep my draft" }]]) {
      const response = await post(url, `/api/copilot/${route}`, body);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, "SDK_NOT_INSTALLED");
    }
    const snapshot = await (await fetch(`${url}/api/copilot/snapshot`)).json();
    assert.deepEqual(snapshot.messages, []);
    assert.equal(snapshot.status.busy, false);
  } finally {
    await app.close();
  }
});

test("real HTTP/SSE vertical slice uses the service, authoritative reconnect and isolated child cwd", { timeout: 20_000 }, async (t) => {
  const workspace = temporaryWorkspace(t);
  const child = await startChatTestServer({ workspace });
  let stream;
  let reconnect;
  try {
    const info = await (await fetch(`${child.url}/api/info`)).json();
    assert.equal(info.workspace, workspace);
    assert.equal((await post(child.url, "/api/copilot/start")).status, 200);
    stream = await events(child.url);
    const initial = await stream.next("chat.snapshot");
    assert.equal(initial.id, initial.data.cursor);
    assert.equal(initial.data.status.state, "ready");
    const display = "  Exact prompt\r\n ";
    const sent = await post(child.url, "/api/copilot/message", { prompt: display, generation: initial.generation });
    assert.equal(sent.status, 202);
    const accepted = await sent.json();
    assert.ok(accepted.operationId);
    const user = await stream.next("user.message");
    assert.equal(user.data.content, display);
    assert.equal(user.data.messageId, accepted.messageId);
    assert.equal((await post(child.url, "/api/copilot/message", { prompt: "duplicate" })).status, 409);
    const expected = " \nExact answer";
    await child.command("emit", { events: [
      { type: "user.message", data: { content: "Hidden model context echo" } },
      { type: "assistant.message", data: { messageId: "tool-only", content: "" } },
      { type: "tool.execution_start", data: { toolCallId: "tool", toolName: "read", arguments: { path: "src/example.js", token: "secret-value" } } },
      { type: "tool.execution_complete", data: { toolCallId: "tool", success: false, result: { content: "Public output" }, error: { message: "Public error" } } },
      { type: "assistant.message_delta", data: { messageId: "answer", deltaContent: " \n" } },
      { type: "assistant.message_delta", data: { messageId: "answer", deltaContent: "Exact answer" } },
      { type: "assistant.message", data: { messageId: "answer", content: expected } },
      { type: "session.idle" }
    ] });
    const completedTool = await stream.next("tool.completed");
    assert.equal(completedTool.data.success, false);
    assert.equal(completedTool.data.arguments.token, "[redacted]");
    const delta = await stream.next("assistant.delta");
    const final = await stream.next("assistant.message");
    assert.equal(delta.data.messageId, final.data.messageId);
    assert.equal(final.data.content, expected);
    await stream.next("session.idle");
    await stream.close();
    stream = null;
    reconnect = await events(child.url);
    const snapshot = (await reconnect.next("chat.snapshot")).data;
    assert.equal(snapshot.status.busy, false);
    assert.equal(snapshot.messages.filter((message) => message.role === "user").length, 1);
    assert.equal(snapshot.messages.at(-1).content, expected);
    assert.equal(snapshot.tools.length, 1);
    assert.equal(snapshot.tools[0].state, "failed");
    assert.deepEqual((await child.command("sent"))[0].sent, [{ prompt: display }]);
    const current = await (await fetch(`${child.url}/api/copilot/snapshot`)).json();
    assert.deepEqual(current.messages, snapshot.messages);
    assert.ok(current.cursor >= snapshot.cursor);
    const progress = await (await fetch(`${child.url}/api/progress`)).json();
    assert.deepEqual(progress.completed, {});
  } finally {
    await stream?.close();
    await reconnect?.close();
    await child.close();
  }
});

test("real permission replay, approval, reset rejection and stale-generation HTTP conflicts", { timeout: 20_000 }, async (t) => {
  const child = await startChatTestServer({ workspace: temporaryWorkspace(t) });
  let stream;
  try {
    await post(child.url, "/api/copilot/start");
    stream = await events(child.url);
    const initial = await stream.next("chat.snapshot");
    const decision = child.command("permission", { kind: "shell", fullCommandText: "echo protected" });
    const requested = await stream.next("permission.requested");
    assert.equal((await post(child.url, "/api/copilot/permission", {
      requestId: requested.data.requestId, decision: "approve"
    }, { Origin: "http://evil.invalid" })).status, 403);
    assert.equal((await post(child.url, "/api/copilot/permission", {
      requestId: requested.data.requestId, decision: "approve", generation: initial.generation
    })).status, 200);
    assert.deepEqual(await decision, { kind: "approve-once", approvedInteractively: true });
    const rejected = child.command("permission", { kind: "write", fileName: "protected.js" });
    const pending = await stream.next("permission.requested");
    await stream.close();
    stream = await events(child.url);
    const restored = await stream.next("chat.snapshot");
    assert.equal(restored.data.permissions[0].requestId, pending.data.requestId);
    assert.equal((await post(child.url, "/api/copilot/reset", { generation: initial.generation })).status, 200);
    assert.equal((await rejected).kind, "reject");
    assert.equal((await post(child.url, "/api/copilot/permission", {
      requestId: pending.data.requestId, decision: "approve"
    })).status, 409);
    const stale = await post(child.url, "/api/copilot/start", { generation: initial.generation });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, "STALE_GENERATION");
    const snapshot = await (await fetch(`${child.url}/api/copilot/snapshot`)).json();
    assert.deepEqual(snapshot.messages, []);
    assert.deepEqual(snapshot.permissions, []);
  } finally {
    await stream?.close();
    await child.close();
  }
});

test("all existing protected routes retain origin, host and header checks; UTF-8 bodies are bounded", { timeout: 15_000 }, async (t) => {
  const child = await startChatTestServer({ workspace: temporaryWorkspace(t) });
  const { url } = child;
  try {
    for (const route of ["/api/check/01", "/api/grade", "/api/scenario/reset", "/api/repository-analysis",
      "/api/copilot/start", "/api/copilot/message", "/api/copilot/permission", "/api/copilot/abort", "/api/copilot/reset"]) {
      for (const invalid of [{ Origin: "http://evil.invalid" }, { "X-Loop-Lab": "invalid" }]) {
        assert.equal((await post(url, route, {}, invalid)).status, 403, route);
      }
      const hostileHostStatus = await new Promise((resolveStatus, rejectStatus) => {
        const req = request(`${url}${route}`, {
          method: "POST", headers: { ...headers, Host: "evil.invalid" }
        }, (response) => {
          response.resume();
          response.on("end", () => resolveStatus(response.statusCode));
        });
        req.on("error", rejectStatus);
        req.end("{}");
      });
      assert.equal(hostileHostStatus, 403, route);
    }
    const large = await post(url, "/api/copilot/message", { prompt: "\u00e9".repeat(5000) });
    assert.equal(large.status, 413);
    assert.equal((await post(url, "/api/copilot/message", { prompt: "   " })).status, 400);
    const invalid = await fetch(`${url}/api/copilot/message`, { method: "POST", headers, body: "{" });
    assert.equal(invalid.status, 400);
    const valid = await post(url, "/api/copilot/start", {}, { Origin: url });
    assert.equal(valid.status, 200);
    assert.equal(new URL(url).hostname, "127.0.0.1");
  } finally {
    await child.close();
  }
});

test("SSE uses one frame per write, bounded slow queues, drain ordering and independent fast readers", async () => {
  class Response extends EventEmitter {
    constructor(slow) {
      super();
      this.slow = slow;
      this.frames = [];
      this.writableLength = 0;
    }
    write(frame) {
      this.frames.push(frame);
      return !this.slow;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const fastResponse = new Response(false);
  const slowResponse = new Response(true);
  let detached = 0;
  const fast = createSseSubscriber(fastResponse, { maxQueueBytes: 1024, heartbeatMs: 10 });
  const slow = createSseSubscriber(slowResponse, { maxQueueBytes: 1024, onClose: () => detached++ });
  try {
    for (let id = 1; id <= 40; id++) {
      const event = { id, type: "assistant.delta", data: { messageId: "one", content: "x".repeat(80) } };
      fast.send(event);
      slow.send(event);
    }
    assert.equal(fastResponse.frames.length, 40);
    assert.equal(slow.stats.closed, true);
    assert.equal(slow.stats.slow, true);
    assert.equal(slow.stats.queuedBytes, 0);
    assert.ok(slow.stats.highWaterMark <= 1024);
    assert.equal(detached, 1);
    assert.equal(fast.stats.closed, false);
    assert.ok(fastResponse.frames.every((frame) => /^id: \d+\nevent: assistant.delta\ndata: .+\n\n$/.test(frame)));
    await pause(25);
    assert.ok(fastResponse.frames.includes(": heartbeat\n\n"));
    const stalledResponse = new Response(true);
    const stalled = createSseSubscriber(stalledResponse, { heartbeatMs: 10 });
    stalled.send({ id: 1, type: "chat.status", data: {} });
    await pause(40);
    assert.equal(stalled.stats.closed, true);
    assert.equal(stalled.stats.slow, true);
    assert.equal(stalledResponse.frames.length, 1);
    const drainResponse = new Response(true);
    const drain = createSseSubscriber(drainResponse);
    for (let id = 1; id <= 3; id++) drain.send({ id, type: "chat.status", data: {} });
    assert.equal(drainResponse.frames.length, 1);
    drainResponse.slow = false;
    drainResponse.emit("drain");
    assert.equal(drainResponse.frames.length, 3);
    assert.equal(drain.stats.queuedBytes, 0);
    drain.close();
  } finally {
    fast.close();
    slow.close();
  }
});

test("direct server entrypoint starts offline and preserves occupied-port fallback", { timeout: 15_000 }, async (t) => {
  const workspace = temporaryWorkspace(t);
  const app = createWorkshopServer({ workspace });
  const occupied = await app.listen();
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/server.js", import.meta.url)), "--no-open"], {
    cwd: workspace,
    env: { ...process.env, PORT: new URL(occupied).port },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    const url = await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error(`Startup timed out: ${output}`)), 10_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Startup exited: ${code} ${output}`)); });
      child.stdout.on("data", (chunk) => {
        output += chunk;
        const match = output.match(/running at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.stderr.on("data", (chunk) => { output += chunk; });
    });
    assert.notEqual(url, occupied);
    assert.equal((await fetch(`${url}/api/health`)).status, 200);
    assert.equal((await (await fetch(`${url}/api/copilot/status`)).json()).code, "SDK_NOT_INSTALLED");
  } finally {
    const exited = once(child, "exit");
    child.kill();
    await exited;
    await app.close();
  }
});
