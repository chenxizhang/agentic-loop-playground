import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createWorkshopServer } from "../src/server-app.js";

if (!process.argv.includes("--allow-live")) {
  throw new Error("Live smoke requires --allow-live. It uses existing authentication and requests at most three SDK turns.");
}
const modulePath = process.env.LOOP_TEST_PLAYWRIGHT_MODULE;
const { chromium } = await import(modulePath ? pathToFileURL(resolve(modulePath)).href : "playwright");
const workspace = mkdtempSync(join(tmpdir(), "loop-live-chat-"));
const artifacts = resolve(process.env.LOOP_TEST_ARTIFACTS ?? join(".workshop", "tmp", `live-${Date.now()}`));
const marker = `inventory-checkpoint-example-${randomUUID()}`;
let app, browser, page;
const evidence = { provider: "real-sdk", assertions: [], errors: [], requestedTurns: 0, marker };
try {
  mkdirSync(artifacts, { recursive: true });
  mkdirSync(join(workspace, ".github", "agents"), { recursive: true });
  mkdirSync(join(workspace, ".github", "skills", "loop-engineering"), { recursive: true });
  copyFileSync(".github/agents/loop-verifier.agent.md", join(workspace, ".github", "agents", "loop-verifier.agent.md"));
  copyFileSync(".github/skills/loop-engineering/SKILL.md", join(workspace, ".github", "skills", "loop-engineering", "SKILL.md"));
  writeFileSync(join(workspace, ".gitignore"), ".workshop/chat/\n.workshop/progress.json\n");
  writeFileSync(join(workspace, "notes.txt"), `${marker}: observe one inventory invariant, make one bounded change, validate it, and stop when evidence is accepted.\n`);
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", workspace], { windowsHide: true });
  execFileSync("git", ["-C", workspace, "remote", "add", "origin", "git@github.com:chenxizhang/agentic-loop-playground.git"], { windowsHide: true });
  if (process.platform === "win32") {
    process.env.COPILOT_CLI_PATH = createRequire(import.meta.url).resolve("@github/copilot-win32-x64");
  }
  evidence.sdk = JSON.parse(readFileSync("node_modules/@github/copilot-sdk/package.json", "utf8")).version;
  app = createWorkshopServer({ workspace });
  let url = await app.listen();
  browser = await chromium.launch({
    headless: process.env.LOOP_TEST_HEADED !== "1",
    ...(process.env.LOOP_TEST_BROWSER ? { executablePath: process.env.LOOP_TEST_BROWSER } : {})
  });
  evidence.browser = browser.version();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(90_000);
  page.on("pageerror", (error) => evidence.errors.push(error.message));
  async function snapshot() {
    return page.evaluate(async () => {
      const labId = document.querySelector("#copilot-lab-title").textContent.match(/Lab (\d+)/)[1];
      const query = new URLSearchParams({
        labId, clientId: sessionStorage.getItem("loop-client-id"),
        conversationId: document.querySelector("#copilot-history").value
      });
      const response = await fetch(`/api/copilot/snapshot?${query}`);
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    });
  }
  async function idle() {
    await page.waitForFunction(() => {
      if (document.querySelector(".permission-card")) throw new Error("Live probe will not approve protected operations.");
      const status = document.querySelector("#copilot-status");
      if (status.classList.contains("error")) throw new Error(document.querySelector("#copilot-tool-status").textContent);
      return status.classList.contains("ready") && !document.querySelector("#copilot-send").disabled;
    });
  }
  function eventContainsMarker(value) {
    if (typeof value === "string") return value.includes(marker);
    if (Array.isArray(value)) return value.some(eventContainsMarker);
    return value && typeof value === "object" && Object.values(value).some(eventContainsMarker);
  }
  async function nativeContextContainsMarker() {
    const state = await snapshot();
    const entry = app.chat.labs.get(state.route.labId).conversations.get(state.route.conversationId);
    assert.equal(typeof entry?.service?.session?.getEvents, "function", "installed SDK session must expose getEvents()");
    const events = await entry.service.session.getEvents();
    evidence.nativeHistoryEventCounts = [...(evidence.nativeHistoryEventCounts ?? []), events.length];
    return events.some((event) => !event.ephemeral && eventContainsMarker(event.data));
  }
  await page.goto(url);
  await page.locator('[data-lesson="01"]').click();
  await page.waitForFunction(() => document.querySelector("#copilot-lab-title").textContent === "Lab 01 Conversation");
  await page.locator("#copilot-connect").click();
  evidence.requestedTurns++;
  await page.locator(".chat-message.assistant").waitFor();
  await idle();
  const first = await snapshot();
  assert.ok(first.chat.sessionId);
  assert.match(await page.locator(".chat-message.assistant").innerText(), /lab|loop|goal/i);
  evidence.assertions.push("real lab-specific kickoff completed");

  const text = "Use a read-only file tool to read notes.txt and quote the unique inventory marker it contains, then explain how that marker relates to this lab. Do not modify files, run commands, or access external services.";
  await page.locator("#copilot-input").fill(text);
  await page.locator("#copilot-send").click();
  evidence.requestedTurns++;
  await page.waitForFunction(() => !document.querySelector("#copilot-input").value);
  await idle();
  assert.match(await page.locator("#copilot-messages").innerText(), new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(await page.locator(".chat-tool").count() > 0);
  assert.equal(await nativeContextContainsMarker(), true);
  const count = (await snapshot()).chat.messages.length;
  evidence.assertions.push("real read-only tool details and response rendered without approval bypass");

  await page.locator('[data-lesson="02"]').click();
  await page.waitForFunction(() => document.querySelector("#copilot-lab-title").textContent === "Lab 02 Conversation");
  await page.locator(".chat-message.assistant").waitFor();
  evidence.requestedTurns++;
  await idle();
  const second = await snapshot();
  assert.notEqual(second.chat.sessionId, first.chat.sessionId);
  await page.locator('[data-lesson="01"]').click();
  await page.waitForFunction(() => document.querySelector("#copilot-lab-title").textContent === "Lab 01 Conversation");
  await idle();
  assert.equal((await snapshot()).chat.sessionId, first.chat.sessionId);
  assert.equal((await snapshot()).chat.messages.length, count);
  assert.equal(await nativeContextContainsMarker(), true, "native context, not just the app transcript, must survive A-B-A");
  evidence.assertions.push("A-B-A resumes the same persisted native session with no repeated kickoff");

  const port = Number(new URL(url).port);
  await app.close();
  app = createWorkshopServer({ workspace });
  url = await app.listen({ port });
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector("#copilot-lab-title").textContent === "Lab 01 Conversation");
  await page.locator("#copilot-connect").click();
  await idle();
  assert.equal((await snapshot()).chat.sessionId, first.chat.sessionId);
  assert.equal((await snapshot()).chat.messages.length, count);
  assert.equal(await nativeContextContainsMarker(), true, "native context must survive process restart");
  evidence.assertions.push("process restart resumes the post-turn native session");

  const confirmation = page.waitForEvent("dialog");
  const deletionResponse = page.waitForResponse((response) => response.url().endsWith("/api/copilot/forget"));
  const deletion = page.locator("#copilot-forget").click();
  const dialog = await confirmation;
  assert.match(dialog.message(), /Permanently forget/);
  await dialog.accept();
  await deletion;
  const receiptResponse = await deletionResponse;
  const receipt = await receiptResponse.json();
  assert.equal(receiptResponse.status(), 200, receipt.error);
  assert.equal(receipt.result.applicationDeleted, true);
  assert.equal(receipt.result.nativeSession.deleted, true);
  assert.equal(receipt.result.nativeSession.sessionId, first.chat.sessionId);
  assert.equal(receipt.result.nativeSession.nativeDeleted, true);
  assert.equal(receipt.result.nativeSession.residualRetention, false);
  await page.waitForFunction((id) => document.querySelector("#copilot-history").value !== id, first.route.conversationId);
  assert.equal((await snapshot()).history.some((entry) => entry.conversationId === first.route.conversationId), false);
  evidence.assertions.push("real post-turn application/native deletion confirmed");
  assert.equal(await page.locator(".permission-card").count(), 0);
  assert.deepEqual(evidence.errors, []);
  await page.screenshot({ path: join(artifacts, "live-app.png"), fullPage: true });
  evidence.result = "passed";
} catch (error) {
  evidence.result = "failed";
  evidence.error = error.stack;
  if (page && !page.isClosed()) await page.screenshot({ path: join(artifacts, "live-failure.png"), fullPage: true });
  throw error;
} finally {
  writeFileSync(join(artifacts, "live-results.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  await browser?.close();
  await app?.close();
  rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log(`Live evidence: ${artifacts}`);
}
