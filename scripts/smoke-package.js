import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporaryRoot = mkdtempSync(join(tmpdir(), "agentic-loop-playground-package-"));
const workspace = join(temporaryRoot, "workspace");
const child = spawn(process.execPath, [resolve("dist/launcher.js"), workspace, "--no-open"], {
  env: { ...process.env, PORT: "0" },
  stdio: ["ignore", "pipe", "pipe"]
});
let output = "";
let origin;

child.stdout.on("data", (chunk) => {
  output += chunk;
  origin ??= output.match(/Agentic Loop Playground is running at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
});
child.stderr.on("data", (chunk) => {
  output += chunk;
});

async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Packaged launcher exited early.\n${output}`);
    }
    if (!origin) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      continue;
    }
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
    } catch {
      // The server may still be starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Packaged launcher did not become healthy.\n${output}`);
}

try {
  await waitForHealth();

  const page = await fetch(origin);
  if (!page.ok || !(await page.text()).includes("<title>Agentic Loop Playground</title>")) {
    throw new Error("Packaged launcher did not serve the built browser application.");
  }

  const workerResponse = await fetch(`${origin}/api/repository-analysis`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Loop-Lab": "browser"
    },
    body: JSON.stringify({ repository: "invalid" })
  });
  const workerResult = await workerResponse.json();
  if (workerResponse.status !== 422 || !workerResult.error?.includes("GitHub repository URL")) {
    throw new Error(`Packaged repository worker returned an unexpected result: ${JSON.stringify(workerResult)}`);
  }
  if (
    !existsSync(join(workspace, ".loop-playground.json")) ||
    !existsSync(join(workspace, "practice/src/inventory.js"))
  ) {
    throw new Error("Packaged template archive was not expanded into the learner workspace.");
  }

  const unsafeWorkspace = join(temporaryRoot, "unsafe-parent-workspace");
  const outsideDirectory = join(temporaryRoot, "outside");
  mkdirSync(unsafeWorkspace);
  mkdirSync(outsideDirectory);
  writeFileSync(
    join(unsafeWorkspace, ".loop-playground.json"),
    readFileSync(resolve("playground-template/.loop-playground.json"))
  );
  symlinkSync(outsideDirectory, join(unsafeWorkspace, "docs"), process.platform === "win32" ? "junction" : "dir");
  const unsafeLaunch = spawnSync(process.execPath, [resolve("dist/launcher.js"), unsafeWorkspace, "--no-open"], {
    env: { ...process.env, PORT: "0" },
    encoding: "utf8",
    timeout: 10_000
  });
  if (
    unsafeLaunch.status === 0 ||
    !`${unsafeLaunch.stdout}${unsafeLaunch.stderr}`.includes("Unsafe packaged template parent") ||
    existsSync(join(outsideDirectory, "PLATFORM-LOOP.md"))
  ) {
    throw new Error("Packaged template extraction did not reject a symlinked parent directory.");
  }

  const danglingWorkspace = join(temporaryRoot, "unsafe-destination-workspace");
  const danglingTarget = join(outsideDirectory, "new-file");
  mkdirSync(danglingWorkspace);
  writeFileSync(
    join(danglingWorkspace, ".loop-playground.json"),
    readFileSync(resolve("playground-template/.loop-playground.json"))
  );
  symlinkSync(danglingTarget, join(danglingWorkspace, "AGENTS.md"), "file");
  const danglingLaunch = spawnSync(process.execPath, [resolve("dist/launcher.js"), danglingWorkspace, "--no-open"], {
    env: { ...process.env, PORT: "0" },
    encoding: "utf8",
    timeout: 10_000
  });
  if (
    danglingLaunch.status === 0 ||
    !`${danglingLaunch.stdout}${danglingLaunch.stderr}`.includes("Unsafe packaged template destination") ||
    existsSync(danglingTarget)
  ) {
    throw new Error("Packaged template extraction did not reject a dangling destination symlink.");
  }

  console.log("Packaged launcher verified: server, browser assets, and repository worker are operational.");
} finally {
  child.kill("SIGTERM");
  rmSync(temporaryRoot, { recursive: true, force: true });
}
