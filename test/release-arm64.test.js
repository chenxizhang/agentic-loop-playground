import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const installPs1 = readFileSync(new URL("../install.ps1", import.meta.url), "utf8");
const publishWorkflow = readFileSync(new URL("../.github/workflows/npm-publish.yml", import.meta.url), "utf8");

test("Windows installer selects architecture-specific release assets", () => {
  assert.match(installPs1, /"AMD64"\s*\{\s*\$windowsArchitecture = "x64"\s*\}/);
  assert.match(installPs1, /"ARM64"\s*\{\s*\$windowsArchitecture = "arm64"\s*\}/);
  assert.match(installPs1, /win32-\$windowsArchitecture\.tgz/);
  assert.match(installPs1, /supports Windows x64 and ARM64/);
});

test("release workflow builds and verifies Windows ARM64 offline packages", () => {
  assert.match(publishWorkflow, /package-offline:[\s\S]*windows-11-arm/);
  assert.match(publishWorkflow, /verify-installers:[\s\S]*windows-11-arm/);
  assert.match(publishWorkflow, /offline-package-\$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}/);
  assert.match(publishWorkflow, /install\.ps1/);
});
