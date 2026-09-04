import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const loopEvidenceItems = [
  "discovery source and issue claim are linked",
  "owned and forbidden files were defined",
  "targeted validation passed",
  "full repository validation passed",
  "an independent checker reviewed the result",
  "residual risks and stop conditions are documented",
  "a human will make the merge decision"
];

function run(command, args = []) {
  try {
    return {
      ok: true,
      output: execFileSync(command, args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }).trim()
    };
  } catch (error) {
    return {
      ok: false,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`.trim()
    };
  }
}

function fileContains(path, terms) {
  const fullPath = resolve(root, path);
  if (!existsSync(fullPath)) {
    return { ok: false, detail: `Missing ${path}` };
  }
  const content = readFileSync(fullPath, "utf8").toLowerCase();
  const missing = terms.filter((term) => !content.includes(term.toLowerCase()));
  return missing.length === 0
    ? { ok: true, detail: `${path} contains the required evidence` }
    : { ok: false, detail: `${path} is missing: ${missing.join(", ")}` };
}

function markdownSections(path, sectionNames) {
  const fullPath = resolve(root, path);
  if (!existsSync(fullPath)) {
    return { ok: false, detail: `Missing ${path}`, content: "" };
  }
  const content = readFileSync(fullPath, "utf8");
  const headings = [...content.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)];
  const missing = [];
  const sections = {};
  for (const sectionName of sectionNames) {
    const headingIndex = headings.findIndex((match) =>
      match[1].trim().toLowerCase() === sectionName.toLowerCase()
    );
    if (headingIndex < 0) {
      missing.push(sectionName);
      continue;
    }
    const start = headings[headingIndex].index + headings[headingIndex][0].length;
    const end = headings[headingIndex + 1]?.index ?? content.length;
    const body = content.slice(start, end).replace(/<!--[\s\S]*?-->/g, "").trim();
    sections[sectionName.toLowerCase()] = body;
    if (body.length < 20) {
      missing.push(`${sectionName} (needs substantive evidence)`);
    }
  }
  return {
    ok: missing.length === 0,
    detail: missing.length === 0 ? `${path} has substantive required sections` : `${path} is missing: ${missing.join(", ")}`,
    content,
    sections
  };
}

function validateSkill(path) {
  const fullPath = resolve(root, path);
  if (!existsSync(fullPath)) {
    return { ok: false, detail: `Missing ${path}` };
  }
  const content = readFileSync(fullPath, "utf8");
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/);
  if (!frontmatter) {
    return { ok: false, detail: `${path} needs valid YAML frontmatter delimiters and a body` };
  }
  const name = frontmatter[1].match(/^name:\s*(.+)$/m)?.[1].trim();
  const description = frontmatter[1].match(/^description:\s*(.+)$/m)?.[1].trim();
  const valid = name === "inventory-maintenance" &&
    Boolean(description && description.length >= 30) &&
    /npm run test:practice/i.test(frontmatter[2]) &&
    /stop|escalat/i.test(frontmatter[2]);
  return {
    ok: valid,
    detail: valid
      ? `${path} has loadable frontmatter and an actionable workflow`
      : `${path} needs name inventory-maintenance, a specific description, test command, and stop rule`
  };
}

function result(name, ok, detail, required = true) {
  return { name, ok, detail, required };
}

function commandAvailable(command, args) {
  const commandResult = run(command, args);
  return result(command, commandResult.ok, commandResult.ok ? commandResult.output.split(/\r?\n/)[0] : commandResult.output);
}

function hasRemote() {
  const remote = run("git", ["remote", "get-url", "origin"]);
  return result("GitHub remote", remote.ok && /github\.com[:/]/i.test(remote.output), remote.output || "No origin remote");
}

function ghJson(args) {
  const response = run("gh", args);
  if (!response.ok) {
    return { ok: false, data: [], detail: response.output };
  }
  try {
    return { ok: true, data: JSON.parse(response.output || "[]"), detail: "GitHub query succeeded" };
  } catch {
    return { ok: false, data: [], detail: "GitHub returned invalid JSON" };
  }
}

export function doctorChecks() {
  const checks = [
    commandAvailable("node", ["--version"]),
    commandAvailable("git", ["--version"]),
    commandAvailable("gh", ["--version"]),
    commandAvailable("copilot", ["--version"]),
    hasRemote()
  ];
  const auth = run("gh", ["auth", "status"]);
  checks.push(result("GitHub authentication", auth.ok, auth.ok ? "Authenticated" : auth.output));
  return checks;
}

export function validateLesson(id, options = {}) {
  switch (String(id).padStart(2, "0")) {
    case "00":
      return doctorChecks();
    case "01": {
      const check = markdownSections(".workshop/evidence/lab-01-loop-design.md", [
        "goal",
        "observe",
        "act",
        "verify",
        "decide",
        "stop condition"
      ]);
      const repositorySpecific = /(inventory|github|issue|test|repository|practice)/i.test(check.content);
      return [
        result("Closed-loop design", check.ok, check.detail),
        result("Repository-specific design", repositorySpecific, repositorySpecific ? "Found repository-specific evidence" : "Reference concrete repository, GitHub, test, or inventory signals")
      ];
    }
    case "02": {
      const agents = markdownSections("practice/AGENTS.md", ["Commands", "Domain invariant", "Forbidden changes"]);
      const skill = validateSkill(".github/skills/inventory-maintenance/SKILL.md");
      return [
        result("Practice instructions", agents.ok, agents.detail),
        result("Inventory skill", skill.ok, skill.detail)
      ];
    }
    case "03": {
      const issues = ghJson(["issue", "list", "--label", "loop:ready", "--state", "open", "--json", "number,comments"]);
      const claimed = issues.ok && issues.data.some((issue) =>
        issue.comments.some((comment) => /LOOP-CLAIM/i.test(comment.body ?? ""))
      );
      return [
        result("Ready issue queue", issues.ok && issues.data.length > 0, issues.ok ? `${issues.data.length} ready issue(s)` : issues.detail),
        result("Durable issue claim", claimed, claimed ? "Found LOOP-CLAIM comment" : "No ready issue has a LOOP-CLAIM comment")
      ];
    }
    case "04": {
      const worktrees = run("git", ["worktree", "list", "--porcelain"]);
      const count = worktrees.ok ? (worktrees.output.match(/^worktree /gm) ?? []).length : 0;
      const worktreeOk = count >= 2 || options.recordedWorktreeEvidence;
      const plan = markdownSections(".workshop/evidence/lab-04-parallel-plan.md", ["Worker 1", "Worker 2", "Merge and escalation"]);
      return [
        result("Isolated worktrees", worktreeOk, count >= 2 ? `${count} worktree(s) found` : options.recordedWorktreeEvidence ? "Previously verified worktree evidence" : `${count} worktree(s) found`),
        result("Parallel ownership plan", plan.ok, plan.detail)
      ];
    }
    case "05": {
      const check = markdownSections(".workshop/evidence/lab-05-maker-checker.md", [
        "maker",
        "checker",
        "disagreement",
        "decision"
      ]);
      const provenance = /loop-builder/i.test(check.sections?.maker ?? "") &&
        /loop-verifier|\/review/i.test(check.sections?.checker ?? "");
      return [
        result("Maker-checker evidence", check.ok, check.detail),
        result("Independent agent provenance", provenance, provenance ? "Maker and checker roles identify independent agents" : "Maker must reference loop-builder; Checker must reference loop-verifier or /review")
      ];
    }
    case "06": {
      const tests = run("node", ["--test", "scenarios/ci-repair/inventory.contract.test.js"]);
      const log = markdownSections(".workshop/evidence/lab-06-repair.md", [
        "observation",
        "hypothesis",
        "change",
        "verification",
        "residual risk"
      ]);
      return [
        result("Practice tests", tests.ok, tests.ok ? "Focused tests pass" : tests.output),
        result("Repair iteration log", log.ok, log.detail)
      ];
    }
    case "07": {
      const design = markdownSections(".workshop/evidence/lab-07-automation.md", [
        "trigger",
        "prompt",
        "budget",
        "stop conditions",
        "escalation",
        "persistent state"
      ]);
      const experimental = /\/experimental\s+on|copilot\s+--experimental/i.test(design.content);
      const commands = /\/loop\s+(?:\d+)(?:s|m|h|d)?\s+\S+/i.test(design.content) &&
        /copilot\s+--autopilot[\s\S]*--max-autopilot-continues/i.test(design.content);
      return [
        result("Bounded automation design", design.ok, design.detail),
        result("Experimental scheduling enabled", experimental, experimental ? "Experimental mode prerequisite is documented" : "Include /experimental on or copilot --experimental"),
        result("Concrete automation commands", commands, commands ? "Found bounded loop and autopilot commands" : "Include exact /loop and bounded --autopilot commands")
      ];
    }
    case "08": {
      const viewer = run("gh", ["api", "user", "--jq", ".login"]);
      const pulls = ghJson(["pr", "list", "--state", "open", "--json", "number,headRefName,body,url,author"]);
      const capstone = pulls.ok && pulls.data.find((pull) => {
        const body = pull.body ?? "";
        const normalizedBody = body.toLowerCase();
        const checklistComplete = loopEvidenceItems.every((item) =>
          normalizedBody.includes(`- [x] ${item}`)
        );
        return viewer.ok &&
        pull.author?.login === viewer.output &&
        pull.headRefName.startsWith("loop/") &&
        /closes\s+#\d+/i.test(body) &&
        /loop evidence/i.test(body) &&
        checklistComplete &&
        !/^- \[ \]/gm.test(body);
      });
      let issueClaimed = false;
      if (capstone) {
        const issueNumber = capstone.body.match(/closes\s+#(\d+)/i)?.[1];
        const issue = issueNumber
          ? ghJson(["issue", "view", issueNumber, "--json", "comments,labels,state"])
          : { ok: false, data: {} };
        const ready = issue.ok &&
          issue.data.state === "OPEN" &&
          issue.data.labels.some((label) => label.name === "loop:ready");
        issueClaimed = ready && issue.data.comments.some((comment) =>
          comment.author?.login === viewer.output && /LOOP-CLAIM/i.test(comment.body ?? "")
        );
      }
      return [
        result("Capstone pull request", Boolean(capstone), capstone ? capstone.url : pulls.detail || "No authored loop/* pull request with all Loop Evidence checked"),
        result("Claimed issue link", issueClaimed, issueClaimed ? "Linked issue contains LOOP-CLAIM" : "The linked issue must contain a LOOP-CLAIM comment")
      ];
    }
    default:
      return [result("Lesson", false, `Unknown lesson ${id}`)];
  }
}

export function passed(checks) {
  return checks.every((check) => !check.required || check.ok);
}
