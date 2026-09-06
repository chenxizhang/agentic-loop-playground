import test from "node:test";
import assert from "node:assert/strict";
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { discoverChatDefinitions } from "../src/chat-commands.js";
import {
  NativeChatAdapter,
  NativeChatCapabilityError
} from "../src/native-chat.js";
import {
  ChatStore,
  MAX_CHAT_STORE_BYTES
} from "../src/chat-store.js";

function temporaryWorkspace() {
  const workspace = mkdtempSync(join(tmpdir(), "loop-native-chat-"));
  execFileSync("git", ["init", "--quiet"], { cwd: workspace });
  mkdirSync(join(workspace, ".github", "skills", "loop-engineering"), { recursive: true });
  mkdirSync(join(workspace, ".github", "agents"), { recursive: true });
  writeFileSync(join(workspace, ".gitignore"), ".workshop/chat/\n");
  writeFileSync(join(workspace, ".github", "skills", "loop-engineering", "SKILL.md"), [
    "---",
    "name: loop-engineering",
    "description: Operate a bounded loop",
    "---",
    "Use evidence before action.",
    ""
  ].join("\n"));
  writeFileSync(join(workspace, ".github", "agents", "loop-verifier.agent.md"), [
    "---",
    "name: loop-verifier",
    "description: Verify independently",
    "tools: [read, search]",
    "---",
    "Inspect evidence without editing.",
    ""
  ].join("\n"));
  return workspace;
}

function runtimeMetadata(definitions) {
  return {
    agents: definitions.agents.filter((agent) => agent.valid).map((agent, index) => ({
      name: agent.name,
      description: agent.description,
      id: agent.name,
      tools: agent.tools
    })),
    skills: definitions.skills.filter((skill) => skill.valid).map((skill) => ({
      name: skill.name,
      commandName: skill.name,
      description: skill.description,
      source: "custom",
      enabled: true,
      userInvocable: true,
      path: skill.canonicalPath
    }))
  };
}

function fakeSession(metadata, overrides = {}) {
  const calls = [];
  const session = {
    rpc: {
      agent: {
        async list(params) {
          calls.push(["agent.list", params]);
          return { agents: metadata.agents };
        },
        async select(params) {
          calls.push(["agent.select", params]);
          return {};
        },
        async deselect() {
          calls.push(["agent.deselect"]);
          return {};
        },
        async reload() {
          calls.push(["agent.reload"]);
          return {};
        },
        ...overrides.agent
      },
      skills: {
        async list() {
          calls.push(["skills.list"]);
          return { skills: metadata.skills };
        },
        async reload() {
          calls.push(["skills.reload"]);
          return { warnings: [], errors: [] };
        },
        ...overrides.skills
      },
      commands: {
        async invoke(params) {
          calls.push(["commands.invoke", params]);
          return {
            kind: "agent-prompt",
            prompt: "Trusted native prompt",
            displayPrompt: "/loop-engineering inspect this"
          };
        },
        ...overrides.commands
      }
    }
  };
  return { session, calls };
}

function createAdapter(workspace, definitions = discoverChatDefinitions(workspace)) {
  return new NativeChatAdapter(workspace, {
    runtimeDirectory: join(workspace, ".workshop", "chat", "native"),
    definitions
  });
}

test("builds isolated empty-mode options from approved project definitions", (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const definitions = discoverChatDefinitions(workspace);
  const adapter = createAdapter(workspace, definitions);

  assert.deepEqual(adapter.clientOptions(), {
    mode: "empty",
    baseDirectory: join(workspace, ".workshop", "chat", "native"),
    workingDirectory: workspace,
    builtinPluginDirectories: []
  });

  const options = adapter.sessionOptions("loop-verifier");
  assert.equal(options.workingDirectory, workspace);
  assert.equal(options.configDirectory, join(workspace, ".workshop", "chat", "native"));
  assert.equal(options.configDirectory, adapter.clientOptions().baseDirectory, "create/resume and client-level delete must use the same session namespace");
  assert.equal(options.enableConfigDiscovery, false);
  assert.equal(options.enableSkills, true);
  assert.equal(options.enableSessionStore, true);
  assert.equal(options.skipCustomInstructions, true);
  assert.equal(options.customAgentsLocalOnly, true);
  assert.deepEqual(options.availableTools, ["builtin:*"]);
  assert.deepEqual(options.pluginDirectories, []);
  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.agent, "loop-verifier");
  assert.deepEqual(options.skillDirectories, [
    dirname(definitions.skills[0].canonicalPath)
  ]);
  assert.deepEqual(options.customAgents, [{
    name: "loop-verifier",
    description: "Verify independently",
    prompt: "Inspect evidence without editing.\n",
    tools: ["read", "search"]
  }]);

  const defaultOptions = adapter.sessionOptions("default");
  assert.equal("agent" in defaultOptions, false);
  assert.equal(adapter.capabilityMetadata().sdk.version, "1.0.11");
  assert.equal(adapter.capabilityMetadata().isolation.ambientPlugins, false);
  assert.deepEqual(adapter.capabilityMetadata().storage, {
    sharesChatStoreBudget: true,
    budgetBytes: MAX_CHAT_STORE_BYTES,
    entryLimit: 8192
  });
});

test("verifies native identities, project provenance, prompts, and tool restrictions", async (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const definitions = discoverChatDefinitions(workspace);
  const metadata = runtimeMetadata(definitions);
  const { session, calls } = fakeSession(metadata);
  const adapter = createAdapter(workspace, definitions);

  const verified = await adapter.verify(session);

  assert.equal(verified.agents[0].verified, true);
  assert.equal(verified.agents[0].id, "loop-verifier");
  assert.equal(verified.agents[0].promptSource, "configured");
  assert.equal(verified.agents[0].source, ".github/agents/loop-verifier.agent.md");
  assert.deepEqual(verified.agents[0].tools, ["read", "search"]);
  assert.equal(verified.skills[0].verified, true);
  assert.equal(verified.skills[0].source, ".github/skills/loop-engineering/SKILL.md");
  assert.deepEqual(calls.slice(0, 2), [
    ["agent.list", { includePrompt: true }],
    ["skills.list"]
  ]);
});

test("rejects ambient same-name metadata and escaped definition junctions", async (context) => {
  const workspace = temporaryWorkspace();
  const outside = mkdtempSync(join(tmpdir(), "loop-native-decoy-"));
  context.after(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  writeFileSync(join(outside, "SKILL.md"), [
    "---",
    "name: loop-engineering",
    "description: Ambient decoy",
    "---",
    "Outside prompt.",
    ""
  ].join("\n"));

  const definitions = discoverChatDefinitions(workspace);
  const metadata = runtimeMetadata(definitions);
  metadata.skills.push({
    name: "loop-engineering",
    commandName: "loop-engineering",
    description: "Ambient decoy",
    source: "user",
    enabled: true,
    userInvocable: true,
    path: join(outside, "SKILL.md")
  });
  const adapter = createAdapter(workspace, definitions);
  const { session } = fakeSession(metadata);

  await assert.rejects(
    adapter.verify(session),
    (error) => error instanceof NativeChatCapabilityError &&
      error.code === "NATIVE_METADATA_MISMATCH" &&
      /duplicate identities/.test(error.message)
  );

  const escapedWorkspace = temporaryWorkspace();
  context.after(() => rmSync(escapedWorkspace, { recursive: true, force: true }));
  rmSync(join(escapedWorkspace, ".github", "skills", "loop-engineering"), {
    recursive: true,
    force: true
  });
  symlinkSync(outside, join(escapedWorkspace, ".github", "skills", "escaped"), "junction");
  const escaped = discoverChatDefinitions(escapedWorkspace);
  const escapedAdapter = createAdapter(escapedWorkspace, escaped);

  assert.equal(escaped.skills[0].valid, false);
  assert.equal(escapedAdapter.sessionOptions().skillDirectories.length, 0);
  assert.equal(
    escapedAdapter.capabilityMetadata().diagnostics.some((item) => item.code === "DISCOVERY_PATH_ESCAPE"),
    true
  );
});

test("rejects a singular pathless ambient agent even when its prompt and tools match", async (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const definitions = discoverChatDefinitions(workspace);
  const metadata = runtimeMetadata(definitions);
  metadata.agents[0].source = "user";
  const { session } = fakeSession(metadata);
  const adapter = createAdapter(workspace, definitions);

  await assert.rejects(
    adapter.verify(session),
    (error) => error.code === "NATIVE_METADATA_MISMATCH" &&
      /conflicting provenance/.test(error.message)
  );
});

test("accepts omitted optional agent metadata while retaining configured prompt provenance", async (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const definitions = discoverChatDefinitions(workspace);
  const metadata = runtimeMetadata(definitions);
  delete metadata.agents[0].displayName;
  delete metadata.agents[0].source;
  delete metadata.agents[0].path;
  delete metadata.agents[0].userInvocable;
  delete metadata.agents[0].prompt;
  const { session } = fakeSession(metadata);
  const adapter = createAdapter(workspace, definitions);

  const verified = await adapter.verify(session);

  assert.equal(verified.agents[0].verified, true);
  assert.equal(verified.agents[0].prompt, definitions.agents[0].body);
  assert.equal(verified.agents[0].promptSource, "configured");
  assert.equal(verified.agents[0].runtimeSource, null);
});

test("accepts configured custom-agent prompt metadata without native source or path", async (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const definitions = discoverChatDefinitions(workspace);
  const metadata = runtimeMetadata(definitions);
  metadata.agents[0].displayName = "Loop verifier";
  metadata.agents[0].prompt = definitions.agents[0].body;
  const adapter = createAdapter(workspace, definitions);

  const verified = await adapter.verify(fakeSession(metadata).session);

  assert.equal(verified.agents[0].verified, true);
  assert.equal(verified.agents[0].promptSource, "runtime");
  assert.equal(verified.agents[0].runtimeSource, null);
  assert.equal(verified.agents[0].runtimePath, null);
});

test("rejects non-invocable and case-mismatched native agents", async (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const definitions = discoverChatDefinitions(workspace);
  const nonInvocable = runtimeMetadata(definitions);
  nonInvocable.agents[0].userInvocable = false;
  const adapter = createAdapter(workspace, definitions);

  await assert.rejects(
    adapter.verify(fakeSession(nonInvocable).session),
    (error) => error.code === "NATIVE_METADATA_MISMATCH" &&
      /identity metadata is incomplete/.test(error.message)
  );

  const caseMismatch = runtimeMetadata(definitions);
  caseMismatch.agents[0].name = "LOOP-VERIFIER";
  await assert.rejects(
    adapter.verify(fakeSession(caseMismatch).session),
    (error) => error.code === "NATIVE_METADATA_MISMATCH" &&
      /identity metadata is incomplete/.test(error.message)
  );
});

test("rejects mismatched custom-agent stable IDs", async (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const definitions = discoverChatDefinitions(workspace);
  const metadata = runtimeMetadata(definitions);
  metadata.agents[0].id = "different-agent-id";
  const adapter = createAdapter(workspace, definitions);

  await assert.rejects(
    adapter.verify(fakeSession(metadata).session),
    (error) => error.code === "NATIVE_METADATA_MISMATCH" &&
      /identity metadata is incomplete/.test(error.message)
  );
});

test("selects verified agents through the native RPC", async (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const definitions = discoverChatDefinitions(workspace);
  const metadata = runtimeMetadata(definitions);
  const { session, calls } = fakeSession(metadata);
  const adapter = createAdapter(workspace, definitions);

  const selected = await adapter.selectAgent(session, "loop-verifier");

  assert.equal(selected.selectedAgent, "loop-verifier");
  assert.deepEqual(
    calls.find(([name]) => name === "agent.select"),
    ["agent.select", { name: "loop-verifier" }]
  );
});

test("deselects a selected session agent when its definition is removed", async (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const definitions = discoverChatDefinitions(workspace);
  const metadata = runtimeMetadata(definitions);
  const { session, calls } = fakeSession(metadata);
  const adapter = createAdapter(workspace, definitions);

  await adapter.selectAgent(session, "loop-verifier");
  rmSync(join(workspace, ".github", "agents", "loop-verifier.agent.md"));
  metadata.agents = [];
  const reloaded = await adapter.reload(session);

  assert.equal(reloaded.selectedAgent, null);
  assert.deepEqual(
    calls.filter(([name]) => name === "agent.select" || name === "agent.deselect"),
    [
      ["agent.select", { name: "loop-verifier" }],
      ["agent.deselect"]
    ]
  );
  assert.equal(reloaded.agents.length, 0);
});

test("keeps selected-agent reload state isolated per native session", async (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const definitions = discoverChatDefinitions(workspace);
  const metadata = runtimeMetadata(definitions);
  const first = fakeSession(metadata);
  const second = fakeSession(metadata);
  const adapter = createAdapter(workspace, definitions);

  await adapter.selectAgent(first.session, "loop-verifier");
  rmSync(join(workspace, ".github", "agents", "loop-verifier.agent.md"));
  metadata.agents = [];

  const secondReload = await adapter.reload(second.session);
  const firstReload = await adapter.reload(first.session);

  assert.equal(secondReload.selectedAgent, null);
  assert.equal(
    second.calls.some(([name]) => name === "agent.deselect"),
    false
  );
  assert.equal(firstReload.selectedAgent, null);
  assert.equal(
    first.calls.filter(([name]) => name === "agent.deselect").length,
    1
  );
});

test("rejects a native skill whose command identity differs from the approved definition", async (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const definitions = discoverChatDefinitions(workspace);
  const metadata = runtimeMetadata(definitions);
  metadata.skills[0].commandName = "other-command";
  const { session } = fakeSession(metadata);
  const adapter = createAdapter(workspace, definitions);

  await assert.rejects(
    adapter.verify(session),
    (error) => error.code === "NATIVE_METADATA_MISMATCH" &&
      /incomplete or inactive/.test(error.message)
  );
});

test("rejects case-only native skill identity mismatches", async (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const definitions = discoverChatDefinitions(workspace);
  const metadata = runtimeMetadata(definitions);
  metadata.skills[0].name = "LOOP-ENGINEERING";
  metadata.skills[0].commandName = "LOOP-ENGINEERING";
  const { session } = fakeSession(metadata);
  const adapter = createAdapter(workspace, definitions);

  await assert.rejects(
    adapter.verify(session),
    (error) => error.code === "NATIVE_METADATA_MISMATCH" &&
      /incomplete or inactive/.test(error.message)
  );
});

test("rejects case-insensitive ambient skill collisions", async (context) => {
  const workspace = temporaryWorkspace();
  const outside = mkdtempSync(join(tmpdir(), "loop-native-case-decoy-"));
  context.after(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  writeFileSync(join(outside, "SKILL.md"), "Ambient");
  const definitions = discoverChatDefinitions(workspace);
  const metadata = runtimeMetadata(definitions);
  metadata.skills.push({
    name: "LOOP-ENGINEERING",
    commandName: "LOOP-ENGINEERING",
    description: definitions.skills[0].description,
    source: "personal-copilot",
    enabled: true,
    userInvocable: true,
    path: join(outside, "SKILL.md")
  });
  const { session } = fakeSession(metadata);
  const adapter = createAdapter(workspace, definitions);

  await assert.rejects(
    adapter.verify(session),
    (error) => error.code === "NATIVE_METADATA_MISMATCH" &&
      /duplicate identities/.test(error.message)
  );
});

test("rejects non-project skill provenance and undeclared path aliases", async (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const definitions = discoverChatDefinitions(workspace);
  const metadata = runtimeMetadata(definitions);
  metadata.skills[0].source = "plugin";
  delete metadata.skills[0].path;
  metadata.skills[0].canonicalPath = definitions.skills[0].canonicalPath;
  const { session } = fakeSession(metadata);
  const adapter = createAdapter(workspace, definitions);

  await assert.rejects(
    adapter.verify(session),
    (error) => error.code === "NATIVE_METADATA_MISMATCH" &&
      /incomplete or inactive/.test(error.message)
  );
});

test("rejects skill tool restrictions that the native metadata cannot verify", (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeFileSync(join(workspace, ".github", "skills", "loop-engineering", "SKILL.md"), [
    "---",
    "name: loop-engineering",
    "description: Operate a bounded loop",
    "tools: [read, search]",
    "---",
    "Use evidence before action.",
    ""
  ].join("\n"));

  assert.throws(
    () => createAdapter(workspace),
    (error) => error.code === "NATIVE_SKILL_TOOL_RESTRICTION_UNSUPPORTED" &&
      error.statusCode === 503 &&
      error.details.tools.join(",") === "read,search"
  );
});

test("surfaces malformed native metadata, reload errors, and SDK failures", async (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const definitions = discoverChatDefinitions(workspace);
  const metadata = runtimeMetadata(definitions);
  const adapter = createAdapter(workspace, definitions);

  const malformed = fakeSession(metadata, {
    agent: {
      async list() {
        return { agents: null };
      }
    }
  });
  await assert.rejects(
    adapter.verify(malformed.session),
    (error) => error.code === "NATIVE_METADATA_INVALID" && error.statusCode === 503
  );

  const reloadFailure = fakeSession(metadata, {
    skills: {
      async reload() {
        return { warnings: ["warning"], errors: ["broken skill"] };
      }
    }
  });
  await assert.rejects(
    adapter.reload(reloadFailure.session),
    (error) => error.code === "NATIVE_SKILL_RELOAD_FAILED" &&
      error.details.errors[0] === "broken skill"
  );

  const sdkError = new Error("SDK transport failed");
  const transportFailure = fakeSession(metadata, {
    commands: {
      async invoke() {
        throw sdkError;
      }
    }
  });
  await adapter.verify(transportFailure.session);
  await assert.rejects(
    adapter.invokeSkill(transportFailure.session, "/loop-engineering inspect"),
    (error) => error === sdkError
  );
});

test("invokes the exact native slash RPC and preserves prompt/display separation", async (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const definitions = discoverChatDefinitions(workspace);
  const metadata = runtimeMetadata(definitions);
  const { session, calls } = fakeSession(metadata);
  const adapter = createAdapter(workspace, definitions);

  const result = await adapter.invokeSkill(
    session,
    "/loop-engineering inspect this exact workspace"
  );

  assert.deepEqual(
    calls.find(([name]) => name === "commands.invoke"),
    ["commands.invoke", {
      name: "loop-engineering",
      input: "inspect this exact workspace"
    }]
  );
  assert.deepEqual(result, {
    prompt: "Trusted native prompt",
    displayPrompt: "/loop-engineering inspect this"
  });

  const unsupported = fakeSession(metadata, {
    commands: {
      async invoke() {
        return { kind: "text", text: "Not an agent prompt" };
      }
    }
  });
  await adapter.verify(unsupported.session);
  await assert.rejects(
    adapter.invokeSkill(unsupported.session, "/loop-engineering"),
    (error) => error.code === "NATIVE_SKILL_RESULT_UNSUPPORTED" &&
      error.statusCode === 503
  );
});

test("deletes sessions only through the verified client API and reports unsupported clients", async (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const adapter = createAdapter(workspace);
  const deleted = [];

  assert.deepEqual(await adapter.deleteSession({}, "session-unsupported"), {
    deleted: false,
    nativeDeleted: false,
    sessionId: "session-unsupported",
    supported: false,
    unsupported: true,
    residualRetention: true,
    code: "NATIVE_SESSION_DELETE_UNSUPPORTED",
    message: "The pinned SDK client does not expose verified native-session deletion."
  });
  assert.deepEqual(await adapter.deleteSession({
    async deleteSession(sessionId) {
      deleted.push(sessionId);
    }
  }, "session-supported"), {
    deleted: true,
    nativeDeleted: true,
    sessionId: "session-supported",
    supported: true,
    unsupported: false,
    residualRetention: false
  });
  assert.deepEqual(deleted, ["session-supported"]);
});

test("native runtime files share the bounded ChatStore budget", async (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const adapter = createAdapter(workspace);
  for (let directoryIndex = 0; directoryIndex < 8; directoryIndex += 1) {
    const directory = join(adapter.runtimeDirectory, "sessions", `bucket-${directoryIndex}`);
    mkdirSync(directory, { recursive: true });
    for (let fileIndex = 0; fileIndex < 16; fileIndex += 1) {
      writeFileSync(
        join(directory, `state-${fileIndex}.bin`),
        Buffer.alloc(16 * 1024, directoryIndex + fileIndex)
      );
    }
  }

  const conversation = await new ChatStore(workspace).createConversation("01");
  assert.equal(conversation.labId, "01");

  const exhaustedWorkspace = temporaryWorkspace();
  context.after(() => rmSync(exhaustedWorkspace, { recursive: true, force: true }));
  const exhaustedAdapter = createAdapter(exhaustedWorkspace);
  writeFileSync(
    join(exhaustedAdapter.runtimeDirectory, "runtime-state.bin"),
    Buffer.alloc(MAX_CHAT_STORE_BYTES)
  );
  await assert.rejects(
    new ChatStore(exhaustedWorkspace).createConversation("01"),
    (error) => error.code === "CHAT_STORE_LIMIT" &&
      /workspace budget/.test(error.message)
  );
});

test("rejects runtime directories outside the ignored workspace chat root", (context) => {
  const workspace = temporaryWorkspace();
  const outside = mkdtempSync(join(tmpdir(), "loop-native-runtime-"));
  context.after(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  assert.throws(
    () => new NativeChatAdapter(workspace, {
      runtimeDirectory: outside,
      definitions: discoverChatDefinitions(workspace)
    }),
    (error) => error.code === "NATIVE_RUNTIME_PATH_ESCAPE"
  );
});

test("rejects an in-workspace junction that redirects the native runtime root", (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const redirected = join(workspace, "redirected-native");
  mkdirSync(join(workspace, ".workshop", "chat"), { recursive: true });
  mkdirSync(redirected);
  symlinkSync(redirected, join(workspace, ".workshop", "chat", "native"), "junction");

  assert.throws(
    () => new NativeChatAdapter(workspace, {
      runtimeDirectory: join(workspace, ".workshop", "chat", "native"),
      definitions: discoverChatDefinitions(workspace)
    }),
    (error) => error.code === "NATIVE_RUNTIME_PATH_ESCAPE"
  );
});

test("does not create directories through linked runtime path segments", (context) => {
  const workspace = temporaryWorkspace();
  const outside = mkdtempSync(join(tmpdir(), "loop-native-write-"));
  context.after(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  mkdirSync(join(workspace, ".workshop"), { recursive: true });
  symlinkSync(outside, join(workspace, ".workshop", "chat"), "junction");

  assert.throws(
    () => new NativeChatAdapter(workspace, {
      runtimeDirectory: join(workspace, ".workshop", "chat", "native", "session"),
      definitions: discoverChatDefinitions(workspace)
    }),
    (error) => error.code === "NATIVE_RUNTIME_PATH_ESCAPE"
  );
  assert.throws(() => lstatSync(join(outside, "native")), { code: "ENOENT" });

  rmSync(join(workspace, ".workshop", "chat"));
  mkdirSync(join(workspace, ".workshop", "chat", "native"), { recursive: true });
  symlinkSync(outside, join(workspace, ".workshop", "chat", "native", "session"), "junction");

  assert.throws(
    () => new NativeChatAdapter(workspace, {
      runtimeDirectory: join(workspace, ".workshop", "chat", "native", "session", "nested"),
      definitions: discoverChatDefinitions(workspace)
    }),
    (error) => error.code === "NATIVE_RUNTIME_PATH_ESCAPE"
  );
  assert.throws(() => lstatSync(join(outside, "nested")), { code: "ENOENT" });
});
