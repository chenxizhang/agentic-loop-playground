import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporaryRoot = mkdtempSync(join(tmpdir(), "agentic-loop-playground-package-"));
const workspace = join(temporaryRoot, "agentic-loop-playground-workspace");
const launcher = process.argv[2] ? resolve(process.argv[2]) : resolve("dist/launcher.js");

const help = spawnSync(process.execPath, [launcher, "--help"], {
  cwd: temporaryRoot,
  encoding: "utf8"
});
if (
  help.status !== 0 ||
  !help.stdout.includes("agentic-loop-playground eval") ||
  existsSync(workspace)
) {
  throw new Error(`Packaged launcher help was not side-effect free.\n${help.stdout}${help.stderr}`);
}

const nonPlayground = join(temporaryRoot, "existing-project");
mkdirSync(nonPlayground);
writeFileSync(join(nonPlayground, "existing.txt"), "do not overwrite");
const unsafeDirectory = spawnSync(process.execPath, [launcher, nonPlayground, "--no-open"], {
  cwd: temporaryRoot,
  encoding: "utf8"
});
if (
  unsafeDirectory.status === 0 ||
  !`${unsafeDirectory.stdout}${unsafeDirectory.stderr}`.includes("is not an Agentic Loop Playground directory") ||
  !existsSync(join(nonPlayground, "existing.txt"))
) {
  throw new Error("Packaged launcher did not reject a non-playground directory with a warning.");
}

const fakePlayground = join(temporaryRoot, "fake-playground");
mkdirSync(fakePlayground);
writeFileSync(
  join(fakePlayground, ".loop-playground.json"),
  JSON.stringify({ name: "Unrelated Project", schemaVersion: 1, templateVersion: "1.0.0" })
);
const fakeMarker = spawnSync(process.execPath, [launcher, fakePlayground, "--no-open"], {
  cwd: temporaryRoot,
  encoding: "utf8"
});
if (
  fakeMarker.status === 0 ||
  !`${fakeMarker.stdout}${fakeMarker.stderr}`.includes("unrecognized or incompatible playground marker") ||
  existsSync(join(fakePlayground, "practice"))
) {
  throw new Error("Packaged launcher accepted a forged playground marker.");
}

const occupiedPortServer = createServer();
await new Promise((resolveListen, rejectListen) => {
  occupiedPortServer.once("error", rejectListen);
  occupiedPortServer.listen(0, "127.0.0.1", resolveListen);
});
const occupiedPort = occupiedPortServer.address().port;
const child = spawn(process.execPath, [launcher, "--no-open", "--port", String(occupiedPort)], {
  cwd: temporaryRoot,
  env: process.env,
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
    throw new Error("Packaged launcher did not populate its default workspace.");
  }
  if (
    new URL(origin).port === String(occupiedPort) ||
    !output.includes(`Port ${occupiedPort} is already in use; selecting an available port.`)
  ) {
    throw new Error(`Packaged launcher did not recover from an occupied port.\n${output}`);
  }
  const branch = spawnSync("git", ["branch", "--show-current"], {
    cwd: workspace,
    encoding: "utf8"
  });
  if (
    branch.status !== 0 ||
    branch.stdout.trim() !== "master" ||
    output.includes("Using 'master' as the name for the initial branch")
  ) {
    throw new Error(`Packaged launcher did not initialize a quiet master branch.\n${output}`);
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
  const unsafeLaunch = spawnSync(process.execPath, [launcher, unsafeWorkspace, "--no-open"], {
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
  try {
    symlinkSync(danglingTarget, join(danglingWorkspace, "AGENTS.md"), "file");
    const danglingLaunch = spawnSync(process.execPath, [launcher, danglingWorkspace, "--no-open"], {
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
  } catch (error) {
    if (process.platform !== "win32" || error.code !== "EPERM") throw error;
  }

  console.log("Packaged launcher verified: server, browser assets, and repository worker are operational.");
} finally {
  child.kill("SIGTERM");
  occupiedPortServer.close();
  rmSync(temporaryRoot, { recursive: true, force: true });
}
