import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const detailLimit = 64 * 1024;
const secretKey = /authorization|cookie|password|passwd|secret|token|api[-_]?key|private[-_]?key|credential/i;

function chatError(message, code, statusCode = 422) {
  return Object.assign(new Error(message), { code, statusCode });
}

function publicDetail(value) {
  let remaining = 16 * 1024;
  let nodes = 512;
  const seen = new Set();
  function visit(item, depth = 0) {
    if (item === undefined || item === null) return null;
    if (--nodes < 0 || remaining <= 0 || depth > 8) return "[truncated]";
    if (typeof item === "string") {
      const text = item.replace(/(authorization\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/gi, "$1[redacted]");
      const length = Math.min(text.length, remaining);
      remaining -= length;
      return length < text.length ? `${text.slice(0, length)} [truncated]` : text;
    }
    if (typeof item === "boolean" || typeof item === "number") return item;
    if (typeof item !== "object") return String(item);
    if (seen.has(item)) return "[circular]";
    seen.add(item);
    const result = Array.isArray(item) ? [] : {};
    for (const key of Object.keys(item)) {
      if (nodes <= 0 || remaining <= 0) {
        if (Array.isArray(result)) result.push("[truncated]");
        else result.truncated = true;
        break;
      }
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      remaining -= key.length;
      result[key] = secretKey.test(key) ? "[redacted]" : visit(item[key], depth + 1);
    }
    return result;
  }
  const sanitized = visit(value);
  const serialized = JSON.stringify(sanitized);
  if (Buffer.byteLength(serialized) <= detailLimit) return sanitized;
  return { preview: serialized.slice(0, detailLimit / 8), truncated: true, limitBytes: detailLimit };
}

async function disposeRuntime(session, client) {
  const errors = [];
  if (session) {
    try {
      await session.disconnect();
    } catch (error) {
      errors.push(error);
    }
  }
  if (client) {
    try {
      const stopErrors = await client.stop();
      if (Array.isArray(stopErrors)) errors.push(...stopErrors);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "Copilot runtime cleanup failed.");
}

export function findCopilotCli({
  cliPath = process.env.COPILOT_CLI_PATH,
  resolvePackage = createRequire(import.meta.url).resolve
} = {}) {
  if (cliPath) {
    return cliPath;
  }
  try {
    const platform = process.platform === "linux" ? "linux" : process.platform;
    const packageName = `@github/copilot-${platform}-${process.arch}`;
    const packageEntry = resolvePackage(packageName);
    if (["copilot", "copilot.exe"].includes(basename(packageEntry).toLowerCase()) && existsSync(packageEntry)) {
      return packageEntry;
    }
    const sdkEntry = join(dirname(packageEntry), "index.js");
    if (existsSync(sdkEntry)) {
      return sdkEntry;
    }
  } catch {
  }
  try {
    const command = process.platform === "win32" ? "where.exe" : "which";
    return execFileSync(command, ["copilot"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).split(/\r?\n/).find(Boolean);
  } catch {
    return undefined;
  }
}

export function isSafeWorkspacePath(workspace, path) {
  try {
    const canonicalWorkspace = realpathSync.native(resolve(workspace));
    const target = realpathSync.native(resolve(workspace, path));
    const relation = relative(canonicalWorkspace, target);
    return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
  } catch {
    return false;
  }
}

export function describePermission(request) {
  switch (request.kind) {
    case "shell":
      return {
        title: "Run command",
        intention: request.intention,
        detail: request.fullCommandText,
        warning: request.warning || (request.hasWriteFileRedirection ? "This command contains file write redirection." : "")
      };
    case "write":
      return {
        title: "Modify files",
        intention: request.intention,
        detail: request.fileName,
        diff: request.diff
      };
    case "read":
      return {
        title: "Read files",
        intention: request.intention,
        detail: request.path
      };
    case "mcp":
      return {
        title: "Call MCP tool",
        intention: request.toolTitle,
        detail: `${request.serverName} / ${request.toolName}`,
        arguments: request.args
      };
    case "url":
      return {
        title: "Access network",
        intention: request.intention,
        detail: request.url
      };
    default:
      return {
        title: "Perform protected operation",
        intention: request.intention || request.kind,
        detail: request
      };
  }
}

export class CopilotChatService {
  constructor(workspace, options = {}) {
    this.workspace = realpathSync.native(resolve(workspace));
    this.options = options;
    this.client = null;
    this.clientsInUse = new Set();
    this.session = null;
    this.starting = null;
    this.resetting = null;
    this.unsubscribeSession = null;
    this.listeners = new Set();
    this.pendingPermissions = new Map();
    this.messages = new Map();
    this.tools = new Map();
    this.fallbackMessages = new Map();
    this.generation = 0;
    this.cursor = 0;
    this.busy = false;
    this.operationId = null;
    this.pendingSend = null;
    this.status = {
      state: "disconnected",
      authenticated: false,
      workspace: this.workspace,
      busy: false,
      generation: this.generation,
      operationId: null
    };
  }

  event(type, data = {}) {
    return {
      id: ++this.cursor,
      type,
      data,
      generation: this.generation,
      sessionId: this.session?.sessionId ?? null,
      operationId: this.operationId,
      timestamp: new Date().toISOString()
    };
  }

  emit(type, data = {}) {
    const event = this.event(type, data);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.listeners.delete(listener);
        process.emitWarning(`Chat subscriber removed: ${error.message}`, { code: "CHAT_SUBSCRIBER_FAILED" });
      }
    }
    return event;
  }

  setStatus(patch) {
    this.status = {
      ...this.status,
      ...patch,
      generation: this.generation,
      busy: this.busy,
      operationId: this.operationId
    };
    this.emit("chat.status", { ...this.status });
  }

  snapshot() {
    return structuredClone({
      status: this.status,
      messages: [...this.messages.values()],
      tools: [...this.tools.values()],
      permissions: [...this.pendingPermissions.values()].map((pending) => pending.event),
      cursor: this.cursor,
      generation: this.generation,
      sessionId: this.session?.sessionId ?? null,
      operationId: this.operationId
    });
  }

  restore(snapshot) {
    if (this.session || this.starting || this.busy) {
      throw chatError("A running chat cannot be restored.", "CHAT_BUSY", 409);
    }
    this.messages = new Map((snapshot.messages ?? []).map((message) => [message.id, structuredClone(message)]));
    this.tools = new Map((snapshot.tools ?? []).map((tool) => [tool.toolCallId ?? tool.id, structuredClone(tool)]));
    this.cursor = Math.max(this.cursor, snapshot.cursor ?? 0);
  }

  subscribe(listener) {
    const snapshot = this.event("chat.snapshot");
    snapshot.data = this.snapshot();
    const initial = [snapshot, this.event("chat.status", { ...this.status })];
    for (const pending of this.pendingPermissions.values()) {
      initial.push(this.event("permission.requested", structuredClone(pending.event)));
    }
    const buffered = [];
    let initializing = true;
    const deliver = (event) => initializing ? buffered.push(event) : listener(event);
    this.listeners.add(deliver);
    try {
      for (const event of initial) listener(event);
      while (buffered.length) listener(buffered.shift());
      initializing = false;
    } catch (error) {
      this.listeners.delete(deliver);
      throw error;
    }
    return () => this.listeners.delete(deliver);
  }

  assertGeneration(generation) {
    if (generation !== this.generation) {
      throw chatError("The chat generation has changed. Reload its current state.", "STALE_GENERATION", 409);
    }
  }

  assertTarget(target = {}) {
    if (target.generation !== undefined) this.assertGeneration(target.generation);
    if (target.operationId !== undefined && target.operationId !== this.operationId) {
      throw chatError("The chat operation has changed.", "STALE_OPERATION", 409);
    }
  }

  async loadSdk() {
    this.sdkPromise ??= Promise.resolve().then(this.options.sdkLoader ?? (() => import("@github/copilot-sdk")));
    try {
      return await this.sdkPromise;
    } catch (error) {
      if (["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"].includes(error.code) &&
          /['"]@github\/copilot-sdk['"]/.test(error.message)) {
        throw chatError("The configured @github/copilot-sdk package is not installed. The local workshop remains available; the Copilot provider cannot start.", "SDK_NOT_INSTALLED", 503);
      }
      throw chatError(`Copilot SDK loading failed: ${error.message}`, "SDK_LOAD_FAILED", 503);
    }
  }

  async checkAvailability() {
    if (this.options.clientFactory) return this.status;
    try {
      await this.loadSdk();
    } catch (error) {
      this.setStatus({
        state: error.code === "SDK_NOT_INSTALLED" ? "unavailable" : "error",
        available: false,
        authenticated: false,
        code: error.code,
        error: error.message
      });
    }
    return this.status;
  }

  async createClient() {
    const clientOptions = {
      workingDirectory: this.workspace,
      logLevel: "error",
      ...this.options.clientOptions
    };
    if (this.options.clientFactory) return this.options.clientFactory(clientOptions);
    const { CopilotClient, RuntimeConnection } = await this.loadSdk();
    const cliPath = findCopilotCli();
    return new CopilotClient({
      ...clientOptions,
      ...(cliPath ? { connection: RuntimeConnection.forStdio({ path: cliPath }) } : {})
    });
  }

  async start(target = {}) {
    this.assertTarget(target);
    if (this.resetting) throw chatError("Chat cleanup is still in progress.", "CHAT_RESETTING", 409);
    if (this.session) return this.status;
    if (this.starting) return this.starting;
    const generation = this.generation;
    const starting = this.startInternal(generation);
    this.starting = starting;
    try {
      return await starting;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  async startInternal(generation) {
    this.setStatus({ state: "connecting", error: undefined, code: undefined });
    let client;
    let session;
    let ownsClient = false;
    try {
      client = await this.createClient();
      if (this.clientsInUse.has(client)) {
        throw chatError("The client factory returned a runtime that is still being retired.", "CLIENT_IN_USE", 409);
      }
      this.clientsInUse.add(client);
      ownsClient = true;
      this.assertGeneration(generation);
      await client.start();
      this.assertGeneration(generation);
      const auth = await client.getAuthStatus();
      this.assertGeneration(generation);
      if (!auth.isAuthenticated) {
        throw chatError(auth.statusMessage || "Copilot backend authentication is required. Run `copilot /login` or configure a supported token.", "AUTH_REQUIRED", 401);
      }
      const sessionOptions = {
        model: "auto",
        streaming: true,
        workingDirectory: this.workspace,
        systemMessage: {
          mode: "append",
          content: [
            "You are the embedded lab agent for Agentic Loop Playground.",
            `Your working directory is ${this.workspace}.`,
            "Operate only inside this workspace unless the user explicitly approves another boundary.",
            "Follow repository instructions and the current lab prompt.",
            "Before modifying files, explain the observation, intended action, verification, and stop condition.",
            "Never weaken validation, fabricate evidence, expose credentials, or merge a pull request without a human decision."
          ].join("\n")
        },
        ...this.options.sessionOptions,
        onPermissionRequest: (request) => this.handlePermissionRequest(request, generation)
      };
      if (this.options.sessionId) {
        if (typeof client.resumeSession !== "function") {
          throw chatError("This Copilot runtime cannot resume the saved native session.", "SESSION_RESUME_UNAVAILABLE", 503);
        }
        session = await client.resumeSession(this.options.sessionId, sessionOptions);
        if (session.sessionId !== this.options.sessionId) {
          throw chatError("The runtime did not resume the requested native session.", "SESSION_RESUME_MISMATCH", 503);
        }
      } else {
        session = await client.createSession(sessionOptions);
      }
      this.assertGeneration(generation);
      this.client = client;
      this.session = session;
      this.unsubscribeSession = session.on((event) => {
        if (generation === this.generation && session === this.session) this.handleSessionEvent(event);
      });
      this.setStatus({
        state: "ready",
        available: true,
        authenticated: true,
        authType: auth.authType,
        login: auth.login,
        workspace: this.workspace,
        sessionId: session.sessionId,
        code: undefined,
        error: undefined
      });
      return this.status;
    } catch (error) {
      try {
        if (ownsClient) await disposeRuntime(session, client);
      } catch (cleanupError) {
        error = chatError(`${error.message} ${cleanupError.message}`, "RUNTIME_CLEANUP_FAILED", 503);
      } finally {
        if (ownsClient) this.clientsInUse.delete(client);
      }
      if (generation === this.generation) {
        this.unsubscribeSession?.();
        this.unsubscribeSession = null;
        this.client = null;
        this.session = null;
        this.setStatus({
          state: error.code === "SDK_NOT_INSTALLED" ? "unavailable" : "error",
          available: error.code !== "SDK_NOT_INSTALLED",
          authenticated: false,
          workspace: this.workspace,
          code: error.code ?? "RUNTIME_START_FAILED",
          error: error.message
        });
      }
      throw error;
    }
  }

  handlePermissionRequest(request, generation = this.generation) {
    if (generation !== this.generation) {
      return { kind: "reject", feedback: "This chat generation is no longer active." };
    }
    if (
      request.kind === "read" &&
      !request.managedApprovalRequired &&
      !request.requestSandboxBypass &&
      isSafeWorkspacePath(this.workspace, request.path)
    ) {
      return { kind: "approve-once" };
    }
    if (this.options.readOnly) {
      return { kind: "reject", feedback: "The introductory lab kickoff permits only unprotected workspace reads." };
    }

    const requestId = randomUUID();
    const permissionEvent = {
      requestId,
      request: publicDetail(describePermission(request)),
      kind: request.kind,
      generation,
      operationId: this.operationId,
      managedApprovalRequired: Boolean(request.managedApprovalRequired),
      sandboxBypass: Boolean(request.requestSandboxBypass)
    };
    return new Promise((resolvePermission) => {
      this.pendingPermissions.set(requestId, {
        resolve: resolvePermission,
        event: permissionEvent
      });
      this.emit("permission.requested", permissionEvent);
    });
  }

  resolvePermission(requestId, decision, feedback, target = {}) {
    this.assertTarget(target);
    if (decision !== "approve" && decision !== "reject") {
      throw chatError("Permission decision must be approve or reject.", "INVALID_PERMISSION_DECISION", 400);
    }
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      throw chatError("Permission request is no longer pending.", "PERMISSION_NOT_PENDING", 409);
    }
    this.pendingPermissions.delete(requestId);
    pending.resolve(
      decision === "approve"
        ? { kind: "approve-once", approvedInteractively: true }
        : { kind: "reject", feedback: feedback || "Rejected by the user in the playground." }
    );
    this.emit("permission.resolved", { requestId, decision });
  }

  rejectPermissions(feedback) {
    for (const [requestId, pending] of this.pendingPermissions) {
      pending.resolve({ kind: "reject", feedback });
      this.pendingPermissions.delete(requestId);
      this.emit("permission.resolved", { requestId, decision: "reject" });
    }
  }

  identity(kind, id) {
    return `${this.generation}:${this.session?.sessionId ?? "pending"}:${kind}:${id}`;
  }

  assistantId(data, agentId, final) {
    if (data.messageId) return this.identity(`assistant:${agentId ?? "root"}`, data.messageId);
    const key = agentId ?? "root";
    if (!this.fallbackMessages.has(key)) {
      this.fallbackMessages.set(key, this.identity(`assistant:${key}`, randomUUID()));
    }
    const id = this.fallbackMessages.get(key);
    if (final) this.fallbackMessages.delete(key);
    return id;
  }

  finishOperation(state = "ready", error) {
    this.busy = false;
    this.fallbackMessages.clear();
    if (error) this.rejectPermissions(error);
    this.setStatus({ state, error, code: error ? "SESSION_ERROR" : undefined });
  }

  handleSessionEvent(event) {
    if (this.pendingSend) {
      if (event.type === "user.message") return;
      if (!["assistant.message_delta", "assistant.message", "tool.execution_start",
        "tool.execution_complete", "session.idle", "session.error"].includes(event.type)) return;
      const pending = this.pendingSend;
      if (pending.error) return;
      const data = event.data ?? {};
      const retained = {
        type: event.type,
        id: event.id,
        agentId: event.agentId ?? data.agentId,
        data: event.type.startsWith("tool.") ? {
          toolCallId: data.toolCallId,
          toolName: publicDetail(data.toolName),
          arguments: data.arguments === undefined ? undefined : publicDetail(data.arguments),
          result: publicDetail(data.result),
          error: publicDetail(data.error),
          success: data.success
        } : event.type === "session.error" ? { message: publicDetail(data.message) } : {
          messageId: data.messageId, content: data.content, deltaContent: data.deltaContent
        }
      };
      pending.bytes += Buffer.byteLength(JSON.stringify(retained));
      if (pending.events.length >= 8192 || pending.bytes > 2 * 1024 * 1024) {
        pending.error = chatError("Copilot emitted too much data before acknowledging the message.", "SEND_BUFFER_LIMIT", 503);
        pending.events.length = 0;
      } else {
        pending.events.push(retained);
      }
      return;
    }
    const data = event.data ?? {};
    const agentId = event.agentId ?? data.agentId;
    switch (event.type) {
      case "user.message":
        // send() owns the exact learner text; SDK echoes can contain model context.
        break;
      case "assistant.message_delta":
      case "assistant.message":
        {
          const final = event.type === "assistant.message";
          const content = final ? data.content : data.deltaContent;
          if (typeof content !== "string") break;
          const messageId = this.assistantId(data, agentId, final);
          const previous = this.messages.get(messageId);
          if (!final && previous?.complete) break;
          this.messages.set(messageId, {
            id: messageId,
            role: "assistant",
            content: final ? content : (previous?.content ?? "") + content,
            complete: final,
            ...(agentId ? { agentId } : {})
          });
          this.emit(final ? "assistant.message" : "assistant.delta", {
            messageId, content, ...(agentId ? { agentId } : {})
          });
        }
        break;
      case "tool.execution_start":
      case "tool.execution_complete":
        {
          const complete = event.type === "tool.execution_complete";
          const toolCallId = this.identity("tool", data.toolCallId ?? event.id ?? randomUUID());
          const previous = this.tools.get(toolCallId);
          const tool = {
            toolCallId,
            toolName: typeof data.toolName === "string" ? publicDetail(data.toolName) : previous?.toolName ?? "Unknown tool",
            arguments: data.arguments === undefined ? previous?.arguments ?? null : publicDetail(data.arguments),
            result: complete ? publicDetail(data.result) : null,
            error: complete ? publicDetail(data.error) : null,
            state: complete ? data.success === false ? "failed" : "completed" : "running",
            ...(agentId ? { agentId } : {})
          };
          this.tools.set(toolCallId, tool);
          this.emit(complete ? "tool.completed" : "tool.started", {
            ...tool, success: complete ? data.success ?? null : null
          });
        }
        break;
      case "session.idle":
        if (!agentId) {
          this.finishOperation();
          this.emit("session.idle");
        }
        break;
      case "session.error":
        if (!agentId) {
          const message = publicDetail(data.message || "Copilot session error");
          this.finishOperation("error", message);
          this.emit("chat.error", { message, code: "SESSION_ERROR" });
        }
        break;
      default:
        break;
    }
  }

  async send(prompt, target = {}) {
    this.assertTarget(target);
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw chatError("A message is required.", "MESSAGE_REQUIRED", 400);
    }
    if (this.busy || this.resetting) {
      throw chatError("A chat operation is already in progress.", "CHAT_BUSY", 409);
    }
    const generation = this.generation;
    const operationId = target.newOperationId ?? randomUUID();
    const displayPrompt = target.displayPrompt ?? prompt;
    if (typeof displayPrompt !== "string") {
      throw chatError("Display text must be a string.", "INVALID_DISPLAY_PROMPT", 400);
    }
    let pending;
    this.operationId = operationId;
    this.busy = true;
    this.setStatus({});
    try {
      await this.start();
      this.assertGeneration(generation);
      this.setStatus({ state: "running" });
      pending = { events: [], bytes: 0, error: null };
      this.pendingSend = pending;
      const sdkMessageId = await this.session.send({
        prompt,
        ...(target.displayPrompt !== undefined ? { displayPrompt } : {})
      });
      this.assertGeneration(generation);
      if (pending.error) throw pending.error;
      const messageId = target.messageId ?? this.identity("user", typeof sdkMessageId === "string" ? sdkMessageId : operationId);
      if (!target.hideUser) {
        this.messages.set(messageId, { id: messageId, role: "user", content: displayPrompt, complete: true });
      }
      await target.onAccepted?.({ operationId, messageId, generation });
      this.assertGeneration(generation);
      if (pending.error) throw pending.error;
      this.pendingSend = null;
      if (!target.hideUser) this.emit("user.message", { messageId, content: displayPrompt });
      for (const event of pending.events) {
        if (generation !== this.generation || operationId !== this.operationId) break;
        this.handleSessionEvent(event);
      }
      return { operationId, messageId, generation };
    } catch (error) {
      if (this.pendingSend === pending) this.pendingSend = null;
      if (generation === this.generation && operationId === this.operationId) {
        this.rejectPermissions("The message was not accepted by the Copilot runtime.");
        this.busy = false;
        this.setStatus({
          state: error.code === "SDK_NOT_INSTALLED" ? "unavailable" : "error",
          error: error.message,
          code: error.code ?? "SEND_FAILED"
        });
        this.emit("chat.error", { message: error.message, code: error.code ?? "SEND_FAILED" });
      }
      throw error;
    }
  }

  async abort(target = {}) {
    this.assertTarget(target);
    if (this.resetting) throw chatError("Chat cleanup is still in progress.", "CHAT_RESETTING", 409);
    const session = this.session;
    // Retire the callback before abort: late terminal events cannot unlock a new turn.
    return this.retireRuntime(false, session ? () => session.abort() : undefined);
  }

  async reset(target = {}) {
    this.assertTarget(target);
    if (this.resetting) return this.resetting;
    return this.retireRuntime(true);
  }

  async retireRuntime(clear, beforeDispose) {
    this.generation += 1;
    this.unsubscribeSession?.();
    this.unsubscribeSession = null;
    const session = this.session;
    const client = this.client;
    this.session = null;
    this.client = null;
    this.starting = null;
    this.pendingSend = null;
    this.busy = false;
    this.operationId = null;
    this.rejectPermissions(clear ? "Session reset by the user." : "Session interrupted by the user.");
    this.fallbackMessages.clear();
    for (const tool of this.tools.values()) {
      if (tool.state === "running") tool.state = "interrupted";
    }
    if (clear) {
      this.messages.clear();
      this.tools.clear();
    }
    this.status = {
      state: "disconnected",
      authenticated: false,
      workspace: this.workspace,
      generation: this.generation,
      busy: false,
      operationId: null
    };
    const cleanup = (async () => {
      const errors = [];
      try {
        await beforeDispose?.();
      } catch (error) {
        errors.push(error);
      }
      try {
        await disposeRuntime(session, client);
      } catch (error) {
        errors.push(error);
      } finally {
        if (client) this.clientsInUse.delete(client);
      }
      if (errors.length) throw chatError("Copilot runtime cleanup failed.", "RUNTIME_CLEANUP_FAILED", 503);
    })();
    this.resetting = cleanup;
    if (clear) this.emit("chat.reset");
    this.setStatus({});
    try {
      await cleanup;
    } catch (error) {
      this.setStatus({ state: "error", code: error.code, error: error.message });
      throw error;
    } finally {
      if (this.resetting === cleanup) this.resetting = null;
    }
  }

  async stop() {
    await this.reset();
  }
}
