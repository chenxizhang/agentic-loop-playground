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
let workspaceRoot;

function printHelp() {
  console.log(`Agentic Loop Playground

Usage:
  agentic-loop-playground [directory] [options]
  agentic-loop-playground eval <owner/repository|URL> [--json]

Options:
  -h, --help         Show this help information
  -p, --port <port>  Preferred local port (0 selects a dynamic port)
      --open         Open the browser after startup (default)
      --no-open      Do not open the browser

The default directory is ./agentic-loop-playground-workspace. A missing or empty
directory is initialized automatically. An existing directory must contain a
compatible .loop-playground.json marker.

Examples:
  agentic-loop-playground
  agentic-loop-playground ./my-loop-lab --port 4173
  agentic-loop-playground eval github/docs
  agentic-loop-playground eval https://github.com/github/docs --json`);
}

function readOptionValue(argumentsList, index, option) {
  const value = argumentsList[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function parsePort(value) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid port: ${value}. Use an integer from 0 to 65535.`);
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65535) {
    throw new Error(`Invalid port: ${value}. Use an integer from 0 to 65535.`);
  }
  return port;
}

function parseInvocation(argumentsList) {
  if (argumentsList.includes("-h") || argumentsList.includes("--help")) {
    return { command: "help" };
  }
  if (argumentsList[0] === "eval") {
    const evaluationArguments = argumentsList.slice(1);
    const json = evaluationArguments.includes("--json");
    const unknown = evaluationArguments.find(
      (argument) => argument.startsWith("-") && argument !== "--json"
    );
    if (unknown) throw new Error(`Unknown eval option: ${unknown}`);
    const repositories = evaluationArguments.filter((argument) => argument !== "--json");
    if (repositories.length !== 1) {
      throw new Error("Usage: agentic-loop-playground eval <owner/repository|URL> [--json]");
    }
    return { command: "eval", repository: repositories[0], json };
  }

  let directory;
  let port;
  let open;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--open") {
      open = true;
    } else if (argument === "--no-open") {
      open = false;
    } else if (argument === "-p" || argument === "--port") {
      port = parsePort(readOptionValue(argumentsList, index, argument));
      index += 1;
    } else if (argument.startsWith("--port=")) {
      port = parsePort(argument.slice("--port=".length));
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (directory) {
      throw new Error("Provide at most one workspace directory.");
    } else {
      directory = argument;
    }
  }
  return { command: "start", directory, port, open };
}

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
        `WARNING: ${workspaceRoot} is not an Agentic Loop Playground directory.\n` +
        "Continuing could mix workshop files with unrelated content, so startup was stopped.\n" +
        "Recommended: choose an empty directory or an existing directory containing .loop-playground.json."
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
      existingMarker.name !== templateMarker.name ||
      existingMarker.schemaVersion !== templateMarker.schemaVersion ||
      existingMarker.templateVersion !== templateMarker.templateVersion
    ) {
      throw new Error(
        `WARNING: ${workspaceRoot} has an unrecognized or incompatible playground marker.\n` +
        "Recommended: choose a new empty directory or a compatible Agentic Loop Playground workspace."
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
    runGit(["init", "--quiet"]);
    runGit(["branch", "-M", "master"]);
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

function printEvaluation(result) {
  console.log(`\nRepository: ${result.repository}`);
  console.log(`Score: ${result.score}/${result.maximum}`);
  console.log(`Level: ${result.level}\n`);
  for (const category of result.categories) {
    console.log(`${category.earned}/${category.maximum}  ${category.title}`);
  }
  console.log(`\nScanned files: ${result.scannedFiles}${result.truncated ? " (truncated)" : ""}`);
}

async function main() {
  const invocation = parseInvocation(process.argv.slice(2));
  if (invocation.command === "help") {
    printHelp();
    return;
  }
  if (invocation.command === "eval") {
    const { analyzeGithubRepository } = await import("./repo-analyzer.js");
    const result = analyzeGithubRepository(invocation.repository);
    if (invocation.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printEvaluation(result);
    }
    return;
  }

  const requestedWorkspace = invocation.directory ?? process.env.AGENTIC_LOOP_PLAYGROUND_WORKSPACE;
  workspaceRoot = resolve(
    currentDirectory,
    requestedWorkspace ?? "agentic-loop-playground-workspace"
  );
  if (invocation.port !== undefined) {
    process.env.PORT = String(invocation.port);
  }
  if (invocation.open ?? true) {
    process.argv.push("--open");
  } else {
    process.argv.push("--no-open");
  }

  scaffoldWorkspace();
  process.chdir(workspaceRoot);
  process.env.AGENTIC_LOOP_PLAYGROUND_WORKSPACE = workspaceRoot;

  console.log("\nAgentic Loop Playground");
  console.log(`Workspace: ${workspaceRoot}`);
  console.log("The browser UI is local; repository checks run against this workspace.\n");

  await import("./server.js");
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
