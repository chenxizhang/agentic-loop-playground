import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ChatStore,
  ChatStoreError,
  MAX_CHAT_MESSAGE_BYTES,
  MAX_CHAT_STORE_BYTES,
  MAX_CHAT_TOOL_FIELD_BYTES
} from "../src/chat-store.js";

function temporaryWorkspace({ ignored = true, git = true } = {}) {
  const workspace = mkdtempSync(join(tmpdir(), "loop-chat-store-"));
  if (git) {
    execFileSync("git", ["init", "--quiet"], { cwd: workspace });
  }
  if (ignored) {
    writeFileSync(join(workspace, ".gitignore"), ".workshop/chat/\n");
  }
  return workspace;
}

function readGitExclude(workspace) {
  return readFileSync(join(workspace, ".git", "info", "exclude"), "utf8");
}

test("stores lab-scoped versioned conversations across restarts", async (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const store = new ChatStore(workspace);
  const first = await store.createConversation("01");
  const secondLab = await store.createConversation("02");
  const saved = await store.saveConversation({
    ...first,
    sessionId: "native-session-01",
    selectedAgent: { name: "loop-coach", source: ".github/agents/loop-coach.agent.md" },
    greeting: { state: "complete", attempted: true },
    messages: [{ id: "m1", role: "user", content: "Need help with the observation section." }],
    tools: [{ id: "t1", name: "read", status: "complete", output: "evidence" }],
    operations: [{ operationId: "op1", status: "complete" }],
    status: "ready"
  });
  const secondGeneration = await store.createConversation("01");

  const restarted = new ChatStore(workspace);
  const lab01 = await restarted.loadLab("01");
  const lab02 = await restarted.loadLab("02");

  assert.equal(saved.sessionId, "native-session-01");
  assert.equal(lab01.activeConversationId, secondGeneration.conversationId);
  assert.deepEqual(lab01.conversations.map((record) => record.generation), [1, 2]);
  assert.equal(lab01.conversations[0].messages[0].content, "Need help with the observation section.");
  assert.deepEqual(lab01.conversations[0].selectedAgent, {
    name: "loop-coach",
    source: ".github/agents/loop-coach.agent.md"
  });
  assert.equal(lab02.activeConversationId, secondLab.conversationId);
  assert.equal(lab02.conversations.length, 1);
  const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: workspace,
    encoding: "utf8"
  });
  assert.doesNotMatch(status, /\.workshop\/chat/);
});

test("serializes writes and keeps the last queued durable state", async (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const store = new ChatStore(workspace);
  const conversation = await store.createConversation("01");

  await Promise.all([
    store.saveConversation({ ...conversation, messages: [{ content: "first" }] }),
    store.saveConversation({ ...conversation, messages: [{ content: "second" }] })
  ]);

  const loaded = await new ChatStore(workspace).loadLab("01");
  assert.equal(loaded.activeConversation.messages[0].content, "second");
  const chatDirectory = join(workspace, ".workshop", "chat");
  assert.equal(
    readdirSync(chatDirectory, { recursive: true }).some((entry) => String(entry).endsWith(".tmp")),
    false
  );
});

test("redacts secrets, omits private state, and records bounded truncation", async (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const store = new ChatStore(workspace);
  const conversation = await store.createConversation("01");
  const longMessage = "m".repeat(MAX_CHAT_MESSAGE_BYTES + 100);
  const longToolDetail = "t".repeat(MAX_CHAT_TOOL_FIELD_BYTES + 100);

  await store.saveConversation({
    ...conversation,
    messages: [{
      id: "message",
      role: "assistant",
      content: longMessage,
      hiddenReasoning: "never durable",
      hidden_reasoning: "private marker",
      headers: {
        Authorization: "Bearer secret",
        "x-api-key": "hyphenated marker",
        "Content-Type": "text/plain"
      }
    }],
    tools: [{
      id: "tool",
      arguments: longToolDetail,
      output: { password: "secret", result: "safe" }
    }, {
      id: "tool-credentials",
      output: {
        secretAccessKey: "secret access marker",
        secret_key: "secret key marker",
        aws_secret_access_key: "aws marker",
        accessKey: "access key marker"
      }
    }],
    operations: [{
      operationId: "permission",
      permissionGrant: { token: "secret" },
      permission_grant: { token: "underscored marker" },
      accessToken: "secret",
      "access-token": "access marker",
      status: "complete"
    }]
  });

  const loaded = (await new ChatStore(workspace).loadLab("01")).activeConversation;
  const durableText = readFileSync(
    join(workspace, ".workshop", "chat", "conversations", `${conversation.conversationId}.json`),
    "utf8"
  );
  assert.equal(Buffer.byteLength(loaded.messages[0].content, "utf8"), MAX_CHAT_MESSAGE_BYTES);
  assert.equal(loaded.messages[0].truncation.content.originalBytes, MAX_CHAT_MESSAGE_BYTES + 100);
  assert.equal(loaded.messages[0].headers.Authorization, "[REDACTED]");
  assert.equal(loaded.messages[0].headers["Content-Type"], "text/plain");
  assert.equal("hiddenReasoning" in loaded.messages[0], false);
  assert.equal("hidden_reasoning" in loaded.messages[0], false);
  assert.equal(loaded.messages[0].headers["x-api-key"], "[REDACTED]");
  assert.equal(Buffer.byteLength(loaded.tools[0].arguments, "utf8"), MAX_CHAT_TOOL_FIELD_BYTES);
  assert.equal(loaded.tools[0].truncation.arguments.originalBytes, MAX_CHAT_TOOL_FIELD_BYTES + 100);
  assert.equal(loaded.tools[0].output.password, "[REDACTED]");
  assert.equal(loaded.tools[1].output.secretAccessKey, "[REDACTED]");
  assert.equal(loaded.tools[1].output.secret_key, "[REDACTED]");
  assert.equal(loaded.tools[1].output.aws_secret_access_key, "[REDACTED]");
  assert.equal(loaded.tools[1].output.accessKey, "[REDACTED]");
  assert.equal("permissionGrant" in loaded.operations[0], false);
  assert.equal("permission_grant" in loaded.operations[0], false);
  assert.equal(loaded.operations[0].accessToken, "[REDACTED]");
  assert.equal(loaded.operations[0]["access-token"], "[REDACTED]");
  assert.doesNotMatch(
    durableText,
    /Bearer secret|never durable|private marker|hyphenated marker|underscored marker|access marker|secret access marker|secret key marker|aws marker|access key marker|"secret"/
  );
});

test("refuses malformed durable state without replacing it", async (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const store = new ChatStore(workspace);
  await store.createConversation("01");
  const manifestPath = join(workspace, ".workshop", "chat", "manifest.json");
  writeFileSync(manifestPath, "{broken");
  const before = readFileSync(manifestPath, "utf8");

  await assert.rejects(
    () => new ChatStore(workspace).loadLab("01"),
    (error) => error instanceof ChatStoreError && error.code === "CHAT_STORE_CORRUPT"
  );
  assert.equal(readFileSync(manifestPath, "utf8"), before);
});

test("classifies invalid persisted manifest identifiers as corruption", async (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const store = new ChatStore(workspace);
  await store.createConversation("01");
  const manifestPath = join(workspace, ".workshop", "chat", "manifest.json");
  const invalidManifests = [
    {
      version: 1,
      labs: {
        "bad/id": { activeConversationId: null, conversationIds: [] }
      }
    },
    {
      version: 1,
      labs: {
        "01": { activeConversationId: null, conversationIds: ["bad/id"] }
      }
    },
    {
      version: 1,
      labs: {
        "01": { activeConversationId: "bad/id", conversationIds: [] }
      }
    }
  ];

  for (const manifest of invalidManifests) {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const before = readFileSync(manifestPath, "utf8");
    await assert.rejects(
      () => new ChatStore(workspace).loadLab("01"),
      (error) => error instanceof ChatStoreError && error.code === "CHAT_STORE_CORRUPT"
    );
    assert.equal(readFileSync(manifestPath, "utf8"), before);
  }
});

test("rejects workspace junction escapes before writing", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "loop-chat-junction-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  mkdirSync(workspace);
  mkdirSync(outside);
  execFileSync("git", ["init", "--quiet"], { cwd: workspace });
  writeFileSync(join(workspace, ".gitignore"), ".workshop/chat/\n");
  const excludeBefore = readGitExclude(workspace);
  symlinkSync(outside, join(workspace, ".workshop"), "junction");
  context.after(() => rmSync(root, { recursive: true, force: true }));

  await assert.rejects(
    () => new ChatStore(workspace).createConversation("01"),
    (error) => error instanceof ChatStoreError && error.code === "CHAT_PATH_ESCAPE"
  );
  assert.equal(readGitExclude(workspace), excludeBefore);
  assert.equal(existsSync(join(outside, "chat", "manifest.json")), false);
});

test("rejects in-workspace storage junctions that bypass lexical Git ignores", async (context) => {
  const workspace = temporaryWorkspace();
  const target = join(workspace, "target");
  mkdirSync(target);
  const excludeBefore = readGitExclude(workspace);
  symlinkSync(target, join(workspace, ".workshop"), "junction");
  context.after(() => rmSync(workspace, { recursive: true, force: true }));

  await assert.rejects(
    () => new ChatStore(workspace).createConversation("01"),
    (error) => error instanceof ChatStoreError && error.code === "CHAT_PATH_ESCAPE"
  );
  assert.equal(readGitExclude(workspace), excludeBefore);
  assert.equal(existsSync(join(target, "chat", "manifest.json")), false);
});

test("establishes a local-only exclusion only for a safe Git root", async (context) => {
  const workspace = temporaryWorkspace({ ignored: false });
  context.after(() => rmSync(workspace, { recursive: true, force: true }));

  await new ChatStore(workspace).createConversation("01");

  const exclude = readFileSync(join(workspace, ".git", "info", "exclude"), "utf8");
  assert.match(exclude, /^\/\.workshop\/chat\/$/m);
  execFileSync("git", [
    "check-ignore",
    "--quiet",
    "--no-index",
    ".workshop/chat/manifest.json"
  ], { cwd: workspace });
});

test("checks real transcript destinations rather than a synthetic ignore probe", async (context) => {
  const workspace = temporaryWorkspace({ ignored: false });
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeFileSync(join(workspace, ".gitignore"), [
    ".workshop/chat/manifest.json",
    ".workshop/chat/conversations/chat-store-probe.json",
    ""
  ].join("\n"));

  await new ChatStore(workspace).createConversation("01");

  const exclude = readFileSync(join(workspace, ".git", "info", "exclude"), "utf8");
  assert.match(exclude, /^\/\.workshop\/chat\/$/m);
  const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: workspace,
    encoding: "utf8"
  });
  assert.doesNotMatch(status, /\.workshop\/chat/);
});

test("checks the exact supplied conversation destination before every write", async (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const store = new ChatStore(workspace);
  const conversation = await store.createConversation("01");
  writeFileSync(join(workspace, ".gitignore"), ".workshop/chat/manifest.json\n");
  writeFileSync(join(workspace, ".git", "info", "exclude"), "");

  await assert.rejects(
    () => store.saveConversation({ ...conversation, messages: [{ content: "must be refused" }] }),
    (error) => error instanceof ChatStoreError && error.code === "CHAT_NOT_IGNORED"
  );
});

test("rejects Git-tracked manifest and conversation destinations", async (context) => {
  const manifestWorkspace = temporaryWorkspace();
  const conversationWorkspace = temporaryWorkspace();
  context.after(() => rmSync(manifestWorkspace, { recursive: true, force: true }));
  context.after(() => rmSync(conversationWorkspace, { recursive: true, force: true }));

  const manifestStore = new ChatStore(manifestWorkspace);
  await manifestStore.createConversation("01");
  execFileSync("git", ["add", "-f", ".workshop/chat/manifest.json"], { cwd: manifestWorkspace });
  await assert.rejects(
    () => manifestStore.createConversation("02"),
    (error) => error instanceof ChatStoreError && error.code === "CHAT_TRACKED"
  );

  const conversationStore = new ChatStore(conversationWorkspace);
  const conversation = await conversationStore.createConversation("01");
  execFileSync("git", [
    "add",
    "-f",
    `.workshop/chat/conversations/${conversation.conversationId}.json`
  ], { cwd: conversationWorkspace });
  await assert.rejects(
    () => conversationStore.saveConversation({ ...conversation, messages: [{ content: "tracked" }] }),
    (error) => error instanceof ChatStoreError && error.code === "CHAT_TRACKED"
  );
});

test("requires the actual atomic temporary destination to be ignored", async (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const store = new ChatStore(workspace);
  const conversation = await store.createConversation("01");
  const path = join(
    workspace,
    ".workshop",
    "chat",
    "conversations",
    `${conversation.conversationId}.json`
  );
  const before = readFileSync(path, "utf8");
  writeFileSync(join(workspace, ".git", "info", "exclude"), "");
  writeFileSync(join(workspace, ".gitignore"), [
    ".workshop/chat/manifest.json",
    `.workshop/chat/conversations/${conversation.conversationId}.json`,
    ""
  ].join("\n"));

  await assert.rejects(
    () => store.saveConversation({ ...conversation, messages: [{ content: "not durable" }] }),
    (error) => error instanceof ChatStoreError && error.code === "CHAT_NOT_IGNORED"
  );
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(readdirSync(dirname(path)).some((entry) => entry.endsWith(".tmp")), false);
});

test("refuses an ignored nested directory that is not the Git workspace root", async (context) => {
  const root = temporaryWorkspace();
  const workspace = join(root, "nested");
  mkdirSync(workspace);
  writeFileSync(join(workspace, ".gitignore"), ".workshop/chat/\n");
  context.after(() => rmSync(root, { recursive: true, force: true }));

  await assert.rejects(
    () => new ChatStore(workspace).createConversation("01"),
    (error) => error instanceof ChatStoreError && error.code === "CHAT_NOT_IGNORED"
  );
  assert.equal(existsSync(join(workspace, ".workshop", "chat")), false);
});

test("refuses persistence when a higher-precedence negation exposes conversation files", async (context) => {
  const workspace = temporaryWorkspace({ ignored: false });
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeFileSync(join(workspace, ".gitignore"), [
    ".workshop/chat/",
    "!.workshop/chat/",
    ".workshop/chat/*",
    "!.workshop/chat/conversations/",
    "!.workshop/chat/conversations/**",
    ""
  ].join("\n"));

  await assert.rejects(
    () => new ChatStore(workspace).createConversation("01"),
    (error) => error instanceof ChatStoreError && error.code === "CHAT_NOT_IGNORED"
  );
  assert.equal(existsSync(join(workspace, ".workshop", "chat", "manifest.json")), false);
});

test("non-Git persistence requires an explicit test-only opt-in", async (context) => {
  const workspace = temporaryWorkspace({ git: false, ignored: false });
  context.after(() => rmSync(workspace, { recursive: true, force: true }));

  await assert.rejects(
    () => new ChatStore(workspace).createConversation("01"),
    (error) => error instanceof ChatStoreError && error.code === "CHAT_PERSISTENCE_UNAVAILABLE"
  );
  const record = await new ChatStore(workspace, { allowNonGitTestMode: true }).createConversation("01");
  assert.equal(record.labId, "01");
});

test("enforces the workspace storage budget without deleting history", async (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const store = new ChatStore(workspace);
  const conversation = await store.createConversation("01");
  const budgetPath = join(workspace, ".workshop", "chat", "budget.bin");
  writeFileSync(budgetPath, Buffer.alloc(MAX_CHAT_STORE_BYTES));

  await assert.rejects(
    () => store.saveConversation({ ...conversation, messages: [{ content: "new" }] }),
    (error) => error instanceof ChatStoreError && error.code === "CHAT_STORE_LIMIT"
  );
  assert.equal(existsSync(
    join(workspace, ".workshop", "chat", "conversations", `${conversation.conversationId}.json`)
  ), true);
});

test("forget deletes only application state and reports native deletion as pending", async (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const store = new ChatStore(workspace);
  const first = await store.createConversation("01");
  await store.saveConversation({ ...first, sessionId: "native-session" });
  const second = await store.createConversation("01");

  const result = await store.forget(second.conversationId);
  const lab = await new ChatStore(workspace).loadLab("01");

  assert.equal(result.applicationDeleted, true);
  assert.deepEqual(result.nativeSession, {
    sessionId: null,
    deleted: false,
    requiresAdapterDeletion: false
  });
  assert.equal(lab.activeConversationId, first.conversationId);
  assert.equal(lab.conversations.length, 1);

  const nativeResult = await store.forget(first.conversationId);
  assert.deepEqual(nativeResult.nativeSession, {
    sessionId: "native-session",
    deleted: false,
    requiresAdapterDeletion: true
  });
  assert.equal((await store.loadLab("01")).conversations.length, 0);
});

test("rejects cross-lab and duplicate-generation record corruption", async (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const store = new ChatStore(workspace);
  const first = await store.createConversation("01");
  const second = await store.createConversation("01");
  const firstPath = join(
    workspace,
    ".workshop",
    "chat",
    "conversations",
    `${first.conversationId}.json`
  );
  const secondPath = join(
    workspace,
    ".workshop",
    "chat",
    "conversations",
    `${second.conversationId}.json`
  );
  const firstRecord = JSON.parse(readFileSync(firstPath, "utf8"));
  firstRecord.labId = "02";
  writeFileSync(firstPath, `${JSON.stringify(firstRecord, null, 2)}\n`);

  await assert.rejects(
    () => new ChatStore(workspace).loadLab("01"),
    (error) => error instanceof ChatStoreError && error.code === "CHAT_STORE_CORRUPT"
  );

  firstRecord.labId = "01";
  writeFileSync(firstPath, `${JSON.stringify(firstRecord, null, 2)}\n`);
  const secondRecord = JSON.parse(readFileSync(secondPath, "utf8"));
  secondRecord.generation = firstRecord.generation;
  writeFileSync(secondPath, `${JSON.stringify(secondRecord, null, 2)}\n`);

  await assert.rejects(
    () => new ChatStore(workspace).loadLab("01"),
    (error) => error instanceof ChatStoreError && error.code === "CHAT_STORE_CORRUPT"
  );
});

test("conversation identity cannot change during an update", async (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const store = new ChatStore(workspace);
  const conversation = await store.createConversation("01");

  await assert.rejects(
    () => store.saveConversation({ ...conversation, generation: 2 }),
    (error) => error instanceof ChatStoreError && error.code === "CHAT_IDENTITY_CONFLICT"
  );
  assert.equal((await store.loadLab("01")).activeConversation.generation, 1);
});

test("rejects malformed persisted conversation field types without normalization", async (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const store = new ChatStore(workspace);
  const conversation = await store.createConversation("01");
  const path = join(
    workspace,
    ".workshop",
    "chat",
    "conversations",
    `${conversation.conversationId}.json`
  );
  const malformedRecords = [
    { ...conversation, generation: "1" },
    { ...conversation, messages: { unexpected: true } },
    { ...conversation, tools: "not-an-array" },
    { ...conversation, operations: [null] }
  ];

  for (const malformed of malformedRecords) {
    writeFileSync(path, `${JSON.stringify(malformed, null, 2)}\n`);
    const before = readFileSync(path, "utf8");
    await assert.rejects(
      () => new ChatStore(workspace).loadLab("01"),
      (error) => error instanceof ChatStoreError && error.code === "CHAT_STORE_CORRUPT"
    );
    assert.equal(readFileSync(path, "utf8"), before);
  }
});

test("atomic replacement failure preserves prior conversation bytes", async (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const store = new ChatStore(workspace);
  const conversation = await store.createConversation("01");
  await store.saveConversation({ ...conversation, messages: [{ content: "durable" }] });
  const path = join(
    workspace,
    ".workshop",
    "chat",
    "conversations",
    `${conversation.conversationId}.json`
  );
  const before = readFileSync(path, "utf8");
  const failingStore = new ChatStore(workspace, {
    renameFile: async () => {
      const error = new Error("injected replace failure");
      error.code = "EPERM";
      throw error;
    }
  });

  await assert.rejects(
    () => failingStore.saveConversation({
      ...conversation,
      messages: [{ content: "must not replace durable state" }]
    }),
    (error) => error instanceof ChatStoreError && error.code === "CHAT_WRITE_FAILED"
  );
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(
    readdirSync(dirname(path)).some((entry) => entry.endsWith(".tmp")),
    false
  );
});

test("failed forget manifest replacement leaves the prior durable state untouched", async (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const initialStore = new ChatStore(workspace);
  const conversation = await initialStore.createConversation("01");
  const path = join(
    workspace,
    ".workshop",
    "chat",
    "conversations",
    `${conversation.conversationId}.json`
  );
  const manifestPath = join(workspace, ".workshop", "chat", "manifest.json");
  const beforeConversation = readFileSync(path, "utf8");
  const beforeManifest = readFileSync(manifestPath, "utf8");
  const failingStore = new ChatStore(workspace, {
    async renameFile() {
      const error = new Error("injected manifest failure");
      error.code = "EPERM";
      throw error;
    }
  });

  await assert.rejects(
    () => failingStore.forget(conversation.conversationId),
    (error) => error instanceof ChatStoreError && error.code === "CHAT_WRITE_FAILED"
  );
  assert.equal(readFileSync(path, "utf8"), beforeConversation);
  assert.equal(readFileSync(manifestPath, "utf8"), beforeManifest);
  assert.equal((await new ChatStore(workspace).loadLab("01")).activeConversationId, conversation.conversationId);
  assert.equal(readdirSync(dirname(path)).some((entry) => entry.endsWith(".tmp")), false);
});

test("failed transcript deletion restores the prior manifest", async (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const initialStore = new ChatStore(workspace);
  const conversation = await initialStore.createConversation("01");
  const path = join(
    workspace,
    ".workshop",
    "chat",
    "conversations",
    `${conversation.conversationId}.json`
  );
  const manifestPath = join(workspace, ".workshop", "chat", "manifest.json");
  const beforeConversation = readFileSync(path, "utf8");
  const beforeManifest = readFileSync(manifestPath, "utf8");
  const failingStore = new ChatStore(workspace, {
    async removeFile() {
      const error = new Error("injected delete failure");
      error.code = "EPERM";
      throw error;
    }
  });

  await assert.rejects(
    () => failingStore.forget(conversation.conversationId),
    (error) => error instanceof ChatStoreError && error.code === "CHAT_DELETE_FAILED"
  );
  assert.equal(readFileSync(path, "utf8"), beforeConversation);
  assert.equal(readFileSync(manifestPath, "utf8"), beforeManifest);
  assert.equal((await new ChatStore(workspace).loadLab("01")).activeConversationId, conversation.conversationId);
});
