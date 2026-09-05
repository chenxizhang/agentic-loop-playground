#!/bin/sh

set -eu

repository="chenxizhang/agentic-loop-playground"

for command in gh npm; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command not found: $command" >&2
    exit 1
  fi
done

if ! gh auth status --hostname github.com >/dev/null 2>&1; then
  echo "GitHub CLI is not authenticated. Run: gh auth login" >&2
  exit 1
fi

system="$(uname -s)"
architecture="$(uname -m)"
case "$system:$architecture" in
  Linux:x86_64|Linux:amd64)
    if command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi "musl"; then
      echo "Unsupported Linux C library: musl. The available Linux tarball requires glibc." >&2
      exit 1
    fi
    asset_pattern="agentic-loop-playground-*-linux-x64.tgz"
    ;;
  Darwin:arm64|Darwin:aarch64)
    asset_pattern="agentic-loop-playground-*-darwin-arm64.tgz"
    ;;
  *)
    echo "Unsupported platform: $system $architecture" >&2
    echo "Available installers support Linux x64 and macOS arm64." >&2
    exit 1
    ;;
esac

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/agentic-loop-playground-install.XXXXXX")"
trap 'rm -rf "$temporary_directory"' EXIT HUP INT TERM

echo "Downloading the latest Agentic Loop Playground release..."
gh release download \
  --repo "$repository" \
  --pattern "$asset_pattern" \
  --dir "$temporary_directory"

set -- "$temporary_directory"/$asset_pattern
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo "Expected exactly one release asset matching $asset_pattern." >&2
  exit 1
fi

echo "Installing from the self-contained tarball..."
npm install --global --offline --no-audit --no-fund "$1"

echo
echo "Installation complete. Run:"
echo "  agentic-loop-playground -h"
