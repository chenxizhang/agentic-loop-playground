import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CopilotChatService } from "../../src/copilot-chat.js";
import { createWorkshopServer } from "../../src/server-app.js";
import { FakeCopilotClient } from "../helpers/fake-copilot.js";
import { createStreamProxy } from "../helpers/stream-proxy.js";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const output = "0123456789abcdef".repeat(4096);
const artifacts = resolve(process.env.LOOP_TEST_ARTIFACTS ?? join(".workshop", "tmp", `browser-${Date.now()}`));
const evidence = { lane: "direct-fixture", seed: 431, expectedHash: hash(output), runs: [] };
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function loadBrowser() {
  const modulePath = process.env.LOOP_TEST_PLAYWRIGHT_MODULE;
  try {
    return await import(modulePath ? pathToFileURL(resolve(modulePath)).href : "playwright");
  } catch (error) {
    throw new Error("Browser prerequisite unavailable. Set LOOP_TEST_PLAYWRIGHT_MODULE to an existing approved Playwright entry; this harness never installs packages.", { cause: error });
  }
}

async function emitAnswer(session, prompt) {
  const messageId = `answer-${session.sent.length}`;
  if (prompt === "tool-only") {
    session.emit("assistant.message", { messageId, content: "" });
    session.emit("assistant.message_delta", { messageId: `${messageId}-space`, deltaContent: " \n " });
    session.emit("assistant.message", { messageId: `${messageId}-space`, content: " \n " });
    session.emit("tool.execution_start", { toolCallId: messageId, toolName: "read", arguments: { path: `src/${"long-path-".repeat(450)}.js` } });
    session.emit("tool.execution_complete", { toolCallId: messageId, success: true, result: { content: "Readable result", value: 42 } });
  } else if (prompt === "burst" || prompt === "paced") {
    for (let index = 0; index < 4096; index++) {
      if (prompt === "paced" && index % 8 === 0) await wait(30);
      session.emit("assistant.message_delta", { messageId, deltaContent: "0123456789abcdef" });
    }
    session.emit("assistant.message", { messageId, content: output });
  } else if (prompt === "format") {
    session.emit("assistant.message", { messageId, content: `# Safe formatted output\n\n${"X".repeat(4096)}\n\n\`\`\`text\n${"C".repeat(4096)}\n\`\`\`\n\n| Name | Value |\n| --- | --- |\n| fixture | ${"T".repeat(4096)} |\n\n[Unsafe](javascript:alert(1))` });
  } else {
    session.emit("assistant.message", { messageId, content: `Guidance for this lab: ${prompt}` });
  }
  session.emit("session.idle", {});
}

test("actual application browser regression harness", { timeout: 300_000 }, async (t) => {
  mkdirSync(artifacts, { recursive: true });
  const { chromium } = await loadBrowser();
  const root = mkdtempSync(join(tmpdir(), "loop-browser-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, ".gitignore"), ".workshop/chat/\n.workshop/progress.json\n");
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", workspace], { windowsHide: true });
  const jobs = new Set();
  const client = new FakeCopilotClient({ onSend: (session, request) => {
    const job = new Promise((resolve, reject) => {
      setImmediate(() => emitAnswer(session, request.prompt).then(resolve, reject));
    });
    jobs.add(job);
    job.finally(() => jobs.delete(job));
  } });
  const chat = new CopilotChatService(workspace, { clientFactory: () => client });
  const app = createWorkshopServer({ workspace, chat });
  let browser;
  let page;
  let proxy;
  const errors = [];
  try {
    let url = await app.listen();
    if (process.env.LOOP_TEST_PROFILE === "fault-proxy") {
      proxy = await createStreamProxy(url, { fragment: true, holdMs: 1000 });
      url = proxy.url;
      evidence.lane = "fault-proxy";
    }
    browser = await chromium.launch({
      headless: process.env.LOOP_TEST_HEADED !== "1",
      ...(process.env.LOOP_TEST_BROWSER ? { executablePath: process.env.LOOP_TEST_BROWSER } : {})
    });
    evidence.browser = browser.version();
    evidence.runtime = process.version;
    evidence.platform = process.platform;
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.loopEvidence = { blanks: 0, added: 0, removed: 0, paints: [], longTasks: [], inputs: [] };
      new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          window.loopEvidence.added += mutation.addedNodes.length;
          window.loopEvidence.removed += mutation.removedNodes.length;
        }
        const messages = document.querySelectorAll(".chat-message.assistant .chat-message-content");
        if ([...messages].some((message) => !message.textContent.trim())) window.loopEvidence.blanks++;
      }).observe(document, { subtree: true, childList: true, characterData: true });
      document.addEventListener("loop:chat-paint", () => window.loopEvidence.paints.push(performance.now()));
      document.addEventListener("keydown", () => {
        const start = performance.now();
        requestAnimationFrame(() => window.loopEvidence.inputs.push(performance.now() - start));
      });
      if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
        new PerformanceObserver((list) => {
          window.loopEvidence.longTasks.push(...list.getEntries().map((entry) => entry.duration));
        }).observe({ type: "longtask" });
      }
    });
    await page.goto(url);
    await page.locator("[data-lesson='01']").waitFor();
    await page.locator("#copilot-connect").click();
    await page.waitForFunction(() => document.querySelector("#copilot-status").textContent.includes("Connected"));

    async function send(prompt) {
      await page.locator("#copilot-input").fill(prompt);
      await page.locator("#copilot-send").click();
      await page.waitForFunction(() => !document.querySelector("#copilot-send").disabled && !document.querySelector("#copilot-input").value);
      await page.waitForTimeout(50);
    }

    async function resetView() {
      await page.locator("#copilot-reset").click();
      await page.waitForFunction(() => !document.querySelectorAll(".chat-message").length && !document.querySelector("#copilot-send").disabled);
    }

    async function check(name, action) {
      await t.test(name, async () => {
        try {
          await action();
        } catch (error) {
          evidence.result = "failed";
          evidence.failures ??= [];
          evidence.failures.push({
            name,
            error: error.stack,
            state: await page.evaluate(() => ({
              status: document.querySelector("#copilot-status").textContent,
              toolStatus: document.querySelector("#copilot-tool-status").textContent,
              sendDisabled: document.querySelector("#copilot-send").disabled,
              overflow: [...document.querySelectorAll("body *")].map((element) => ({
                tag: element.tagName, id: element.id, className: element.className,
                right: element.getBoundingClientRect().right, width: element.getBoundingClientRect().width
              })).filter((item) => item.right > innerWidth + 1).slice(0, 20)
            }))
          });
          await page.screenshot({ path: join(artifacts, `failure-${evidence.failures.length}.png`), fullPage: true });
          throw error;
        }
      });
    }

    await check("tool-only events never create empty bubbles and detail is readable", async () => {
      await send("tool-only");
      assert.equal(await page.locator(".chat-message.assistant").count(), 0);
      await page.locator(".chat-tool summary").click();
      await page.getByText("Readable result", { exact: false }).waitFor();
      assert.equal(await page.evaluate(() => window.loopEvidence.blanks), 0);
    });

    await check("layout contains ordinary, code, table and tool content at breakpoint edges", async () => {
      await send("format");
      for (const width of [320, 375, 600, 768, 1024, 1180, 1181, 1200, 1219, 1220, 1280, 1440, 1920]) {
        await page.setViewportSize({ width, height: 900 });
        const dimensions = await page.evaluate(() => ({
          document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          body: document.body.scrollWidth - document.body.clientWidth,
          input: document.querySelector("#copilot-input").getBoundingClientRect().width
        }));
        assert.ok(dimensions.document <= 1, `document overflow at ${width}: ${JSON.stringify(dimensions)}`);
        assert.ok(dimensions.body <= 1, `body overflow at ${width}: ${JSON.stringify(dimensions)}`);
        assert.ok(dimensions.input > 100, `composer clipped at ${width}`);
      }
      assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.screenshot({ path: join(artifacts, "long-content.png"), fullPage: true });
    });

    await check("warm-up and three measured 64KiB bursts are exact and bounded", async () => {
      for (let run = -1; run < 3; run++) {
        await resetView();
        await page.evaluate(() => {
          window.loopEvidence.added = 0;
          window.loopEvidence.removed = 0;
          window.loopEvidence.paints = [];
          window.loopEvidence.longTasks = [];
        });
        const start = performance.now();
        await send("burst");
        const content = await page.locator(".chat-message.assistant .chat-message-content").last().textContent();
        const metrics = await page.evaluate(() => ({ ...window.loopEvidence }));
        const actualHash = hash(content);
        assert.equal(actualHash, evidence.expectedHash);
        assert.equal(metrics.blanks, 0);
        assert.ok(metrics.added + metrics.removed < 500, `excess DOM mutation: ${metrics.added + metrics.removed}`);
        for (const time of metrics.paints) {
          assert.ok(metrics.paints.filter((sample) => sample >= time && sample < time + 1000).length <= 65);
        }
        assert.ok(Math.max(0, ...metrics.longTasks) <= 200, `long task exceeded 200ms: ${metrics.longTasks}`);
        if (run >= 0) evidence.runs.push({ run, actualHash, elapsedMs: performance.now() - start, ...metrics });
      }
    });

    await check("typing stays responsive through three paced 15-second streams", async () => {
      const text = "abcdefghij".repeat(10);
      const measured = [];
      for (let run = -1; run < 3; run++) {
        await resetView();
        await page.locator("#copilot-input").fill("paced");
        await page.locator("#copilot-send").click();
        await page.waitForFunction(() => !document.querySelector("#copilot-input").value);
        await page.evaluate(() => {
          window.loopEvidence.inputs = [];
          window.loopEvidence.longTasks = [];
          window.loopEvidence.paints = [];
        });
        await page.locator("#copilot-input").pressSequentially(text, { delay: 100 });
        await page.waitForFunction(() => !document.querySelector("#copilot-send").disabled, undefined, { timeout: 30_000 });
        assert.equal(await page.locator("#copilot-input").inputValue(), text);
        const metrics = await page.evaluate(() => ({ ...window.loopEvidence }));
        const samples = metrics.inputs.toSorted((left, right) => left - right);
        assert.ok(samples.length >= 100, `insufficient input samples: ${samples.length}`);
        const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
        const maximum = samples.at(-1);
        assert.ok(p95 <= 100, `input-to-paint p95: ${p95}ms`);
        assert.ok(maximum <= 250, `input-to-paint max: ${maximum}ms`);
        assert.ok(Math.max(0, ...metrics.longTasks) <= 200);
        assert.ok(metrics.longTasks.reduce((sum, value) => sum + value, 0) < 1500);
        for (const time of metrics.paints) {
          assert.ok(metrics.paints.filter((sample) => sample >= time && sample < time + 1000).length <= 65);
        }
        const content = await page.locator(".chat-message.assistant .chat-message-content").last().textContent();
        assert.equal(hash(content), evidence.expectedHash);
        if (run >= 0) measured.push({ run, sampleCount: samples.length, p50: samples[Math.floor(samples.length / 2)], p95, maximum, ...metrics });
      }
      evidence.responsiveness = { cadenceMs: 100, samplesPerRun: 100, runs: measured };
      await page.locator("#copilot-input").fill("");
    });

    await check("manual scroll position is not stolen and jump-to-content remains operable", async () => {
      await page.locator("#copilot-messages").evaluate((element) => { element.scrollTop = 20; });
      await page.waitForTimeout(50);
      const before = await page.locator("#copilot-messages").evaluate((element) => element.scrollTop);
      await send("Another small update");
      const after = await page.locator("#copilot-messages").evaluate((element) => element.scrollTop);
      assert.ok(Math.abs(before - after) <= 2, `reader moved ${after - before}px`);
      await page.locator("#copilot-new-content").click();
      const gap = await page.locator("#copilot-messages").evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
      assert.ok(gap <= 48);
    });

    await check("reloading restores the actual service snapshot without duplicates", async () => {
      const count = await page.locator(".chat-message").count();
      await page.reload();
      await page.waitForFunction((expected) => document.querySelectorAll(".chat-message").length === expected, count);
      assert.equal(await page.locator(".chat-message").count(), count);
      assert.equal(await page.evaluate(() => window.loopEvidence.blanks), 0);
    });
    assert.deepEqual(errors, [], "browser page errors");
    evidence.result ??= "passed";
  } catch (error) {
    evidence.result = "failed";
    evidence.error = error.stack;
    if (page && !page.isClosed()) await page.screenshot({ path: join(artifacts, "failure.png"), fullPage: true });
    throw error;
  } finally {
    evidence.pageErrors = errors;
    if (proxy) evidence.proxy = proxy.metrics;
    mkdirSync(dirname(join(artifacts, "results.json")), { recursive: true });
    writeFileSync(join(artifacts, "results.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    await browser?.close();
    await proxy?.close();
    await Promise.all(jobs);
    await app.close();
    rmSync(root, { recursive: true, force: true });
    console.log(`Browser evidence: ${artifacts}`);
  }
});
