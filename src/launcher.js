#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const templateRoot = resolve(packageRoot, "playground-template");
const templateMarker = JSON.parse(readFileSync(resolve(templateRoot, ".loop-playground.json"), "utf8"));
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
const workspaceRoot = requestedWorkspace
  ? resolve(currentDirectory, requestedWorkspace)
  : existsSync(currentMarker)
    ? currentDirectory
    : resolve(currentDirectory, "agentic-loop-playground");

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

function scaffoldWorkspace() {
  if (!existsSync(templateRoot)) {
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
  if (existsSync(existingMarkerPath)) {
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
  cpSync(templateRoot, workspaceRoot, {
    recursive: true,
    force: false,
    errorOnExist: false
  });

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
    if (resolve(topLevel).toLowerCase() !== resolve(workspaceRoot).toLowerCase()) {
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
    if (resolve(topLevel).toLowerCase() !== resolve(workspaceRoot).toLowerCase()) {
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
