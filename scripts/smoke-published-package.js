import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const version = readOption("--version") ?? process.env.RELEASE_VERSION;
if (!version) {
  throw new Error("Provide the published version with --version.");
}
if (!process.env.npm_execpath) {
  throw new Error("npm_execpath is unavailable; run this command through npm.");
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "agentic-loop-playground-published-"));
const packageDirectory = join(temporaryRoot, "package");
const installDirectory = join(temporaryRoot, "install");
const cacheDirectory = join(temporaryRoot, "cache");
const npm = (...args) =>
  execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

try {
  mkdirSync(packageDirectory);
  let lastError;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      npm(
        "pack",
        `${packageJson.name}@${version}`,
        "--pack-destination",
        packageDirectory,
        "--cache",
        cacheDirectory,
        "--registry",
        "https://registry.npmjs.org"
      );
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 12) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10_000));
      }
    }
  }
  if (lastError) {
    throw new Error(
      `Published tarball was not downloadable after 12 attempts.\n${lastError.stderr ?? lastError.message}`
    );
  }

  const tarball = readdirSync(packageDirectory).find((name) => name.endsWith(".tgz"));
  if (!tarball) {
    throw new Error("npm pack did not create a published package tarball.");
  }
  npm(
    "install",
    "--prefix",
    installDirectory,
    "--cache",
    cacheDirectory,
    "--registry",
    "https://registry.npmjs.org",
    join(packageDirectory, tarball)
  );
  execFileSync(
    process.execPath,
    [
      resolve("scripts/smoke-package.js"),
      join(installDirectory, "node_modules", packageJson.name, "dist", "launcher.js")
    ],
    { stdio: "inherit" }
  );
  console.log(`Published package verified: ${packageJson.name}@${version} downloaded, installed, and launched.`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
