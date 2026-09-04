import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

test("workspace contains the required learning surfaces", () => {
  const paths = [
    "AGENTS.md",
    ".github/copilot-instructions.md",
    ".github/skills/loop-engineering/SKILL.md",
    ".github/agents/loop-builder.agent.md",
    ".github/agents/loop-verifier.agent.md",
    "practice/src/inventory.js",
    "scenarios/ci-repair/inventory.contract.test.js"
  ];
  for (const path of paths) {
    assert.equal(existsSync(path), true, `Missing ${path}`);
  }
});

