import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { lessons } from "../../src/curriculum.js";
import { createWorkshopServer } from "../../src/server-app.js";

async function loadBrowser() {
  const modulePath = process.env.LOOP_TEST_PLAYWRIGHT_MODULE;
  try {
    return await import(modulePath ? pathToFileURL(resolve(modulePath)).href : "playwright");
  } catch (error) {
    throw new Error("Browser prerequisite unavailable. Set LOOP_TEST_PLAYWRIGHT_MODULE to an existing approved Playwright entry; this harness never installs packages.", { cause: error });
  }
}

test("feedback actions star, create issues, and encourage final score sharing", { timeout: 60_000 }, async () => {
  const { chromium } = await loadBrowser();
  const workspace = mkdtempSync(join(tmpdir(), "loop-feedback-browser-"));
  mkdirSync(join(workspace, ".github", "skills"), { recursive: true });
  mkdirSync(join(workspace, ".github", "agents"), { recursive: true });
  writeFileSync(join(workspace, ".gitignore"), ".workshop/chat/\n.workshop/progress.json\n");
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", workspace], { windowsHide: true });
  const calls = [];
  const feedback = {
    metadata: () => ({ repository: "chenxizhang/agentic-loop-playground", repositoryUrl: "https://github.com/chenxizhang/agentic-loop-playground", version: "1.0.1" }),
    account: async () => ({ authenticated: true, login: "fixture", canUseDirectGithubFeedback: true, repositoryUrl: "https://github.com/chenxizhang/agentic-loop-playground", issueUrl: "https://github.com/chenxizhang/agentic-loop-playground/issues/new", version: "1.0.1" }),
    star: async () => {
      calls.push({ kind: "star" });
      return { ok: true, starred: true };
    },
    createIssue: async (body) => {
      calls.push({ kind: "issue", body });
      return {
        ok: true,
        issue: {
          number: 42,
          title: `[Playground feedback] ${body.title}`,
          url: "https://github.com/chenxizhang/agentic-loop-playground/issues/42",
          state: "open",
          body: body.feedback
        }
      };
    }
  };
  const app = createWorkshopServer({
    workspace,
    feedback,
    async runValidation(root, kind, id) {
      if (kind === "grade") {
        return {
          ok: true,
          score: lessons.length * 10,
          maximum: lessons.length * 10,
          results: lessons.map((lesson) => ({ ...lesson, ok: true, checks: [] }))
        };
      }
      return { id, ok: true, checks: [] };
    }
  });

  test("enterprise-managed accounts are guided to GitHub instead of direct writes", { timeout: 60_000 }, async () => {
    const { chromium } = await loadBrowser();
    const workspace = mkdtempSync(join(tmpdir(), "loop-feedback-emu-browser-"));
    mkdirSync(join(workspace, ".github", "skills"), { recursive: true });
    mkdirSync(join(workspace, ".github", "agents"), { recursive: true });
    writeFileSync(join(workspace, ".gitignore"), ".workshop/chat/\n.workshop/progress.json\n");
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", workspace], { windowsHide: true });
    const calls = [];
    const fallback = {
      repositoryUrl: "https://github.com/chenxizhang/agentic-loop-playground",
      issueUrl: "https://github.com/chenxizhang/agentic-loop-playground/issues/new"
    };
    const feedback = {
      metadata: () => ({ repository: "chenxizhang/agentic-loop-playground", version: "1.0.1", directRestricted: true, restriction: { code: "GH_EMU_RESTRICTED" }, ...fallback }),
      account: async () => ({ authenticated: true, login: "managed", canUseDirectGithubFeedback: false, directRestricted: true, restriction: { code: "GH_EMU_RESTRICTED" }, ...fallback }),
      star: async () => {
        calls.push("star");
        return { ok: false, directRestricted: true, ...fallback };
      },
      createIssue: async () => {
        calls.push("issue");
        return { ok: false, directRestricted: true, ...fallback };
      }
    };
    const app = createWorkshopServer({ workspace, feedback });
    let browser;
    try {
      const url = await app.listen();
      browser = await chromium.launch({
        headless: process.env.LOOP_TEST_HEADED !== "1",
        ...(process.env.LOOP_TEST_BROWSER ? { executablePath: process.env.LOOP_TEST_BROWSER } : {})
      });
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(url);
      await page.locator("[data-lesson='00']").waitFor();
      await page.waitForFunction(() => document.querySelector("#star-button").textContent === "Open GitHub");
      const starPopup = page.waitForEvent("popup");
      await page.locator("#star-button").click();
      assert.equal((await starPopup).url(), fallback.repositoryUrl);
      const issuePopup = page.waitForEvent("popup");
      await page.locator("#feedback-button").click();
      assert.equal((await issuePopup).url(), fallback.issueUrl);
      assert.deepEqual(calls, []);
    } finally {
      await browser?.close();
      await app.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
  let browser;
  try {
    const url = await app.listen();
    browser = await chromium.launch({
      headless: process.env.LOOP_TEST_HEADED !== "1",
      ...(process.env.LOOP_TEST_BROWSER ? { executablePath: process.env.LOOP_TEST_BROWSER } : {})
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(url);
    await page.locator("[data-lesson='00']").waitFor();
    const initialUrl = page.url();

    await page.locator("#star-button").click();
    await page.waitForFunction(() => document.querySelector("#star-button").textContent === "Starred");
    assert.equal(page.url(), initialUrl);

    await page.locator("#feedback-button").click();
    await page.locator("#feedback-title").fill("Helpful workshop");
    await page.locator("#feedback-text").fill("The loop structure helped me validate each step.");
    await page.locator("#feedback-submit").click();
    await page.locator(".issue-created").waitFor();
    assert.match(await page.locator(".issue-created").textContent(), /issue #42/i);
    assert.equal(page.url(), initialUrl);

    await page.locator("#grade-button").click();
    await page.locator(".feedback-nudge").waitFor();
    assert.match(await page.locator(".feedback-nudge").textContent(), /90\/90/);
    await page.locator("[data-final-feedback]").click();
    await page.locator("#feedback-dialog[open]").waitFor();
    assert.match(await page.locator("#feedback-text").inputValue(), /I scored 90 \/ 90/);
    assert.deepEqual(calls.map((call) => call.kind), ["star", "issue"]);
    assert.equal(calls[1].body.context.labId, "00");
  } finally {
    await browser?.close();
    await app.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});
