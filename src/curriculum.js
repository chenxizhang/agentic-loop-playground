export const lessons = [
  {
    id: "00",
    title: "Environment and repository contract",
    component: "Foundation",
    objective: "Prove that the embedded Copilot agent, Git, and GitHub operate against the same repository workspace.",
    scenario: "You have joined a team whose maintenance loop is stalled because nobody knows whether the automation environment is trustworthy.",
    steps: [
      "Click `Environment Check` in the browser and resolve every required failure.",
      "Connect the embedded Copilot pane and ask it to inspect the current environment.",
      "In the embedded pane run `/skills list` and `/agent`; confirm that repository skills and custom agents are visible.",
      "Run `npm run github:setup` after pushing the repository to GitHub.",
      "Send the prompt below to the embedded Copilot pane and inspect its answer before approving any action."
    ],
    prompt: "First inspect `git remote -v`. If this workspace has no GitHub remote, explain why the labs need one, ask me for the repository name and whether it should be public or private, then wait for my answer before proposing `gh repo create` and requesting approval. If a GitHub remote already exists, read @AGENTS.md, @.github/copilot-instructions.md, and @docs/PLATFORM-LOOP.md, then explain the repository's trust boundary, validation commands, and stop conditions. Do not modify files.",
    evidence: [
      "Required local tools are installed.",
      "The repository has a GitHub remote.",
      "GitHub CLI authentication works."
    ],
    verification: "Click `Check Lab 00` in the browser.",
    reflection: "Which permissions would you refuse to pre-approve, and why?"
  },
  {
    id: "01",
    title: "From open-loop prompt to closed-loop system",
    component: "Control loop",
    objective: "Turn a vague maintenance request into an observable loop with a deterministic stop condition.",
    scenario: "A product owner says: 'Keep the inventory service healthy.' A one-shot prompt cannot decide what healthy means or when to stop.",
    steps: [
      "Confirm that the workspace has a GitHub remote. If it does not, ask Copilot in this conversation to guide you through creating and pushing one.",
      "Create `.workshop/evidence/lab-01-loop-design.md`.",
      "Define the sections `Goal`, `Observe`, `Act`, `Verify`, `Decide`, and `Stop Condition`.",
      "Give each section at least one repository-specific statement.",
      "Select `/agent loop-verifier` in the embedded pane and ask it to challenge weak measurements without rewriting your design.",
      "Revise the design until every action has an observable result."
    ],
    prompt: "Inspect `git remote -v` first. If there is no GitHub remote, ask me for the repository name and visibility, then guide me through creating it with `gh repo create --source . --remote origin --push`, requesting approval before running the command. After the remote exists, use @docs/templates/loop-design.md as a rubric and critique my @.workshop/evidence/lab-01-loop-design.md as a closed-loop control system. Identify ambiguous observations, unverifiable actions, and unsafe stop conditions. Do not rewrite the design for me.",
    evidence: [
      "A loop design exists with all six control sections.",
      "The stop condition is measurable rather than subjective."
    ],
    verification: "Click `Check Lab 01` in the browser.",
    reflection: "What signal causes another iteration, and what signal forces a human decision?"
  },
  {
    id: "02",
    title: "Encode knowledge as instructions and a skill",
    component: "Skills and memory",
    objective: "Move repeated prompt context into repository-owned, selectively loaded knowledge.",
    scenario: "Agents repeatedly make unsafe changes because the inventory domain rules only exist in a senior engineer's memory.",
    steps: [
      "Create `practice/AGENTS.md` with substantive `Commands`, `Domain invariant`, and `Forbidden changes` sections.",
      "Create `.github/skills/inventory-maintenance/SKILL.md` with valid YAML frontmatter.",
      "Make the skill description specific enough that Copilot loads it only for inventory maintenance.",
      "In the embedded Copilot pane run `/skills reload` and `/skills info inventory-maintenance`.",
      "Ask Copilot to compare always-on instructions with task-specific skill content."
    ],
    prompt: "Use the /inventory-maintenance skill. Read @practice/AGENTS.md and propose a safe repair workflow for the inventory scenario. Explain which knowledge came from instructions and which came from the skill. Do not edit production code.",
    evidence: [
      "`practice/AGENTS.md` documents commands and invariants.",
      "The inventory maintenance skill has a name, description, and actionable workflow."
    ],
    verification: "Click `Check Lab 02` in the browser.",
    reflection: "Which guidance belongs in always-on instructions, and which guidance should remain selectively loaded?"
  },
  {
    id: "03",
    title: "GitHub Issues as discovery queue and persistent memory",
    component: "Connectors and memory",
    objective: "Discover work from GitHub state instead of manually inventing the next prompt.",
    scenario: "A maintenance loop must select the next ready task from a shared backlog and leave a durable audit trail.",
    steps: [
      "Run `npm run github:setup` if you have not already done so.",
      "Use the embedded Copilot pane with the built-in GitHub MCP server to list open issues labeled `loop:ready`.",
      "Select exactly one issue using severity, readiness, and dependency information.",
      "Add a comment containing `LOOP-CLAIM`, your selection reason, verification plan, and stop condition.",
      "Do not change code in this lab."
    ],
    prompt: "Use GitHub tools to inspect open issues in this repository labeled `loop:ready`. Select one issue using an explicit priority rule. Comment on it with `LOOP-CLAIM`, the reason, a verification plan, and the condition that would stop execution and require a human. Do not modify code.",
    evidence: [
      "At least one ready issue exists.",
      "A ready issue contains a durable `LOOP-CLAIM` comment."
    ],
    verification: "Click `Check Lab 03` in the browser.",
    reflection: "Why is an issue comment better loop memory than relying on the current chat context?"
  },
  {
    id: "04",
    title: "Parallel work without collisions",
    component: "Worktrees and sub-agents",
    objective: "Isolate concurrent agent work and give each worker a narrow ownership boundary.",
    scenario: "Two agents need to improve tests and documentation at the same time without editing the same checkout.",
    steps: [
      "Create a branch named `lab/worktree-docs` in a second Git worktree.",
      "Keep the worktree until this lab passes; the platform records this ephemeral evidence in local progress.",
      "In the embedded pane, explicitly ask separate agents to analyze tests and documentation. `/fleet` is a CLI-only alternative, not an embedded command.",
      "Require each worker to report owned files, verification, and unresolved risks.",
      "Record substantive `Worker 1`, `Worker 2`, and `Merge and escalation` sections in `.workshop/evidence/lab-04-parallel-plan.md`."
    ],
    prompt: "Design two independent work packets for this repository: one for test analysis and one for documentation analysis. They must not own the same files. Include inputs, outputs, validation, merge order, and escalation conditions. Save the agreed plan to @.workshop/evidence/lab-04-parallel-plan.md.",
    evidence: [
      "Git reports at least two worktrees.",
      "The parallel plan names two workers and non-overlapping file ownership."
    ],
    verification: "Click `Check Lab 04` in the browser.",
    reflection: "Which dependency would make these work packets unsafe to run in parallel?"
  },
  {
    id: "05",
    title: "Separate maker and checker",
    component: "Sub-agents and verification",
    objective: "Prevent the implementation agent from being the only judge of its own work.",
    scenario: "A maker claims a change is complete, but the team needs independent evidence before accepting it.",
    steps: [
      "Use the `loop-builder` agent to propose a small change to the practice scenario without implementing it.",
      "Use the `loop-verifier` agent or `/review` to critique that proposal independently.",
      "Record both positions in `.workshop/evidence/lab-05-maker-checker.md`.",
      "Include `Maker`, `Checker`, `Disagreement`, and `Decision` sections; name `loop-builder` in Maker and `loop-verifier` or `/review` in Checker.",
      "Make the final decision depend on evidence, not agent confidence."
    ],
    prompt: "Run two separate analyses of the inventory repair scenario. First select or invoke the loop-builder agent and request a bounded proposal without implementation. Then select or invoke the loop-verifier agent and ask it to independently challenge that proposal. After both responses, use the default agent to record Maker, Checker, Disagreement, and Decision sections in @.workshop/evidence/lab-05-maker-checker.md.",
    evidence: [
      "Maker and checker outputs are recorded separately.",
      "The decision includes a concrete test or repository signal."
    ],
    verification: "Click `Check Lab 05` in the browser.",
    reflection: "What information must be hidden or independently regenerated to reduce confirmation bias?"
  },
  {
    id: "06",
    title: "Test-driven CI repair loop",
    component: "Observe, act, verify, repeat",
    objective: "Run a real repair loop until tests prove the inventory behavior is correct.",
    scenario: "The inventory reservation function has multiple defects and its focused test suite is failing.",
    steps: [
      "Run `npm run scenario:reset`.",
      "Run `npm run test:practice` and inspect the failing evidence.",
      "Ask Copilot to form a hypothesis before editing.",
      "Allow a minimal implementation change in `practice/src/inventory.js`.",
      "Repeat focused tests until they pass, then run `npm test`.",
      "Create `.workshop/evidence/lab-06-repair.md` with `Observation`, `Hypothesis`, `Change`, `Verification`, and `Residual Risk`."
    ],
    prompt: "Use the /inventory-maintenance skill to repair the failing inventory scenario. Follow a strict loop: run the focused tests, state a hypothesis, make the smallest change, rerun tests, and repeat only if evidence requires it. Record the iterations in @.workshop/evidence/lab-06-repair.md. Stop and ask me if the domain invariant is ambiguous.",
    evidence: [
      "The focused practice tests pass.",
      "The repair log records an evidence-driven iteration."
    ],
    verification: "Click `Check Lab 06` in the browser.",
    reflection: "What prevented the agent from making a broad, plausible-looking rewrite?"
  },
  {
    id: "07",
    title: "Automation, budgets, and stop conditions",
    component: "Automation",
    objective: "Make the loop recur safely without turning autonomy into unbounded execution.",
    scenario: "The team wants a recurring health check, but it must not keep editing forever or consume an unlimited budget.",
    steps: [
      "Create `.workshop/evidence/lab-07-automation.md`.",
      "Document the CLI-only `/experimental on` and `/loop` commands; do not run them in the embedded pane or start a schedule.",
      "Include `Trigger`, `Prompt`, `Budget`, `Stop Conditions`, `Escalation`, and `Persistent State`.",
      "Design one in-session `/loop` command and one persistent GitHub Actions schedule.",
      "Use a minimum interval appropriate for a lab; do not leave a noisy schedule running.",
      "Record `/experimental on` (or `copilot --experimental`) and include a safe programmatic example using both `--autopilot` and `--max-autopilot-continues`."
    ],
    prompt: "Review @.github/workflows/loop-health.yml and design a complementary Copilot CLI `/loop` command. Write the design to @.workshop/evidence/lab-07-automation.md with trigger, exact prompt, AI/iteration budget, stop conditions, escalation path, and persistent state. Do not start the schedule.",
    evidence: [
      "The design distinguishes session-scoped and persistent automation.",
      "It defines an iteration or AI-credit budget and human escalation."
    ],
    verification: "Click `Check Lab 07` in the browser.",
    reflection: "Which failure modes should stop immediately rather than trigger another iteration?"
  },
  {
    id: "08",
    title: "Capstone: issue-to-PR maintenance loop",
    component: "Complete loop",
    objective: "Operate the complete loop with discovery, isolation, execution, verification, review, and durable state.",
    scenario: "Run one ready GitHub issue through the team's full maintenance system and produce a reviewable pull request.",
    steps: [
      "Select the issue claimed in Lab 03 or claim another `loop:ready` issue.",
      "Create an isolated `loop/` branch or worktree.",
      "Use plan mode before implementation and a specialized agent for the work.",
      "Run targeted validation, independent review, and the full repository validation.",
      "Open a pull request containing `Closes #<issue>` and complete every Loop Evidence checklist item.",
      "Leave the issue and pull request as the durable final state; do not merge solely because the agents approve."
    ],
    prompt: "Run the full repository maintenance loop for the GitHub issue I claimed. Use plan mode, isolate work on a `loop/` branch, use the relevant skill, implement the smallest valid change, run targeted and full validation, request independent review, and open a pull request using the repository template. Stop before merge and ask me for the final human decision.",
    evidence: [
      "A pull request exists from a `loop/` branch.",
      "The pull request links an issue and includes Loop Evidence.",
      "Local Labs 01 through 07 pass."
    ],
    verification: "Click `Final Score` in the browser.",
    reflection: "What did the human decide that the loop could not safely decide?"
  }
];

export function getLesson(id) {
  return lessons.find((lesson) => lesson.id === String(id).padStart(2, "0"));
}
