import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadProgress,
  MAX_PROGRESS_CHECK_DETAIL_BYTES,
  PROGRESS_SCHEMA_VERSION,
  ProgressStoreError,
  recordCheckpoint,
  saveProgress
} from "../src/progress.js";

function temporaryWorkspace() {
  return mkdtempSync(join(tmpdir(), "loop-progress-"));
}

test("records exact latest failure context across reloads and labs", (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const failedChecks = [
    { name: "Observation section", detail: "Missing a measurable observation.", ok: false, required: true },
    { name: "Budget", detail: "Budget is present.", ok: true, required: true }
  ];

  const failed = recordCheckpoint("01", false, {
    workspace,
    source: "browser",
    timestamp: "2026-09-06T00:00:00.000Z",
    checks: failedChecks
  });
  recordCheckpoint("02", true, {
    workspace,
    source: "chat",
    timestamp: "2026-09-06T00:01:00.000Z",
    checks: [{ name: "Evidence", detail: "Accepted.", ok: true }]
  });
  const reloaded = loadProgress(workspace, { strict: true });

  assert.equal(failed.version, PROGRESS_SCHEMA_VERSION);
  assert.deepEqual(reloaded.latestChecks["01"], {
    source: "browser",
    attempt: 1,
    timestamp: "2026-09-06T00:00:00.000Z",
    ok: false,
    checks: failedChecks
  });
  assert.equal(reloaded.latestChecks["02"].ok, true);
  assert.equal(reloaded.completed["01"], undefined);
  assert.equal(reloaded.completed["02"], "2026-09-06T00:01:00.000Z");
});

test("pass then failure updates one lab without contaminating another", (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  recordCheckpoint("01", true, {
    workspace,
    source: "cli",
    timestamp: "2026-09-06T01:00:00.000Z",
    checks: [{ name: "Required sections", detail: "Present.", ok: true }]
  });
  recordCheckpoint("02", true, {
    workspace,
    source: "grade",
    timestamp: "2026-09-06T01:01:00.000Z",
    checks: [{ name: "Checkpoint", detail: "Passed.", ok: true }]
  });
  const progress = recordCheckpoint("01", false, {
    workspace,
    source: "chat",
    timestamp: "2026-09-06T01:02:00.000Z",
    checks: [{ name: "Required sections", detail: "Action section was removed.", ok: false }]
  });

  assert.equal(progress.attempts["01"], 2);
  assert.equal(progress.latestChecks["01"].attempt, 2);
  assert.equal(progress.latestChecks["01"].checks[0].detail, "Action section was removed.");
  assert.equal(progress.completed["01"], undefined);
  assert.equal(progress.completed["02"], "2026-09-06T01:01:00.000Z");
  assert.equal(progress.latestChecks["02"].source, "grade");
});

test("retains Lab 04 evidence and bounded check details", (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const detail = "d".repeat(MAX_PROGRESS_CHECK_DETAIL_BYTES + 100);

  const progress = recordCheckpoint("04", true, {
    workspace,
    source: "cli",
    timestamp: "2026-09-06T02:00:00.000Z",
    checks: [{ name: "Worktree evidence", detail, ok: true }]
  });

  assert.equal(progress.evidence.lab04Worktree, "2026-09-06T02:00:00.000Z");
  assert.equal(
    Buffer.byteLength(progress.latestChecks["04"].checks[0].detail, "utf8"),
    MAX_PROGRESS_CHECK_DETAIL_BYTES
  );
});

test("strict reads report malformed progress and checkpoint writes preserve it", (context) => {
  const workspace = temporaryWorkspace();
  const workshop = join(workspace, ".workshop");
  const path = join(workshop, "progress.json");
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  mkdirSync(workshop);
  writeFileSync(path, "{malformed", { flag: "wx" });
  const before = readFileSync(path, "utf8");

  assert.throws(
    () => loadProgress(workspace, { strict: true }),
    (error) => error instanceof ProgressStoreError && error.code === "PROGRESS_MALFORMED"
  );
  assert.throws(
    () => recordCheckpoint("01", false, { workspace, source: "cli", checks: [] }),
    (error) => error instanceof ProgressStoreError && error.code === "PROGRESS_MALFORMED"
  );
  assert.equal(readFileSync(path, "utf8"), before);
});

test("progress writes are atomic and legacy files remain additive", (context) => {
  const workspace = temporaryWorkspace();
  const workshop = join(workspace, ".workshop");
  const path = join(workshop, "progress.json");
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  mkdirSync(workshop);
  writeFileSync(path, JSON.stringify({
    completed: { "00": "earlier" },
    attempts: { "00": 1 },
    evidence: { retained: true }
  }));

  const progress = recordCheckpoint("01", true, {
    workspace,
    source: "cli",
    timestamp: "2026-09-06T03:00:00.000Z",
    checks: []
  });

  assert.equal(progress.completed["00"], "earlier");
  assert.equal(progress.evidence.retained, true);
  assert.equal(progress.version, PROGRESS_SCHEMA_VERSION);
  assert.equal(existsSync(path), true);
  assert.equal(readdirSync(workshop).some((entry) => entry.endsWith(".tmp")), false);
});

test("strict writes preserve unsupported and malformed progress schemas", (context) => {
  const workspace = temporaryWorkspace();
  const path = join(workspace, ".workshop", "progress.json");
  mkdirSync(dirname(path), { recursive: true });
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const invalidDocuments = [
    { version: 999, completed: {}, attempts: {}, evidence: {}, latestChecks: {} },
    { version: 2, completed: {}, attempts: { "01": "bad" }, evidence: {}, latestChecks: {} },
    {
      version: 2,
      completed: {},
      attempts: {},
      evidence: {},
      latestChecks: { "01": { source: "cli", attempt: 1, timestamp: "now", ok: false, checks: "bad" } }
    }
  ];

  for (const document of invalidDocuments) {
    writeFileSync(path, `${JSON.stringify(document)}\n`);
    const before = readFileSync(path, "utf8");
    assert.throws(
      () => recordCheckpoint("01", false, { workspace, source: "cli", checks: [] }),
      (error) => error instanceof ProgressStoreError
    );
    assert.equal(readFileSync(path, "utf8"), before);
  }
});

test("atomic replacement failure preserves prior progress bytes", (context) => {
  const workspace = temporaryWorkspace();
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  recordCheckpoint("01", true, {
    workspace,
    source: "cli",
    timestamp: "2026-09-06T04:00:00.000Z",
    checks: []
  });
  const path = join(workspace, ".workshop", "progress.json");
  const before = readFileSync(path, "utf8");
  const progress = loadProgress(workspace, { strict: true });
  progress.attempts["01"] = 99;

  assert.throws(
    () => saveProgress(progress, workspace, {
      renameFile() {
        const error = new Error("injected replace failure");
        error.code = "EPERM";
        throw error;
      }
    }),
    (error) => error instanceof ProgressStoreError && error.code === "PROGRESS_WRITE_FAILED"
  );
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(readdirSync(dirname(path)).some((entry) => entry.endsWith(".tmp")), false);
});

test("CLI progress reads fail clearly instead of presenting malformed state as empty", (context) => {
  const workspace = temporaryWorkspace();
  const path = join(workspace, ".workshop", "progress.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{\"version\":999}\n");
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

  const result = spawnSync(process.execPath, [cli, "status"], {
    cwd: workspace,
    encoding: "utf8",
    windowsHide: true
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported schema version 999/i);
  assert.doesNotMatch(result.stdout, /0\/9 labs completed/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test("strict progress reads and writes enforce latest-check bounds", (context) => {
  const workspace = temporaryWorkspace();
  const path = join(workspace, ".workshop", "progress.json");
  mkdirSync(dirname(path), { recursive: true });
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const base = {
    version: PROGRESS_SCHEMA_VERSION,
    completed: {},
    attempts: { "01": 1 },
    evidence: {},
    latestChecks: {
      "01": {
        source: "cli",
        attempt: 1,
        timestamp: "2026-09-06T05:00:00.000Z",
        ok: false,
        checks: []
      }
    }
  };
  const invalidProgress = [
    {
      ...base,
      latestChecks: {
        "01": { ...base.latestChecks["01"], source: "s".repeat(65) }
      }
    },
    {
      ...base,
      latestChecks: {
        "01": {
          ...base.latestChecks["01"],
          checks: Array.from({ length: 65 }, (_, index) => ({
            name: `check-${index}`,
            detail: "",
            ok: false,
            required: true
          }))
        }
      }
    },
    {
      ...base,
      latestChecks: {
        "01": {
          ...base.latestChecks["01"],
          checks: [{
            name: "n".repeat(513),
            detail: "d".repeat(MAX_PROGRESS_CHECK_DETAIL_BYTES + 1),
            ok: false,
            required: true
          }]
        }
      }
    }
  ];

  for (const progress of invalidProgress) {
    assert.throws(
      () => saveProgress(progress, workspace),
      (error) => error instanceof ProgressStoreError && error.code === "PROGRESS_INVALID_SCHEMA"
    );
    writeFileSync(path, `${JSON.stringify(progress)}\n`);
    assert.throws(
      () => loadProgress(workspace, { strict: true }),
      (error) => error instanceof ProgressStoreError && error.code === "PROGRESS_INVALID_SCHEMA"
    );
  }
});
