import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeRepositoryDirectory, parseGithubRepository } from "../src/repo-analyzer.js";

test("parses GitHub repository URLs and shorthand", () => {
  assert.equal(parseGithubRepository("https://github.com/github/docs").slug, "github/docs");
  assert.equal(parseGithubRepository("github/docs.git").slug, "github/docs");
  assert.throws(() => parseGithubRepository("https://example.com/owner/repo"), /github\.com/);
  assert.throws(() => parseGithubRepository("https://github.com/owner/repo/issues/1"), /repository root/);
});

test("scores a repository from static loop evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-analyzer-test-"));
  try {
    mkdirSync(join(root, ".github", "skills", "maintenance"), { recursive: true });
    mkdirSync(join(root, ".github", "agents"), { recursive: true });
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    mkdirSync(join(root, ".github", "ISSUE_TEMPLATE"), { recursive: true });
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "Run npm test for verification. Stop and request human approval before merge.");
    writeFileSync(join(root, ".github", "skills", "maintenance", "SKILL.md"), "---\nname: maintenance\ndescription: Maintains the project\n---\n");
    writeFileSync(join(root, ".github", "agents", "builder.agent.md"), "---\ndescription: builds\n---\n");
    writeFileSync(join(root, ".github", "agents", "verifier.agent.md"), "---\ndescription: verifies\n---\n");
    writeFileSync(join(root, ".github", "workflows", "ci.yml"), "on:\n  workflow_dispatch:\njobs: {}\n");
    writeFileSync(join(root, ".github", "ISSUE_TEMPLATE", "task.md"), "# Task\n");
    writeFileSync(join(root, ".github", "pull_request_template.md"), "# Evidence\n");
    writeFileSync(join(root, "package.json"), "{\"scripts\":{\"test\":\"node --test\",\"build\":\"node build.js\"}}");
    writeFileSync(join(root, "test", "app.test.js"), "");
    const result = analyzeRepositoryDirectory(root, "example/repository");
    assert.equal(result.maximum, 100);
    assert.ok(result.score >= 85, `Expected a loop-ready score, received ${result.score}`);
    assert.equal(result.repository, "example/repository");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not treat an arbitrary package property as a test script", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-analyzer-package-test-"));
  try {
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(join(root, "package.json"), "{\"dependencies\":{\"test\":\"1.0.0\"}}");
    writeFileSync(join(root, ".github", "workflows", "ci.yml"), "on: push\njobs: {}\n");
    const result = analyzeRepositoryDirectory(root);
    const verification = result.categories.find((category) => category.title === "Continuous verification");
    assert.equal(verification.earned, 8);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
