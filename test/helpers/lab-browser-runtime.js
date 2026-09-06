import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeCopilotClient, FakeCopilotSession } from "./fake-copilot.js";

export function createLabBrowserRuntime(workspace) {
  const calls = [];
  const sessions = new Map();
  const deleted = [];
  const commands = [];
  const timers = new Set();
  let held = null;

  function skills() {
    return readdirSync(join(workspace, ".github", "skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const path = join(workspace, ".github", "skills", entry.name, "SKILL.md");
        const content = readFileSync(path, "utf8");
        return {
          name: content.match(/^name:\s*(.+)$/m)[1].trim(),
          commandName: entry.name,
          description: content.match(/^description:\s*(.+)$/m)[1].trim(),
          source: "custom",
          path,
          enabled: true,
          userInvocable: true
        };
      });
  }

  function configure(session, history = []) {
    const agents = () => (session.config.customAgents ?? []).map((agent) => ({
      ...agent, id: agent.name, displayName: agent.name, userInvocable: true
    }));
    session.rpc = {
      agent: {
        async list() { return { agents: agents() }; },
        async select({ name }) {
          const agent = agents().find((entry) => entry.name === name);
          if (!agent) throw new Error(`Unknown fixture agent: ${name}`);
          session.selectedAgent = name;
          return { agent };
        },
        async deselect() { session.selectedAgent = null; },
        async reload() { return { agents: agents() }; }
      },
      skills: {
        async ensureLoaded() {},
        async list() { return { skills: skills() }; },
        async reload() { return { warnings: [], errors: [] }; }
      },
      commands: {
        async list() {
          return { commands: skills().map((skill) => ({
            name: skill.commandName, description: skill.description, kind: "skill",
            allowDuringAgentExecution: false
          })) };
        },
        async invoke({ name, input = "" }) {
          if (!skills().some((skill) => skill.commandName === name)) throw new Error(`Unknown native fixture command: ${name}`);
          commands.push({ name, input });
          return {
            kind: "agent-prompt",
            prompt: `Native skill ${name}: ${input}`,
            displayPrompt: `/${name}${input ? ` ${input}` : ""}`
          };
        }
      }
    };
    session.getEvents = async () => [...history];
    session.getMessages = async () => [...history];
    const emit = session.emit.bind(session);
    session.emit = (type, data = {}, envelope = {}) => {
      history.push({ type, data, id: randomUUID(), timestamp: new Date().toISOString(), ...envelope });
      emit(type, data, envelope);
    };
    sessions.set(session.sessionId, { session, history });
  }

  function reply(session, request) {
    const display = request.displayPrompt ?? request.prompt;
    const id = `assistant-${session.sent.length}`;
    if (display === "hold this operation") {
      held = session;
      session.emit("assistant.message_delta", { messageId: id, deltaContent: "Holding the controlled operation." });
      return;
    }
    if (display === "generate large fixture history") {
      for (let index = 0; index < 4; index++) {
        session.emit("assistant.message", {
          messageId: `${id}-large-${index}`,
          content: `Large fixture reply ${index + 1}: ${"x".repeat(64 * 1024)}`
        });
      }
      session.emit("session.idle");
      return;
    }
    session.emit("assistant.message", { messageId: id, content: `Fixture lab guidance: ${display || "Welcome to this lab."}` });
    session.emit("session.idle");
  }

  function clientFactory() {
    const client = new FakeCopilotClient({
      onCreateSession: configure,
      onSend(session, request) {
        calls.push({ sessionId: session.sessionId, request: { ...request }, config: session.config });
        const timer = setTimeout(() => {
          timers.delete(timer);
          reply(session, request);
        }, 10);
        timers.add(timer);
      }
    });
    client.resumeSession = async (sessionId, config) => {
      const previous = sessions.get(sessionId);
      if (!previous) throw new Error(`Unknown native fixture session: ${sessionId}`);
      const session = new FakeCopilotSession(client, config);
      session.sessionId = sessionId;
      session.sent = [...previous.session.sent];
      configure(session, previous.history);
      client.sessions.push(session);
      return session;
    };
    client.deleteSession = async (sessionId) => {
      if (!sessions.has(sessionId)) throw new Error(`Native fixture session not found: ${sessionId}`);
      sessions.delete(sessionId);
      deleted.push(sessionId);
    };
    client.listSessions = async () => [...sessions.keys()].map((sessionId) => ({ sessionId }));
    return client;
  }

  return {
    clientFactory, calls, sessions, deleted, commands,
    get heldSession() { return held; },
    close() { for (const timer of timers) clearTimeout(timer); timers.clear(); }
  };
}
