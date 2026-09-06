import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkshopServer } from "../src/server-app.js";
import { CopilotChatService } from "../src/copilot-chat.js";
import { loadProgress, recordCheckpoint } from "../src/progress.js";
import { deferred, FakeCopilotClient } from "./helpers/fake-copilot.js";

test("slow validation leaves HTTP responsive and records fresh workspace-scoped evidence", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "loop-server-validation-"));
  const started = deferred();
  const release = deferred();
  const app = createWorkshopServer({
    workspace,
    chat: new CopilotChatService(workspace, { clientFactory: () => new FakeCopilotClient() }),
    async runValidation(root, kind, id) {
      assert.equal(root, workspace);
      assert.equal(kind, "check");
      assert.equal(id, "01");
      started.resolve();
      await release.promise;
      return { id, ok: false, checks: [{ name: "Goal", detail: "Missing measurable goal", ok: false, required: true }] };
    }
  });
  try {
    const url = await app.listen();
    const pending = fetch(`${url}/api/check/01`, {
      method: "POST", headers: { "X-Loop-Lab": "browser" }
    });
    await started.promise;
    const start = performance.now();
    assert.equal((await fetch(`${url}/api/health`)).status, 200);
    assert.ok(performance.now() - start < 250);
    recordCheckpoint("02", true, { workspace, source: "cli", checks: [] });
    release.resolve();
    const response = await pending;
    assert.equal(response.status, 200);
    const progress = loadProgress(workspace, { strict: true });
    assert.equal(progress.latestChecks["01"].source, "browser");
    assert.equal(progress.latestChecks["01"].checks[0].detail, "Missing measurable goal");
    assert.ok(progress.completed["02"]);
  } finally {
    release.resolve();
    await app.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});
