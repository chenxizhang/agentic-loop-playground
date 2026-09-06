import { randomUUID } from "node:crypto";

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export class FakeCopilotSession {
  constructor(client, config) {
    this.client = client;
    this.config = config;
    this.sessionId = randomUUID();
    this.listeners = new Set();
    this.sent = [];
    this.disconnectCalls = 0;
    this.abortCalls = 0;
    this.selectedAgent = config.agent ?? null;
    this.rpc = {
      agent: {
        list: async () => ({ agents: client.options.agents ?? (config.customAgents ?? []).map((agent) => ({
          ...agent, id: agent.name, source: "project"
        })) }),
        select: async ({ name }) => {
          await client.options.onSelectAgent?.(this, name);
          this.selectedAgent = name;
          return {};
        },
        deselect: async () => {
          await client.options.onSelectAgent?.(this, null);
          this.selectedAgent = null;
          return {};
        },
        reload: async () => await client.options.onAgentReload?.(this) ?? {}
      },
      skills: {
        list: async () => ({ skills: client.options.skills ?? [] }),
        ensureLoaded: async () => await client.options.onSkillsLoaded?.(this) ?? {},
        reload: async () => await client.options.onSkillsReload?.(this) ?? { warnings: [], errors: [] }
      },
      commands: {
        invoke: async (request) => {
          if (!client.options.onInvokeCommand) throw new Error("No fake native command handler is configured.");
          return client.options.onInvokeCommand(this, request);
        }
      }
    };
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(type, data = {}, envelope = {}) {
    const event = { type, data, id: randomUUID(), ...envelope };
    for (const listener of this.listeners) listener(event);
  }

  async send(request) {
    this.sent.push(request);
    await this.client.options.onSend?.(this, request);
    return `sent-${this.sent.length}`;
  }

  async abort() {
    this.abortCalls += 1;
    await this.client.options.onAbort?.(this);
  }

  async disconnect() {
    this.disconnectCalls += 1;
    await this.client.options.onDisconnect?.(this);
  }

  requestPermission(request) {
    return this.config.onPermissionRequest(request);
  }
}

export class FakeCopilotClient {
  constructor(options = {}) {
    this.options = options;
    this.sessions = [];
    this.startCalls = 0;
    this.stopCalls = 0;
    this.createCalls = 0;
    this.resumeCalls = [];
    this.deleteCalls = [];
    this.savedSessions = options.savedSessions ?? new Map();
  }

  get session() {
    return this.sessions.at(-1);
  }

  async start() {
    this.startCalls += 1;
    await this.options.onStart?.(this);
  }

  async getAuthStatus() {
    return this.options.auth ?? { isAuthenticated: true, authType: "test", login: "offline-fixture" };
  }

  async createSession(config) {
    this.createCalls += 1;
    const session = new FakeCopilotSession(this, config);
    this.sessions.push(session);
    this.savedSessions.set(session.sessionId, session);
    await this.options.onCreateSession?.(session);
    return session;
  }

  async resumeSession(sessionId, config) {
    this.resumeCalls.push({ sessionId, config });
    if (!this.savedSessions.has(sessionId)) throw new Error(`Unknown fake native session: ${sessionId}`);
    const previous = this.savedSessions.get(sessionId);
    const session = new FakeCopilotSession(this, config);
    session.sessionId = sessionId;
    session.sent = [...previous.sent];
    this.sessions.push(session);
    this.savedSessions.set(sessionId, session);
    await this.options.onResumeSession?.(session);
    return session;
  }

  async deleteSession(sessionId) {
    this.deleteCalls.push(sessionId);
    await this.options.onDeleteSession?.(this, sessionId);
    this.savedSessions.delete(sessionId);
  }

  async stop() {
    this.stopCalls += 1;
    return await this.options.onStop?.(this) ?? [];
  }
}
