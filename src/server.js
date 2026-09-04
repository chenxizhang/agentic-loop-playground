import { execFile } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { getLesson, lessons } from "./curriculum.js";
import { doctorChecks, passed, validateLesson } from "./validators.js";
import { loadProgress, recordCheckpoint, saveProgress } from "./progress.js";
import { repositoryAnalysisPrerequisites } from "./repo-analyzer.js";
import { CopilotChatService } from "./copilot-chat.js";

const host = "127.0.0.1";
const configuredPort = Number(process.env.PORT ?? 4173);
if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65535) {
  throw new Error(`Invalid PORT value: ${process.env.PORT}`);
}
let activePort = configuredPort;
const packaged = typeof __PACKAGED__ !== "undefined" && __PACKAGED__;
const publicDirectory = fileURLToPath(new URL(packaged ? "./public/" : "../public/", import.meta.url));
const repositoryWorker = fileURLToPath(new URL("./analyze-repo-worker.js", import.meta.url));
const copilotChat = new CopilotChatService(process.cwd());
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

function sendEvent(response, event) {
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function gradeCourse() {
  const progress = loadProgress();
  const results = lessons.map((lesson) => {
    const checks = validateLesson(lesson.id, {
      recordedWorktreeEvidence: Boolean(progress.evidence?.lab04Worktree)
    });
    const ok = passed(checks);
    if (ok) {
      progress.completed[lesson.id] ??= new Date().toISOString();
    } else {
      delete progress.completed[lesson.id];
    }
    return { id: lesson.id, title: lesson.title, ok, checks };
  });
  saveProgress(progress);
  return {
    results,
    score: results.filter((result) => result.ok).length * 10,
    maximum: lessons.length * 10,
    progress
  };
}

function resetScenario() {
  copyFileSync("scenarios/ci-repair/inventory.start.js", "practice/src/inventory.js");
  copyFileSync("scenarios/ci-repair/inventory.test.js", "practice/test/inventory.test.js");
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
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 8192) {
        rejectBody(new Error("Request body is too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolveBody(body ? JSON.parse(body) : {});
      } catch {
        rejectBody(new Error("Request body must be valid JSON"));
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
        cwd: process.cwd(),
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

async function handleApi(request, response, pathname) {
  if (request.method === "GET" && pathname === "/api/health") {
    return sendJson(response, 200, { ok: true });
  }
  if (request.method === "GET" && pathname === "/api/info") {
    return sendJson(response, 200, {
      workspace: process.cwd(),
      localOnly: true,
      runtime: process.version
    });
  }
  if (request.method === "GET" && pathname === "/api/lessons") {
    return sendJson(response, 200, { lessons });
  }
  if (request.method === "GET" && pathname === "/api/progress") {
    return sendJson(response, 200, loadProgress());
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
    response.write(": connected\n\n");
    const unsubscribe = copilotChat.subscribe((event) => sendEvent(response, event));
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    request.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    return;
  }
  if (request.method === "GET" && pathname === "/api/copilot/status") {
    return sendJson(response, 200, copilotChat.status);
  }
  if (request.method === "GET" && pathname === "/api/doctor") {
    const checks = doctorChecks();
    return sendJson(response, 200, { ok: passed(checks), checks });
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
    const currentProgress = loadProgress();
    const checks = validateLesson(lesson.id, {
      recordedWorktreeEvidence: Boolean(currentProgress.evidence?.lab04Worktree)
    });
    const ok = passed(checks);
    const progress = recordCheckpoint(lesson.id, ok);
    return sendJson(response, 200, { ok, checks, progress });
  }
  if (request.method === "POST" && pathname === "/api/grade") {
    if (!canMutate(request)) {
      return sendJson(response, 403, { error: "Cross-origin mutation rejected" });
    }
    return sendJson(response, 200, gradeCourse());
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
    try {
      return sendJson(response, 200, await copilotChat.start());
    } catch (error) {
      return sendJson(response, 422, { error: error.message });
    }
  }
  if (request.method === "POST" && pathname === "/api/copilot/message") {
    if (!canMutate(request)) {
      return sendJson(response, 403, { error: "Cross-origin mutation rejected" });
    }
    const body = await readJsonBody(request);
    try {
      await copilotChat.send(body.prompt);
      return sendJson(response, 202, { ok: true });
    } catch (error) {
      return sendJson(response, 422, { error: error.message });
    }
  }
  if (request.method === "POST" && pathname === "/api/copilot/permission") {
    if (!canMutate(request)) {
      return sendJson(response, 403, { error: "Cross-origin mutation rejected" });
    }
    const body = await readJsonBody(request);
    try {
      copilotChat.resolvePermission(body.requestId, body.decision, body.feedback);
      return sendJson(response, 200, { ok: true });
    } catch (error) {
      return sendJson(response, 409, { error: error.message });
    }
  }
  if (request.method === "POST" && pathname === "/api/copilot/abort") {
    if (!canMutate(request)) {
      return sendJson(response, 403, { error: "Cross-origin mutation rejected" });
    }
    await copilotChat.abort();
    return sendJson(response, 200, { ok: true });
  }
  if (request.method === "POST" && pathname === "/api/copilot/reset") {
    if (!canMutate(request)) {
      return sendJson(response, 403, { error: "Cross-origin mutation rejected" });
    }
    await copilotChat.reset();
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
    handleApi(request, response, url.pathname).catch((error) => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: error.message });
      } else {
        response.end();
      }
    });
    return;
  }
  serveStatic(response, url.pathname);
});

let usedFallbackPort = false;

server.on("error", (error) => {
  if (error.code === "EADDRINUSE" && configuredPort !== 0 && !usedFallbackPort) {
    usedFallbackPort = true;
    console.warn(`Port ${configuredPort} is already in use; selecting an available port.`);
    server.listen(0, host);
    return;
  }
  throw error;
});

server.on("listening", () => {
  const address = server.address();
  activePort = typeof address === "object" && address ? address.port : configuredPort;
  const url = `http://${host}:${activePort}`;
  console.log(`Agentic Loop Playground is running at ${url}`);
  console.log("Press Ctrl+C to stop.");
  if (process.argv.includes("--open")) {
    if (process.platform === "win32") {
      execFile("cmd.exe", ["/c", "start", "", url]);
    } else if (process.platform === "darwin") {
      execFile("open", [url]);
    } else {
      execFile("xdg-open", [url]);
    }
  }
});

server.listen(configuredPort, host);
