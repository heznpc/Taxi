#!/usr/bin/env bash
set -euo pipefail

GH_VERSION="2.93.0"
INSTALL_ROOT="${GH_INSTALL_ROOT:-${RUNNER_TEMP:?RUNNER_TEMP is required}/taxi-gh-${GH_VERSION}}"
PLATFORM="$(uname -s)"
MACHINE="$(uname -m)"

case "$PLATFORM:$MACHINE" in
  Darwin:x86_64)
    ARTIFACT="gh_${GH_VERSION}_macOS_amd64.zip"
    SHA256="009425b9d175c482037fe25181817fd6b1ea3ae1f51cfae0e18f29f33d3152ac"
    ;;
  Darwin:arm64)
    ARTIFACT="gh_${GH_VERSION}_macOS_arm64.zip"
    SHA256="a86be4e0a86c26456cf71177d6572d6f1165cf1679e532b72f7f15918ee51fd2"
    ;;
  Linux:x86_64)
    ARTIFACT="gh_${GH_VERSION}_linux_amd64.tar.gz"
    SHA256="02d1290eba130e0b896f3709ffff22e1c75a51475ddb70476a85abc6b5807af0"
    ;;
  Linux:aarch64|Linux:arm64)
    ARTIFACT="gh_${GH_VERSION}_linux_arm64.tar.gz"
    SHA256="c55feb33684abba57e9909737340d5b39282257c0363e1edde6785ac4a413be7"
    ;;
  *)
    echo "Unsupported GitHub CLI platform: $PLATFORM $MACHINE" >&2
    exit 1
    ;;
esac

DOWNLOAD_DIR="$(mktemp -d "${RUNNER_TEMP:?}/taxi-gh-download.XXXXXX")"
trap 'rm -rf "$DOWNLOAD_DIR"' EXIT
ARCHIVE="$DOWNLOAD_DIR/$ARTIFACT"
/usr/bin/curl --proto '=https' --tlsv1.2 -fsSLo "$ARCHIVE" \
  "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${ARTIFACT}"
ACTUAL_SHA256="$(openssl dgst -sha256 -r "$ARCHIVE" | awk '{print $1}')"
if [ "$ACTUAL_SHA256" != "$SHA256" ]; then
  echo "GitHub CLI checksum mismatch: expected $SHA256, got $ACTUAL_SHA256" >&2
  exit 1
fi

mkdir -p "$DOWNLOAD_DIR/extracted" "$INSTALL_ROOT/bin"
case "$ARTIFACT" in
  *.zip) unzip -q "$ARCHIVE" -d "$DOWNLOAD_DIR/extracted" ;;
  *.tar.gz) tar -xzf "$ARCHIVE" -C "$DOWNLOAD_DIR/extracted" ;;
esac
GH_BINARY="$(find "$DOWNLOAD_DIR/extracted" -type f -path '*/bin/gh' -print -quit)"
if [ -z "$GH_BINARY" ]; then
  echo "Pinned GitHub CLI archive did not contain bin/gh" >&2
  exit 1
fi
install -m 0755 "$GH_BINARY" "$INSTALL_ROOT/bin/gh"
"$INSTALL_ROOT/bin/gh" version | head -1 | grep -F "gh version $GH_VERSION " >/dev/null
"$INSTALL_ROOT/bin/gh" release verify --help >/dev/null
"$INSTALL_ROOT/bin/gh" release verify-asset --help >/dev/null

if [ -n "${GITHUB_PATH:-}" ]; then
  printf '%s\n' "$INSTALL_ROOT/bin" >> "$GITHUB_PATH"
fi
echo "Pinned GitHub CLI $GH_VERSION installed with release attestation commands."
