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
    const session = new FakeCopilotSession(this, config);
    this.sessions.push(session);
    await this.options.onCreateSession?.(session);
    return session;
  }

  async stop() {
    this.stopCalls += 1;
    return await this.options.onStop?.(this) ?? [];
  }
}
