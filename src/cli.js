#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import process from "node:process";
import { getLesson, lessons } from "./curriculum.js";
import { doctorChecks, passed, validateLesson } from "./validators.js";
import { loadProgress, ProgressStoreError, recordCheckpoint } from "./progress.js";

function loadCurrentProgress() {
  return loadProgress(process.cwd(), { strict: true });
}

function printHeader() {
  console.log("\nCOPILOT LOOP LAB");
  console.log("Learn by operating a real GitHub Copilot CLI engineering loop.\n");
}

function printLesson(lesson) {
  console.log(`\n[${lesson.id}] ${lesson.title}`);
  console.log(`${lesson.component} | ${lesson.objective}\n`);
  console.log(`SCENARIO\n${lesson.scenario}\n`);
  console.log("DO");
  lesson.steps.forEach((step, index) => console.log(`${index + 1}. ${step}`));
  console.log(`\nCOPY INTO COPILOT CLI\n${lesson.prompt}\n`);
  console.log("PASS EVIDENCE");
  lesson.evidence.forEach((item) => console.log(`- ${item}`));
  console.log(`\nCHECKPOINT\n${lesson.verification}`);
  console.log(`\nREFLECT\n${lesson.reflection}\n`);
}

function printChecks(checks) {
  for (const check of checks) {
    console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}`);
  }
}

function runCheck(id, update = true) {
  const lesson = getLesson(id);
  if (!lesson) {
    console.error(`Unknown lesson: ${id}`);
    process.exitCode = 1;
    return false;
  }
  const currentProgress = loadCurrentProgress();
  const checks = validateLesson(lesson.id, {
    recordedWorktreeEvidence: Boolean(currentProgress.evidence?.lab04Worktree)
  });
  console.log(`\nCheckpoint ${lesson.id}: ${lesson.title}`);
  printChecks(checks);
  const ok = passed(checks);
  if (update) {
    recordCheckpoint(lesson.id, ok, { source: "cli", checks });
  }
  console.log(ok ? "\nCheckpoint passed." : "\nCheckpoint not passed. Use the evidence above for the next loop iteration.");
  return ok;
}

function printStatus() {
  const progress = loadCurrentProgress();
  console.log("\nLearning progress\n");
  for (const lesson of lessons) {
    const done = Boolean(progress.completed[lesson.id]);
    const attempts = progress.attempts[lesson.id] ?? 0;
    console.log(`${done ? "[x]" : "[ ]"} ${lesson.id} ${lesson.title} (${attempts} check attempt${attempts === 1 ? "" : "s"})`);
  }
  const completed = Object.keys(progress.completed).length;
  console.log(`\n${completed}/${lessons.length} labs completed.`);
}

function nextLesson() {
  const progress = loadCurrentProgress();
  return lessons.find((lesson) => !progress.completed[lesson.id]) ?? lessons.at(-1);
}

function grade() {
  const progress = loadCurrentProgress();
  let score = 0;
  console.log("\nFinal assessment\n");
  for (const lesson of lessons) {
    const checks = validateLesson(lesson.id, {
      recordedWorktreeEvidence: Boolean(progress.evidence?.lab04Worktree)
    });
    const ok = passed(checks);
    if (ok) {
      score += 10;
    }
    recordCheckpoint(lesson.id, ok, { source: "grade", checks });
    console.log(`${ok ? "PASS" : "FAIL"}  ${lesson.id} ${lesson.title}`);
    if (!ok) {
      printChecks(checks.filter((check) => !check.ok));
    }
  }
  const percentage = Math.round((score / (lessons.length * 10)) * 100);
  console.log(`\nScore: ${score}/${lessons.length * 10} (${percentage}%)`);
  console.log(percentage === 100
    ? "Result: Loop Operator certification evidence complete."
    : "Result: Continue the loop on failed checkpoints.");
  if (percentage < 100) {
    process.exitCode = 1;
  }
}

async function interactive() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  printHeader();
  try {
    while (true) {
      printStatus();
      const suggestion = nextLesson();
      console.log(`\nSuggested next lab: ${suggestion.id} ${suggestion.title}`);
      const answer = (await rl.question("\nChoose: [n]ext lesson, [c]heck, [g]rade, [q]uit: ")).trim().toLowerCase();
      if (answer === "q") break;
      if (answer === "n" || answer === "") {
        printLesson(suggestion);
        await rl.question("Press Enter to return to the dashboard...");
      } else if (answer === "c") {
        const id = await rl.question("Lesson ID: ");
        runCheck(id);
        await rl.question("Press Enter to continue...");
      } else if (answer === "g") {
        grade();
        await rl.question("Press Enter to continue...");
      }
    }
  } finally {
    rl.close();
  }
}

try {
  const [command, argument] = process.argv.slice(2);

  switch (command) {
    case undefined:
      await interactive();
      break;
    case "lesson": {
      const lesson = getLesson(argument ?? nextLesson().id);
      if (!lesson) {
        console.error(`Unknown lesson: ${argument}`);
        process.exitCode = 1;
      } else {
        printLesson(lesson);
      }
      break;
    }
    case "next":
      printLesson(nextLesson());
      break;
    case "check":
      if (argument) {
        if (!runCheck(argument)) {
          process.exitCode = 1;
        }
      } else {
        if (!runCheck(nextLesson().id)) {
          process.exitCode = 1;
        }
      }
      break;
    case "doctor":
      printHeader();
      {
        const checks = doctorChecks();
        printChecks(checks);
        if (!passed(checks)) {
          process.exitCode = 1;
        }
      }
      break;
    case "status":
      printStatus();
      break;
    case "grade":
      grade();
      break;
    default:
      console.error("Usage: loop-lab [doctor|status|next|lesson ID|check ID|grade]");
      process.exitCode = 1;
  }
} catch (error) {
  if (error instanceof ProgressStoreError) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
