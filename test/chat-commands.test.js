import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHAT_COMMAND_REGISTRY,
  discoverChatDefinitions,
  listChatCommandMetadata,
  MAX_DISCOVERY_FILE_BYTES,
  parseChatCommand
} from "../src/chat-commands.js";

function temporaryWorkspace() {
  const workspace = mkdtempSync(join(tmpdir(), "loop-chat-commands-"));
  mkdirSync(join(workspace, ".github", "skills"), { recursive: true });
  mkdirSync(join(workspace, ".github", "agents"), { recursive: true });
  return workspace;
}

function writeSkill(workspace, directory, contents) {
  const path = join(workspace, ".github", "skills", directory);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), contents);
}

test("discovers only workspace definitions and preserves native adapter candidates", (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeSkill(workspace, "plain", [
    "---",
    "name: plain-skill",
    "description: Plain description",
    "---",
    "Exact body.",
    ""
  ].join("\n"));
  writeSkill(workspace, "quoted", [
    "---",
    "name: \"quoted-skill\"",
    "description: >",
    "  Folded description",
    "  across lines",
    "tools: [read, 'search']",
    "---",
    "Quoted body.",
    ""
  ].join("\n"));
  writeSkill(workspace, "multiline-blank", [
    "---",
    "name: multiline-blank",
    "description: |",
    "  First paragraph.",
    "",
    "  Second paragraph.",
    "---",
    "Multiline body.",
    ""
  ].join("\n"));
  writeFileSync(join(workspace, ".github", "agents", "checker.agent.md"), [
    "---",
    "name: checker",
    "description: |",
    "  Independent checker",
    "  with restrictions",
    "tools:",
    "  - read",
    "  - search",
    "---",
    "Agent body.",
    ""
  ].join("\n"));

  const discovered = discoverChatDefinitions(workspace);
  const plain = discovered.skills.find((skill) => skill.name === "plain-skill");
  const quoted = discovered.skills.find((skill) => skill.name === "quoted-skill");
  const checker = discovered.agents.find((agent) => agent.name === "checker");
  const multiline = discovered.skills.find((skill) => skill.name === "multiline-blank");

  assert.equal(discovered.diagnostics.length, 0);
  assert.equal(plain.body, "Exact body.\n");
  assert.equal(plain.source, ".github/skills/plain/SKILL.md");
  assert.equal(plain.canonicalPath.endsWith(join(".github", "skills", "plain", "SKILL.md")), true);
  assert.equal(plain.activatable, false);
  assert.equal(plain.activation.state, "candidate");
  assert.equal(quoted.description, "Folded description across lines");
  assert.deepEqual(quoted.tools, ["read", "search"]);
  assert.equal(multiline.description, "First paragraph.\n\nSecond paragraph.");
  assert.equal(checker.description, "Independent checker\nwith restrictions");
  assert.deepEqual(checker.tools, ["read", "search"]);
  assert.equal(checker.activatable, false);
});

test("surfaces malformed, duplicate, unsupported, and oversized definitions", (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeSkill(workspace, "first", "---\nname: duplicate\ndescription: First\n---\nFirst\n");
  writeSkill(workspace, "second", "---\nname: Duplicate\ndescription: Second\n---\nSecond\n");
  writeSkill(workspace, "unsupported", [
    "---",
    "name: unsupported",
    "description: Unsupported tools",
    "tools: { allow: [read] }",
    "---",
    "Body",
    ""
  ].join("\n"));
  writeSkill(workspace, "unsupported-policy", [
    "---",
    "name: unsupported-policy",
    "description: Unsupported policy",
    "permissions: read-only",
    "---",
    "Body",
    ""
  ].join("\n"));
  writeSkill(workspace, "unsupported-inline", [
    "---",
    "name: unsupported-inline",
    "description: Unsupported inline restriction",
    "tools: [read, { allow: write }]",
    "---",
    "Body",
    ""
  ].join("\n"));
  writeSkill(workspace, "unsupported-block", [
    "---",
    "name: unsupported-block",
    "description: Unsupported block restriction",
    "tools:",
    "  - read",
    "  - { allow: write }",
    "---",
    "Body",
    ""
  ].join("\n"));
  writeSkill(workspace, "unsupported-description", [
    "---",
    "name: unsupported-description",
    "description: { text: unsupported }",
    "---",
    "Body",
    ""
  ].join("\n"));
  writeSkill(workspace, "oversized", [
    "---",
    "name: oversized",
    "description: Too large",
    "---",
    "x".repeat(MAX_DISCOVERY_FILE_BYTES)
  ].join("\n"));
  writeFileSync(
    join(workspace, ".github", "agents", "broken.agent.md"),
    "name: broken\nNo frontmatter"
  );

  const discovered = discoverChatDefinitions(workspace);

  assert.equal(
    discovered.skills.filter((skill) => skill.name?.toLowerCase() === "duplicate").every((skill) => !skill.valid),
    true
  );
  assert.equal(discovered.skills.find((skill) => skill.source.includes("unsupported")).valid, false);
  assert.equal(discovered.skills.find((skill) => skill.source.includes("unsupported-policy")).valid, false);
  assert.equal(discovered.skills.find((skill) => skill.source.includes("unsupported-inline")).valid, false);
  assert.equal(discovered.skills.find((skill) => skill.source.includes("unsupported-block")).valid, false);
  assert.equal(discovered.skills.find((skill) => skill.source.includes("unsupported-description")).valid, false);
  assert.equal(discovered.skills.find((skill) => skill.source.includes("oversized")).valid, false);
  assert.equal(discovered.agents[0].valid, false);
  assert.deepEqual(
    new Set(discovered.diagnostics.map((diagnostic) => diagnostic.code)),
    new Set([
      "DISCOVERY_INVALID_DEFINITION",
      "DISCOVERY_FILE_LIMIT",
      "DISCOVERY_DUPLICATE_NAME"
    ])
  );
});

test("enforces entry, aggregate byte, and elapsed discovery limits", (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeSkill(workspace, "a", "---\nname: a\ndescription: A\n---\nA\n");
  writeSkill(workspace, "b", "---\nname: b\ndescription: B\n---\nB\n");
  writeSkill(workspace, "c", "---\nname: c\ndescription: C\n---\nC\n");

  const entryLimited = discoverChatDefinitions(workspace, { maxEntries: 1 });
  assert.equal(entryLimited.skills.length, 1);
  assert.equal(entryLimited.diagnostics.some((item) => item.code === "DISCOVERY_ENTRY_LIMIT"), true);

  const aggregateLimited = discoverChatDefinitions(workspace, { maxTotalBytes: 40 });
  assert.equal(
    aggregateLimited.diagnostics.some((item) => item.code === "DISCOVERY_TOTAL_LIMIT"),
    true
  );
  assert.equal(aggregateLimited.skills.some((skill) => !skill.valid), true);

  let tick = 0;
  const timedOut = discoverChatDefinitions(workspace, {
    maxMilliseconds: 2,
    clock: () => tick++
  });
  assert.equal(timedOut.diagnostics.some((item) => item.code === "DISCOVERY_TIMEOUT"), true);
});

test("counts irrelevant filesystem entries against the discovery scan bound", (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  for (let index = 0; index < 10; index += 1) {
    writeFileSync(join(workspace, ".github", "skills", `irrelevant-${index}.txt`), "ignored");
  }
  writeFileSync(
    join(workspace, ".github", "agents", "must-not-scan.agent.md"),
    "---\nname: must-not-scan\ndescription: Must not scan\n---\nBody\n"
  );

  const discovered = discoverChatDefinitions(workspace, { maxEntries: 3 });

  assert.equal(discovered.skills.length, 0);
  assert.equal(discovered.agents.length, 0);
  assert.equal(discovered.diagnostics.some((item) => item.code === "DISCOVERY_ENTRY_LIMIT"), true);
});

test("rejects definition files that escape through a junction", (context) => {
  const root = mkdtempSync(join(tmpdir(), "loop-command-junction-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  mkdirSync(join(workspace, ".github", "skills"), { recursive: true });
  mkdirSync(join(workspace, ".github", "agents"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, "SKILL.md"), "---\nname: escaped\ndescription: Escaped\n---\nBody\n");
  symlinkSync(outside, join(workspace, ".github", "skills", "escaped"), "junction");
  context.after(() => rmSync(root, { recursive: true, force: true }));

  const discovered = discoverChatDefinitions(workspace);

  assert.equal(discovered.skills[0].valid, false);
  assert.equal(discovered.skills[0].activatable, false);
  assert.equal(discovered.diagnostics[0].code, "DISCOVERY_PATH_ESCAPE");
});

test("registry exposes only supported application commands with capability dependencies", () => {
  assert.deepEqual(
    CHAT_COMMAND_REGISTRY.map((command) => command.name),
    ["help", "skills", "agent", "clear", "new", "history", "stop", "status", "check", "forget"]
  );
  const metadata = listChatCommandMetadata({
    skills: [{
      name: "loop-engineering",
      description: "Loop skill",
      source: ".github/skills/loop-engineering/SKILL.md",
      valid: true,
      activation: { capabilityDependency: "Native confirmation required." }
    }],
    agents: [{
      name: "loop-verifier",
      description: "Verifier",
      source: ".github/agents/loop-verifier.agent.md",
      tools: ["read", "search"],
      valid: true,
      activation: { capabilityDependency: "Restriction confirmation required." }
    }]
  });

  assert.equal(metadata.skillCandidates[0].activatable, false);
  assert.equal(metadata.agentCandidates[0].activatable, false);
  assert.deepEqual(metadata.agentCandidates[0].tools, ["read", "search"]);
});

test("parses application commands without sending them to the model", () => {
  assert.deepEqual(parseChatCommand("ordinary prompt"), {
    kind: "message",
    displayPrompt: "ordinary prompt",
    sendToModel: true
  });
  assert.equal(parseChatCommand("/skills").subcommand, "list");
  assert.deepEqual(parseChatCommand("/skills info \"loop-engineering\"").args, ["info", "loop-engineering"]);
  assert.equal(parseChatCommand("/agent loop-verifier").kind, "application-command");
  assert.equal(parseChatCommand("/forget").metadata.effect, "destructive");
  assert.equal(parseChatCommand("/check").sendToModel, false);
  assert.equal(parseChatCommand("/status extra").code, "INVALID_COMMAND_ARGUMENTS");
});

test("returns honest CLI-only, native-candidate, and unknown command errors", () => {
  const definitions = {
    skills: [{
      name: "loop-engineering",
      valid: true,
      activation: { capabilityDependency: "Native runtime confirmation required." }
    }]
  };

  const cliOnly = parseChatCommand("/fleet investigate", definitions);
  const candidate = parseChatCommand("/loop-engineering inspect this", definitions);
  const unknown = parseChatCommand("/does-not-exist", definitions);

  assert.equal(cliOnly.code, "CLI_ONLY_COMMAND");
  assert.equal(cliOnly.sendToModel, false);
  assert.equal(candidate.kind, "native-skill-candidate");
  assert.equal(candidate.activatable, false);
  assert.match(candidate.message, /must confirm activation/);
  assert.equal(unknown.code, "UNKNOWN_COMMAND");
  assert.equal(unknown.sendToModel, false);
});
