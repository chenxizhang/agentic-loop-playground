#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const templateRoot = resolve(packageRoot, "playground-template");
const packaged = typeof __PACKAGED__ !== "undefined" && __PACKAGED__;
const templateArchive = resolve(packageRoot, "dist/playground-template.json.gz");
const templateEntries = packaged
  ? JSON.parse(gunzipSync(readFileSync(templateArchive)))
  : null;
const markerEntry = templateEntries?.find(({ path }) => path === ".loop-playground.json");
const templateMarker = JSON.parse(
  markerEntry
    ? Buffer.from(markerEntry.content, "base64").toString("utf8")
    : readFileSync(resolve(templateRoot, ".loop-playground.json"), "utf8")
);
const currentDirectory = process.cwd();
const launcherArguments = process.argv.slice(2);
const positionalArguments = launcherArguments.filter((argument) => !argument.startsWith("-"));
const unknownOptions = launcherArguments.filter(
  (argument) => argument.startsWith("-") && argument !== "--open" && argument !== "--no-open"
);

if (unknownOptions.length > 0) {
  throw new Error(`Unknown option: ${unknownOptions[0]}`);
}
if (positionalArguments.length > 1) {
  throw new Error("Provide at most one workspace directory.");
}

const requestedWorkspace = positionalArguments[0] ?? process.env.AGENTIC_LOOP_PLAYGROUND_WORKSPACE;
const currentMarker = resolve(currentDirectory, ".loop-playground.json");
const defaultWorkspace = resolve(currentDirectory, "agentic-loop-playground");
const fallbackWorkspace = resolve(currentDirectory, "agentic-loop-playground-workspace");
const workspaceRoot = requestedWorkspace
  ? resolve(currentDirectory, requestedWorkspace)
  : existsSync(currentMarker)
    ? currentDirectory
    : isOccupiedNonPlayground(defaultWorkspace)
      ? fallbackWorkspace
      : defaultWorkspace;

function runGit(args, options = {}) {
  try {
    const output = execFileSync("git", args, {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: options.quiet ? ["ignore", "pipe", "pipe"] : "inherit"
    });
    return typeof output === "string" ? output.trim() : "";
  } catch (error) {
    if (options.allowFailure) {
      return "";
    }
    const detail = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    throw new Error(detail || `git ${args.join(" ")} failed`);
  }
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function isOccupiedNonPlayground(path) {
  const stats = lstatIfPresent(path);
  return Boolean(
    stats?.isDirectory() &&
    !existsSync(resolve(path, ".loop-playground.json")) &&
    readdirSync(path).length > 0
  );
}

function canonicalPath(path) {
  const canonical = realpathSync.native(resolve(path));
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function copyPackagedTemplate() {
  for (const entry of templateEntries) {
    const pathSegments = entry.path.split("/");
    if (pathSegments.some((segment) => !segment || segment === "." || segment === "..")) {
      throw new Error(`Invalid packaged template path: ${entry.path}`);
    }
    const destination = resolve(workspaceRoot, entry.path);
    const workspaceRelativePath = relative(workspaceRoot, destination);
    if (!workspaceRelativePath || workspaceRelativePath.startsWith("..") || isAbsolute(workspaceRelativePath)) {
      throw new Error(`Invalid packaged template path: ${entry.path}`);
    }

    let parent = workspaceRoot;
    for (const segment of pathSegments.slice(0, -1)) {
      parent = resolve(parent, segment);
      const stats = lstatIfPresent(parent);
      if (!stats) continue;
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(`Unsafe packaged template parent: ${relative(workspaceRoot, parent)}`);
      }
    }
    const destinationStats = lstatIfPresent(destination);
    if (destinationStats) {
      if (destinationStats.isSymbolicLink()) {
        throw new Error(`Unsafe packaged template destination: ${entry.path}`);
      }
      continue;
    }
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, Buffer.from(entry.content, "base64"), { mode: entry.mode });
  }
}

function scaffoldWorkspace() {
  if (packaged && !templateEntries) {
    throw new Error(`Playground template archive is missing: ${templateArchive}`);
  }
  if (!packaged && !existsSync(templateRoot)) {
    throw new Error(`Playground template is missing: ${templateRoot}`);
  }

  if (existsSync(workspaceRoot) && !existsSync(resolve(workspaceRoot, ".loop-playground.json"))) {
    const entries = readdirSync(workspaceRoot);
    if (entries.length > 0) {
      throw new Error(
        `Refusing to write into non-playground directory: ${workspaceRoot}\n` +
        "Choose an empty directory, an existing playground, or omit the path to create ./agentic-loop-playground."
      );
    }
  }

  const existingMarkerPath = resolve(workspaceRoot, ".loop-playground.json");
  const existingMarkerStats = lstatIfPresent(existingMarkerPath);
  if (existingMarkerStats) {
    if (existingMarkerStats.isSymbolicLink()) {
      throw new Error(`Playground marker cannot be a symbolic link: ${existingMarkerPath}`);
    }
    const existingMarker = JSON.parse(readFileSync(existingMarkerPath, "utf8"));
    if (
      existingMarker.schemaVersion !== templateMarker.schemaVersion ||
      existingMarker.templateVersion !== templateMarker.templateVersion
    ) {
      throw new Error(
        `Workspace template ${existingMarker.templateVersion ?? "unknown"} is incompatible with ${templateMarker.templateVersion}.\n` +
        "Choose a new directory argument or set AGENTIC_LOOP_PLAYGROUND_WORKSPACE to preserve the existing learner workspace."
      );
    }
  }

  mkdirSync(workspaceRoot, { recursive: true });
  if (packaged) {
    copyPackagedTemplate();
  } else {
    cpSync(templateRoot, workspaceRoot, {
      recursive: true,
      force: false,
      errorOnExist: false
    });
  }

  const stagedGitignore = resolve(workspaceRoot, "gitignore.template");
  const gitignore = resolve(workspaceRoot, ".gitignore");
  if (existsSync(stagedGitignore)) {
    if (existsSync(gitignore)) {
      unlinkSync(stagedGitignore);
    } else {
      renameSync(stagedGitignore, gitignore);
    }
  }

  if (!existsSync(resolve(workspaceRoot, ".git"))) {
    runGit(["--version"], { quiet: true });
    runGit(["init"]);
    runGit(["branch", "-M", "main"]);
    const topLevel = runGit(["rev-parse", "--show-toplevel"], { quiet: true });
    if (canonicalPath(topLevel) !== canonicalPath(workspaceRoot)) {
      throw new Error(`Git initialized an unexpected repository root: ${topLevel}`);
    }
    const hasName = runGit(["config", "user.name"], { quiet: true, allowFailure: true });
    const hasEmail = runGit(["config", "user.email"], { quiet: true, allowFailure: true });
    if (!hasName) runGit(["config", "--local", "user.name", "agentic-loop-playground"]);
    if (!hasEmail) runGit(["config", "--local", "user.email", "agentic-loop-playground@local.invalid"]);
    runGit(["add", "."]);
    runGit(["commit", "-m", "Initialize agentic-loop-playground workspace"]);
  } else {
    const topLevel = runGit(["rev-parse", "--show-toplevel"], { quiet: true });
    if (canonicalPath(topLevel) !== canonicalPath(workspaceRoot)) {
      throw new Error(`Workspace Git root does not match the workspace directory: ${topLevel}`);
    }
  }
}

scaffoldWorkspace();
process.chdir(workspaceRoot);
process.env.AGENTIC_LOOP_PLAYGROUND_WORKSPACE = workspaceRoot;

console.log("\nAgentic Loop Playground");
console.log(`Workspace: ${workspaceRoot}`);
console.log("The browser UI is local; repository checks run against this workspace.\n");

if (!process.argv.includes("--open") && !process.argv.includes("--no-open")) {
  process.argv.push("--open");
}

await import("./server.js");
