import { fork } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CopilotChatService } from "../../src/copilot-chat.js";
import { createWorkshopServer } from "../../src/server-app.js";
import { FakeCopilotClient } from "./fake-copilot.js";

export async function startChatTestServer({ workspace, publicDirectory } = {}) {
  const child = fork(fileURLToPath(import.meta.url), [], {
    cwd: workspace,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let output = "";
  child.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-8192); });
  const pending = new Map();
  let nextId = 0;
  child.on("message", (message) => {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.value);
  });
  child.on("exit", (code) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(`Test server exited (${code}): ${output}`));
    }
    pending.clear();
  });
  function command(type, data = {}) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Test server command timed out: ${type}`));
      }, 10_000);
      pending.set(id, { resolve, reject, timer });
      child.send({ id, type, data }, (error) => {
        if (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }
  try {
    const url = await command("listen", { publicDirectory });
    const response = await fetch(`${url}/api/health`);
    if (!response.ok) throw new Error("Test server failed its health probe.");
    return {
      child,
      url,
      command,
      async close() {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        try {
          await command("close");
        } finally {
          child.kill();
          await exited;
        }
      }
    };
  } catch (error) {
    child.kill();
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url && process.send) {
  const client = new FakeCopilotClient();
  const chat = new CopilotChatService(process.cwd(), { clientFactory: () => client });
  let app;
  process.on("message", async ({ id, type, data }) => {
    try {
      let value;
      if (type === "listen") {
        app = createWorkshopServer({ workspace: process.cwd(), chat, publicDirectory: data.publicDirectory });
        value = await app.listen();
      } else if (type === "emit") {
        if (!client.session) throw new Error("Start the chat before emitting fixture events.");
        for (const event of data.events) client.session.emit(event.type, event.data, event.envelope);
        value = chat.snapshot();
      } else if (type === "permission") {
        if (!client.session) throw new Error("Start the chat before requesting permission.");
        value = await client.session.requestPermission(data);
      } else if (type === "sent") {
        value = client.sessions.map((session) => ({ sessionId: session.sessionId, sent: session.sent }));
      } else if (type === "close") {
        await app.close();
        value = true;
      } else {
        throw new Error(`Unknown test server command: ${type}`);
      }
      process.send({ id, value });
    } catch (error) {
      process.send({ id, error: error.message });
    }
  });
}
