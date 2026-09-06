import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runValidation } from "../src/validation-runner.js";

test("real validator runs in an isolated workspace without blocking the caller", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-validation-"));
  try {
    let timerRan = false;
    const pending = runValidation(root, "check", "01");
    await new Promise((resolve) => setTimeout(() => { timerRan = true; resolve(); }, 0));
    const result = await pending;
    assert.equal(timerRan, true);
    assert.equal(result.id, "01");
    assert.equal(result.ok, false);
    assert.ok(result.checks.some((check) => !check.ok && /Missing/i.test(check.detail)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid worker operations fail explicitly", async () => {
  await assert.rejects(runValidation(process.cwd(), "unknown"), /Unknown validation operation/);
});
