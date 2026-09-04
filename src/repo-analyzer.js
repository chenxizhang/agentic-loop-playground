import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const ignoredDirectories = new Set([
  ".git",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  ".next",
  "target"
]);

function run(command, args, options = {}) {
  try {
    return {
      ok: true,
      output: execFileSync(command, args, {
        cwd: options.cwd,
        encoding: "utf8",
        timeout: options.timeout ?? 120_000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, ...options.env },
        stdio: ["ignore", "pipe", "pipe"]
      }).trim()
    };
  } catch (error) {
    return {
      ok: false,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`.trim() || error.message
    };
  }
}

export function parseGithubRepository(input) {
  const value = String(input ?? "").trim().replace(/\.git$/, "");
  const shorthand = value.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (shorthand) {
    return { owner: shorthand[1], name: shorthand[2], slug: `${shorthand[1]}/${shorthand[2]}` };
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a GitHub repository URL such as https://github.com/owner/repository.");
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    throw new Error("Only HTTPS github.com repository URLs are supported.");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part))) {
    throw new Error("The URL must point to a repository root, not an issue, pull request, or subdirectory.");
  }
  return { owner: parts[0], name: parts[1], slug: `${parts[0]}/${parts[1]}` };
}

export function repositoryAnalysisPrerequisites() {
  const git = run("git", ["--version"], { timeout: 10_000 });
  const gh = run("gh", ["--version"], { timeout: 10_000 });
  const auth = gh.ok ? run("gh", ["auth", "status", "--hostname", "github.com"], { timeout: 15_000 }) : { ok: false, output: "GitHub CLI is not installed" };
  return {
    readyForPublicRepositories: git.ok,
    readyForPrivateRepositories: git.ok && auth.ok,
    checks: [
      {
        name: "Git",
        ok: git.ok,
        requiredFor: "All repositories",
        detail: git.ok ? git.output.split(/\r?\n/)[0] : "Install Git and make it available on PATH."
      },
      {
        name: "GitHub CLI",
        ok: gh.ok,
        requiredFor: "Private repositories and richer GitHub access",
        detail: gh.ok ? gh.output.split(/\r?\n/)[0] : "Install GitHub CLI from https://cli.github.com/."
      },
      {
        name: "GitHub authentication",
        ok: auth.ok,
        requiredFor: "Private repositories",
        detail: auth.ok ? "Authenticated with GitHub CLI." : "Run `gh auth login` for private repository access."
      }
    ],
    safety: [
      "The repository is cloned into a temporary directory.",
      "The analyzer reads files but does not execute repository scripts, builds, tests, hooks, or actions.",
      "The temporary clone is deleted after analysis.",
      "Private repositories require an authenticated GitHub CLI identity with access to the repository."
    ]
  };
}

function walk(directory, root = directory, files = []) {
  if (files.length >= 5000) return files;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (files.length >= 5000) break;
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(path, root, files);
    } else if (entry.isFile()) {
      files.push(relative(root, path).replaceAll("\\", "/"));
    }
  }
  return files;
}

function safeRead(root, path) {
  const fullPath = resolve(root, path);
  if (!existsSync(fullPath) || !statSync(fullPath).isFile() || statSync(fullPath).size > 200_000) {
    return "";
  }
  try {
    return readFileSync(fullPath, "utf8");
  } catch {
    return "";
  }
}

function containsAny(content, patterns) {
  return patterns.some((pattern) => pattern.test(content));
}

function category(title, maximum, earned, evidence, recommendation) {
  return { title, maximum, earned, evidence, recommendation };
}

function analyzeFiles(files, read, repository) {
  const matching = (predicate) => files.filter(predicate);
  const instructionFiles = matching((file) =>
    file.toLowerCase() === "agents.md" ||
    file.toLowerCase() === ".github/copilot-instructions.md" ||
    /^\.github\/instructions\/.+\.instructions\.md$/i.test(file)
  );
  const skillFiles = matching((file) => /^\.github\/skills\/[^/]+\/skill\.md$/i.test(file));
  const agentFiles = matching((file) => /^\.github\/agents\/.+\.agent\.md$/i.test(file));
  const workflowFiles = matching((file) => /^\.github\/workflows\/.+\.ya?ml$/i.test(file));
  const testFiles = matching((file) =>
    /(^|\/)(test|tests|__tests__)\//i.test(file) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/i.test(file) ||
    /_test\.(go|py)$/i.test(file)
  );
  const issueTemplates = matching((file) => /^\.github\/issue_template\//i.test(file));
  const pullRequestTemplate = files.find((file) => /^\.github\/pull_request_template\.md$/i.test(file));
  const hookFiles = matching((file) => /^\.github\/hooks\/.+\.json$/i.test(file));
  const packageJson = read("package.json");
  let packageMetadata = {};
  try {
    packageMetadata = packageJson ? JSON.parse(packageJson) : {};
  } catch {
    packageMetadata = {};
  }
  const readme = read(files.find((file) => /^readme\.md$/i.test(file)) ?? "");
  const instructionContent = instructionFiles.slice(0, 50).map((file) => read(file)).join("\n");
  const workflowContent = workflowFiles.slice(0, 50).map((file) => read(file)).join("\n");
  const documentation = `${readme}\n${instructionContent}`;

  const hasTestCommand = typeof packageMetadata.scripts?.test === "string" && packageMetadata.scripts.test.trim().length > 0 ||
    containsAny(documentation, [/\bnpm (run )?test\b/i, /\bpytest\b/i, /\bgo test\b/i, /\bcargo test\b/i, /\bdotnet test\b/i, /\bmvn test\b/i, /\bgradle test\b/i]);
  const hasBuildCommand = typeof packageMetadata.scripts?.build === "string" && packageMetadata.scripts.build.trim().length > 0 ||
    containsAny(documentation, [/\bnpm run build\b/i, /\bdotnet build\b/i, /\bcargo build\b/i, /\bmvn package\b/i]);
  const scheduledWorkflow = containsAny(workflowContent, [/\bschedule\s*:/i, /\bworkflow_dispatch\s*:/i]);
  const verificationGuidance = containsAny(documentation, [
    /\bvalidate\b/i,
    /\bverification\b/i,
    /\btest command\b/i,
    /\bnpm (run )?(test|validate)\b/i,
    /\bpytest\b/i,
    /\bgo test\b/i
  ]);
  const governanceGuidance = containsAny(documentation, [
    /stop condition/i,
    /\bescalat/i,
    /human (approval|decision|review)/i,
    /do not (merge|modify|execute)/i,
    /\bbudget\b/i
  ]);

  const categories = [
    category(
      "Repository instructions",
      15,
      instructionFiles.length ? 15 : 0,
      instructionFiles.length ? instructionFiles : ["No Copilot or agent instruction file found."],
      "Add AGENTS.md or .github/copilot-instructions.md with architecture, commands, invariants, and boundaries."
    ),
    category(
      "Reusable skills",
      10,
      skillFiles.length ? 10 : 0,
      skillFiles.length ? skillFiles : ["No project agent skills found."],
      "Encode task-specific operating knowledge in .github/skills/<name>/SKILL.md."
    ),
    category(
      "Specialized agents",
      10,
      agentFiles.length >= 2 ? 10 : agentFiles.length === 1 ? 5 : 0,
      agentFiles.length ? agentFiles : ["No custom agents found."],
      "Define separate maker and verifier agents to reduce self-review bias."
    ),
    category(
      "Continuous verification",
      15,
      workflowFiles.length && hasTestCommand ? 15 : workflowFiles.length || hasTestCommand ? 8 : 0,
      [
        `${workflowFiles.length} workflow file(s)`,
        `${testFiles.length} test file(s)`,
        hasTestCommand ? "A test command is documented or configured." : "No test command detected."
      ],
      "Connect deterministic test or validation commands to a GitHub Actions workflow."
    ),
    category(
      "Executable quality signals",
      15,
      testFiles.length && hasTestCommand ? 15 : testFiles.length || hasTestCommand ? 8 : 0,
      [`${testFiles.length} test file(s)`, hasBuildCommand ? "Build command detected." : "No build command detected."],
      "Provide focused tests and documented build or validation commands that can disprove success."
    ),
    category(
      "Collaboration memory",
      10,
      issueTemplates.length && pullRequestTemplate ? 10 : issueTemplates.length || pullRequestTemplate ? 5 : 0,
      [
        `${issueTemplates.length} issue template(s)`,
        pullRequestTemplate ?? "No pull request template found."
      ],
      "Use issue templates for discoverable work and a pull request template for durable loop evidence."
    ),
    category(
      "Automation triggers",
      10,
      scheduledWorkflow || hookFiles.length ? 10 : workflowFiles.length ? 5 : 0,
      [
        scheduledWorkflow ? "Scheduled or manual workflow trigger detected." : "No recurring or manual loop trigger detected.",
        `${hookFiles.length} Copilot hook file(s)`
      ],
      "Add a bounded schedule, workflow_dispatch trigger, or repository hook with explicit stop conditions."
    ),
    category(
      "Verification documentation",
      10,
      verificationGuidance ? 10 : 0,
      verificationGuidance ? ["Validation guidance is documented."] : ["No clear validation guidance detected."],
      "Document exact focused and full validation commands in repository instructions."
    ),
    category(
      "Human governance",
      5,
      governanceGuidance ? 5 : 0,
      governanceGuidance ? ["Stop, escalation, budget, or human-decision guidance detected."] : ["No explicit human control boundary detected."],
      "Document stop conditions, budgets, forbidden actions, and decisions that require a human."
    )
  ];

  const score = categories.reduce((total, item) => total + item.earned, 0);
  return {
    repository,
    score,
    maximum: 100,
    level: score >= 85 ? "Loop-ready" : score >= 65 ? "Developing" : score >= 40 ? "Foundational" : "Open-loop",
    categories,
    scannedFiles: files.length,
    truncated: files.length >= 5000,
    analyzedAt: new Date().toISOString()
  };
}

export function analyzeRepositoryDirectory(directory, repository = "local/repository") {
  const files = walk(directory);
  return analyzeFiles(files, (path) => safeRead(directory, path), repository);
}

function analyzeGitObjectDatabase(directory, repository) {
  const head = run("git", ["-C", directory, "rev-parse", "--verify", "HEAD"], { timeout: 10_000 });
  if (!head.ok) {
    return analyzeFiles([], () => "", repository);
  }
  const tree = run("git", ["-C", directory, "ls-tree", "-r", "--name-only", "HEAD"], { timeout: 30_000 });
  if (!tree.ok) {
    throw new Error(`Unable to inspect repository tree: ${tree.output}`);
  }
  const files = tree.output.split(/\r?\n/).filter(Boolean).slice(0, 5000);
  const read = (path) => {
    if (!path) return "";
    const content = run("git", ["-C", directory, "show", `HEAD:${path}`], { timeout: 30_000 });
    return content.ok && content.output.length <= 200_000 ? content.output : "";
  };
  return analyzeFiles(files, read, repository);
}

export function analyzeGithubRepository(input) {
  const repository = parseGithubRepository(input);
  const prerequisites = repositoryAnalysisPrerequisites();
  if (!prerequisites.readyForPublicRepositories) {
    throw new Error("Git is required before a repository can be analyzed.");
  }

  const temporaryRoot = mkdtempSync(join(tmpdir(), "agentic-loop-playground-analysis-"));
  const cloneDirectory = join(temporaryRoot, "repository");
  const hooksDirectory = join(temporaryRoot, "disabled-hooks");
  mkdirSync(hooksDirectory);
  const safeGitEnvironment = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: hooksDirectory,
    GIT_LFS_SKIP_SMUDGE: "1"
  };

  try {
    const clone = prerequisites.readyForPrivateRepositories
      ? run("gh", ["repo", "clone", `https://github.com/${repository.slug}.git`, cloneDirectory, "--", "--depth", "1", "--filter=blob:none", "--no-checkout", "--no-recurse-submodules"], {
          env: { ...safeGitEnvironment, GH_HOST: "github.com" }
        })
      : run("git", ["clone", "--depth", "1", "--filter=blob:none", "--no-checkout", "--no-recurse-submodules", `https://github.com/${repository.slug}.git`, cloneDirectory], {
          env: safeGitEnvironment
        });
    if (!clone.ok) {
      const privateHint = prerequisites.readyForPrivateRepositories
        ? "Confirm that the repository exists and your GitHub identity can access it."
        : "For a private repository, install GitHub CLI and run `gh auth login` first.";
      throw new Error(`Unable to clone ${repository.slug}. ${privateHint}\n${clone.output}`);
    }
    return analyzeGitObjectDatabase(cloneDirectory, repository.slug);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
}
