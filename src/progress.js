import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const progressPath = resolve(".workshop/progress.json");

export function loadProgress() {
  if (!existsSync(progressPath)) {
    return { completed: {}, attempts: {}, evidence: {} };
  }
  try {
    const progress = JSON.parse(readFileSync(progressPath, "utf8"));
    return {
      completed: progress.completed ?? {},
      attempts: progress.attempts ?? {},
      evidence: progress.evidence ?? {}
    };
  } catch {
    return { completed: {}, attempts: {}, evidence: {} };
  }
}

export function saveProgress(progress) {
  mkdirSync(dirname(progressPath), { recursive: true });
  writeFileSync(progressPath, `${JSON.stringify(progress, null, 2)}\n`);
}

export function recordCheckpoint(id, ok) {
  const progress = loadProgress();
  progress.attempts[id] = (progress.attempts[id] ?? 0) + 1;
  if (ok) {
    progress.completed[id] = new Date().toISOString();
    if (id === "04") {
      progress.evidence.lab04Worktree = progress.completed[id];
    }
  } else {
    delete progress.completed[id];
  }
  saveProgress(progress);
  return progress;
}
