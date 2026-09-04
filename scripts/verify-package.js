import { execFileSync } from "node:child_process";

const npmArguments = ["pack", "--dry-run", "--json", "--ignore-scripts"];
if (!process.env.npm_execpath) {
  throw new Error("npm_execpath is unavailable; run this command through npm.");
}
const output = execFileSync(process.execPath, [process.env.npm_execpath, ...npmArguments], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"]
});
const packageFiles = JSON.parse(output)[0].files.map(({ path }) => path);
const allowedRoots = ["README.md", "package.json", "dist/"];
const forbiddenRoots = ["src/", "public/", "scripts/", "test/", "playground-template/"];
const requiredFiles = [
  "dist/launcher.js",
  "dist/analyze-repo-worker.js",
  "dist/playground-template.json.gz",
  "dist/public/app.js",
  "dist/public/index.html",
  "dist/public/styles.css"
];

const unexpected = packageFiles.filter(
  (path) => !allowedRoots.some((root) => path === root || (root.endsWith("/") && path.startsWith(root)))
);
const sourceFiles = packageFiles.filter((path) => forbiddenRoots.some((root) => path.startsWith(root)));
const sourceMaps = packageFiles.filter((path) => path.endsWith(".map"));
const missing = requiredFiles.filter((path) => !packageFiles.includes(path));

if (unexpected.length || sourceFiles.length || sourceMaps.length || missing.length) {
  const details = [
    unexpected.length ? `unexpected files: ${unexpected.join(", ")}` : "",
    sourceFiles.length ? `source directories: ${sourceFiles.join(", ")}` : "",
    sourceMaps.length ? `source maps: ${sourceMaps.join(", ")}` : "",
    missing.length ? `missing build artifacts: ${missing.join(", ")}` : ""
  ].filter(Boolean);
  throw new Error(`Package boundary check failed (${details.join("; ")})`);
}

console.log(`Package boundary verified: ${packageFiles.length} files, no application source directories.`);
