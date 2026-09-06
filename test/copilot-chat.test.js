import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotChatService, findCopilotCli } from "../src/copilot-chat.js";
import { deferred, FakeCopilotClient } from "./helpers/fake-copilot.js";

function fixture(t, options = {}) {
  const workspace = mkdtempSync(join(tmpdir(), "loop-chat-"));
  const client = new FakeCopilotClient(options);
  const chat = new CopilotChatService(workspace, { clientFactory: () => client });
  t.after(async () => {
    await chat.stop();
    rmSync(workspace, { recursive: true, force: true });
  });
  return { workspace, client, chat };
}

test("service imports offline and reports an unavailable SDK without fake fallback", async (t) => {
  const { workspace } = fixture(t);
  let loads = 0;
  const chat = new CopilotChatService(workspace, {
    sdkLoader() {
      loads++;
      throw Object.assign(new Error("Cannot find package '@github/copilot-sdk' imported from service"), { code: "ERR_MODULE_NOT_FOUND" });
    }
  });
  assert.equal(loads, 0);
  await chat.checkAvailability();
  assert.equal(chat.status.state, "unavailable");
  assert.equal(chat.status.code, "SDK_NOT_INSTALLED");
  assert.equal(chat.status.available, false);
  await assert.rejects(chat.send("Keep my draft"), { code: "SDK_NOT_INSTALLED", statusCode: 503 });
  assert.equal(chat.status.busy, false);
  assert.equal(loads, 1);
  assert.deepEqual(chat.snapshot().messages, []);
});

test("SDK loader injection constructs the SDK-compatible client lazily", async (t) => {
  const { workspace } = fixture(t);
  let created = 0;
  const cliPath = join(workspace, "copilot.exe");
  const previousCliPath = process.env.COPILOT_CLI_PATH;
  process.env.COPILOT_CLI_PATH = cliPath;
  t.after(() => {
    if (previousCliPath === undefined) delete process.env.COPILOT_CLI_PATH;
    else process.env.COPILOT_CLI_PATH = previousCliPath;
  });
  const chat = new CopilotChatService(workspace, {
    sdkLoader: async () => ({
      CopilotClient: class extends FakeCopilotClient {
        constructor(options) {
          super();
          assert.equal(options.workingDirectory, workspace);
          assert.deepEqual(options.connection, { kind: "stdio", path: cliPath });
          created++;
        }
      },
      RuntimeConnection: { forStdio: (options) => ({ kind: "stdio", ...options }) }
    })
  });
  t.after(() => chat.stop());
  assert.equal(created, 0);
  await chat.start();
  assert.equal(created, 1);
});

test("CLI discovery prefers a platform executable export and preserves legacy and explicit paths", (t) => {
  const { workspace } = fixture(t);
  const executable = join(workspace, "copilot.exe");
  const legacyEntry = join(workspace, "index.js");
  writeFileSync(executable, "Fixture path only; never executed.");
  writeFileSync(legacyEntry, "Fixture path only; never executed.");
  assert.equal(findCopilotCli({ cliPath: "", resolvePackage: () => executable }), executable);
  assert.equal(findCopilotCli({ cliPath: "", resolvePackage: () => join(workspace, "package-entry.js") }), legacyEntry);
  assert.equal(findCopilotCli({
    cliPath: "explicit-override",
    resolvePackage() { throw new Error("Package discovery must not replace the override."); }
  }), "explicit-override");
});

test("authentication and broken transitive SDK imports are not missing-provider errors", async (t) => {
  const { workspace, chat, client } = fixture(t, { auth: { isAuthenticated: false, statusMessage: "Backend auth is unavailable" } });
  await assert.rejects(chat.start(), { code: "AUTH_REQUIRED", statusCode: 401 });
  assert.equal(client.stopCalls, 1);
  assert.equal(chat.status.state, "error");
  assert.equal(chat.status.code, "AUTH_REQUIRED");
  const broken = new CopilotChatService(workspace, {
    sdkLoader: async () => {
      throw Object.assign(new Error("Cannot find package 'transitive'"), { code: "ERR_MODULE_NOT_FOUND" });
    }
  });
  await assert.rejects(broken.start(), { code: "SDK_LOAD_FAILED" });
  assert.notEqual(broken.status.code, "SDK_NOT_INSTALLED");
});

test("accepted display text is exact and unique while assistant identities reconcile", async (t) => {
  const { chat, client } = fixture(t, {
    onSend(session) {
      session.emit("user.message", { content: "Trusted context plus SDK echo" });
    }
  });
  const events = [];
  const unsubscribe = chat.subscribe((event) => events.push(event));
  t.after(unsubscribe);
  const display = "  Exact learner text\r\nwith whitespace  ";
  const accepted = await chat.send(display);
  assert.equal(client.session.sent[0].prompt, display);
  assert.equal(chat.status.busy, true);
  assert.equal(chat.status.operationId, accepted.operationId);
  await assert.rejects(chat.send("Competing send"), { statusCode: 409, code: "CHAT_BUSY" });
  client.session.emit("assistant.message_delta", { messageId: "same", deltaContent: " \n" });
  client.session.emit("assistant.message_delta", { messageId: "same", deltaContent: "Answer" });
  client.session.emit("assistant.message", { messageId: "same", content: " \nAnswer" });
  client.session.emit("assistant.message_delta", { messageId: "same", deltaContent: "late" });
  client.session.emit("session.idle");
  const snapshot = chat.snapshot();
  assert.equal(snapshot.status.busy, false);
  assert.deepEqual(snapshot.messages.map(({ role, content, complete }) => ({ role, content, complete })), [
    { role: "user", content: display, complete: true },
    { role: "assistant", content: " \nAnswer", complete: true }
  ]);
  assert.equal(events.filter((event) => event.type === "user.message").length, 1);
  const assistant = events.filter((event) => event.type.startsWith("assistant."));
  assert.equal(new Set(assistant.map((event) => event.data.messageId)).size, 1);
  assert.ok(events.every((event, index) => index === 0 || event.id > events[index - 1].id));
  snapshot.messages[0].content = "external mutation";
  assert.equal(chat.snapshot().messages[0].content, display);
});

test("missing IDs are grouped per agent and reset never reuses the old namespace", async (t) => {
  const { chat, client } = fixture(t);
  await chat.send("One");
  const oldSession = client.session;
  const oldCallback = [...oldSession.listeners][0];
  oldSession.emit("assistant.message_delta", { deltaContent: "root" });
  oldSession.emit("assistant.message_delta", { deltaContent: "child" }, { agentId: "child" });
  oldSession.emit("assistant.message", { content: "root" });
  oldSession.emit("assistant.message", { content: "child" }, { agentId: "child" });
  oldSession.emit("session.idle", {}, { agentId: "child" });
  assert.equal(chat.status.busy, true);
  assert.equal(chat.snapshot().messages.filter((message) => message.role === "assistant").length, 2);
  const oldId = chat.snapshot().messages[1].id;
  await chat.reset();
  await chat.send("Two");
  oldCallback({ type: "assistant.message", data: { messageId: "late", content: "Do not insert" } });
  client.session.emit("assistant.message", { content: "new" });
  const messages = chat.snapshot().messages;
  assert.equal(messages.length, 2);
  assert.notEqual(messages[1].id, oldId);
  assert.equal(oldSession.listeners.size, 0);
  await assert.rejects(chat.send("stale", { generation: 0 }), { code: "STALE_GENERATION" });
});

test("tool details retain identity, errors and bounded redacted fields", async (t) => {
  const { chat, client } = fixture(t);
  await chat.start();
  const events = [];
  chat.subscribe((event) => events.push(event));
  client.session.emit("tool.execution_start", {
    toolCallId: "a", toolName: "shell",
    arguments: { command: "echo hello", headers: { Authorization: "do-not-publish" }, token: "hidden" }
  });
  client.session.emit("tool.execution_start", { toolCallId: "b", toolName: "shell", arguments: { command: "other" } });
  client.session.emit("tool.execution_complete", {
    toolCallId: "a", success: false,
    result: { content: "bounded result", password: "hidden" },
    error: { message: "Failed", code: "EXIT_1" }
  });
  client.session.emit("tool.execution_complete", { toolCallId: "orphan", success: true, result: "large".repeat(100_000) });
  const tools = chat.snapshot().tools;
  assert.equal(tools.length, 3);
  assert.equal(tools[0].toolName, "shell");
  assert.equal(tools[0].state, "failed");
  assert.equal(tools[1].state, "running");
  assert.equal(tools[0].error.code, "EXIT_1");
  assert.equal(tools[0].arguments.headers.Authorization, "[redacted]");
  assert.equal(tools[0].result.password, "[redacted]");
  assert.ok(Buffer.byteLength(JSON.stringify(tools[2].result)) <= 64 * 1024);
  assert.match(JSON.stringify(tools[2].result), /truncated/);
  const completed = events.find((event) => event.type === "tool.completed");
  assert.equal(completed.data.toolCallId, tools[0].toolCallId);
  for (const field of ["toolName", "arguments", "result", "error", "success"]) assert.ok(field in completed.data);
  assert.doesNotMatch(JSON.stringify(events), /do-not-publish|hidden/);
});

test("subscription snapshot and replay have an atomic cursor even during reentrant events", async (t) => {
  const { chat } = fixture(t);
  const decision = chat.handlePermissionRequest({ kind: "write", fileName: "practice/example.js" });
  const events = [];
  const unsubscribe = chat.subscribe((event) => {
    events.push(event);
    if (event.type === "chat.snapshot") chat.emit("chat.error", { message: "after snapshot" });
  });
  assert.equal(events[0].type, "chat.snapshot");
  assert.equal(events[0].id, events[0].data.cursor);
  assert.equal(events[0].data.permissions.length, 1);
  assert.equal(events[1].type, "chat.status");
  assert.equal(events[2].type, "permission.requested");
  assert.equal(events[3].type, "chat.error");
  assert.ok(events.every((event, index) => index === 0 || event.id > events[index - 1].id));
  chat.resolvePermission(events[2].data.requestId, "reject", "No");
  assert.deepEqual(await decision, { kind: "reject", feedback: "No" });
  unsubscribe();
});

for (const stage of ["start", "createSession"]) {
  test(`reset during pending ${stage} disposes late resources and cannot overwrite a successor`, async (t) => {
    const gate = deferred();
    const entered = deferred();
    let first = true;
    const hook = async () => {
      if (!first) return;
      first = false;
      entered.resolve();
      await gate.promise;
    };
    const { chat, client } = fixture(t, stage === "start" ? { onStart: hook } : { onCreateSession: hook });
    const successor = new FakeCopilotClient();
    const starting = chat.start();
    const rejected = assert.rejects(starting, { code: "STALE_GENERATION" });
    await entered.promise;
    await chat.reset();
    chat.options.clientFactory = () => successor;
    await chat.start();
    const current = chat.session;
    gate.resolve();
    await rejected;
    assert.equal(chat.session, current);
    assert.equal(chat.status.state, "ready");
    assert.equal(client.stopCalls, 1);
    if (stage === "createSession") assert.equal(client.sessions[0].disconnectCalls, 1);
  });

}

test("a factory cannot lend a still-starting client to the successor generation", async (t) => {
  const gate = deferred();
  const entered = deferred();
  const { chat, client } = fixture(t, { onStart: () => { entered.resolve(); return gate.promise; } });
  const starting = chat.start();
  const rejected = assert.rejects(starting, { code: "STALE_GENERATION" });
  await entered.promise;
  await chat.reset();
  await assert.rejects(chat.start(), { code: "CLIENT_IN_USE", statusCode: 409 });
  assert.equal(client.stopCalls, 0);
  gate.resolve();
  await rejected;
  assert.equal(client.stopCalls, 1);
  await chat.start();
  assert.equal(chat.status.state, "ready");
});

test("concurrent start creates once and pending send rejects competing work before acceptance", async (t) => {
  const gate = deferred();
  const { chat, client } = fixture(t, { onStart: () => gate.promise });
  const first = chat.start();
  const second = chat.start();
  const send = chat.send("First");
  await assert.rejects(chat.send("Second"), { code: "CHAT_BUSY" });
  gate.resolve();
  await Promise.all([first, second, send]);
  assert.equal(client.startCalls, 1);
  assert.equal(client.sessions.length, 1);
  assert.equal(client.session.sent.length, 1);
});

test("permissions remain protected and reset rejects stale approvals", async (t) => {
  const { chat, client, workspace } = fixture(t);
  writeFileSync(join(workspace, "safe.txt"), "Safe");
  await chat.start();
  assert.deepEqual(client.session.requestPermission({ kind: "read", path: "safe.txt" }), { kind: "approve-once" });
  const protectedRead = client.session.requestPermission({ kind: "read", path: "safe.txt", managedApprovalRequired: true });
  const firstId = chat.snapshot().permissions[0].requestId;
  assert.throws(() => chat.resolvePermission(firstId, "anything"), { code: "INVALID_PERMISSION_DECISION" });
  chat.resolvePermission(firstId, "approve");
  assert.deepEqual(await protectedRead, { kind: "approve-once", approvedInteractively: true });
  const oldHandler = client.session.config.onPermissionRequest;
  const pending = oldHandler({ kind: "shell", fullCommandText: "echo protected" });
  const pendingId = chat.snapshot().permissions[0].requestId;
  await chat.reset();
  assert.equal((await pending).kind, "reject");
  assert.throws(() => chat.resolvePermission(pendingId, "approve"), { code: "PERMISSION_NOT_PENDING" });
  assert.equal(oldHandler({ kind: "write", fileName: "late" }).kind, "reject");
});

test("abort retires late callbacks, retains partial history and surfaces cleanup failures", async (t) => {
  const { chat, client } = fixture(t);
  await chat.send("Keep partial");
  const session = client.session;
  const callback = [...session.listeners][0];
  session.emit("assistant.message_delta", { messageId: "partial", deltaContent: "Partial" });
  const decision = session.requestPermission({ kind: "write", fileName: "protected" });
  await chat.abort();
  assert.equal((await decision).kind, "reject");
  assert.equal(session.abortCalls, 1);
  assert.equal(session.disconnectCalls, 1);
  await chat.send("New turn");
  callback({ type: "session.idle", data: {} });
  assert.equal(chat.status.busy, true);
  assert.equal(chat.snapshot().messages[1].content, "Partial");
  client.options.onStop = () => [new Error("Stop failed")];
  await assert.rejects(chat.reset(), { code: "RUNTIME_CLEANUP_FAILED" });
  assert.equal(chat.status.state, "error");
  client.options.onStop = undefined;
});

test("session and send errors unlock the operation without fabricated final messages", async (t) => {
  const { chat, client } = fixture(t);
  await chat.send("Fail asynchronously");
  client.session.emit("session.error", { message: "Runtime failure" });
  assert.equal(chat.status.busy, false);
  assert.equal(chat.status.state, "error");
  const events = [];
  chat.subscribe((event) => events.push(event));
  let permission;
  client.options.onSend = (session) => {
    permission = session.requestPermission({ kind: "write", fileName: "not-accepted.js" });
    session.emit("assistant.message", { messageId: "rejected", content: "Not accepted" });
    throw new Error("Send rejected");
  };
  await assert.rejects(chat.send("Fail synchronously"), /Send rejected/);
  assert.equal(chat.status.busy, false);
  assert.equal(chat.status.code, "SEND_FAILED");
  assert.equal((await permission).kind, "reject");
  assert.deepEqual(chat.snapshot().permissions, []);
  assert.equal(chat.snapshot().messages.filter((message) => message.role === "user").length, 1);
  assert.equal(events.filter((event) => event.type === "user.message").length, 0);
  assert.equal(chat.snapshot().messages.filter((message) => message.role === "assistant").length, 0);
});

test("events before SDK acceptance are ordered after one exact accepted user message", async (t) => {
  const gate = deferred();
  const emitted = deferred();
  const { chat } = fixture(t, {
    onSend(session) {
      session.emit("assistant.message_delta", { messageId: "early", deltaContent: "early" });
      session.emit("assistant.message", { messageId: "early", content: "early" });
      session.emit("session.idle");
      emitted.resolve();
      return gate.promise;
    }
  });
  const events = [];
  chat.subscribe((event) => events.push(event));
  const sending = chat.send(" exact ");
  await emitted.promise;
  assert.deepEqual(chat.snapshot().messages, []);
  assert.equal(chat.status.busy, true);
  gate.resolve();
  const accepted = await sending;
  const visible = events.filter((event) => ["user.message", "assistant.delta", "assistant.message"].includes(event.type));
  assert.deepEqual(visible.map((event) => event.type), ["user.message", "assistant.delta", "assistant.message"]);
  assert.equal(visible[0].data.messageId, accepted.messageId);
  assert.equal(visible[0].data.content, " exact ");
  assert.equal(chat.status.busy, false);
});

test("SDK options and verified resume preserve the saved native identity and protected callback", async (t) => {
  const { workspace, client } = fixture(t);
  const original = await client.createSession({});
  const chat = new CopilotChatService(workspace, {
    clientFactory: (options) => {
      assert.equal(options.mode, "empty");
      assert.equal(options.baseDirectory, workspace);
      return client;
    },
    clientOptions: { mode: "empty", baseDirectory: workspace },
    sessionOptions: {
      availableTools: ["read"], agent: "coach",
      onPermissionRequest: () => ({ kind: "approve-once" })
    },
    sessionId: original.sessionId
  });
  t.after(() => chat.stop());
  chat.restore({ messages: [{ id: "saved", role: "assistant", content: "Saved", complete: true }], tools: [], cursor: 10 });
  await chat.start();
  assert.equal(chat.session.sessionId, original.sessionId);
  assert.equal(client.createCalls, 1);
  assert.equal(client.resumeCalls.length, 1);
  assert.equal(client.session.config.agent, "coach");
  assert.deepEqual(client.session.config.availableTools, ["read"]);
  const permission = client.session.requestPermission({ kind: "write", fileName: "protected.js" });
  assert.equal(chat.snapshot().permissions.length, 1);
  chat.resolvePermission(chat.snapshot().permissions[0].requestId, "reject");
  assert.equal((await permission).kind, "reject");
  assert.equal(chat.snapshot().messages[0].content, "Saved");
});

test("trusted prompt uses exact display text and waits for durable acceptance before publishing terminal events", async (t) => {
  const { chat, client } = fixture(t);
  const persisted = deferred();
  const gate = deferred();
  const events = [];
  chat.subscribe((event) => events.push(event));
  const sending = chat.send("Trusted wrapper", {
    displayPrompt: " exact text\r\n ",
    onAccepted: async () => {
      persisted.resolve();
      await gate.promise;
    }
  });
  await persisted.promise;
  client.session.emit("assistant.message", { messageId: "reply", content: "After persistence" });
  client.session.emit("session.idle");
  assert.equal(events.some((event) => event.type === "session.idle"), false);
  assert.deepEqual(client.session.sent[0], { prompt: "Trusted wrapper", displayPrompt: " exact text\r\n " });
  gate.resolve();
  await sending;
  assert.equal(chat.snapshot().messages[0].content, " exact text\r\n ");
  assert.deepEqual(events.filter((event) => ["user.message", "assistant.message", "session.idle"].includes(event.type)).map((event) => event.type),
    ["user.message", "assistant.message", "session.idle"]);
});
