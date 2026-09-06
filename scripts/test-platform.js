import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repository = fileURLToPath(new URL("../", import.meta.url));
const directory = join(repository, "test");
const files = readdirSync(directory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
  .map((entry) => join(directory, entry.name))
  .sort();
if (!files.length) throw new Error("No platform tests were found.");

const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...files], {
  cwd: repository,
  stdio: "inherit"
});
if (result.error) throw result.error;
if (result.signal) console.error(`Platform tests terminated by ${result.signal}.`);
process.exitCode = result.status ?? 1;
