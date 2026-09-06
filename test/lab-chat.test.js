import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore, MAX_CHAT_STORE_BYTES } from "../src/chat-store.js";
import { LabChatCoordinator, MAX_LAB_CHAT_ITEMS, MAX_PUBLIC_DEFINITIONS_BYTES } from "../src/lab-chat.js";
import { listChatCommandMetadata } from "../src/chat-commands.js";
import { recordCheckpoint } from "../src/progress.js";
import { deferred, FakeCopilotClient } from "./helpers/fake-copilot.js";

function nativeAdapter(overrides = {}) {
  return {
    clientOptions: () => ({ mode: "empty", baseDirectory: "fixture-only" }),
    sessionOptions: (agent) => ({ availableTools: ["read"], ...(agent ? { agent } : {}) }),
    verify: async () => ({ agents: [], skills: [], diagnostics: [] }),
    selectAgent: async (session, name) => name === "default" ? { selectedAgent: null }
      : { selectedAgent: name, agent: { name, tools: ["read"], source: "fixture" } },
    reload: async () => ({ selectedAgent: null }),
    invokeSkill: async () => { throw new Error("No fixture skill invocation configured."); },
    deleteSession: async (client, sessionId) => {
      await client.deleteSession(sessionId);
      return { deleted: true, sessionId };
    },
    ...overrides
  };
}

function fixture(t, options = {}) {
  const workspace = mkdtempSync(join(tmpdir(), "loop-lab-chat-"));
  execFileSync("git", ["init", "--quiet"], { cwd: workspace });
  writeFileSync(join(workspace, ".gitignore"), ".workshop/chat/\n");
  const clients = [];
  const savedSessions = new Map();
  const factory = (config) => {
    const client = new FakeCopilotClient({
      savedSessions,
      onSend(session) {
        session.emit("user.message", { content: "Do not expose trusted context" });
        session.emit("assistant.message", { messageId: `answer-${session.sent.length}`, content: `Answer ${session.sent.length}` });
        session.emit("session.idle");
      },
      ...options.client
    });
    client.receivedOptions = config;
    clients.push(client);
    return client;
  };
  const coordinators = [];
  const create = (overrides = {}) => {
    const coordinator = new LabChatCoordinator(workspace, {
      clientFactory: factory, nativeAdapter: nativeAdapter(options.adapter), ...overrides
    });
    coordinators.push(coordinator);
    return coordinator;
  };
  const chat = create();
  t.after(async () => {
    for (const coordinator of coordinators) if (!coordinator.stopped) await coordinator.stop();
    rmSync(workspace, { recursive: true, force: true });
  });
  return { workspace, clients, chat, create, savedSessions };
}

async function connect(chat, labId = "01", clientId = "tab-a") {
  const snapshot = await chat.getSnapshot({ labId, clientId });
  return chat.activate({ route: snapshot.route });
}

function savedRecord(workspace, conversationId) {
  return JSON.parse(readFileSync(join(workspace, ".workshop", "chat", "conversations", `${conversationId}.json`), "utf8"));
}

test("all nine labs are passive, strictly scoped, and locally usable without native calls", async (t) => {
  const { chat, clients, workspace } = fixture(t);
  for (let index = 0; index < 9; index++) {
    const labId = String(index).padStart(2, "0");
    const snapshot = await chat.getSnapshot({ labId, clientId: "tab-a" });
    assert.equal(snapshot.route.labId, labId);
    assert.equal(snapshot.route.leaseVersion, 0);
    assert.equal(snapshot.lease, null);
    assert.equal(snapshot.sequence, snapshot.chat.cursor);
    assert.match(snapshot.chat.messages[0].content, new RegExp(`Lab ${labId}`));
    assert.equal(snapshot.chat.messages[0].local, true);
    const again = await chat.getSnapshot({ labId, clientId: "tab-b" });
    assert.equal(again.route.conversationId, snapshot.route.conversationId);
    assert.equal(again.route.leaseVersion, 0);
  }
  assert.equal(clients.length, 0);
  for (const labId of ["9", "09", "../01", "", "1", 1, "000"]) {
    await assert.rejects(chat.getSnapshot({ labId, clientId: "tab-a" }), { code: "INVALID_LAB_ID" });
  }
  const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: workspace, encoding: "utf8" });
  assert.doesNotMatch(status, /\.workshop[\\/]chat/);
});

test("public snapshot definitions are bounded, body-free, and include authoritative command metadata", async (t) => {
  const { chat, workspace, clients } = fixture(t);
  const agents = join(workspace, ".github", "agents");
  mkdirSync(agents, { recursive: true });
  for (let index = 0; index < 50; index++) {
    writeFileSync(join(agents, `coach-${index}.agent.md`), [
      "---", `name: coach-${index}`, `description: ${JSON.stringify("\u0001".repeat(2000))}`,
      "tools: [read, search]", "---", "AUTHORED_BODY_MUST_NOT_BE_SNAPSHOT_METADATA"
    ].join("\n"));
  }
  const snapshot = await chat.getSnapshot({ labId: "01", clientId: "reader" });
  assert.deepEqual(snapshot.definitions.commands, listChatCommandMetadata().commands);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot.definitions)) <= MAX_PUBLIC_DEFINITIONS_BYTES);
  assert.equal(snapshot.definitions.truncated, true);
  assert.ok(snapshot.definitions.omitted.agents > 0);
  assert.ok(snapshot.definitions.agents.length > 0);
  assert.deepEqual(snapshot.definitions.agents[0].tools, ["read", "search"]);
  assert.equal(snapshot.definitions.agents[0].activatable, false);
  assert.doesNotMatch(JSON.stringify(snapshot), /AUTHORED_BODY_MUST_NOT_BE_SNAPSHOT_METADATA/);
  assert.equal(clients.length, 0);
  const events = [];
  await chat.subscribe({ ...snapshot.route, clientId: "other-reader" }, (event) => events.push(event));
  assert.equal(events[0].data.route.clientId, "other-reader");
  assert.equal(events[0].data.lease, null);
  assert.ok(Buffer.byteLength(JSON.stringify(events[0].data.definitions)) <= MAX_PUBLIC_DEFINITIONS_BYTES);
  assert.doesNotMatch(JSON.stringify(events), /AUTHORED_BODY_MUST_NOT_BE_SNAPSHOT_METADATA/);
});

test("published snapshot and command DTOs retain global lease identity and command metadata on every surface", async (t) => {
  const { chat, clients } = fixture(t);
  const reader = { labId: "02", clientId: "viewer" };
  const passive = await chat.getSnapshot(reader);
  const assertWrapper = (snapshot, route, lease) => {
    assert.deepEqual(Object.keys(snapshot).sort(), [
      "chat", "definitions", "history", "latestValidation", "lease", "route", "selectedAgent", "sequence"
    ]);
    assert.equal(snapshot.route.labId, route.labId);
    assert.equal(snapshot.route.clientId, route.clientId);
    assert.equal(snapshot.route.conversationId, route.conversationId);
    assert.equal(snapshot.sequence, snapshot.chat.cursor);
    assert.deepEqual(snapshot.lease, lease);
    assert.deepEqual(snapshot.definitions.commands, listChatCommandMetadata().commands);
    assert.ok(snapshot.history.every((item) => !Object.hasOwn(item, "messages") && !Object.hasOwn(item, "tools")));
  };
  assertWrapper(passive, passive.route, null);
  const archived = await connect(chat, "01", "owner");
  const active = await chat.reset({ route: archived.route });
  clients.at(-1).options.onSend = undefined;
  await chat.send({ route: active.route, prompt: "Controlled owner operation" });
  const lease = {
    clientId: "owner", labId: "01", conversationId: active.route.conversationId,
    version: active.route.leaseVersion, busy: true
  };
  const selected = await chat.getSnapshot(reader);
  assertWrapper(selected, passive.route, lease);
  assert.equal(selected.chat.status.ownerClientId, null);
  assert.equal(selected.chat.status.busy, false);
  const events = [];
  await chat.subscribe(reader, (event) => events.push(event));
  assert.equal(events[0].type, "chat.snapshot");
  assertWrapper(events[0].data, passive.route, lease);
  assert.equal(events[0].sequence, events[0].data.sequence);
  const status = await chat.command({ route: selected.route, command: "/status" });
  assertWrapper(status.result, passive.route, lease);
  const ownerLabAsReader = await chat.getSnapshot({ labId: "01", clientId: "viewer" });
  const history = await chat.command({
    route: ownerLabAsReader.route, command: `/history ${archived.route.conversationId}`
  });
  assertWrapper(history.result, { ...archived.route, clientId: "viewer" }, lease);
  assert.equal(history.result.chat.status.ownerClientId, null);
  const confirmation = await chat.command({ route: history.result.route, command: "/forget" });
  assert.deepEqual(confirmation.result, { confirmationRequired: true, conversationId: archived.route.conversationId });
  assert.equal(clients.flatMap((client) => client.deleteCalls).length, 0);
  const deletionTarget = await chat.getSnapshot({ ...archived.route, clientId: "owner" });
  const deletion = await chat.forget({ route: deletionTarget.route, confirm: true });
  assert.equal(deletion.result.applicationDeleted, true);
  assert.equal(deletion.result.nativeSession.deleted, true);
  assert.equal(deletion.result.nativeSession.sessionId, archived.chat.sessionId);
  assert.equal((await chat.getSnapshot({ labId: "01", clientId: "owner" })).route.conversationId, active.route.conversationId);
});

test("kickoff is persisted before dispatch, protected operations are rejected, and concurrent connects pay once", async (t) => {
  let fixtureWorkspace;
  let observedGreeting;
  let decisions;
  const { chat, clients, workspace } = fixture(t, {
    client: {
      async onSend(session) {
        const manifest = JSON.parse(readFileSync(join(fixtureWorkspace, ".workshop", "chat", "manifest.json"), "utf8"));
        observedGreeting = savedRecord(fixtureWorkspace, manifest.labs["01"].activeConversationId).greeting;
        decisions = await Promise.all([
          session.requestPermission({ kind: "write", fileName: "not-allowed.js" }),
          session.requestPermission({ kind: "shell", fullCommandText: "git status" }),
          session.requestPermission({ kind: "url", url: "https://example.com" }),
          session.requestPermission({ kind: "read", path: ".gitignore" }),
          session.requestPermission({ kind: "read", path: ".gitignore", managedApprovalRequired: true })
        ]);
        session.emit("assistant.message", { messageId: "intro", content: "Bounded next step" });
        session.emit("session.idle");
      }
    }
  });
  fixtureWorkspace = workspace;
  const passive = await chat.getSnapshot({ labId: "01", clientId: "tab-a" });
  const first = chat.activate({ route: passive.route });
  const duplicate = assert.rejects(chat.activate({ route: passive.route }), { code: "STALE_CHAT_ROUTE" });
  const active = await first;
  await duplicate;
  assert.equal(observedGreeting.attempted, true);
  assert.equal(observedGreeting.state, "prepared");
  assert.deepEqual(decisions.map((item) => item.kind), ["reject", "reject", "reject", "approve-once", "reject"]);
  assert.equal(clients[0].session.sent.length, 1);
  assert.equal(clients[0].session.sent[0].displayPrompt, "");
  assert.match(clients[0].session.sent[0].prompt, /one short read-only introduction/);
  await chat.activate({ route: active.route });
  assert.equal(clients[0].session.sent.length, 1);
  assert.equal(active.chat.messages.filter((message) => message.role === "user").length, 0);
});

test("A to B to A restores exact transcript and native identity without duplicate kickoff", async (t) => {
  const { chat, clients, workspace } = fixture(t);
  let a = await connect(chat);
  const exact = "  exact learner text\r\nwith whitespace  ";
  const accepted = await chat.send({ route: a.route, prompt: exact });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.result.generation, a.route.generation);
  const durable = savedRecord(workspace, a.route.conversationId);
  assert.equal(durable.messages.find((message) => message.role === "user").content, exact);
  assert.equal(durable.operations.at(-1).state, "complete");
  a = await chat.getSnapshot(a.route);
  const original = a.chat;
  const b = await connect(chat, "02");
  assert.notEqual(a.chat.sessionId, b.chat.sessionId);
  const passiveA = await chat.getSnapshot(a.route);
  const returned = await chat.activate({ route: passiveA.route });
  assert.equal(returned.chat.sessionId, original.sessionId);
  assert.deepEqual(returned.chat.messages, original.messages);
  assert.equal(clients.length, 2);
  assert.equal(clients[0].session.sent.length, 2);
  assert.equal(clients[0].session.sent[1].displayPrompt, exact);
  assert.match(clients[0].session.sent[1].prompt, /Trusted workshop context/);
  assert.doesNotMatch(JSON.stringify(returned.chat.messages), /Trusted workshop context|SDK echo/);
});

test("retired leases never revive an earlier passive route and visible generations remain immutable", async (t) => {
  const { chat } = fixture(t);
  const oldPassive = await chat.getSnapshot({ labId: "01", clientId: "tab-a" });
  const active = await chat.activate({ route: oldPassive.route });
  assert.equal(active.chat.generation, active.route.generation);
  assert.equal(active.chat.status.generation, active.route.generation);
  const stopped = await chat.abort({ route: active.route });
  const afterAbort = await chat.getSnapshot(stopped.route);
  assert.equal(afterAbort.chat.generation, active.route.generation);
  assert.equal(afterAbort.chat.status.generation, active.route.generation);
  await connect(chat, "02");
  await assert.rejects(chat.activate({ route: oldPassive.route }), { code: "STALE_CHAT_ROUTE" });
});

test("default real adapter supports native agent selection, exact skill display, reload, and resumed restrictions", async (t) => {
  const { workspace, create, clients } = fixture(t);
  mkdirSync(join(workspace, ".github", "agents"), { recursive: true });
  mkdirSync(join(workspace, ".github", "skills", "workshop-skill"), { recursive: true });
  const agentPath = join(workspace, ".github", "agents", "coach.agent.md");
  const skillPath = join(workspace, ".github", "skills", "workshop-skill", "SKILL.md");
  writeFileSync(agentPath, "---\nname: coach\ndescription: Read-only coach\ntools: [read, search]\n---\nRead evidence only.\n");
  writeFileSync(skillPath, "---\nname: workshop-skill\ndescription: A workshop skill\n---\nInspect evidence.\n");
  const metadata = [{
    name: "workshop-skill", commandName: "workshop-skill", description: "A workshop skill",
    enabled: true, userInvocable: true, path: skillPath, source: "project"
  }];
  const native = create({ nativeAdapter: undefined });
  const passive = await native.getSnapshot({ labId: "01", clientId: "tab-a" });
  const originalFactory = native.serviceOptions.clientFactory;
  native.serviceOptions.clientFactory = (config) => {
    const client = originalFactory(config);
    client.options.skills = metadata;
    client.options.onInvokeCommand = (session, request) => {
      assert.deepEqual(request, { name: "workshop-skill", input: "inspect" });
      return { kind: "agent-prompt", prompt: "Expanded by verified native RPC", displayPrompt: "/workshop-skill inspect" };
    };
    return client;
  };
  const active = await native.activate({ route: passive.route });
  assert.match(clients[0].receivedOptions.baseDirectory, /[\\/]chat[\\/]native$/);
  assert.equal(active.definitions.agents[0].verified, true);
  assert.equal(active.definitions.skills[0].activatable, true);
  assert.equal(Object.hasOwn(active.definitions.agents[0], "prompt"), false);
  assert.equal(Object.hasOwn(active.definitions.agents[0], "body"), false);
  await native.command({ route: active.route, command: "/agent coach" });
  const selected = await native.getSnapshot(active.route);
  assert.equal(selected.selectedAgent.name, "coach");
  assert.deepEqual(selected.selectedAgent.tools, ["read", "search"]);
  assert.equal(Object.hasOwn(selected.selectedAgent, "prompt"), false);
  assert.equal(savedRecord(workspace, selected.route.conversationId).selectedAgent.prompt, "Read evidence only.\n");
  assert.equal(clients[0].session.selectedAgent, "coach");
  assert.equal((await native.command({ route: active.route, command: "/help" })).result.skillCandidates[0].activatable, true);
  const exactCommand = "/workshop-skill inspect  ";
  await native.command({ route: active.route, command: exactCommand });
  assert.equal(clients[0].session.sent.at(-1).displayPrompt, exactCommand);
  assert.match(clients[0].session.sent.at(-1).prompt, /Expanded by verified native RPC/);
  await native.stop();
  const resumed = create({ nativeAdapter: undefined, clientFactory: native.serviceOptions.clientFactory });
  const restored = await connect(resumed);
  assert.equal(restored.selectedAgent.name, "coach");
  assert.equal(clients[1].session.config.agent, "coach");
  assert.equal(clients[1].session.selectedAgent, "coach");
  assert.deepEqual(clients[1].session.config.customAgents[0].tools, ["read", "search"]);
  await resumed.command({ route: restored.route, command: "/agent default" });
  assert.equal(clients[1].session.selectedAgent, null);
  await resumed.command({ route: restored.route, command: "/agent coach" });
  rmSync(agentPath);
  await resumed.command({ route: restored.route, command: "/skills reload" });
  assert.equal((await resumed.getSnapshot(restored.route)).selectedAgent, null);
  assert.equal(clients[1].session.selectedAgent, null);
});

test("restart resumes saved session, cursor advances, and every send refreshes exact failed validation context", async (t) => {
  const { chat, clients, workspace, create } = fixture(t);
  const a = await connect(chat);
  const events = [];
  await chat.subscribe(a.route, (event) => events.push(event));
  recordCheckpoint("01", false, { workspace, source: "embedded-chat", checks: [{ name: "Gate", ok: false, detail: "exact failure", required: false }] });
  await chat.send({ route: a.route, prompt: "first" });
  const before = await chat.getSnapshot(a.route);
  await chat.stop();
  const restarted = create();
  const passive = await restarted.getSnapshot(a.route);
  assert.equal(passive.route.leaseVersion, 0);
  assert.deepEqual(passive.latestValidation.checks, [{ name: "Gate", ok: false, detail: "exact failure", required: false }]);
  const resumed = await restarted.activate({ route: passive.route });
  assert.equal(resumed.chat.sessionId, a.chat.sessionId);
  assert.deepEqual(clients[1].resumeCalls.map((item) => item.sessionId), [a.chat.sessionId]);
  assert.equal(clients[1].createCalls, 0);
  assert.equal(clients[1].session.sent.length, 2);
  const resumedEvents = [];
  await restarted.subscribe(resumed.route, (event) => resumedEvents.push(event));
  assert.ok(resumedEvents[0].sequence > before.chat.cursor);
  assert.equal(resumedEvents[0].type, "chat.snapshot");
  assert.equal(resumedEvents[0].sequence, resumedEvents[0].data.sequence);
  assert.equal(resumedEvents[0].data.sequence, resumedEvents[0].data.chat.cursor);
  assert.deepEqual(resumedEvents[0].data.route, resumed.route);
  recordCheckpoint("01", false, { workspace, source: "browser", checks: [{ name: "Next gate", ok: false, detail: "new failure" }] });
  await restarted.send({ route: resumed.route, prompt: "second" });
  assert.match(clients[1].session.sent.at(-1).prompt, /new failure/);
  assert.match(clients[1].session.sent.at(-1).prompt, /"source":"browser"/);
  await assert.rejects(restarted.send({ route: a.route, prompt: "stale old process" }), { code: "STALE_CHAT_ROUTE" });
});

test("new archives only current lab and clear/history never mutate transcripts or progress", async (t) => {
  const { chat, workspace } = fixture(t);
  const b = await connect(chat, "02");
  const a = await connect(chat, "01");
  await chat.send({ route: a.route, prompt: `Archived transcript marker ${"x".repeat(64 * 1024)}` });
  recordCheckpoint("01", false, { workspace, source: "test", checks: [] });
  const progress = readFileSync(join(workspace, ".workshop", "progress.json"), "utf8");
  const bBefore = savedRecord(workspace, b.route.conversationId);
  const newConversation = await chat.reset({ route: a.route });
  assert.notEqual(newConversation.route.conversationId, a.route.conversationId);
  assert.equal(newConversation.route.generation, a.route.generation + 1);
  assert.deepEqual(savedRecord(workspace, b.route.conversationId), bBefore);
  assert.equal(readFileSync(join(workspace, ".workshop", "progress.json"), "utf8"), progress);
  assert.doesNotMatch(JSON.stringify(newConversation.result), /Archived transcript marker/);
  assert.ok(newConversation.result.history.every((item) => !Object.hasOwn(item, "messages") && !Object.hasOwn(item, "tools")));
  const archived = await chat.getSnapshot(a.route);
  assert.equal(archived.history.find((item) => item.conversationId === a.route.conversationId).active, false);
  await assert.rejects(chat.activate({ route: archived.route }), { code: "ARCHIVED_CONVERSATION" });
  const before = savedRecord(workspace, newConversation.route.conversationId).messages;
  assert.deepEqual((await chat.command({ route: newConversation.route, command: "/clear" })).result, { viewOnly: true });
  const history = await chat.command({ route: newConversation.route, command: `/history ${a.route.conversationId}` });
  assert.equal(history.result.route.conversationId, a.route.conversationId);
  assert.deepEqual(savedRecord(workspace, newConversation.route.conversationId).messages, before);
  assert.equal((await chat.getSnapshot({ labId: "01", clientId: "tab-a" })).route.conversationId, newConversation.route.conversationId);
});

test("passive clients see only selected envelopes; busy takeover fences callbacks and permissions without changing record generation", async (t) => {
  const { chat, clients } = fixture(t);
  const a = await connect(chat, "01", "tab-a");
  const passiveB = await chat.getSnapshot({ labId: "02", clientId: "tab-b" });
  assert.equal(passiveB.route.clientId, "tab-b");
  assert.deepEqual(passiveB.lease, {
    clientId: "tab-a", labId: "01", conversationId: a.route.conversationId, version: a.route.leaseVersion, busy: false
  });
  const eventsA = [];
  const eventsB = [];
  await chat.subscribe(a.route, (event) => eventsA.push(event));
  await chat.subscribe(passiveB.route, (event) => eventsB.push(event));
  clients[0].options.onSend = undefined;
  await chat.send({ route: a.route, prompt: "long operation" });
  const busyB = await chat.getSnapshot(passiveB.route);
  assert.equal(busyB.route.clientId, "tab-b");
  assert.equal(busyB.route.leaseVersion, passiveB.route.leaseVersion);
  assert.equal(busyB.lease.clientId, "tab-a");
  assert.equal(busyB.lease.busy, true);
  const oldSession = clients[0].session;
  const callback = [...oldSession.listeners][0];
  const permission = oldSession.requestPermission({ kind: "write", fileName: "protected.js" });
  const permissionId = (await chat.getSnapshot(a.route)).chat.permissions[0].requestId;
  const foreignA = await chat.getSnapshot({ ...a.route, clientId: "tab-b" });
  await assert.rejects(chat.permission({ route: foreignA.route, requestId: permissionId, decision: "approve" }), { statusCode: 409 });
  await assert.rejects(chat.send({ route: passiveB.route, prompt: "no implicit activation" }), { code: "CHAT_LEASE_REQUIRED" });
  await assert.rejects(chat.activate({ route: passiveB.route }), { code: "CHAT_LEASE_BUSY" });
  const activeB = await chat.activate({ route: passiveB.route, takeover: true });
  assert.deepEqual(activeB.lease, {
    clientId: "tab-b", labId: "02", conversationId: activeB.route.conversationId, version: activeB.route.leaseVersion, busy: false
  });
  assert.equal((await permission).kind, "reject");
  assert.equal(oldSession.abortCalls, 1);
  await assert.rejects(chat.permission({ route: a.route, requestId: permissionId, decision: "approve" }), { code: "STALE_CHAT_ROUTE" });
  callback({ type: "assistant.message", data: { messageId: "late", content: "must not appear" } });
  assert.equal((await chat.getSnapshot(a.route)).route.generation, a.route.generation);
  assert.equal(eventsB.every((event) => event.labId === "02" && event.conversationId === activeB.route.conversationId), true);
  assert.equal(eventsA.every((event) => event.labId === "01"), true);
  assert.doesNotMatch(JSON.stringify(eventsB), /long operation|protected.js|must not appear/);
});

test("foreign idle leases require explicit takeover while own idle navigation remains allowed", async (t) => {
  const { chat, clients } = fixture(t);
  const active = await connect(chat);
  const foreignSame = await chat.getSnapshot({ ...active.route, clientId: "foreign" });
  const foreignOther = await chat.getSnapshot({ labId: "02", clientId: "foreign" });
  const ownOther = await chat.getSnapshot({ labId: "02", clientId: active.route.clientId });
  const events = [];
  await chat.subscribe(foreignOther.route, (event) => events.push(event));
  assert.equal(events[0].data.lease.clientId, active.route.clientId);
  assert.equal(events[0].data.lease.busy, false);
  for (const target of [foreignSame, foreignOther]) {
    await assert.rejects(chat.activate({ route: target.route, takeover: false }), {
      code: "CHAT_LEASE_TAKEOVER_REQUIRED", statusCode: 409
    });
  }
  for (const takeover of ["true", 1, null]) {
    await assert.rejects(chat.activate({ route: foreignOther.route, takeover }), { code: "INVALID_TAKEOVER", statusCode: 400 });
  }
  assert.deepEqual((await chat.getSnapshot(active.route)).lease, active.lease);
  assert.equal(clients.length, 1);
  assert.equal(clients[0].session.sent.length, 1);
  assert.equal(clients[0].session.abortCalls, 0);
  const switched = await chat.activate({ route: ownOther.route });
  assert.equal(switched.lease.clientId, active.route.clientId);
  assert.equal(switched.lease.labId, "02");
  assert.equal(clients[1].session.sent.length, 1);
  clients[1].options.onSend = undefined;
  await chat.send({ route: switched.route, prompt: "Keep my other lab busy" });
  const third = await chat.getSnapshot({ labId: "03", clientId: active.route.clientId });
  await assert.rejects(chat.activate({ route: third.route }), { code: "CHAT_LEASE_BUSY", statusCode: 409 });
  assert.equal(clients.length, 2);
  const stoppedAndSwitched = await chat.activate({ route: third.route, takeover: true });
  assert.equal(stoppedAndSwitched.lease.labId, "03");
  assert.equal(clients[1].sessions[0].abortCalls, 1);
  assert.equal(clients[2].session.sent.length, 1);
});

test("in-flight activation rejects queued stale sends and in-flight SDK acceptance remains cancellable", async (t) => {
  const started = deferred();
  const gate = deferred();
  const { chat, clients } = fixture(t, { client: { onStart: () => { started.resolve(); return gate.promise; } } });
  const passive = await chat.getSnapshot({ labId: "01", clientId: "tab-a" });
  const activating = chat.activate({ route: passive.route });
  await started.promise;
  const stale = assert.rejects(chat.send({ route: passive.route, prompt: "stale before activation" }), { code: "STALE_CHAT_ROUTE" });
  gate.resolve();
  const active = await activating;
  await stale;
  const entered = deferred();
  const ack = deferred();
  clients[0].options.onSend = () => { entered.resolve(); return ack.promise; };
  const sending = chat.send({ route: active.route, prompt: "pending acknowledgement" });
  const rejected = assert.rejects(sending, { code: "STALE_GENERATION" });
  await entered.promise;
  const stopped = await chat.abort({ route: active.route });
  assert.notEqual(stopped.route.leaseVersion, active.route.leaseVersion);
  ack.resolve();
  await rejected;
  assert.equal((await chat.getSnapshot(stopped.route)).route.generation, active.route.generation);
});

test("terminal publication follows durable flush and coalesces many streaming deltas", async (t) => {
  const { chat, clients, workspace } = fixture(t);
  const active = await connect(chat);
  const store = chat.store;
  let writes = 0;
  const save = store.saveConversation.bind(store);
  store.saveConversation = async (record) => { writes++; return save(record); };
  const durableAtTerminal = [];
  await chat.subscribe(active.route, (event) => {
    if (event.type === "session.idle") durableAtTerminal.push(savedRecord(workspace, active.route.conversationId));
  });
  clients[0].options.onSend = (session) => {
    for (let index = 0; index < 500; index++) session.emit("assistant.message_delta", { messageId: "stream", deltaContent: "x" });
    session.emit("assistant.message", { messageId: "stream", content: "x".repeat(500) });
    session.emit("session.idle");
  };
  await chat.send({ route: active.route, prompt: "stream" });
  assert.equal(durableAtTerminal.length, 1);
  assert.equal(durableAtTerminal[0].operations.at(-1).state, "complete");
  assert.equal(durableAtTerminal[0].messages.at(-1).content, "x".repeat(500));
  assert.ok(writes < 15, `Streaming performed ${writes} durable writes`);
});

for (const boundary of ["subscribe", "activate"]) {
  test(`authoritative ${boundary} snapshot never replays an already included delta across delayed persistence`, async (t) => {
    const { chat, clients } = fixture(t);
    const active = await connect(chat);
    clients[0].options.onSend = undefined;
    await chat.send({ route: active.route, prompt: "partial stream" });
    const events = [];
    if (boundary === "activate") await chat.subscribe(active.route, (event) => events.push(event));
    const entered = deferred();
    const gate = deferred();
    const save = chat.store.saveConversation.bind(chat.store);
    let block = true;
    chat.store.saveConversation = async (record) => {
      if (block) {
        block = false;
        entered.resolve();
        await gate.promise;
      }
      return save(record);
    };
    const operation = boundary === "subscribe"
      ? chat.subscribe(active.route, (event) => events.push(event))
      : chat.activate({ route: active.route });
    await entered.promise;
    clients[0].session.emit("assistant.message_delta", { messageId: "racing", deltaContent: "x" });
    gate.resolve();
    await operation;
    const current = await chat.getSnapshot(active.route);
    const messageId = current.chat.messages.at(-1).id;
    let displayed = "";
    for (const event of events) {
      if (event.type === "chat.snapshot") {
        displayed = event.data.chat.messages.find((message) => message.id === messageId)?.content ?? "";
      } else if (event.type === "assistant.delta" && event.data.messageId === messageId) {
        displayed += event.data.content;
      }
    }
    assert.equal(displayed, "x");
    assert.equal(current.chat.messages.at(-1).content, "x");
    assert.ok(events.every((event, index) => !index || event.sequence > events[index - 1].sequence));
  });
}

test("missing SDK and unsupported resume are explicit, with no replacement native session or kickoff replay", async (t) => {
  const { workspace, create, chat, clients } = fixture(t);
  const unavailable = create({
    clientFactory: undefined,
    sdkLoader: async () => { throw Object.assign(new Error("Cannot find package '@github/copilot-sdk'"), { code: "ERR_MODULE_NOT_FOUND" }); }
  });
  const local = await unavailable.getSnapshot({ labId: "02", clientId: "tab-b" });
  await assert.rejects(unavailable.activate({ route: local.route }), { code: "SDK_NOT_INSTALLED", statusCode: 503 });
  assert.equal((await unavailable.getSnapshot(local.route)).chat.status.state, "unavailable");
  assert.equal(savedRecord(workspace, local.route.conversationId).greeting.attempted, false);
  const active = await connect(chat);
  await chat.stop();
  const noResume = create({ clientFactory: () => Object.assign(new FakeCopilotClient(), { resumeSession: undefined }) });
  const saved = await noResume.getSnapshot(active.route);
  await assert.rejects(noResume.activate({ route: saved.route }), { code: "SESSION_RESUME_UNAVAILABLE", statusCode: 503 });
  assert.equal(clients.length, 1);
  assert.equal(savedRecord(workspace, active.route.conversationId).sessionId, active.chat.sessionId);
});

test("restart of persisted busy work reports interrupted/unknown and never automatically resends", async (t) => {
  const { chat, clients, workspace, create } = fixture(t);
  const active = await connect(chat);
  clients[0].options.onSend = undefined;
  await chat.send({ route: active.route, prompt: "unfinished" });
  const record = savedRecord(workspace, active.route.conversationId);
  assert.equal(record.status.busy, true);
  const restarted = create();
  const snapshot = await restarted.getSnapshot(active.route);
  assert.equal(snapshot.chat.status.state, "interrupted");
  assert.equal(snapshot.chat.status.pendingOperations.at(-1).state, "unknown");
  const resumed = await restarted.activate({ route: snapshot.route });
  assert.equal(resumed.chat.sessionId, active.chat.sessionId);
  assert.equal(clients[1].session.sent.length, 2);
});

test("commands have real local semantics and native deletion requires confirmation and a positive receipt", async (t) => {
  const { chat, clients, workspace } = fixture(t);
  const active = await connect(chat);
  let checks = 0;
  let workerResult;
  chat.runCheck = async (labId) => {
    checks++;
    const resultChecks = [{ name: "check", ok: false, detail: "real worker result" }];
    const progress = recordCheckpoint(labId, false, { workspace, source: "embedded-chat", checks: resultChecks });
    workerResult = { id: labId, ok: false, checks: resultChecks, progress };
    return workerResult;
  };
  const checked = await chat.command({ route: active.route, command: "/check" });
  assert.deepEqual(checked.result, workerResult);
  assert.equal(checks, 1);
  assert.equal((await chat.getSnapshot(active.route)).latestValidation.source, "embedded-chat");
  const selected = await chat.command({ route: active.route, command: "/agent loop-coach" });
  assert.equal(selected.result.selectedAgent.name, "loop-coach");
  assert.equal((await chat.command({ route: active.route, command: "/agent default" })).result.selectedAgent, null);
  await assert.rejects(chat.command({ route: active.route, command: "/not-real" }), { code: "UNKNOWN_COMMAND" });
  await assert.rejects(chat.send({ route: active.route, prompt: "/help" }), { code: "COMMAND_REQUIRED" });
  assert.equal(clients[0].session.sent.length, 1);
  await assert.rejects(chat.forget({ route: active.route }), { code: "FORGET_CONFIRM_REQUIRED" });
  chat.nativeAdapter.deleteSession = async () => ({ deleted: false, residual: "runtime retained" });
  await assert.rejects(chat.forget({ route: active.route, confirm: true }), { code: "NATIVE_DELETE_INCOMPLETE" });
  for (const receipt of [{ deleted: true }, { deleted: true, sessionId: "wrong-session" }]) {
    chat.nativeAdapter.deleteSession = async () => receipt;
    const current = await chat.getSnapshot(active.route);
    await assert.rejects(chat.forget({ route: current.route, confirm: true }), { code: "NATIVE_DELETE_INCOMPLETE" });
  }
  assert.equal((await new ChatStore(workspace).loadLab("01")).conversations.length, 1);
  chat.nativeAdapter.deleteSession = nativeAdapter().deleteSession;
  const current = await chat.getSnapshot(active.route);
  const deleted = await chat.forget({ route: current.route, confirm: true });
  assert.equal(deleted.result.applicationDeleted, true);
  assert.equal(deleted.result.deleted, true);
  assert.equal(deleted.result.nativeSession.deleted, true);
  assert.equal(clients.flatMap((client) => client.deleteCalls).length, 1);
});

test("native forget completes after verified delete even when cleanup reports warnings", async (t) => {
  let stopCount = 0;
  const { chat, clients, workspace, savedSessions } = fixture(t, {
    client: {
      onStop: () => ++stopCount === 2 ? [Object.assign(new Error("native cleanup pipe already closed"), { code: "PIPE_CLOSED" })] : []
    }
  });
  const active = await connect(chat);
  const sessionId = active.chat.sessionId;
  const deleted = await chat.forget({ route: active.route, confirm: true });
  assert.equal(deleted.result.applicationDeleted, true);
  assert.equal(deleted.result.deleted, true);
  assert.equal(deleted.result.nativeSession.deleted, true);
  assert.equal(deleted.result.nativeSession.sessionId, sessionId);
  assert.deepEqual(deleted.result.cleanupWarnings, [{
    code: "PIPE_CLOSED",
    message: "native cleanup pipe already closed"
  }]);
  assert.equal(savedSessions.has(sessionId), false);
  const lab = await new ChatStore(workspace).loadLab("01");
  assert.equal(lab.conversations.some((conversation) => conversation.conversationId === active.route.conversationId), false);
  assert.deepEqual(clients.flatMap((client) => client.deleteCalls), [sessionId]);
});

test("native forget preserves primary delete failure when cleanup is also noisy", async (t) => {
  const primary = Object.assign(new Error("native delete failed before receipt"), { code: "DELETE_PRIMARY" });
  let stopCount = 0;
  const { chat, workspace } = fixture(t, {
    client: {
      onStop: () => ++stopCount === 2 ? [new Error("cleanup after primary failure")] : []
    },
    adapter: {
      deleteSession: async () => { throw primary; }
    }
  });
  const active = await connect(chat);
  await assert.rejects(chat.forget({ route: active.route, confirm: true }), (error) => {
    assert.equal(error, primary);
    assert.deepEqual(error.cleanupWarnings, [{
      code: "RUNTIME_CLEANUP_WARNING",
      message: "cleanup after primary failure"
    }]);
    return true;
  });
  const lab = await new ChatStore(workspace).loadLab("01");
  assert.equal(lab.conversations.some((conversation) => conversation.conversationId === active.route.conversationId), true);
});

test("confirmed forget commands delete the exact named conversation and report native retention truthfully", async (t) => {
  const { chat, clients, workspace } = fixture(t);
  const archived = await connect(chat);
  const current = await chat.reset({ route: archived.route });
  const command = `/forget ${archived.route.conversationId}`;
  const prepared = await chat.command({ route: current.route, command });
  assert.equal(prepared.result.confirmationRequired, true);
  assert.equal(prepared.result.conversationId, archived.route.conversationId);
  assert.equal(clients.flatMap((client) => client.deleteCalls).length, 0);
  for (const receipt of [
    { deleted: false, residualRetention: true },
    { deleted: true, residualRetention: true },
    { deleted: true, nativeDeleted: false }
  ]) {
    chat.nativeAdapter.deleteSession = async (client, sessionId) => ({ ...receipt, sessionId });
    await assert.rejects(chat.command({ route: current.route, command, confirm: true }), {
      code: "NATIVE_DELETE_INCOMPLETE", nativeSession: { ...receipt, sessionId: archived.chat.sessionId }
    });
  }
  assert.equal((await new ChatStore(workspace).loadLab("01")).conversations.length, 2);
  chat.nativeAdapter.deleteSession = nativeAdapter().deleteSession;
  const deleted = await chat.command({ route: current.route, command, confirm: true });
  assert.equal(deleted.result.deleted, true);
  assert.equal(deleted.result.applicationDeleted, true);
  assert.equal(deleted.result.conversationId, archived.route.conversationId);
  assert.equal(deleted.result.nativeSession.sessionId, archived.chat.sessionId);
  assert.equal(deleted.result.nativeSession.deleted, true);
  assert.equal((await chat.getSnapshot({ labId: "01", clientId: "tab-a" })).route.conversationId, current.route.conversationId);
  assert.deepEqual(clients.flatMap((client) => client.deleteCalls), [archived.chat.sessionId]);
});

test("confirmed local-only forget does not claim a native session was deleted or start a provider", async (t) => {
  const { chat, clients } = fixture(t);
  const local = await chat.getSnapshot({ labId: "01", clientId: "reader" });
  const deleted = await chat.command({ route: local.route, command: "/forget", confirm: true });
  assert.equal(deleted.result.applicationDeleted, true);
  assert.equal(deleted.result.deleted, true);
  assert.equal(deleted.result.nativeSession.notPresent, true);
  assert.equal(deleted.result.nativeSession.nativeDeleted, false);
  assert.equal(deleted.result.nativeSession.residualRetention, false);
  assert.equal(clients.length, 0);
});

test("native state overhead shares both ChatStore quotas and never permits an unpersistable paid dispatch", async (t) => {
  const { workspace, create, clients } = fixture(t);
  const native = create({ nativeAdapter: undefined });
  const active = await connect(native);
  const runtime = join(workspace, ".workshop", "chat", "native");
  for (let sessionIndex = 0; sessionIndex < 8; sessionIndex++) {
    const directory = join(runtime, "session-state", `retained-${sessionIndex}`);
    mkdirSync(directory, { recursive: true });
    for (let fileIndex = 0; fileIndex < 16; fileIndex++) {
      writeFileSync(join(directory, `event-log-${fileIndex}.jsonl`), `${JSON.stringify({
        type: "assistant.message", data: { content: "x".repeat(16 * 1024) }
      })}\n`);
    }
  }
  const accepted = await native.send({ route: active.route, prompt: "Persist alongside retained native state" });
  assert.equal(accepted.ok, true);
  assert.equal(savedRecord(workspace, active.route.conversationId).messages.find((message) => message.id === accepted.result.messageId).content,
    "Persist alongside retained native state");
  const byteOverflow = join(runtime, "overflow.log");
  const entryOverflow = join(runtime, "overflow-entries");
  for (const quota of ["bytes", "entries"]) {
    if (quota === "bytes") {
      writeFileSync(byteOverflow, Buffer.alloc(MAX_CHAT_STORE_BYTES));
    } else {
      mkdirSync(entryOverflow);
      for (let index = 0; index < 8193; index++) writeFileSync(join(entryOverflow, `${index}.log`), "");
    }
    try {
      const dispatched = clients[0].session.sent.length;
      await assert.rejects(native.send({ route: active.route, prompt: `Must not dispatch over ${quota} quota` }), {
        code: "CHAT_STORE_LIMIT"
      });
      assert.equal(clients[0].session.sent.length, dispatched);
      assert.doesNotMatch(JSON.stringify(savedRecord(workspace, active.route.conversationId).messages), /Must not dispatch/);
    } finally {
      if (quota === "bytes") rmSync(byteOverflow);
      else rmSync(entryOverflow, { recursive: true });
    }
    await native.send({ route: active.route, prompt: `Explicit retry after freeing ${quota}` });
  }
});

test("corrupt or unreadable chat state and malformed progress fail truthfully without replacement", async (t) => {
  const { chat, workspace, create, clients } = fixture(t);
  const active = await connect(chat);
  await chat.stop();
  const path = join(workspace, ".workshop", "chat", "conversations", `${active.route.conversationId}.json`);
  writeFileSync(path, "{broken");
  await assert.rejects(create().getSnapshot(active.route), { code: "CHAT_STORE_CORRUPT" });
  assert.equal(readFileSync(path, "utf8"), "{broken");
  const unreadable = create({ store: { loadLab: async () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); } } });
  await assert.rejects(unreadable.getSnapshot({ labId: "02", clientId: "tab-b" }), { code: "EACCES" });
  mkdirSync(join(workspace, ".workshop"), { recursive: true });
  writeFileSync(join(workspace, ".workshop", "progress.json"), "{broken");
  await assert.rejects(create().getSnapshot({ labId: "02", clientId: "tab-b" }), { code: "PROGRESS_MALFORMED" });
  assert.equal(clients.length, 1);
});

test("store retention limits reject a new learner turn before a paid dispatch rather than silently dropping it", async (t) => {
  const { chat, clients, workspace } = fixture(t);
  const store = new ChatStore(workspace);
  const record = await store.createConversation("01");
  await store.saveConversation({
    ...record, greeting: { state: "complete", attempted: true },
    messages: Array.from({ length: 2048 }, (_, index) => ({ id: `saved-${index}`, role: "assistant", content: "saved", complete: true }))
  });
  const active = await connect(chat);
  await assert.rejects(chat.send({ route: active.route, prompt: "retain this exactly" }), { code: "CHAT_TRANSCRIPT_LIMIT", statusCode: 413 });
  assert.equal(clients[0].session.sent.length, 0);
  assert.equal(savedRecord(workspace, active.route.conversationId).messages.length, 2048);
});

test("request idempotency replays a lost POST acknowledgement and rejects conflicting text", async (t) => {
  const { chat, clients, workspace } = fixture(t);
  const active = await connect(chat);
  const requestId = randomUUID();
  const prompt = "  exact retry text\r\n ";
  const original = await chat.send({ route: active.route, prompt, requestId });
  const retry = await chat.send({ route: active.route, prompt, requestId });
  assert.equal(retry.requestId, requestId);
  assert.equal(retry.replayed, true);
  assert.equal(original.replayed, false);
  assert.equal(retry.operationId, original.operationId);
  assert.deepEqual(retry.result, original.result);
  assert.deepEqual(retry.route, active.route);
  assert.equal(clients[0].session.sent.length, 2);
  const saved = savedRecord(workspace, active.route.conversationId);
  assert.equal(saved.operations.filter((operation) => operation.requestId === requestId).length, 1);
  assert.equal(saved.messages.filter((message) => message.content === prompt).length, 1);
  assert.deepEqual(saved.operations.at(-1).acceptance, original.result);
  await assert.rejects(chat.send({ route: active.route, prompt: `${prompt}changed`, requestId }), {
    code: "REQUEST_ID_CONFLICT", statusCode: 409
  });
  for (const invalid of ["", "not-a-uuid", null, 42]) {
    await assert.rejects(chat.send({ route: active.route, prompt, requestId: invalid }), { code: "INVALID_REQUEST_ID", statusCode: 400 });
  }
  assert.equal(clients[0].session.sent.length, 2);
});

test("concurrent request retries share one persisted-before-dispatch attempt without blocking competing rejection", async (t) => {
  const { chat, clients, workspace } = fixture(t);
  const active = await connect(chat);
  const requestId = randomUUID();
  const entered = deferred();
  const gate = deferred();
  clients[0].options.onSend = async (session) => {
    const operation = savedRecord(workspace, active.route.conversationId).operations.at(-1);
    assert.equal(operation.requestId, requestId);
    assert.equal(operation.clientId, active.route.clientId);
    assert.equal(operation.state, "prepared");
    assert.equal(operation.acceptance, undefined);
    entered.resolve();
    await gate.promise;
    session.emit("assistant.message", { messageId: "one-reply", content: "Once" });
    session.emit("session.idle");
  };
  const first = chat.send({ route: active.route, prompt: "one attempt", requestId });
  await entered.promise;
  const retry = chat.send({ route: active.route, prompt: "one attempt", requestId });
  await assert.rejects(chat.send({ route: active.route, prompt: "another attempt", requestId: randomUUID() }), { code: "CHAT_BUSY" });
  await assert.rejects(chat.send({ route: active.route, prompt: "changed text", requestId }), { code: "REQUEST_ID_CONFLICT" });
  gate.resolve();
  const [accepted, replayed] = await Promise.all([first, retry]);
  assert.equal(replayed.operationId, accepted.operationId);
  assert.equal(replayed.replayed, true);
  assert.equal(clients[0].session.sent.length, 2);
  assert.equal(savedRecord(workspace, active.route.conversationId).operations.filter((operation) => operation.requestId).length, 1);
});

test("accepted request receipts survive restart and are replayed under the newly activated lease", async (t) => {
  const { chat, clients, create } = fixture(t);
  const active = await connect(chat);
  const requestId = randomUUID();
  clients[0].options.onSend = undefined;
  const accepted = await chat.send({ route: active.route, prompt: "acknowledged but unfinished", requestId });
  await chat.stop();
  const restarted = create();
  const resumed = await connect(restarted);
  assert.notEqual(resumed.route.leaseVersion, active.route.leaseVersion);
  const replayed = await restarted.send({ route: resumed.route, prompt: "acknowledged but unfinished", requestId });
  assert.deepEqual(replayed.result, accepted.result);
  assert.deepEqual(replayed.route, resumed.route);
  assert.equal(replayed.replayed, true);
  assert.equal(clients[1].session.sent.length, 2);
  assert.equal(clients[1].resumeCalls.length, 1);
});

test("ambiguous request outcomes remain explicit across retries and restart without another SDK send", async (t) => {
  const { chat, clients, workspace, create } = fixture(t);
  const active = await connect(chat);
  const requestId = randomUUID();
  clients[0].options.onSend = () => { throw new Error("Lost native acknowledgement"); };
  await assert.rejects(chat.send({ route: active.route, prompt: "unknown delivery", requestId }), /Lost native acknowledgement/);
  const saved = savedRecord(workspace, active.route.conversationId);
  assert.equal(saved.operations.at(-1).state, "unknown");
  assert.equal(saved.operations.at(-1).acceptance, undefined);
  await assert.rejects(chat.send({ route: active.route, prompt: "unknown delivery", requestId }), {
    code: "REQUEST_OUTCOME_UNKNOWN", statusCode: 409
  });
  assert.equal(clients[0].session.sent.length, 2);
  await chat.stop();
  const restarted = create();
  const resumed = await connect(restarted);
  await assert.rejects(restarted.send({ route: resumed.route, prompt: "unknown delivery", requestId }), {
    code: "REQUEST_OUTCOME_UNKNOWN", statusCode: 409
  });
  assert.equal(clients[1].session.sent.length, 2);
});

test("failed durable acceptance cannot leave an in-memory replayable receipt", async (t) => {
  const { chat, clients, workspace } = fixture(t);
  const active = await connect(chat);
  const requestId = randomUUID();
  const save = chat.store.saveConversation.bind(chat.store);
  let failed = false;
  chat.store.saveConversation = async (record) => {
    if (!failed && record.operations.some((operation) => operation.requestId === requestId && operation.acceptance)) {
      failed = true;
      throw Object.assign(new Error("Acceptance write failed"), { code: "EACCES" });
    }
    return save(record);
  };
  await assert.rejects(chat.send({ route: active.route, prompt: "uncertain durable acknowledgement", requestId }), { code: "EACCES" });
  const operation = savedRecord(workspace, active.route.conversationId).operations.at(-1);
  assert.equal(operation.state, "unknown");
  assert.equal(operation.acceptance, undefined);
  await assert.rejects(chat.send({ route: active.route, prompt: "uncertain durable acknowledgement", requestId }), {
    code: "REQUEST_OUTCOME_UNKNOWN"
  });
  assert.equal(clients[0].session.sent.length, 2);
});

test("request keys are isolated by conversation and client, never borrowed from operation identity", async (t) => {
  const { chat, clients } = fixture(t);
  const first = await connect(chat);
  const requestId = randomUUID();
  const a = await chat.send({ route: first.route, prompt: "client A", requestId });
  const passive = await chat.getSnapshot({ ...first.route, clientId: "tab-b" });
  await assert.rejects(chat.send({ route: passive.route, prompt: "client A", requestId }), { code: "CHAT_LEASE_REQUIRED" });
  await assert.rejects(chat.activate({ route: passive.route }), { code: "CHAT_LEASE_TAKEOVER_REQUIRED", statusCode: 409 });
  const second = await chat.activate({ route: passive.route, takeover: true });
  const b = await chat.send({ route: second.route, prompt: "client B", requestId });
  assert.notEqual(a.operationId, b.operationId);
  const anotherLab = await connect(chat, "02", "tab-b");
  const c = await chat.send({ route: anotherLab.route, prompt: "another conversation", requestId });
  assert.notEqual(c.operationId, b.operationId);
  const fresh = await chat.send({ route: { ...anotherLab.route, operationId: c.operationId }, prompt: "a new compatibility send" });
  assert.notEqual(fresh.requestId, requestId);
  assert.notEqual(fresh.operationId, c.operationId);
  assert.equal(clients[0].session.sent.length, 3);
  assert.equal(clients[1].session.sent.length, 3);
});

for (const collection of ["messages", "operations"]) {
  test(`the ${collection} limit refuses new requests before SDK acceptance while allowing receipt replay`, async (t) => {
    const { chat, clients, workspace } = fixture(t);
    const store = new ChatStore(workspace);
    const record = await store.createConversation("01");
    await store.saveConversation({
      ...record, greeting: { state: "complete", attempted: true },
      messages: collection === "messages" ? Array.from({ length: MAX_LAB_CHAT_ITEMS - 2 }, (_, index) => ({
        id: `saved-${index}`, role: "assistant", content: "saved", complete: true
      })) : [],
      operations: collection === "operations" ? Array.from({ length: MAX_LAB_CHAT_ITEMS - 1 }, (_, index) => ({
        operationId: `legacy-${index}`, kind: "message", state: "complete"
      })) : []
    });
    const active = await connect(chat);
    const requestId = randomUUID();
    const accepted = await chat.send({ route: active.route, prompt: "last retained request", requestId });
    const saved = savedRecord(workspace, active.route.conversationId);
    assert.equal(saved[collection].length, MAX_LAB_CHAT_ITEMS);
    assert.equal(saved.operations.at(-1).requestId, requestId);
    assert.deepEqual(saved.operations.at(-1).acceptance, accepted.result);
    await assert.rejects(chat.send({ route: active.route, prompt: "over capacity", requestId: randomUUID() }), {
      code: collection === "messages" ? "CHAT_TRANSCRIPT_LIMIT" : "CHAT_OPERATION_LIMIT", statusCode: 413
    });
    const replay = await chat.send({ route: active.route, prompt: "last retained request", requestId });
    assert.equal(replay.operationId, accepted.operationId);
    assert.equal(replay.replayed, true);
    assert.equal(clients[0].session.sent.length, 1);
    assert.doesNotMatch(JSON.stringify(savedRecord(workspace, active.route.conversationId)), /over capacity/);
  });
}

test("late completion of a forgotten pending request cannot resurrect its durable ledger", async (t) => {
  const { chat, clients, workspace } = fixture(t);
  const active = await connect(chat);
  const entered = deferred();
  const gate = deferred();
  clients[0].options.onSend = () => { entered.resolve(); return gate.promise; };
  const sending = chat.send({ route: active.route, prompt: "delete while acknowledgement is pending", requestId: randomUUID() });
  const rejected = assert.rejects(sending, { code: "STALE_GENERATION" });
  await entered.promise;
  const forgotten = await chat.forget({ route: active.route, confirm: true });
  assert.equal(forgotten.result.deleted, true);
  gate.resolve();
  await rejected;
  const saved = await new ChatStore(workspace).loadLab("01");
  assert.equal(saved.conversations.length, 1);
  assert.notEqual(saved.activeConversationId, active.route.conversationId);
  assert.equal(saved.conversations[0].operations.length, 0);
});
