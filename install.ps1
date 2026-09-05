$ErrorActionPreference = "Stop"

$repository = "chenxizhang/agentic-loop-playground"
$ghCommand = Get-Command "gh.exe" -ErrorAction SilentlyContinue
if (-not $ghCommand) {
    $ghCommand = Get-Command "gh" -ErrorAction SilentlyContinue
}
$npmCommand = Get-Command "npm.cmd" -ErrorAction SilentlyContinue
if (-not $npmCommand) {
    $npmCommand = Get-Command "npm" -ErrorAction SilentlyContinue
}
if (-not $ghCommand) {
    throw "Required command not found: gh"
}
if (-not $npmCommand) {
    throw "Required command not found: npm"
}

$architecture = $env:PROCESSOR_ARCHITEW6432
if (-not $architecture) {
    $architecture = $env:PROCESSOR_ARCHITECTURE
}
if ($architecture -ne "AMD64") {
    throw "Unsupported Windows architecture: $architecture. The available installer supports Windows x64."
}

& $ghCommand.Source auth status --hostname github.com 2>$null
if ($LASTEXITCODE -ne 0) {
    throw "GitHub CLI is not authenticated. Run: gh auth login"
}

$temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) (
    "agentic-loop-playground-install-" + [System.Guid]::NewGuid().ToString("N")
)
New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null

try {
    $assetPattern = "agentic-loop-playground-*-win32-x64.tgz"
    Write-Host "Downloading the latest Agentic Loop Playground release..."
    & $ghCommand.Source release download --repo $repository --pattern $assetPattern --dir $temporaryDirectory
    if ($LASTEXITCODE -ne 0) {
        throw "GitHub CLI failed to download the release asset."
    }

    $tarballs = @(Get-ChildItem -Path $temporaryDirectory -Filter $assetPattern -File)
    if ($tarballs.Count -ne 1) {
        throw "Expected exactly one release asset matching $assetPattern."
    }

    Write-Host "Installing from the self-contained tarball..."
    & $npmCommand.Source install --global --offline --no-audit --no-fund $tarballs[0].FullName
    if ($LASTEXITCODE -ne 0) {
        throw "npm failed to install the release tarball."
    }

    Write-Host ""
    Write-Host "Installation complete. Run:"
    Write-Host "  agentic-loop-playground -h"
}
finally {
    Remove-Item -Path $temporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
