import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubFeedbackService, formatFeedbackIssue } from "../src/github-feedback.js";
import { applicationMetadata } from "../src/app-metadata.js";

function fixtureRunner(calls, responses = []) {
  return (command, args, options, callback) => {
    calls.push({ command, args, options });
    const response = responses.shift() ?? { stdout: "" };
    callback(response.error ?? null, response.stdout ?? "", response.stderr ?? "");
  };
}

test("stars the fixed project repository through gh api", async () => {
  const calls = [];
  const service = new GitHubFeedbackService({ runner: fixtureRunner(calls) });
  const receipt = await service.star();
  assert.equal(receipt.starred, true);
  assert.equal(receipt.repository, applicationMetadata.feedbackRepository);
  assert.deepEqual(calls.map((call) => call.args), [
    ["api", "--method", "PUT", "/user/starred/chenxizhang/agentic-loop-playground"]
  ]);
  assert.equal(calls[0].options.timeout, 20_000);
});

test("formats feedback issues with app version and score context", async () => {
  const formatted = formatFeedbackIssue({
    category: "success",
    title: "Great lab",
    feedback: "The workshop helped me close the loop.",
    context: { labId: "08", score: 90, maximum: 90 }
  });
  assert.match(formatted.title, /^\[Playground feedback\] Great lab$/);
  assert.match(formatted.body, /App version: 1\.0\.1/);
  assert.match(formatted.body, /Current lab: 08/);
  assert.match(formatted.body, /Final score: 90 \/ 90/);
});

test("creates one GitHub issue per submission id and replays the receipt", async () => {
  const calls = [];
  const issue = { number: 123, title: "[Playground feedback] Useful", html_url: "https://github.com/chenxizhang/agentic-loop-playground/issues/123", state: "open", body: "body" };
  const service = new GitHubFeedbackService({ runner: fixtureRunner(calls, [{ stdout: JSON.stringify(issue) }]) });
  const input = {
    submissionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    category: "idea",
    title: "Useful",
    feedback: "Please add more examples.",
    context: { labId: "03" }
  };
  const first = await service.createIssue(input);
  const second = await service.createIssue(input);
  assert.equal(first.issue.number, 123);
  assert.equal(second.replayed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], "api");
  assert.ok(calls[0].args.includes("repos/chenxizhang/agentic-loop-playground/issues"));
  assert.ok(calls[0].args.some((arg) => arg.includes("App version: 1.0.1")));
});

test("rejects invalid feedback before running gh", async () => {
  const calls = [];
  const service = new GitHubFeedbackService({ runner: fixtureRunner(calls) });
  await assert.rejects(() => service.createIssue({
    submissionId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    title: "   ",
    feedback: "ok"
  }), { code: "INVALID_TITLE", statusCode: 400 });
  assert.equal(calls.length, 0);
});

test("detects enterprise-managed user restrictions and switches to fallback metadata", async () => {
  const calls = [];
  const workspace = mkdtempSync(join(tmpdir(), "loop-feedback-"));
  try {
  const error = Object.assign(new Error("Command failed"), {});
  const service = new GitHubFeedbackService({
    workspace,
    runner: fixtureRunner(calls, [{
      error,
      stderr: "gh: Unauthorized: As an Enterprise Managed User, you cannot access this content (HTTP 403)"
    }])
  });
  service.currentLogin = "managed";
  await assert.rejects(() => service.star(), { code: "GH_EMU_RESTRICTED", statusCode: 403 });
  const metadata = service.metadata();
  assert.equal(metadata.directRestricted, true);
  assert.equal(metadata.issueUrl, "https://github.com/chenxizhang/agentic-loop-playground/issues/new");
  assert.equal((await service.createIssue({
    submissionId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
    title: "Manual path",
    feedback: "Fallback please"
  })).directRestricted, true);
  assert.equal(calls.length, 1);
  const restarted = new GitHubFeedbackService({ workspace, runner: fixtureRunner(calls) });
  restarted.currentLogin = "managed";
  assert.equal((await restarted.star()).directRestricted, true);
  assert.equal(calls.length, 1);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("reports the current gh account when available", async () => {
  const calls = [];
  const service = new GitHubFeedbackService({
    runner: fixtureRunner(calls, [{ stdout: JSON.stringify({ login: "octocat", type: "User" }) }])
  });
  const account = await service.account();
  assert.equal(account.authenticated, true);
  assert.equal(account.login, "octocat");
  assert.equal(account.canUseDirectGithubFeedback, true);
  assert.deepEqual(calls.map((call) => call.args), [["api", "user"]]);
});
