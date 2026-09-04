import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function readOption(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const version = readOption("--version", packageJson.version);
const temporaryRoot = mkdtempSync(join(tmpdir(), "agentic-loop-playground-offline-"));
const packageDirectory = join(temporaryRoot, "package");
const installDirectory = join(temporaryRoot, "install");
const cacheDirectory = join(temporaryRoot, "empty-cache");

try {
  execFileSync(
    process.execPath,
    [
      resolve("scripts/pack-offline-package.js"),
      "--version",
      version,
      "--output",
      packageDirectory
    ],
    { stdio: "inherit" }
  );
  const packagePath = join(
    packageDirectory,
    `${packageJson.name}-${version}-${process.platform}-${process.arch}.tgz`
  );
  const npmArguments = [
    "install",
    "--prefix",
    installDirectory,
    "--offline",
    "--cache",
    cacheDirectory,
    "--registry",
    "http://127.0.0.1:9",
    packagePath
  ];
  execFileSync(
    process.platform === "win32" ? process.env.ComSpec : "npm",
    process.platform === "win32"
      ? ["/d", "/s", "/c", "npm.cmd", ...npmArguments]
      : npmArguments,
    { stdio: "inherit" }
  );
  const packageRoot = join(installDirectory, "node_modules", packageJson.name);
  const githubModules = join(packageRoot, "node_modules", "@github");
  const runtimePrefix = `copilot-${process.platform === "win32" ? "win32" : process.platform}`;
  const runtimeSuffix = `-${process.arch}`;
  const runtimeName = readdirSync(githubModules).find(
    (name) => name.startsWith(runtimePrefix) && name.endsWith(runtimeSuffix)
  );
  if (!runtimeName) {
    throw new Error(`Installed package is missing the ${process.platform}-${process.arch} Copilot runtime.`);
  }
  const runtimeRoot = join(githubModules, runtimeName);
  const runtimePackage = JSON.parse(readFileSync(join(runtimeRoot, "package.json"), "utf8"));
  const runtimeExecutable = join(runtimeRoot, Object.values(runtimePackage.bin)[0]);
  const runtimeCheck = spawnSync(runtimeExecutable, ["--version"], {
    encoding: "utf8",
    timeout: 15_000
  });
  if (runtimeCheck.status !== 0) {
    throw new Error(
      `Bundled Copilot runtime did not start.\n${runtimeCheck.stdout ?? ""}${runtimeCheck.stderr ?? ""}`
    );
  }
  execFileSync(
    process.execPath,
    [
      resolve("scripts/smoke-package.js"),
      join(packageRoot, "dist", "launcher.js")
    ],
    { stdio: "inherit" }
  );
  console.log("Offline package verified: install and launch succeeded without registry access.");
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
