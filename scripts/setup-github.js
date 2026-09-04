import { execFileSync } from "node:child_process";

function gh(args, options = {}) {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"]
    }).trim();
  } catch (error) {
    if (options.allowFailure) {
      return "";
    }
    const detail = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    throw new Error(detail || `gh ${args.join(" ")} failed`);
  }
}

function ensureLabel(name, color, description) {
  gh(["label", "create", name, "--color", color, "--description", description], { allowFailure: true });
  gh(["label", "edit", name, "--color", color, "--description", description], { allowFailure: true });
}

function ensureIssue(title, body, labels) {
  const existing = JSON.parse(gh(["issue", "list", "--state", "all", "--search", `"${title}" in:title`, "--json", "title,number"]) || "[]")
    .find((issue) => issue.title === title);
  if (existing) {
    console.log(`Issue #${existing.number} already exists: ${title}`);
    return;
  }
  gh(["issue", "create", "--title", title, "--body", body, ...labels.flatMap((label) => ["--label", label])], { inherit: true });
}

gh(["auth", "status"]);
gh(["repo", "view", "--json", "nameWithOwner"]);

ensureLabel("loop:ready", "1F883D", "Ready for discovery by the maintenance loop");
ensureLabel("loop:blocked", "D1242F", "Requires a human decision or dependency");
ensureLabel("loop:verify", "8250DF", "Requires independent verification");

ensureIssue(
  "Document the inventory reservation invariant",
  [
    "## Goal",
    "Make the inventory reservation invariant explicit for future agents.",
    "",
    "## Acceptance criteria",
    "- The invariant is documented next to the practice code.",
    "- The focused test command is documented.",
    "- No production behavior changes.",
    "",
    "## Stop condition",
    "Stop if the tests and current behavior imply conflicting domain rules."
  ].join("\n"),
  ["loop:ready"]
);

ensureIssue(
  "Add a zero-quantity inventory test",
  [
    "## Goal",
    "Add focused evidence for the zero-quantity reservation boundary.",
    "",
    "## Acceptance criteria",
    "- A deterministic test describes the expected behavior.",
    "- Existing focused tests continue to pass.",
    "",
    "## Stop condition",
    "Stop and request a human decision if zero quantity has no documented domain meaning."
  ].join("\n"),
  ["loop:ready", "loop:verify"]
);

ensureIssue(
  "Evaluate external inventory alert integration",
  [
    "## Goal",
    "Determine whether an external alert connector should be added.",
    "",
    "## Blocker",
    "No approved service, credentials, data classification, or network policy is available.",
    "",
    "## Stop condition",
    "Do not implement an integration until a human approves the service and security boundary."
  ].join("\n"),
  ["loop:blocked"]
);

console.log("GitHub lab labels and issues are ready.");

