import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDirectory = resolve(repositoryRoot, "dist");
const publicDirectory = resolve(distDirectory, "public");
const templateDirectory = resolve(repositoryRoot, "playground-template");

rmSync(distDirectory, { recursive: true, force: true });
mkdirSync(publicDirectory, { recursive: true });

const sharedOptions = {
  bundle: true,
  minify: true,
  sourcemap: false,
  legalComments: "none",
  target: "node20",
  logLevel: "warning"
};

const buildResults = await Promise.all([
  build({
    ...sharedOptions,
    metafile: true,
    entryPoints: [resolve(repositoryRoot, "src/launcher.js")],
    outfile: resolve(distDirectory, "launcher.js"),
    platform: "node",
    format: "esm",
    external: ["@github/copilot-sdk"],
    define: { __PACKAGED__: "true" }
  }),
  build({
    ...sharedOptions,
    metafile: true,
    entryPoints: [resolve(repositoryRoot, "src/analyze-repo-worker.js")],
    outfile: resolve(distDirectory, "analyze-repo-worker.js"),
    platform: "node",
    format: "esm"
  }),
  build({
    ...sharedOptions,
    metafile: true,
    entryPoints: [resolve(repositoryRoot, "public/app.js")],
    outfile: resolve(publicDirectory, "app.js"),
    platform: "browser",
    format: "iife"
  }),
  build({
    ...sharedOptions,
    metafile: true,
    entryPoints: [resolve(repositoryRoot, "public/styles.css")],
    outfile: resolve(publicDirectory, "styles.css")
  })
]);

for (const result of buildResults) {
  for (const output of Object.values(result.metafile.outputs)) {
    const internalImports = output.imports.filter((dependency) => !dependency.external);
    if (internalImports.length > 0) {
      throw new Error(`Build output contains unbundled imports: ${internalImports.map(({ path }) => path).join(", ")}`);
    }
  }
}

const indexHtml = readFileSync(resolve(repositoryRoot, "public/index.html"), "utf8")
  .replace(/<!--[\s\S]*?-->/g, "")
  .replace(/>\s+</g, "><")
  .trim();
writeFileSync(resolve(publicDirectory, "index.html"), indexHtml);

const templateEntries = [];
const pendingDirectories = [templateDirectory];
while (pendingDirectories.length > 0) {
  const directory = pendingDirectories.pop();
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      pendingDirectories.push(path);
      continue;
    }
    const stats = statSync(path);
    templateEntries.push({
      path: relative(templateDirectory, path).replaceAll("\\", "/"),
      content: readFileSync(path).toString("base64"),
      mode: stats.mode & 0o777
    });
  }
}
templateEntries.sort((left, right) => left.path.localeCompare(right.path));
writeFileSync(
  resolve(distDirectory, "playground-template.json.gz"),
  gzipSync(JSON.stringify(templateEntries), { level: 9 })
);
chmodSync(resolve(distDirectory, "launcher.js"), 0o755);
