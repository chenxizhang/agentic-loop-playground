import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

function readOption(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const packagePath = resolve("package.json");
const originalPackage = readFileSync(packagePath, "utf8");
const packageJson = JSON.parse(originalPackage);
const version = readOption("--version", process.env.RELEASE_VERSION ?? packageJson.version);
const outputDirectory = resolve(readOption("--output", process.env.RELEASE_OUTPUT ?? "release"));
const bundledDependencies = Object.keys(packageJson.dependencies ?? {});

if (bundledDependencies.length === 0) {
  throw new Error("Offline package requires at least one runtime dependency.");
}
for (const dependency of bundledDependencies) {
  if (!existsSync(resolve("node_modules", ...dependency.split("/"), "package.json"))) {
    throw new Error(`Missing runtime dependency ${dependency}; run npm ci before packing.`);
  }
}

mkdirSync(outputDirectory, { recursive: true });
packageJson.version = version;
packageJson.bundleDependencies = bundledDependencies;

try {
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  const npmArguments = ["pack", "--json", "--pack-destination", outputDirectory];
  if (!process.env.npm_execpath) {
    throw new Error("npm_execpath is unavailable; run this command through npm.");
  }
  const output = execFileSync(process.execPath, [process.env.npm_execpath, ...npmArguments], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  });
  const outputLines = output.split(/\r?\n/);
  const jsonStart = outputLines.findIndex((line) => line === "[");
  const jsonEnd = outputLines.findLastIndex((line) => line === "]");
  if (jsonStart === -1 || jsonEnd <= jsonStart) {
    throw new Error(`npm pack did not return JSON output:\n${output}`);
  }
  const packResult = JSON.parse(outputLines.slice(jsonStart, jsonEnd + 1).join("\n"))[0];
  const missingBundles = bundledDependencies.filter(
    (dependency) => !packResult.bundled?.includes(dependency)
  );
  if (missingBundles.length > 0) {
    throw new Error(`Offline package omitted bundled dependencies: ${missingBundles.join(", ")}`);
  }
  const runtimePrefix = `@github/copilot-${process.platform === "win32" ? "win32" : process.platform}`;
  const runtimeSuffix = `-${process.arch}`;
  if (
    !packResult.bundled?.some(
      (dependency) => dependency.startsWith(runtimePrefix) && dependency.endsWith(runtimeSuffix)
    )
  ) {
    throw new Error(`Offline package omitted the ${process.platform}-${process.arch} Copilot runtime.`);
  }

  const sourcePath = resolve(outputDirectory, packResult.filename);
  const targetName = `${packageJson.name}-${version}-${process.platform}-${process.arch}.tgz`;
  const targetPath = resolve(outputDirectory, targetName);
  renameSync(sourcePath, targetPath);
  console.log(`Offline package created: ${basename(targetPath)}`);
} finally {
  writeFileSync(packagePath, originalPackage);
}
