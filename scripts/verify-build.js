import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { transform } from "esbuild";

const packageMetadata = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const expectedFiles = ["dist", "README.md"];
const artifacts = [
  "dist/launcher.js",
  "dist/analyze-repo-worker.js",
  "dist/validate-worker.js",
  "dist/public/app.js",
  "dist/public/styles.css"
];

if (packageMetadata.bin?.["agentic-loop-playground"] !== "dist/launcher.js") {
  throw new Error("The published executable must point to dist/launcher.js.");
}
if (JSON.stringify(packageMetadata.files) !== JSON.stringify(expectedFiles)) {
  throw new Error(`Published files must remain restricted to: ${expectedFiles.join(", ")}.`);
}

for (const artifact of artifacts) {
  const content = readFileSync(resolve(artifact), "utf8");
  const loader = artifact.endsWith(".css") ? "css" : "js";
  const transformed = await transform(content, { loader, minify: true, target: loader === "js" ? "node20" : "es2020" });
  if (content.length > transformed.code.length * 1.05 + 32) {
    throw new Error(`${artifact} is not minified (${content.length} bytes versus ${transformed.code.length}).`);
  }
  if (/sourceMappingURL|(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']\.\.?\//.test(content)) {
    throw new Error(`${artifact} contains source metadata or a relative application import.`);
  }
}

const indexHtml = readFileSync(resolve("dist/public/index.html"), "utf8");
const minifiedHtml = indexHtml
  .replace(/<!--[\s\S]*?-->/g, "")
  .replace(/>\s+</g, "><")
  .trim();
if (indexHtml !== minifiedHtml) {
  throw new Error("dist/public/index.html is not minified.");
}

const launcher = readFileSync(resolve("dist/launcher.js"), "utf8");
if (!launcher.startsWith("#!/usr/bin/env node")) {
  throw new Error("dist/launcher.js is missing its executable hashbang.");
}
readFileSync(resolve("dist/playground-template.json.gz"));

console.log("Build artifacts verified: bundled, minified, and free of relative source imports.");
