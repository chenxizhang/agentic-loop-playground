import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotChatService, isSafeWorkspacePath } from "../src/copilot-chat.js";
import { getLesson, lessons } from "../src/curriculum.js";
import { passed } from "../src/validators.js";

test("curriculum has sequential unique lesson IDs", () => {
  assert.deepEqual(lessons.map((lesson) => lesson.id), ["00", "01", "02", "03", "04", "05", "06", "07", "08"]);
  assert.equal(new Set(lessons.map((lesson) => lesson.id)).size, lessons.length);
});

test("every lesson is an actionable checkpoint", () => {
  for (const lesson of lessons) {
    assert.ok(lesson.steps.length >= 4, `${lesson.id} needs practical steps`);
    assert.match(lesson.prompt, /\S/);
    assert.ok(lesson.evidence.length >= 2, `${lesson.id} needs pass evidence`);
    assert.match(lesson.verification, /check|grade|score/i);
    assert.match(lesson.reflection, /\?$/);
  }
});

test("lesson lookup normalizes numeric IDs", () => {
  assert.equal(getLesson("1")?.id, "01");
  assert.equal(getLesson("08")?.id, "08");
  assert.equal(getLesson("99"), undefined);
});

test("required checks determine pass state", () => {
  assert.equal(passed([{ ok: true, required: true }]), true);
  assert.equal(passed([{ ok: false, required: false }]), true);
  assert.equal(passed([{ ok: false, required: true }]), false);
});

test("workspace read boundary follows real paths", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-read-boundary-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  mkdirSync(workspace);
  mkdirSync(outside);
  writeFileSync(join(workspace, "inside.txt"), "inside");
  writeFileSync(join(outside, "outside.txt"), "outside");
  symlinkSync(outside, join(workspace, "outside-link"), "junction");

  try {
    assert.equal(isSafeWorkspacePath(workspace, "inside.txt"), true);
    assert.equal(isSafeWorkspacePath(workspace, "missing.txt"), false);
    assert.equal(isSafeWorkspacePath(workspace, join("outside-link", "outside.txt")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pending permissions replay to reconnecting listeners", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "loop-permission-replay-"));
  const chat = new CopilotChatService(workspace);
  const decision = chat.handlePermissionRequest({ kind: "write", path: "practice/example.js" });
  const events = [];
  const unsubscribe = chat.subscribe((event) => events.push(event));
  const permission = events.find((event) => event.type === "permission.requested");

  try {
    assert.ok(permission);
    chat.resolvePermission(permission.data.requestId, "reject", "Test rejection");
    assert.deepEqual(await decision, { kind: "reject", feedback: "Test rejection" });
  } finally {
    unsubscribe();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("browser interface uses English and keeps workspace context in Copilot", () => {
  const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const curriculum = readFileSync(new URL("../src/curriculum.js", import.meta.url), "utf8");
  const copilotChat = readFileSync(new URL("../src/copilot-chat.js", import.meta.url), "utf8");

  for (const source of [index, app, curriculum, copilotChat]) {
    assert.doesNotMatch(source, /\p{Script=Han}/u);
  }
  assert.doesNotMatch(index, /workspace-guide/);
  assert.match(index, /class="copilot-workspace"/);
  assert.match(index, /id="workspace-path"/);
});

test("application uses a package slug and a polished display brand", () => {
  const packageMetadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const packageLock = readFileSync(new URL("../package-lock.json", import.meta.url), "utf8");
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const templateMarker = readFileSync(new URL("../playground-template/.loop-playground.json", import.meta.url), "utf8");
  const retiredBrands = /agentic-loop-engineering-playground|Agentic Loop Engineering Playground|Copilot Loop Lab/;

  assert.equal(packageMetadata.name, "agentic-loop-playground");
  assert.equal(packageMetadata.bin["agentic-loop-playground"], "src/launcher.js");
  assert.match(packageLock, /agentic-loop-playground/);
  for (const source of [readme, index, templateMarker]) {
    assert.doesNotMatch(source, retiredBrands);
    assert.match(source, /Agentic Loop Playground/);
  }
  assert.match(index, /<title>Agentic Loop Playground<\/title>/);
  assert.doesNotMatch(index, />agentic-loop-playground</);
});
