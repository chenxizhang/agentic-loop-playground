import { execFile } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getLesson, lessons } from "./curriculum.js";
import { loadProgress, recordCheckpoint } from "./progress.js";
import { repositoryAnalysisPrerequisites } from "./repo-analyzer.js";
import { runValidation } from "./validation-runner.js";

const host = "127.0.0.1";
const packaged = typeof __PACKAGED__ !== "undefined" && __PACKAGED__;
const defaultPublicDirectory = fileURLToPath(new URL(packaged ? "./public/" : "../public/", import.meta.url));
const repositoryWorker = fileURLToPath(new URL("./analyze-repo-worker.js", import.meta.url));
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(body));
}

export function createSseSubscriber(response, {
  maxQueueBytes = 256 * 1024,
  maxQueueFrames = 512,
  maxSnapshotBytes = 12 * 1024 * 1024,
  heartbeatMs = 15_000,
  onClose = () => {}
} = {}) {
  const queue = [];
  const stats = { queuedBytes: 0, highWaterMark: 0, closed: false, slow: false };
  let blocked = false;
  let blockedHeartbeats = 0;
  let firstEvent = true;
  let snapshotDebt = 0;
  let heartbeat;
  const frameFor = (event) => `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  const isDelta = (event) => event?.type === "assistant.delta" &&
    typeof event.data?.messageId === "string" && typeof event.data?.content === "string";
  const sameDelta = (left, right) => isDelta(left) && isDelta(right) &&
    left.data.messageId === right.data.messageId && left.data.agentId === right.data.agentId &&
    left.operationId === right.operationId && left.sessionId === right.sessionId &&
    left.conversationId === right.conversationId && left.generation === right.generation;

  function close(slow = false) {
    if (stats.closed) return;
    stats.closed = true;
    stats.slow = slow;
    clearInterval(heartbeat);
    queue.length = 0;
    stats.queuedBytes = 0;
    response.off("drain", drain);
    response.off("close", close);
    response.off("error", onError);
    onClose();
    response.destroy();
  }

  function onError() {
    close();
  }

  function drain() {
    blocked = false;
    blockedHeartbeats = 0;
    snapshotDebt = 0;
    while (queue.length && !blocked && !stats.closed) {
      const entry = queue.shift();
      stats.queuedBytes -= entry.bytes;
      const frame = entry.parts
        ? frameFor({ ...entry.event, data: { ...entry.event.data, content: entry.parts.join("") } })
        : entry.frame;
      blocked = !response.write(frame);
    }
  }

  function write(frame, initialSnapshot = false, event) {
    if (stats.closed) return;
    const bytes = Buffer.byteLength(frame);
    if (initialSnapshot && !blocked && queue.length === 0 && (response.writableLength ?? 0) <= maxQueueBytes) {
      if (bytes > maxSnapshotBytes) {
        close(true);
        return;
      }
      stats.snapshotBytes = bytes;
      blocked = !response.write(frame);
      snapshotDebt = blocked ? response.writableLength ?? 0 : 0;
      return;
    }
    const last = queue.at(-1);
    if (blocked && sameDelta(last?.event, event)) {
      const contentBytes = Buffer.byteLength(JSON.stringify(event.data.content)) - 2;
      const envelopeBytes = Buffer.byteLength(frameFor({ ...event, data: { ...event.data, content: "" } }));
      const mergedBytes = envelopeBytes + last.contentBytes + contentBytes;
      const pending = stats.queuedBytes - last.bytes + mergedBytes +
        Math.max(0, (response.writableLength ?? 0) - snapshotDebt);
      if (pending > maxQueueBytes) {
        close(true);
        return;
      }
      stats.queuedBytes += mergedBytes - last.bytes;
      stats.highWaterMark = Math.max(stats.highWaterMark, pending);
      last.parts.push(event.data.content);
      last.contentBytes += contentBytes;
      last.bytes = mergedBytes;
      last.event = event;
      return;
    }
    const pending = stats.queuedBytes + Math.max(0, (response.writableLength ?? 0) - snapshotDebt) + bytes;
    if (pending > maxQueueBytes || queue.length >= maxQueueFrames) {
      close(true);
      return;
    }
    stats.highWaterMark = Math.max(stats.highWaterMark, pending);
    if (blocked) {
      queue.push({
        frame, event, bytes,
        parts: isDelta(event) ? [event.data.content] : null,
        contentBytes: isDelta(event) ? Buffer.byteLength(JSON.stringify(event.data.content)) - 2 : 0
      });
      stats.queuedBytes += bytes;
    } else {
      blocked = !response.write(frame);
    }
  }

  response.on("drain", drain);
  response.on("close", close);
  response.on("error", onError);
  heartbeat = setInterval(() => {
    if (blocked) {
      if (++blockedHeartbeats >= 2) close(true);
    } else {
      write(": heartbeat\n\n");
    }
  }, heartbeatMs);
  heartbeat.unref?.();
  return {
    stats,
    close,
    send(event) {
      const initialSnapshot = firstEvent && event.type === "chat.snapshot";
      firstEvent = false;
      write(frameFor(event), initialSnapshot, event);
    }
  };
}

export function createWorkshopServer(options = {}) {
  const workspace = resolve(options.workspace ?? process.cwd());
  const publicDirectory = resolve(options.publicDirectory ?? defaultPublicDirectory);
  const copilotChat = options.chat ?? null;
  let coordinator = options.coordinator ?? null;
  const subscribers = new Set();
  let activePort = 0;
  let listening = null;
  let validationTail = Promise.resolve();

  function validate(kind, id = "", source = "browser") {
    const job = validationTail.then(async () => {
      const result = await (options.runValidation ?? runValidation)(workspace, kind, id);
      if (kind === "check") {
        return { ...result, progress: recordCheckpoint(id, result.ok, { workspace, source, checks: result.checks }) };
      }
      if (kind === "grade") {
        for (const item of result.results) recordCheckpoint(item.id, item.ok, { workspace, source: "grade", checks: item.checks });
        return { ...result, progress: loadProgress(workspace, { strict: true }) };
      }
      return result;
    });
    // The caller receives failures; later validation jobs may still proceed.
    validationTail = job.then(() => undefined, () => undefined);
    return job;
  }

  function resetScenario() {
    copyFileSync(join(workspace, "scenarios/ci-repair/inventory.start.js"), join(workspace, "practice/src/inventory.js"));
    copyFileSync(join(workspace, "scenarios/ci-repair/inventory.test.js"), join(workspace, "practice/test/inventory.test.js"));
  }

  function canMutate(request) {
    const hostHeader = request.headers.host ?? "";
    const allowedHost = hostHeader === `${host}:${activePort}` || hostHeader === `localhost:${activePort}`;
    const origin = request.headers.origin;
    const sameOrigin = !origin || origin === `http://${hostHeader}`;
    return allowedHost && sameOrigin && request.headers["x-loop-lab"] === "browser";
  }

  function readJsonBody(request) {
    return new Promise((resolveBody, rejectBody) => {
      const chunks = [];
      let bytes = 0;
      let tooLarge = false;
      request.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 8192) {
          tooLarge = true;
          chunks.length = 0;
          rejectBody(Object.assign(new Error("Request body is too large"), { statusCode: 413 }));
        } else if (!tooLarge) {
          chunks.push(chunk);
        }
      });
      request.on("end", () => {
        if (tooLarge) return;
        try {
          const body = Buffer.concat(chunks).toString("utf8");
          const parsed = body ? JSON.parse(body) : {};
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid body");
          resolveBody(parsed);
        } catch {
          rejectBody(Object.assign(new Error("Request body must be a JSON object"), { statusCode: 400 }));
        }
      });
      request.on("error", rejectBody);
    });
  }

  function analyzeRepositoryInWorker(repository) {
    return new Promise((resolveAnalysis, rejectAnalysis) => {
      execFile(
        process.execPath,
        [repositoryWorker, repository],
        {
          cwd: workspace,
          encoding: "utf8",
          timeout: 150_000,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true
        },
        (error, stdout, stderr) => {
          if (error) {
            const detail = stderr.trim() || (error.killed ? "Repository analysis exceeded the 150 second limit." : error.message);
            rejectAnalysis(new Error(detail));
            return;
          }
          try {
            resolveAnalysis(JSON.parse(stdout));
          } catch {
            rejectAnalysis(new Error("Repository analyzer returned an invalid result."));
          }
        }
      );
    });
  }

  async function handleLabApi(request, response, pathname, search) {
    const target = {
      labId: search.get("labId"),
      clientId: search.get("clientId"),
      ...(search.has("conversationId") ? { conversationId: search.get("conversationId") } : {})
    };
    if (request.method === "GET" && pathname === "/api/copilot/snapshot") {
      return sendJson(response, 200, await coordinator.getSnapshot(target));
    }
    if (request.method === "GET" && pathname === "/api/copilot/status") {
      if (!target.labId || !target.clientId) return sendJson(response, 200, { state: "disconnected", workspace, protocol: "lab-v1" });
      return sendJson(response, 200, (await coordinator.getSnapshot(target)).chat.status);
    }
    if (request.method === "GET" && pathname === "/api/copilot/events") {
      await coordinator.getSnapshot(target);
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
      });
      let unsubscribe;
      const subscriber = createSseSubscriber(response, {
        ...options.sse,
        onClose() { unsubscribe?.(); subscribers.delete(subscriber); }
      });
      subscribers.add(subscriber);
      unsubscribe = await coordinator.subscribe(target, (event) => subscriber.send(event));
      if (subscriber.stats.closed) unsubscribe();
      return;
    }
    if (request.method !== "POST") return sendJson(response, 404, { error: "Chat route not found" });
    if (!canMutate(request)) return sendJson(response, 403, { error: "Cross-origin mutation rejected" });
    const body = await readJsonBody(request);
    const action = pathname.split("/").at(-1);
    if (action === "activate" || action === "start") {
      return sendJson(response, 200, { ok: true, ...await coordinator.activate(body) });
    }
    if (action === "message") return sendJson(response, 202, await coordinator.send(body));
    if (["command", "permission", "abort", "reset", "forget"].includes(action)) {
      return sendJson(response, 200, await coordinator[action](body));
    }
    return sendJson(response, 404, { error: "Chat route not found" });
  }

  async function handleApi(request, response, pathname, search) {
    if (coordinator && pathname.startsWith("/api/copilot/")) return handleLabApi(request, response, pathname, search);
    if (request.method === "GET" && pathname === "/api/health") {
      return sendJson(response, 200, { ok: true });
    }
    if (request.method === "GET" && pathname === "/api/info") {
      return sendJson(response, 200, {
        workspace,
        workspaceId: coordinator?.workspaceId,
        chatProtocol: coordinator ? "lab-v1" : "legacy",
        localOnly: true,
        runtime: process.version
      });
    }
    if (request.method === "GET" && pathname === "/api/lessons") {
      return sendJson(response, 200, { lessons });
    }
    if (request.method === "GET" && pathname === "/api/progress") {
      return sendJson(response, 200, loadProgress(workspace, { strict: true }));
    }
    if (request.method === "GET" && pathname === "/api/repository-analysis/prerequisites") {
      return sendJson(response, 200, repositoryAnalysisPrerequisites());
    }
    if (request.method === "GET" && pathname === "/api/copilot/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
      });
      let unsubscribe;
      const subscriber = createSseSubscriber(response, {
        ...options.sse,
        onClose() {
          unsubscribe?.();
          subscribers.delete(subscriber);
        }
      });
      subscribers.add(subscriber);
      unsubscribe = copilotChat.subscribe((event) => subscriber.send(event));
      if (subscriber.stats.closed) unsubscribe();
      return;
    }
    if (request.method === "GET" && pathname === "/api/copilot/snapshot") {
      return sendJson(response, 200, copilotChat.snapshot());
    }
    if (request.method === "GET" && pathname === "/api/copilot/status") {
      return sendJson(response, 200, copilotChat.status);
    }
    if (request.method === "GET" && pathname === "/api/doctor") {
      return sendJson(response, 200, await validate("doctor"));
    }
    if (request.method === "POST" && pathname.startsWith("/api/check/")) {
      if (!canMutate(request)) {
        return sendJson(response, 403, { error: "Cross-origin mutation rejected" });
      }
      const id = pathname.split("/").at(-1);
      const lesson = getLesson(id);
      if (!lesson) {
        return sendJson(response, 404, { error: "Unknown lesson" });
      }
      return sendJson(response, 200, await validate("check", lesson.id));
    }
    if (request.method === "POST" && pathname === "/api/grade") {
      if (!canMutate(request)) {
        return sendJson(response, 403, { error: "Cross-origin mutation rejected" });
      }
      return sendJson(response, 200, await validate("grade"));
    }
    if (request.method === "POST" && pathname === "/api/scenario/reset") {
      if (!canMutate(request)) {
        return sendJson(response, 403, { error: "Cross-origin mutation rejected" });
      }
      resetScenario();
      return sendJson(response, 200, { ok: true });
    }
    if (request.method === "POST" && pathname === "/api/repository-analysis") {
      if (!canMutate(request)) {
        return sendJson(response, 403, { error: "Cross-origin mutation rejected" });
      }
      const body = await readJsonBody(request);
      if (typeof body.repository !== "string") {
        return sendJson(response, 400, { error: "A repository URL is required" });
      }
      try {
        return sendJson(response, 200, await analyzeRepositoryInWorker(body.repository));
      } catch (error) {
        return sendJson(response, 422, { error: error.message });
      }
    }
    if (request.method === "POST" && pathname === "/api/copilot/start") {
      if (!canMutate(request)) {
        return sendJson(response, 403, { error: "Cross-origin mutation rejected" });
      }
      const body = await readJsonBody(request);
      return sendJson(response, 200, await copilotChat.start(body));
    }
    if (request.method === "POST" && pathname === "/api/copilot/message") {
      if (!canMutate(request)) {
        return sendJson(response, 403, { error: "Cross-origin mutation rejected" });
      }
      const body = await readJsonBody(request);
      const accepted = await copilotChat.send(body.prompt, body);
      return sendJson(response, 202, { ok: true, ...accepted });
    }
    if (request.method === "POST" && pathname === "/api/copilot/permission") {
      if (!canMutate(request)) {
        return sendJson(response, 403, { error: "Cross-origin mutation rejected" });
      }
      const body = await readJsonBody(request);
      try {
        copilotChat.resolvePermission(body.requestId, body.decision, body.feedback, body);
        return sendJson(response, 200, { ok: true });
      } catch (error) {
        return sendJson(response, error.statusCode ?? 409, { error: error.message, code: error.code, status: copilotChat.status });
      }
    }
    if (request.method === "POST" && pathname === "/api/copilot/abort") {
      if (!canMutate(request)) {
        return sendJson(response, 403, { error: "Cross-origin mutation rejected" });
      }
      const body = await readJsonBody(request);
      await copilotChat.abort(body);
      return sendJson(response, 200, { ok: true });
    }
    if (request.method === "POST" && pathname === "/api/copilot/reset") {
      if (!canMutate(request)) {
        return sendJson(response, 403, { error: "Cross-origin mutation rejected" });
      }
      const body = await readJsonBody(request);
      await copilotChat.reset(body);
      return sendJson(response, 200, { ok: true });
    }
    return sendJson(response, 404, { error: "API route not found" });
  }

  function serveStatic(response, pathname) {
    const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
    const normalizedPath = normalize(relativePath);
    if (normalizedPath.startsWith("..") || normalize(join(publicDirectory, normalizedPath)).startsWith(publicDirectory) === false) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }
    const filePath = join(publicDirectory, normalizedPath);
    if (!existsSync(filePath)) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": contentTypes[extname(filePath)] ?? "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    response.end(readFileSync(filePath));
  }

  const server = createServer((request, response) => {
    let url;
    try {
      url = new URL(request.url, `http://${host}:${activePort}`);
    } catch {
      response.writeHead(400);
      response.end("Invalid request URL");
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      handleApi(request, response, url.pathname, url.searchParams).catch((error) => {
        if (!response.headersSent) {
          sendJson(response, error.statusCode ?? 500, {
            error: error.message,
            code: error.code,
            ...(error.current ? { current: error.current } : {}),
            ...(copilotChat && url.pathname.startsWith("/api/copilot/") ? { status: copilotChat.status } : {})
          });
        } else {
          response.end();
        }
      });
      return;
    }
    serveStatic(response, url.pathname);
  });

  return {
    server,
    get chat() { return coordinator ?? copilotChat; },
    async listen({ port = 0 } = {}) {
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port: ${port}`);
      if (server.listening) return `http://${host}:${activePort}`;
      if (listening) return listening;
      listening = (async () => {
        if (!copilotChat && !coordinator) {
          const { LabChatCoordinator } = await import("./lab-chat.js");
          coordinator = new LabChatCoordinator(workspace, {
            ...options.chatOptions,
            runCheck: (id) => validate("check", id, "embedded")
          });
        }
        await copilotChat?.checkAvailability?.();
        return new Promise((resolveListen, rejectListen) => {
          function onError(error) {
            server.off("listening", onListening);
            rejectListen(error);
          }
          function onListening() {
            server.off("error", onError);
            activePort = server.address().port;
            resolveListen(`http://${host}:${activePort}`);
          }
          server.once("error", onError);
          server.once("listening", onListening);
          server.listen(port, host);
        });
      })();
      try {
        return await listening;
      } finally {
        listening = null;
      }
    },
    async close() {
      for (const subscriber of subscribers) subscriber.close();
      const stopped = await Promise.allSettled([
        (coordinator ?? copilotChat)?.stop(),
        validationTail,
        new Promise((resolveClose, rejectClose) => {
          server.close((error) => {
            if (error && error.code !== "ERR_SERVER_NOT_RUNNING") rejectClose(error);
            else resolveClose();
          });
          server.closeAllConnections();
        })
      ]);
      const errors = stopped.filter((result) => result.status === "rejected").map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, "Workshop shutdown failed.");
    }
  };
}
