import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createWorkshopServer } from "../../src/server-app.js";
import { createLabBrowserRuntime } from "../helpers/lab-browser-runtime.js";

test("real lab conversation browser lifecycle", { timeout: 180_000 }, async () => {
  const modulePath = process.env.LOOP_TEST_PLAYWRIGHT_MODULE;
  const { chromium } = await import(modulePath ? pathToFileURL(resolve(modulePath)).href : "playwright");
  const root = mkdtempSync(join(tmpdir(), "loop-lab-browser-"));
  const artifacts = resolve(process.env.LOOP_TEST_ARTIFACTS ?? join(".workshop", "tmp", `lab-browser-${Date.now()}`));
  const skills = join(root, ".github", "skills", "fixture-skill");
  const agents = join(root, ".github", "agents");
  mkdirSync(skills, { recursive: true });
  mkdirSync(agents, { recursive: true });
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".workshop/chat/\n.workshop/progress.json\n");
  writeFileSync(join(skills, "SKILL.md"), "---\nname: fixture-skill\ndescription: Bounded fixture guidance\n---\nRead the current lab and give one hint. Do not modify files.\n");
  writeFileSync(join(agents, "loop-verifier.agent.md"), "---\nname: loop-verifier\ndescription: Read-only independent checker\ntools: [read, search]\n---\nRead the lab evidence and report missing checks. Do not modify files.\n");
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", root], { windowsHide: true });
  const runtime = createLabBrowserRuntime(root);
  let app = createWorkshopServer({ workspace: root, chatOptions: { clientFactory: runtime.clientFactory } });
  let browser, page, other;
  const evidence = { lane: "real-lab-fixture", assertions: [], pageErrors: [], network: [] };
  const passed = (name) => evidence.assertions.push(name);
  try {
    let url = await app.listen();
    browser = await chromium.launch({
      headless: process.env.LOOP_TEST_HEADED !== "1",
      ...(process.env.LOOP_TEST_BROWSER ? { executablePath: process.env.LOOP_TEST_BROWSER } : {})
    });
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(15_000);
    page.on("pageerror", (error) => evidence.pageErrors.push(error.message));
    page.on("requestfailed", (request) => {
      if (evidence.network.length < 64) evidence.network.push({ url: request.url(), error: request.failure()?.errorText });
    });
    page.on("response", (response) => {
      if (response.status() >= 400 && evidence.network.length < 64) {
        evidence.network.push({ url: response.url(), status: response.status() });
      }
    });
    async function snapshot(target = page, labId = "01") {
      return target.evaluate(async (id) => {
        const query = new URLSearchParams({ labId: id, clientId: sessionStorage.getItem("loop-client-id") });
        const response = await fetch(`/api/copilot/snapshot?${query}`);
        if (!response.ok) throw new Error(await response.text());
        return response.json();
      }, labId);
    }
    async function navigate(target, id) {
      await target.locator(`[data-lesson="${id}"]`).click();
      await target.waitForFunction((lab) => document.querySelector("#copilot-lab-title").textContent === `Lab ${lab} Conversation`, id);
    }
    async function idle(target = page) {
      await target.waitForFunction(() => document.querySelector("#copilot-status").classList.contains("ready") &&
        !document.querySelector("#copilot-send").disabled);
    }
    async function send(text, target = page) {
      await target.locator("#copilot-input").fill(text);
      await target.locator("#copilot-send").click();
      await target.waitForFunction(() => document.querySelector("#copilot-input").value === "");
      if (text !== "hold this operation") await idle(target);
    }
    function selectedAgentName(snapshot) {
      return typeof snapshot.selectedAgent === "string" ? snapshot.selectedAgent : snapshot.selectedAgent?.name ?? null;
    }
    function messageIds(snapshot) {
      return snapshot.chat.messages.map((message) => message.id);
    }
    function assertNoEmptyOrDuplicateMessages(snapshot) {
      const ids = messageIds(snapshot);
      assert.equal(new Set(ids).size, ids.length, "message ids must remain unique");
      for (const message of snapshot.chat.messages) {
        assert.notEqual(message.content, "", `message ${message.id} must not reload as an empty message`);
      }
    }
    await page.goto(url);
    await navigate(page, "01");
    assert.equal(runtime.calls.length, 0, "passive navigation must not generate a greeting");
    await page.locator(".chat-message.local").waitFor();
    assert.equal(await page.locator(".chat-message.assistant").count(), 0, "local guidance must not be presented as a Copilot response");
    await page.locator("#copilot-connect").click();
    await page.locator(".chat-message.assistant").waitFor();
    await idle();
    const first = await snapshot();
    const firstSession = first.chat.sessionId;
    assert.ok(firstSession);
    assert.equal(runtime.calls.length, 1);
    passed("one explicit-connect greeting with a real session identity");

    for (const width of [320, 375, 600, 768, 1024, 1180, 1181, 1200, 1219, 1220, 1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth <= 1), `lab controls overflow at ${width}`);
      for (const selector of [".lab-chat-controls", "#copilot-history", "#copilot-agent", "#copilot-forget", "#copilot-lease"]) {
        assert.ok(await page.locator(selector).isVisible(), `${selector} hidden at ${width}`);
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    passed("13-width containment with real lab controls visible");

    const input = page.locator("#copilot-input");
    await input.fill("/s");
    await page.waitForFunction(() => document.querySelector("#copilot-commands:not([hidden]) [role='option']"));
    const options = await page.locator("#copilot-commands [role='option'] strong").allTextContents();
    assert.ok(options.length >= 2, "fixture command palette must expose multiple /s completions");
    await input.press("ArrowDown");
    await input.press("Enter");
    assert.equal(await input.inputValue(), options[1]);
    await input.fill("/sk");
    await page.waitForFunction(() => !document.querySelector("#copilot-commands").hidden);
    await input.press("Escape");
    assert.equal(await page.locator("#copilot-commands").getAttribute("hidden"), "");
    assert.equal(await input.inputValue(), "/sk");
    await page.locator("#copilot-input").evaluate((element) => {
      element.value = "/ski";
      element.dispatchEvent(new InputEvent("input", { bubbles: true, data: "/ski" }));
      element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "/ski" }));
      element.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 229, which: 229, isComposing: true
      }));
    });
    assert.equal(await input.inputValue(), "/ski");
    assert.equal(await page.locator("#copilot-commands").getAttribute("hidden"), "");
    await page.locator("#copilot-input").evaluate((element) => {
      element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "/ski" }));
    });
    await page.waitForFunction(() => !document.querySelector("#copilot-commands").hidden);
    await page.locator("#copilot-input").fill("/ski");
    await page.locator("#copilot-input").press("Tab");
    assert.equal(await page.locator("#copilot-input").inputValue(), "/skills");
    assert.equal(runtime.calls.length, 1, "completion must not invoke the model");
    await page.locator("#copilot-input").press("Escape");
    await send("/skills list");
    assert.match(await page.locator("#copilot-messages").textContent(), /fixture-skill/);
    await send("/help");
    await page.locator("#copilot-input").fill("/not-a-command");
    const unknownResponse = page.waitForResponse((response) => response.url().endsWith("/api/copilot/command") &&
      response.request().postData()?.includes("/not-a-command"));
    await page.locator("#copilot-send").click();
    assert.ok((await unknownResponse).status() >= 400);
    await idle();
    assert.equal(await page.locator("#copilot-input").inputValue(), "/not-a-command");
    assert.equal(runtime.calls.length, 1);
    passed("keyboard completion, project discovery and honest unknown command handling");

    await send("/fixture-skill give a bounded hint");
    assert.deepEqual(runtime.commands.at(-1), { name: "fixture-skill", input: "give a bounded hint" });
    assert.equal(runtime.calls.at(-1).request.displayPrompt, "/fixture-skill give a bounded hint");
    assert.match(runtime.calls.at(-1).request.prompt, /Native skill fixture-skill/);
    passed("project skill invocation uses the verified native command adapter");

    await page.locator("#copilot-input").fill("Unsaved Lab A draft");
    await navigate(page, "02");
    await page.locator(".chat-message.assistant").waitFor();
    await idle();
    const second = await snapshot(page, "02");
    assert.notEqual(second.chat.sessionId, firstSession);
    const beforeReturn = runtime.calls.length;
    await navigate(page, "01");
    await idle();
    assert.equal((await snapshot()).chat.sessionId, firstSession);
    assert.equal(await page.locator("#copilot-input").inputValue(), "Unsaved Lab A draft");
    assert.equal(runtime.calls.length, beforeReturn);
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#copilot-lab-title").textContent === "Lab 01 Conversation");
    assert.equal(await page.locator("#copilot-input").inputValue(), "Unsaved Lab A draft");
    passed("A-B-A and reload restore session, transcript, selected lab and draft without another greeting");

    await send("/check");
    const progress = JSON.parse(readFileSync(join(root, ".workshop", "progress.json"), "utf8"));
    assert.equal(progress.latestChecks["01"].ok, false);
    assert.ok(progress.latestChecks["01"].checks.some((check) => !check.ok));
    await send("Help me address this checkpoint failure");
    const last = runtime.calls.at(-1).request;
    assert.equal(last.displayPrompt, "Help me address this checkpoint failure");
    assert.match(last.prompt, /01/);
    assert.ok(progress.latestChecks["01"].checks.filter((check) => !check.ok).some((check) => last.prompt.includes(check.detail)));
    passed("real validation updates canonical evidence and trusted model context without forging learner text");

    const selectionResponse = page.waitForResponse((response) => response.url().endsWith("/api/copilot/command") &&
      response.request().postData()?.includes("/agent loop-verifier"));
    await page.locator("#copilot-agent").selectOption("loop-verifier");
    assert.ok((await selectionResponse).ok());
    await idle();
    const selected = (await snapshot()).selectedAgent;
    assert.equal(selectedAgentName(await snapshot()), "loop-verifier");
    await send("Review the remaining evidence");
    assert.ok(runtime.calls.at(-1).config.customAgents.some((agent) => agent.name === "loop-verifier" && agent.tools.join(",") === "read,search"));
    passed("native project agent selection retains read/search restrictions");

    await app.close();
    app = createWorkshopServer({ workspace: root, chatOptions: { clientFactory: runtime.clientFactory } });
    url = await app.listen();
    await page.goto(url);
    await navigate(page, "01");
    const selectedAfterRestart = await snapshot();
    assert.equal(selectedAfterRestart.chat.sessionId, firstSession);
    assert.equal(selectedAgentName(selectedAfterRestart), "loop-verifier");
    await page.locator("#copilot-connect").click();
    await idle();
    const selectedAfterResume = await snapshot();
    assert.equal(selectedAfterResume.chat.sessionId, firstSession);
    assert.equal(selectedAgentName(selectedAfterResume), "loop-verifier");
    assert.equal(runtime.sessions.get(firstSession).session.selectedAgent, "loop-verifier");
    passed("selected agent persists through app state, native resume and process restart");

    const deliveryText = "Verify one unconfirmed delivery";
    const callsBeforeLoss = runtime.calls.length;
    let firstRequest, firstReceipt, interceptionError, completeInterception;
    const intercepted = new Promise((resolve) => { completeInterception = resolve; });
    await page.route("**/api/copilot/message", async (route) => {
      try {
        firstRequest = JSON.parse(route.request().postData());
        const response = await route.fetch();
        assert.equal(response.status(), 202);
        firstReceipt = await response.json();
      } catch (error) {
        interceptionError = error;
      } finally {
        await route.abort("failed");
        completeInterception();
      }
    }, { times: 1 });
    await page.locator("#copilot-input").fill(deliveryText);
    await page.locator("#copilot-send").click();
    await intercepted;
    if (interceptionError) throw interceptionError;
    await idle();
    assert.equal(await page.locator("#copilot-input").inputValue(), deliveryText);
    const pendingDelivery = await page.evaluate((route) => JSON.parse(localStorage.getItem(
      `loop:${route.workspaceId}:${route.labId}:${route.conversationId}:pending-send`
    )), firstRequest.route);
    assert.equal(pendingDelivery.requestId, firstRequest.requestId);
    const retriedResponse = page.waitForResponse((response) => response.url().endsWith("/api/copilot/message"));
    await send(deliveryText);
    const replay = await (await retriedResponse).json();
    assert.equal(replay.replayed, true);
    assert.equal(replay.operationId, firstReceipt.operationId);
    assert.equal(runtime.calls.length, callsBeforeLoss + 1);
    assert.equal(await page.locator(".chat-message.user .chat-message-content").filter({ hasText: deliveryText }).count(), 1);
    passed("lost POST response preserves draft and request identity; explicit retry never duplicates the model turn");

    const historyCount = (await snapshot()).history.length;
    const staleMessageRoute = (await snapshot()).route;
    await page.locator("#copilot-reset").click();
    await page.waitForFunction(() => document.querySelector("#copilot-history").options.length > 1);
    await idle();
    assert.equal((await snapshot()).history.length, historyCount + 1);
    assert.equal((await snapshot(page, "02")).route.conversationId, second.route.conversationId);
    const staleSendStatus = await page.evaluate(async (route) => {
      const response = await fetch("/api/copilot/message", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Loop-Lab": "browser" },
        body: JSON.stringify({ route, prompt: "stale route must not send", requestId: crypto.randomUUID() })
      });
      return response.status;
    }, staleMessageRoute);
    assert.equal(staleSendStatus, 409);
    const retained = (await snapshot()).chat.messages.length;
    const renderedBeforeClear = await page.locator("#copilot-messages .chat-message:not(.local)").count();
    await send("/clear");
    assert.equal((await snapshot()).chat.messages.length, retained);
    assert.ok(renderedBeforeClear > 0);
    assert.equal(await page.locator("#copilot-messages .chat-message:not(.local)").count(), 0);
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#copilot-lab-title").textContent === "Lab 01 Conversation");
    assert.equal((await snapshot()).chat.messages.length, retained);
    assert.equal(await page.locator("#copilot-messages .chat-message:not(.local)").count(), 0);
    passed("New archives only the current lab, stale routes return 409 and Clear is view-only");

    await send("hold this operation");
    const stale = (await snapshot()).route;
    const held = runtime.heldSession;
    assert.ok(held);
    const permission = held.requestPermission({ kind: "write", fileName: join(root, "fixture.txt"), intention: "Synthetic permission fixture", diff: "+ fixture" });
    await page.locator(".permission-card").waitFor();
    const requestId = await page.locator(".permission-card").getAttribute("data-permission-id");
    other = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    assert.notEqual(page.context(), other.context(), "browser.newPage must create independent browser contexts");
    await other.goto(url);
    await navigate(other, "02");
    assert.equal(await other.locator(".permission-card").count(), 0);
    assert.doesNotMatch(await other.locator("#copilot-messages").textContent(), /Holding the controlled operation/);
    const busyCalls = runtime.calls.length;
    await navigate(other, "03");
    assert.equal(runtime.calls.length, busyCalls);
    await navigate(other, "02");
    other.once("dialog", (dialog) => dialog.accept());
    await other.locator("#copilot-connect").click();
    await idle(other);
    assert.equal((await permission).kind, "reject");
    const rejected = await page.evaluate(async ({ route, requestId }) => {
      const response = await fetch("/api/copilot/permission", {
        method: "POST", headers: { "Content-Type": "application/json", "X-Loop-Lab": "browser" },
        body: JSON.stringify({ route, requestId, decision: "approve" })
      });
      return response.status;
    }, { route: stale, requestId });
    assert.equal(rejected, 409);
    passed("two-tab passive isolation, explicit takeover and stale permission rejection");

    await other.close();
    other = null;
    await app.close();
    app = createWorkshopServer({ workspace: root, chatOptions: { clientFactory: runtime.clientFactory } });
    url = await app.listen();
    await page.goto(url);
    await navigate(page, "01");
    const restored = await snapshot();
    assert.ok(restored.history.length >= 2);
    assert.equal(restored.latestValidation.ok, false);
    await page.locator("#copilot-connect").click();
    await idle();
    const afterRestart = await snapshot();
    assert.equal(afterRestart.chat.sessionId, restored.chat.sessionId);
    passed("process restart preserves conversations, validation context and native session identity");

    await send("generate large fixture history");
    const largeSnapshot = await snapshot();
    const largeReplies = largeSnapshot.chat.messages.filter((message) => message.content.startsWith("Large fixture reply "));
    assert.equal(largeReplies.length, 4);
    assert.ok(Buffer.byteLength(largeReplies.map((message) => message.content).join("")) > 256 * 1024);
    assertNoEmptyOrDuplicateMessages(largeSnapshot);
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#copilot-lab-title").textContent === "Lab 01 Conversation");
    await idle();
    const reloadedLarge = await snapshot();
    assert.deepEqual(messageIds(reloadedLarge), messageIds(largeSnapshot));
    assertNoEmptyOrDuplicateMessages(reloadedLarge);
    passed(">256KiB history reload preserves large replies without empty or duplicate messages");

    const labTwoConversationId = (await snapshot(page, "02")).route.conversationId;
    const deletedConversationId = reloadedLarge.route.conversationId;
    const deletedSessionId = reloadedLarge.chat.sessionId;
    const progressBeforeForget = readFileSync(join(root, ".workshop", "progress.json"), "utf8");
    page.once("dialog", (dialog) => dialog.accept());
    const forgetReceipt = page.waitForResponse((response) => response.url().endsWith("/api/copilot/forget"));
    await page.locator("#copilot-forget").click();
    const forgetPayload = await (await forgetReceipt).json();
    assert.equal(forgetPayload.result.applicationDeleted, true);
    assert.equal(forgetPayload.result.nativeSession.deleted, true);
    assert.equal(forgetPayload.result.nativeSession.sessionId, deletedSessionId);
    assert.ok(runtime.deleted.includes(deletedSessionId));
    await page.waitForFunction((conversationId) => document.querySelector("#copilot-history").value !== conversationId, deletedConversationId);
    assert.equal((await snapshot()).history.some((entry) => entry.conversationId === deletedConversationId), false);
    assert.equal((await snapshot(page, "02")).route.conversationId, labTwoConversationId);
    assert.equal(readFileSync(join(root, ".workshop", "progress.json"), "utf8"), progressBeforeForget);
    passed("Forget deletes the selected application/native fixture session without deleting other lab history or progress");

    assert.deepEqual(evidence.pageErrors, []);
    evidence.result = "passed";
  } catch (error) {
    evidence.result = "failed";
    evidence.error = error.stack;
    if (page && !page.isClosed()) await page.screenshot({ path: join(artifacts, "lab-failure.png"), fullPage: true });
    throw error;
  } finally {
    writeFileSync(join(artifacts, "lab-results.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    await browser?.close();
    runtime.close();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
