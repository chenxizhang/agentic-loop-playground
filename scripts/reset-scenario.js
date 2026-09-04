import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("practice/src", { recursive: true });
mkdirSync("practice/test", { recursive: true });
copyFileSync("scenarios/ci-repair/inventory.start.js", "practice/src/inventory.js");
copyFileSync("scenarios/ci-repair/inventory.test.js", "practice/test/inventory.test.js");

console.log("Practice scenario reset. `npm run test:practice` should now fail.");

