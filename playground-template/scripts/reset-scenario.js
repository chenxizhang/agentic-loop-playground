import { copyFileSync } from "node:fs";

copyFileSync("scenarios/ci-repair/inventory.start.js", "practice/src/inventory.js");
copyFileSync("scenarios/ci-repair/inventory.test.js", "practice/test/inventory.test.js");
console.log("Practice scenario reset.");

