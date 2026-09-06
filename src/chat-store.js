import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { promisify } from "node:util";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const execFileAsync = promisify(execFile);

export const CHAT_STORE_SCHEMA_VERSION = 1;
export const MAX_CHAT_STORE_BYTES = 10 * 1024 * 1024;
export const MAX_CHAT_MESSAGE_BYTES = 256 * 1024;
export const MAX_CHAT_TOOL_FIELD_BYTES = 64 * 1024;
export const CHAT_IGNORE_PATTERN = "/.workshop/chat/";

const MAX_COLLECTION_ITEMS = 2048;
const MAX_OBJECT_KEYS = 256;
const MAX_SANITIZE_DEPTH = 8;
const REDACTED = "[REDACTED]";
const OMITTED_KEYS = new Set([
  "reasoning",
  "hiddenreasoning",
  "chainofthought",
  "permissiongrant",
  "permissiongrants",
  "approvalgrant",
  "approvalgrants",
  "credential",
  "credentials"
]);
const LAB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export class ChatStoreError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "ChatStoreError";
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pathIsInside(parent, child) {
  const pathFromParent = relative(parent, child);
  return pathFromParent === "" || (
    pathFromParent !== ".." &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent)
  );
}

function pathsEqual(left, right) {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

function normalizedKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isOmittedKey(key) {
  return OMITTED_KEYS.has(normalizedKey(key));
}

function isSecretKey(key) {
  const normalized = normalizedKey(key);
  return /(?:authorization|cookie|token|secret|password|passwd|apikey|accesskey|secretkey|privatekey)$/.test(normalized);
}

function validateLabId(labId) {
  if (typeof labId !== "string" || !LAB_ID_PATTERN.test(labId)) {
    throw new ChatStoreError(
      "CHAT_INVALID_LAB_ID",
      "Lab IDs must contain 1-64 letters, numbers, underscores, or hyphens."
    );
  }
  return labId;
}

function validateConversationId(conversationId) {
  if (typeof conversationId !== "string" || !CONVERSATION_ID_PATTERN.test(conversationId)) {
    throw new ChatStoreError(
      "CHAT_INVALID_CONVERSATION_ID",
      "Conversation IDs must contain 1-128 letters, numbers, underscores, or hyphens."
    );
  }
  return conversationId;
}

function truncateUtf8(value, maxBytes) {
  const text = String(value ?? "");
  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes <= maxBytes) {
    return { value: text, truncated: false, originalBytes, storedBytes: originalBytes };
  }
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), "utf8") <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const stored = text.slice(0, low);
  return {
    value: stored,
    truncated: true,
    originalBytes,
    storedBytes: Buffer.byteLength(stored, "utf8")
  };
}

function sanitizeValue(value, {
  maxStringBytes = MAX_CHAT_TOOL_FIELD_BYTES,
  depth = 0,
  key = ""
} = {}) {
  if (isOmittedKey(key)) {
    return undefined;
  }
  if (isSecretKey(key)) {
    return REDACTED;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return truncateUtf8(value, maxStringBytes).value;
  }
  if (depth >= MAX_SANITIZE_DEPTH) {
    return "[OMITTED: depth limit]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_COLLECTION_ITEMS).map((item) => (
      sanitizeValue(item, { maxStringBytes, depth: depth + 1 })
    ));
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const sanitized = {};
  for (const [entryKey, entryValue] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    const nextValue = sanitizeValue(entryValue, {
      maxStringBytes,
      depth: depth + 1,
      key: entryKey
    });
    if (nextValue !== undefined) {
      sanitized[entryKey] = nextValue;
    }
  }
  return sanitized;
}

function sanitizeMessage(message, index) {
  const source = isRecord(message) ? message : { content: message };
  const content = truncateUtf8(source.content ?? "", MAX_CHAT_MESSAGE_BYTES);
  const sanitized = sanitizeValue(source, { maxStringBytes: MAX_CHAT_TOOL_FIELD_BYTES }) ?? {};
  delete sanitized.reasoning;
  delete sanitized.hiddenReasoning;
  sanitized.id = truncateUtf8(source.id ?? `message-${index + 1}`, 512).value;
  sanitized.role = truncateUtf8(source.role ?? "assistant", 64).value;
  sanitized.content = content.value;
  if (content.truncated) {
    sanitized.truncation = {
      ...(isRecord(sanitized.truncation) ? sanitized.truncation : {}),
      content: {
        originalBytes: content.originalBytes,
        storedBytes: content.storedBytes
      }
    };
  }
  return sanitized;
}

function sanitizeTool(tool, index) {
  const source = isRecord(tool) ? tool : { detail: tool };
  const sanitized = sanitizeValue(source, { maxStringBytes: MAX_CHAT_TOOL_FIELD_BYTES }) ?? {};
  sanitized.id = truncateUtf8(source.id ?? source.callId ?? `tool-${index + 1}`, 512).value;
  const truncation = {};
  for (const [field, fieldValue] of Object.entries(source)) {
    if (typeof fieldValue !== "string" || isOmittedKey(field) || isSecretKey(field)) {
      continue;
    }
    const result = truncateUtf8(fieldValue, MAX_CHAT_TOOL_FIELD_BYTES);
    sanitized[field] = result.value;
    if (result.truncated) {
      truncation[field] = {
        originalBytes: result.originalBytes,
        storedBytes: result.storedBytes
      };
    }
  }
  if (Object.keys(truncation).length > 0) {
    sanitized.truncation = {
      ...(isRecord(sanitized.truncation) ? sanitized.truncation : {}),
      ...truncation
    };
  }
  return sanitized;
}

export function sanitizeChatRecord(record, { now = () => new Date().toISOString() } = {}) {
  if (!isRecord(record)) {
    throw new ChatStoreError("CHAT_INVALID_RECORD", "Conversation record must be an object.");
  }
  const labId = validateLabId(record.labId);
  const conversationId = validateConversationId(record.conversationId);
  const generation = Number(record.generation);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new ChatStoreError("CHAT_INVALID_GENERATION", "Conversation generation must be a positive integer.");
  }
  const createdAt = truncateUtf8(record.createdAt ?? now(), 128).value;
  const updatedAt = truncateUtf8(record.updatedAt ?? now(), 128).value;
  const sanitized = {
    version: CHAT_STORE_SCHEMA_VERSION,
    labId,
    conversationId,
    generation,
    sessionId: record.sessionId == null ? null : truncateUtf8(record.sessionId, 1024).value,
    greeting: sanitizeValue(record.greeting ?? { state: "pending" }) ?? { state: "pending" },
    selectedAgent: sanitizeValue(record.selectedAgent ?? null),
    messages: Array.isArray(record.messages)
      ? record.messages.slice(0, MAX_COLLECTION_ITEMS).map(sanitizeMessage)
      : [],
    tools: Array.isArray(record.tools)
      ? record.tools.slice(0, MAX_COLLECTION_ITEMS).map(sanitizeTool)
      : [],
    operations: Array.isArray(record.operations)
      ? record.operations.slice(0, MAX_COLLECTION_ITEMS).map((operation) => (
        sanitizeValue(operation, { maxStringBytes: MAX_CHAT_TOOL_FIELD_BYTES }) ?? {}
      ))
      : [],
    status: sanitizeValue(record.status ?? "new", { maxStringBytes: 4096 }),
    createdAt,
    updatedAt
  };
  return validatePersistedRecord(sanitized, "conversation record");
}

export function serializeChatRecord(record, options) {
  return `${JSON.stringify(sanitizeChatRecord(record, options), null, 2)}\n`;
}

function emptyManifest() {
  return {
    version: CHAT_STORE_SCHEMA_VERSION,
    labs: {}
  };
}

function normalizeManifest(value, path) {
  if (!isRecord(value) || value.version !== CHAT_STORE_SCHEMA_VERSION || !isRecord(value.labs)) {
    throw new ChatStoreError(
      "CHAT_STORE_CORRUPT",
      `Chat manifest ${path} has an unsupported or malformed schema and was preserved.`
    );
  }
  const labs = {};
  for (const [labId, lab] of Object.entries(value.labs)) {
    try {
      validateLabId(labId);
    } catch (error) {
      throw new ChatStoreError(
        "CHAT_STORE_CORRUPT",
        `Chat manifest ${path} contains an invalid persisted lab ID and was preserved.`,
        { cause: error }
      );
    }
    if (!isRecord(lab) || !Array.isArray(lab.conversationIds)) {
      throw new ChatStoreError(
        "CHAT_STORE_CORRUPT",
        `Chat manifest ${path} has a malformed entry for lab ${labId} and was preserved.`
      );
    }
    let conversationIds;
    try {
      conversationIds = lab.conversationIds.map(validateConversationId);
    } catch (error) {
      throw new ChatStoreError(
        "CHAT_STORE_CORRUPT",
        `Chat manifest ${path} contains an invalid persisted conversation ID for lab ${labId}.`,
        { cause: error }
      );
    }
    if (new Set(conversationIds).size !== conversationIds.length) {
      throw new ChatStoreError(
        "CHAT_STORE_CORRUPT",
        `Chat manifest ${path} contains duplicate conversations for lab ${labId} and was preserved.`
      );
    }
    let activeConversationId = null;
    if (lab.activeConversationId != null) {
      try {
        activeConversationId = validateConversationId(lab.activeConversationId);
      } catch (error) {
        throw new ChatStoreError(
          "CHAT_STORE_CORRUPT",
          `Chat manifest ${path} contains an invalid active conversation ID for lab ${labId}.`,
          { cause: error }
        );
      }
    }
    if (activeConversationId && !conversationIds.includes(activeConversationId)) {
      throw new ChatStoreError(
        "CHAT_STORE_CORRUPT",
        `Chat manifest ${path} references a missing active conversation for lab ${labId}.`
      );
    }
    labs[labId] = { activeConversationId, conversationIds };
  }
  return { version: CHAT_STORE_SCHEMA_VERSION, labs };
}

function validatePersistedRecord(value, path) {
  if (!isRecord(value) || value.version !== CHAT_STORE_SCHEMA_VERSION) {
    throw new ChatStoreError(
      "CHAT_STORE_CORRUPT",
      `Conversation file ${path} has an unsupported or malformed schema and was preserved.`
    );
  }
  validateLabId(value.labId);
  validateConversationId(value.conversationId);
  if (!Number.isSafeInteger(value.generation) || value.generation < 1) {
    throw new ChatStoreError(
      "CHAT_STORE_CORRUPT",
      `Conversation file ${path} has an invalid generation and was preserved.`
    );
  }
  if (value.sessionId !== null && typeof value.sessionId !== "string") {
    throw new ChatStoreError(
      "CHAT_STORE_CORRUPT",
      `Conversation file ${path} has an invalid session ID and was preserved.`
    );
  }
  if (!isRecord(value.greeting)) {
    throw new ChatStoreError(
      "CHAT_STORE_CORRUPT",
      `Conversation file ${path} has invalid greeting state and was preserved.`
    );
  }
  if (
    value.selectedAgent !== null &&
    typeof value.selectedAgent !== "string" &&
    !isRecord(value.selectedAgent)
  ) {
    throw new ChatStoreError(
      "CHAT_STORE_CORRUPT",
      `Conversation file ${path} has invalid selected-agent state and was preserved.`
    );
  }
  for (const field of ["messages", "tools", "operations"]) {
    if (!Array.isArray(value[field]) || value[field].some((entry) => !isRecord(entry))) {
      throw new ChatStoreError(
        "CHAT_STORE_CORRUPT",
        `Conversation file ${path} has an invalid ${field} collection and was preserved.`
      );
    }
  }
  if (
    value.messages.some((message) => (
      typeof message.id !== "string" ||
      typeof message.role !== "string" ||
      typeof message.content !== "string"
    ))
  ) {
    throw new ChatStoreError(
      "CHAT_STORE_CORRUPT",
      `Conversation file ${path} has an invalid message record and was preserved.`
    );
  }
  if (
    (typeof value.status !== "string" && !isRecord(value.status)) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw new ChatStoreError(
      "CHAT_STORE_CORRUPT",
      `Conversation file ${path} has invalid status or timestamps and was preserved.`
    );
  }
  return value;
}

async function atomicWrite(path, contents, {
  renameFile = rename,
  temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
} = {}) {
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameFile(temporaryPath, path);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw new ChatStoreError(
      "CHAT_WRITE_FAILED",
      `Could not atomically replace ${path}; the previous durable file was preserved: ${error.message}`,
      { cause: error }
    );
  }
}

async function runGit(workspace, args) {
  return execFileAsync("git", args, {
    cwd: workspace,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 256 * 1024
  });
}

export class ChatStore {
  #allowNonGitTestMode;
  #canonicalWorkspace;
  #clock;
  #removeFile;
  #renameFile;
  #ready;
  #workspace;
  #writes = Promise.resolve();

  constructor(workspace, {
    allowNonGitTestMode = false,
    clock = () => new Date().toISOString(),
    removeFile = unlink,
    renameFile = rename
  } = {}) {
    if (typeof workspace !== "string" || !workspace.trim()) {
      throw new TypeError("ChatStore requires an explicit workspace path.");
    }
    this.#workspace = resolve(workspace);
    this.#allowNonGitTestMode = Boolean(allowNonGitTestMode);
    this.#clock = clock;
    this.#removeFile = removeFile;
    this.#renameFile = renameFile;
  }

  get workspace() {
    return this.#canonicalWorkspace ?? this.#workspace;
  }

  async loadLab(labId) {
    validateLabId(labId);
    await this.#writes;
    await this.#ensureReady();
    const manifest = await this.#readManifest();
    const lab = manifest.labs[labId] ?? { activeConversationId: null, conversationIds: [] };
    const conversations = [];
    const generations = new Set();
    for (const conversationId of lab.conversationIds) {
      const conversation = await this.#readConversation(conversationId);
      if (conversation.labId !== labId) {
        throw new ChatStoreError(
          "CHAT_STORE_CORRUPT",
          `Conversation ${conversationId} belongs to lab ${conversation.labId}, not manifest lab ${labId}.`
        );
      }
      if (generations.has(conversation.generation)) {
        throw new ChatStoreError(
          "CHAT_STORE_CORRUPT",
          `Lab ${labId} contains duplicate conversation generation ${conversation.generation}.`
        );
      }
      generations.add(conversation.generation);
      conversations.push(conversation);
    }
    return {
      labId,
      activeConversationId: lab.activeConversationId,
      activeConversation: conversations.find((record) => record.conversationId === lab.activeConversationId) ?? null,
      conversations
    };
  }

  async listConversations(labId) {
    return (await this.loadLab(labId)).conversations;
  }

  async createConversation(labId) {
    validateLabId(labId);
    return this.#enqueue(async () => {
      await this.#ensureReady();
      const manifest = await this.#readManifest();
      const lab = manifest.labs[labId] ?? { activeConversationId: null, conversationIds: [] };
      let generation = 1;
      for (const conversationId of lab.conversationIds) {
        const conversation = await this.#readConversation(conversationId);
        generation = Math.max(generation, conversation.generation + 1);
      }
      const timestamp = this.#clock();
      const record = sanitizeChatRecord({
        version: CHAT_STORE_SCHEMA_VERSION,
        labId,
        conversationId: randomUUID(),
        generation,
        sessionId: null,
        greeting: { state: "pending", attempted: false },
        selectedAgent: null,
        messages: [],
        tools: [],
        operations: [],
        status: "new",
        createdAt: timestamp,
        updatedAt: timestamp
      }, { now: this.#clock });
      await this.#writeNewConversation(record, manifest);
      return record;
    });
  }

  async saveConversation(record) {
    return this.#enqueue(async () => {
      await this.#ensureReady();
      const sanitized = sanitizeChatRecord({
        ...record,
        updatedAt: this.#clock()
      }, { now: this.#clock });
      const manifest = await this.#readManifest();
      const lab = manifest.labs[sanitized.labId] ?? {
        activeConversationId: null,
        conversationIds: []
      };
      const owner = this.#findConversationOwner(manifest, sanitized.conversationId);
      if (owner && owner !== sanitized.labId) {
        throw new ChatStoreError(
          "CHAT_IDENTITY_CONFLICT",
          `Conversation ${sanitized.conversationId} already belongs to lab ${owner}.`
        );
      }
      const isNew = !lab.conversationIds.includes(sanitized.conversationId);
      if (!isNew) {
        const existing = await this.#readConversation(sanitized.conversationId);
        if (existing.generation !== sanitized.generation) {
          throw new ChatStoreError(
            "CHAT_IDENTITY_CONFLICT",
            `Conversation ${sanitized.conversationId} generation cannot change from ${existing.generation} to ${sanitized.generation}.`
          );
        }
      } else {
        const duplicateGeneration = await this.#findGeneration(lab.conversationIds, sanitized.generation);
        if (duplicateGeneration) {
          throw new ChatStoreError(
            "CHAT_GENERATION_CONFLICT",
            `Lab ${sanitized.labId} already has conversation generation ${sanitized.generation}.`
          );
        }
      }
      const path = this.#conversationPath(sanitized.conversationId);
      const serialized = `${JSON.stringify(sanitized, null, 2)}\n`;
      await this.#replaceChatFile(path, serialized);
      if (isNew) {
        lab.conversationIds.push(sanitized.conversationId);
        lab.activeConversationId ??= sanitized.conversationId;
        manifest.labs[sanitized.labId] = lab;
        try {
          await this.#writeManifest(manifest);
        } catch (error) {
          await unlink(path).catch(() => {});
          throw error;
        }
      }
      return sanitized;
    });
  }

  async forget(conversationId) {
    validateConversationId(conversationId);
    return this.#enqueue(async () => {
      await this.#ensureReady();
      const manifest = await this.#readManifest();
      const labId = this.#findConversationOwner(manifest, conversationId);
      if (!labId) {
        return {
          forgotten: false,
          applicationDeleted: false,
          nativeSession: { sessionId: null, deleted: false, requiresAdapterDeletion: false }
        };
      }
      const record = await this.#readConversation(conversationId);
      const path = this.#conversationPath(conversationId);
      const originalManifest = structuredClone(manifest);
      const lab = manifest.labs[labId];
      lab.conversationIds = lab.conversationIds.filter((id) => id !== conversationId);
      if (lab.activeConversationId === conversationId) {
        lab.activeConversationId = lab.conversationIds.at(-1) ?? null;
      }
      if (lab.conversationIds.length === 0) {
        delete manifest.labs[labId];
      }
      await this.#assertExistingPathSafe(path);
      await this.#assertIgnoredDestination(path);
      const manifestTemporaryPath = await this.#prepareAtomicWrite(this.#manifestPath());
      const restoreManifestTemporaryPath = await this.#prepareAtomicWrite(this.#manifestPath());
      await this.#writeManifest(manifest, { temporaryPath: manifestTemporaryPath });
      try {
        await this.#removeFile(path);
      } catch (deleteError) {
        try {
          await this.#writeManifest(originalManifest, {
            temporaryPath: restoreManifestTemporaryPath
          });
        } catch (restoreError) {
          throw new ChatStoreError(
            "CHAT_FORGET_INCOMPLETE",
            `Conversation ${conversationId} was not deleted, but the prior manifest could not be restored: ${restoreError.message}`,
            { cause: new AggregateError([deleteError, restoreError]) }
          );
        }
        throw new ChatStoreError(
          "CHAT_DELETE_FAILED",
          `Conversation ${conversationId} remains durable because deletion failed: ${deleteError.message}`,
          { cause: deleteError }
        );
      }
      return {
        forgotten: true,
        applicationDeleted: true,
        labId,
        conversationId,
        nativeSession: {
          sessionId: record.sessionId,
          deleted: false,
          requiresAdapterDeletion: Boolean(record.sessionId)
        }
      };
    });
  }

  #enqueue(task) {
    const result = this.#writes.then(task, task);
    this.#writes = result.catch(() => {});
    return result;
  }

  async #ensureReady() {
    this.#ready ??= this.#initialize();
    return this.#ready;
  }

  async #initialize() {
    let workspaceStat;
    try {
      workspaceStat = await stat(this.#workspace);
      this.#canonicalWorkspace = await realpath(this.#workspace);
    } catch (error) {
      throw new ChatStoreError(
        "CHAT_WORKSPACE_UNAVAILABLE",
        `Workspace ${this.#workspace} is unavailable: ${error.message}`,
        { cause: error }
      );
    }
    if (!workspaceStat.isDirectory()) {
      throw new ChatStoreError("CHAT_WORKSPACE_UNAVAILABLE", `Workspace ${this.#workspace} is not a directory.`);
    }
    await this.#assertExistingStorageHierarchySafe();
    await this.#ensureIgnored();
    await this.#ensureDirectory(".workshop");
    await this.#ensureDirectory(join(".workshop", "chat"));
    await this.#ensureDirectory(join(".workshop", "chat", "conversations"));
  }

  async #ensureIgnored() {
    if (this.#allowNonGitTestMode) {
      return;
    }
    let metadata;
    try {
      const { stdout } = await runGit(this.#canonicalWorkspace, [
        "rev-parse",
        "--show-toplevel",
        "--absolute-git-dir"
      ]);
      const [topLevel, gitDirectory] = stdout.trim().split(/\r?\n/);
      metadata = {
        topLevel: await realpath(resolve(topLevel)),
        gitDirectory: await realpath(resolve(gitDirectory))
      };
    } catch (error) {
      throw new ChatStoreError(
        "CHAT_PERSISTENCE_UNAVAILABLE",
        `Chat persistence is unavailable because ${this.#canonicalWorkspace} is not an eligible Git workspace. ` +
        "Tests may opt in explicitly with allowNonGitTestMode.",
        { cause: error }
      );
    }
    if (
      metadata.topLevel !== this.#canonicalWorkspace ||
      !pathIsInside(this.#canonicalWorkspace, metadata.gitDirectory)
    ) {
      throw new ChatStoreError(
        "CHAT_NOT_IGNORED",
        `${CHAT_IGNORE_PATTERN} is not ignored. Add it to the workspace .gitignore; the store refused to edit an outer or external Git directory.`
      );
    }
    if (await this.#isIgnored()) {
      return;
    }
    const excludePath = join(metadata.gitDirectory, "info", "exclude");
    await mkdir(dirname(excludePath), { recursive: true });
    let contents = "";
    try {
      contents = await readFile(excludePath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    const lines = contents.split(/\r?\n/).map((line) => line.trim());
    if (!lines.includes(CHAT_IGNORE_PATTERN)) {
      const prefix = contents && !contents.endsWith("\n") ? "\n" : "";
      await appendFile(excludePath, `${prefix}${CHAT_IGNORE_PATTERN}\n`, { encoding: "utf8", mode: 0o600 });
    }
    if (!await this.#isIgnored()) {
      throw new ChatStoreError(
        "CHAT_NOT_IGNORED",
        `Chat persistence remains disabled because Git does not ignore ${CHAT_IGNORE_PATTERN}.`
      );
    }
  }

  async #isIgnored() {
    for (const path of [
      ".workshop/chat/manifest.json",
      `.workshop/chat/conversations/${randomUUID()}.json`
    ]) {
      if (!await this.#isIgnoredPath(path)) {
        return false;
      }
    }
    return true;
  }

  async #isIgnoredPath(path) {
    try {
      await runGit(this.#canonicalWorkspace, [
        "check-ignore",
        "--quiet",
        "--no-index",
        path
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async #isTrackedPath(path) {
    const { stdout } = await runGit(this.#canonicalWorkspace, [
      "ls-files",
      "--stage",
      "--",
      path
    ]);
    return Boolean(stdout.trim());
  }

  async #assertIgnoredDestination(path) {
    if (this.#allowNonGitTestMode) {
      return;
    }
    const workspaceRelativePath = relative(this.#canonicalWorkspace, path).split(sep).join("/");
    if (!pathIsInside(this.#canonicalWorkspace, path)) {
      throw new ChatStoreError(
        "CHAT_PATH_ESCAPE",
        `Chat persistence refused to access ${workspaceRelativePath} outside the workspace.`
      );
    }
    if (await this.#isTrackedPath(workspaceRelativePath)) {
      throw new ChatStoreError(
        "CHAT_TRACKED",
        `Chat persistence refused to write ${workspaceRelativePath} because it is tracked by Git.`
      );
    }
    if (!await this.#isIgnoredPath(workspaceRelativePath)) {
      throw new ChatStoreError(
        "CHAT_NOT_IGNORED",
        `Chat persistence refused to write ${workspaceRelativePath} because Git does not ignore that exact destination.`
      );
    }
  }

  async #prepareAtomicWrite(path) {
    await this.#assertExistingPathSafe(path);
    await this.#assertIgnoredDestination(path);
    const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
    await this.#assertIgnoredDestination(temporaryPath);
    return temporaryPath;
  }

  async #replaceChatFile(path, contents, { temporaryPath } = {}) {
    const preparedTemporaryPath = temporaryPath ?? await this.#prepareAtomicWrite(path);
    if (temporaryPath) {
      await this.#assertExistingPathSafe(path);
      await this.#assertIgnoredDestination(path);
      await this.#assertIgnoredDestination(temporaryPath);
    }
    const oldBytes = await this.#existingSize(path);
    await this.#assertBudget(Buffer.byteLength(contents, "utf8") - oldBytes);
    await atomicWrite(path, contents, {
      renameFile: this.#renameFile,
      temporaryPath: preparedTemporaryPath
    });
  }

  async #assertStorageDirectorySafe(path) {
    const pathMetadata = await lstat(path);
    const canonicalPath = await realpath(path);
    if (
      pathMetadata.isSymbolicLink() ||
      !pathIsInside(this.#canonicalWorkspace, canonicalPath) ||
      !pathsEqual(path, canonicalPath)
    ) {
      throw new ChatStoreError(
        "CHAT_PATH_ESCAPE",
        `Chat storage path ${path} must be a real directory at its canonical workspace location.`
      );
    }
    const pathStat = await stat(canonicalPath);
    if (!pathStat.isDirectory()) {
      throw new ChatStoreError("CHAT_PATH_ESCAPE", `Chat storage path ${path} is not a directory.`);
    }
  }

  async #ensureDirectory(relativePath) {
    const path = join(this.#canonicalWorkspace, relativePath);
    await mkdir(path).catch((error) => {
      if (error.code !== "EEXIST") {
        throw error;
      }
    });
    await this.#assertStorageDirectorySafe(path);
  }

  #manifestPath() {
    return join(this.#canonicalWorkspace, ".workshop", "chat", "manifest.json");
  }

  #conversationPath(conversationId) {
    return join(
      this.#canonicalWorkspace,
      ".workshop",
      "chat",
      "conversations",
      `${validateConversationId(conversationId)}.json`
    );
  }

  async #assertExistingPathSafe(path) {
    await this.#assertStorageHierarchySafe();
    try {
      const fileStat = await lstat(path);
      if (fileStat.isSymbolicLink()) {
        throw new ChatStoreError("CHAT_PATH_ESCAPE", `Chat file ${path} must not be a symbolic link or junction.`);
      }
      const canonicalPath = await realpath(path);
      if (!pathIsInside(this.#canonicalWorkspace, canonicalPath) || !pathsEqual(path, canonicalPath)) {
        throw new ChatStoreError("CHAT_PATH_ESCAPE", `Chat file ${path} resolves outside its canonical location.`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  async #assertExistingStorageHierarchySafe() {
    for (const relativePath of [
      ".workshop",
      join(".workshop", "chat"),
      join(".workshop", "chat", "conversations")
    ]) {
      const path = join(this.#canonicalWorkspace, relativePath);
      try {
        await this.#assertStorageDirectorySafe(path);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }

  async #assertStorageHierarchySafe() {
    for (const relativePath of [
      ".workshop",
      join(".workshop", "chat"),
      join(".workshop", "chat", "conversations")
    ]) {
      const path = join(this.#canonicalWorkspace, relativePath);
      await this.#assertStorageDirectorySafe(path);
    }
  }

  async #readManifest() {
    const path = this.#manifestPath();
    await this.#assertExistingPathSafe(path);
    let contents;
    try {
      contents = await readFile(path, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return emptyManifest();
      }
      throw error;
    }
    try {
      return normalizeManifest(JSON.parse(contents), path);
    } catch (error) {
      if (error instanceof ChatStoreError) {
        throw error;
      }
      throw new ChatStoreError(
        "CHAT_STORE_CORRUPT",
        `Chat manifest ${path} is malformed and was preserved: ${error.message}`,
        { cause: error }
      );
    }
  }

  async #writeManifest(manifest, options = {}) {
    const path = this.#manifestPath();
    const normalized = normalizeManifest(manifest, path);
    const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
    await this.#replaceChatFile(path, serialized, options);
  }

  async #readConversation(conversationId) {
    const path = this.#conversationPath(conversationId);
    await this.#assertExistingPathSafe(path);
    let contents;
    try {
      const fileStat = await stat(path);
      if (fileStat.size > MAX_CHAT_STORE_BYTES) {
        throw new ChatStoreError("CHAT_STORE_CORRUPT", `Conversation file ${path} exceeds the store budget.`);
      }
      contents = await readFile(path, "utf8");
    } catch (error) {
      if (error instanceof ChatStoreError) {
        throw error;
      }
      throw new ChatStoreError(
        "CHAT_STORE_CORRUPT",
        `Conversation file ${path} is missing or unreadable and the manifest was preserved: ${error.message}`,
        { cause: error }
      );
    }
    try {
      const parsed = JSON.parse(contents);
      const sanitized = sanitizeChatRecord(validatePersistedRecord(parsed, path), { now: this.#clock });
      if (sanitized.conversationId !== conversationId) {
        throw new Error("identity mismatch");
      }
      return sanitized;
    } catch (error) {
      throw new ChatStoreError(
        "CHAT_STORE_CORRUPT",
        `Conversation file ${path} is malformed and was preserved: ${error.message}`,
        { cause: error }
      );
    }
  }

  async #writeNewConversation(record, manifest) {
    const path = this.#conversationPath(record.conversationId);
    const serialized = `${JSON.stringify(record, null, 2)}\n`;
    await this.#replaceChatFile(path, serialized);
    const lab = manifest.labs[record.labId] ?? { activeConversationId: null, conversationIds: [] };
    lab.conversationIds.push(record.conversationId);
    lab.activeConversationId = record.conversationId;
    manifest.labs[record.labId] = lab;
    try {
      await this.#writeManifest(manifest);
    } catch (error) {
      await unlink(path).catch(() => {});
      throw error;
    }
  }

  #findConversationOwner(manifest, conversationId) {
    for (const [labId, lab] of Object.entries(manifest.labs)) {
      if (lab.conversationIds.includes(conversationId)) {
        return labId;
      }
    }
    return null;
  }

  async #findGeneration(conversationIds, generation) {
    for (const conversationId of conversationIds) {
      if ((await this.#readConversation(conversationId)).generation === generation) {
        return conversationId;
      }
    }
    return null;
  }

  async #existingSize(path) {
    try {
      return (await stat(path)).size;
    } catch (error) {
      if (error.code === "ENOENT") {
        return 0;
      }
      throw error;
    }
  }

  async #assertBudget(deltaBytes) {
    await this.#assertStorageHierarchySafe();
    const chatRoot = join(this.#canonicalWorkspace, ".workshop", "chat");
    let total = 0;
    const pending = [chatRoot];
    let entriesSeen = 0;
    while (pending.length > 0) {
      const directory = pending.pop();
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        entriesSeen += 1;
        if (entriesSeen > 8192) {
          throw new ChatStoreError("CHAT_STORE_LIMIT", "Chat storage contains too many filesystem entries.");
        }
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          const canonicalPath = await realpath(path);
          if (!pathIsInside(this.#canonicalWorkspace, canonicalPath)) {
            throw new ChatStoreError("CHAT_PATH_ESCAPE", `Chat storage entry ${path} escapes the workspace.`);
          }
        }
        if (entry.isDirectory()) {
          pending.push(path);
        } else if (entry.isFile()) {
          total += (await stat(path)).size;
        }
      }
    }
    if (total + deltaBytes > MAX_CHAT_STORE_BYTES) {
      throw new ChatStoreError(
        "CHAT_STORE_LIMIT",
        `Chat persistence would exceed the ${MAX_CHAT_STORE_BYTES}-byte workspace budget.`
      );
    }
  }
}
