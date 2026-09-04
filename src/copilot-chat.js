import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";

function findCopilotCli() {
  if (process.env.COPILOT_CLI_PATH) {
    return process.env.COPILOT_CLI_PATH;
  }
  try {
    const platform = process.platform === "linux" ? "linux" : process.platform;
    const packageName = `@github/copilot-${platform}-${process.arch}`;
    const packageEntry = createRequire(import.meta.url).resolve(packageName);
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
        detail: JSON.stringify(request)
      };
  }
}

export class CopilotChatService {
  constructor(workspace) {
    this.workspace = realpathSync.native(resolve(workspace));
    this.client = null;
    this.session = null;
    this.starting = null;
    this.listeners = new Set();
    this.pendingPermissions = new Map();
    this.activeTools = new Map();
    this.status = {
      state: "disconnected",
      authenticated: false,
      workspace: this.workspace
    };
  }

  emit(type, data = {}) {
    const event = { type, data, timestamp: new Date().toISOString() };
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener({ type: "chat.status", data: this.status, timestamp: new Date().toISOString() });
    for (const pending of this.pendingPermissions.values()) {
      listener({
        type: "permission.requested",
        data: pending.event,
        timestamp: new Date().toISOString()
      });
    }
    return () => this.listeners.delete(listener);
  }

  async start() {
    if (this.session) return this.status;
    if (this.starting) return this.starting;
    this.starting = this.startInternal();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async startInternal() {
    this.status = { ...this.status, state: "connecting", error: undefined };
    this.emit("chat.status", this.status);
    const cliPath = findCopilotCli();
    const client = new CopilotClient({
      ...(cliPath ? { connection: RuntimeConnection.forStdio({ path: cliPath }) } : {}),
      workingDirectory: this.workspace,
      logLevel: "error"
    });
    try {
      await client.start();
      const auth = await client.getAuthStatus();
      if (!auth.isAuthenticated) {
        throw new Error(auth.statusMessage || "Copilot authentication is required. Run `copilot /login` or configure a supported token.");
      }
      const session = await client.createSession({
        model: "auto",
        streaming: true,
        workingDirectory: this.workspace,
        onPermissionRequest: (request) => this.handlePermissionRequest(request),
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
        }
      });
      session.on((event) => this.handleSessionEvent(event));
      this.client = client;
      this.session = session;
      this.status = {
        state: "ready",
        authenticated: true,
        authType: auth.authType,
        login: auth.login,
        workspace: this.workspace,
        sessionId: session.sessionId
      };
      this.emit("chat.status", this.status);
      return this.status;
    } catch (error) {
      await client.stop().catch(() => {});
      this.status = {
        state: "error",
        authenticated: false,
        workspace: this.workspace,
        error: error.message
      };
      this.emit("chat.status", this.status);
      throw error;
    }
  }

  handlePermissionRequest(request) {
    if (
      request.kind === "read" &&
      !request.managedApprovalRequired &&
      !request.requestSandboxBypass &&
      isSafeWorkspacePath(this.workspace, request.path)
    ) {
      return { kind: "approve-once" };
    }

    const requestId = randomUUID();
    const permissionEvent = {
      requestId,
      request: describePermission(request),
      kind: request.kind,
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

  resolvePermission(requestId, decision, feedback) {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      throw new Error("Permission request is no longer pending.");
    }
    this.pendingPermissions.delete(requestId);
    pending.resolve(
      decision === "approve"
        ? { kind: "approve-once", approvedInteractively: true }
        : { kind: "reject", feedback: feedback || "Rejected by the user in the playground." }
    );
    this.emit("permission.resolved", { requestId, decision });
  }

  handleSessionEvent(event) {
    switch (event.type) {
      case "user.message":
        this.emit("user.message", { content: event.data.content });
        break;
      case "assistant.message_delta":
        if (!event.data.agentId) {
          this.emit("assistant.delta", { content: event.data.deltaContent });
        }
        break;
      case "assistant.message":
        if (!event.data.agentId) {
          this.emit("assistant.message", { content: event.data.content });
        }
        break;
      case "tool.execution_start":
        this.activeTools.set(event.data.toolCallId, event.data.toolName);
        this.emit("tool.started", {
          toolName: event.data.toolName
        });
        break;
      case "tool.execution_complete":
        {
          const toolName = this.activeTools.get(event.data.toolCallId);
          this.activeTools.delete(event.data.toolCallId);
        this.emit("tool.completed", {
          toolName,
          success: event.data.success
        });
        }
        break;
      case "session.idle":
        this.emit("session.idle");
        break;
      case "session.error":
        this.emit("chat.error", { message: event.data.message || "Copilot session error" });
        break;
      default:
        break;
    }
  }

  async send(prompt) {
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw new Error("A message is required.");
    }
    await this.start();
    await this.session.send({ prompt: prompt.trim() });
  }

  async abort() {
    if (this.session) {
      await this.session.abort();
    }
  }

  async reset() {
    for (const pending of this.pendingPermissions.values()) {
      pending.resolve({ kind: "reject", feedback: "Session reset by the user." });
    }
    this.pendingPermissions.clear();
    this.activeTools.clear();
    if (this.session) {
      await this.session.disconnect();
      this.session = null;
    }
    if (this.client) {
      await this.client.stop();
      this.client = null;
    }
    this.status = {
      state: "disconnected",
      authenticated: this.status.authenticated,
      workspace: this.workspace
    };
    this.emit("chat.reset");
    this.emit("chat.status", this.status);
  }

  async stop() {
    await this.reset();
  }
}
