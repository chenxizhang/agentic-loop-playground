import { execFileSync } from "node:child_process";

function gh(args, allowFailure = false) {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch (error) {
    if (allowFailure) return "";
    throw new Error(`${error.stdout ?? ""}${error.stderr ?? ""}`.trim());
  }
}

function ensureLabel(name, color, description) {
  gh(["label", "create", name, "--color", color, "--description", description], true);
  gh(["label", "edit", name, "--color", color, "--description", description], true);
}

function ensureIssue(title, body, labels) {
  const issues = JSON.parse(gh(["issue", "list", "--state", "all", "--json", "title,number"]) || "[]");
  if (issues.some((issue) => issue.title === title)) return;
  gh(["issue", "create", "--title", title, "--body", body, ...labels.flatMap((label) => ["--label", label])]);
}

gh(["auth", "status"]);
gh(["repo", "view", "--json", "nameWithOwner"]);
ensureLabel("loop:ready", "1F883D", "Ready for discovery by the maintenance loop");
ensureLabel("loop:blocked", "D1242F", "Requires a human decision or dependency");
ensureLabel("loop:verify", "8250DF", "Requires independent verification");
ensureIssue("Document the inventory reservation invariant", "Define the invariant, focused validation, and human stop condition.", ["loop:ready"]);
ensureIssue("Add a zero-quantity inventory test", "Add deterministic evidence without weakening existing tests.", ["loop:ready", "loop:verify"]);
ensureIssue("Evaluate external inventory alert integration", "Blocked until a human approves the service and security boundary.", ["loop:blocked"]);
console.log("GitHub lab labels and issues are ready.");

