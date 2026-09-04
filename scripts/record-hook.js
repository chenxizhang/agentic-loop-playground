import { appendFileSync, mkdirSync, readFileSync } from "node:fs";

let input = "";
try {
  input = readFileSync(0, "utf8");
} catch {
  input = "{}";
}

let payload;
try {
  payload = JSON.parse(input || "{}");
} catch {
  payload = { invalidJson: true, rawInput: input };
}

mkdirSync(".workshop", { recursive: true });
appendFileSync(
  ".workshop/hook-events.jsonl",
  `${JSON.stringify({ recordedAt: new Date().toISOString(), payload })}\n`
);
