import { getLesson, lessons } from "./curriculum.js";
import { loadProgress } from "./progress.js";
import { doctorChecks, passed, validateLesson } from "./validators.js";

try {
  const [kind, id] = process.argv.slice(2);
  const progress = loadProgress(process.cwd(), { strict: true });
  function check(lesson) {
    const checks = validateLesson(lesson.id, {
      recordedWorktreeEvidence: Boolean(progress.evidence?.lab04Worktree)
    });
    return { id: lesson.id, title: lesson.title, ok: passed(checks), checks };
  }
  let result;
  if (kind === "doctor") {
    const checks = doctorChecks();
    result = { ok: passed(checks), checks };
  } else if (kind === "check" && getLesson(id)) {
    result = check(getLesson(id));
  } else if (kind === "grade") {
    const results = lessons.map(check);
    result = { results, score: results.filter((item) => item.ok).length * 10, maximum: lessons.length * 10 };
  } else {
    throw new Error("Unknown validation operation or lesson.");
  }
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
