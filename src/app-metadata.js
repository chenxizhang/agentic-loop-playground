import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));

export const applicationMetadata = Object.freeze({
  name: packageJson.name,
  version: packageJson.version,
  feedbackRepository: "chenxizhang/agentic-loop-playground",
  feedbackRepositoryUrl: "https://github.com/chenxizhang/agentic-loop-playground"
});
