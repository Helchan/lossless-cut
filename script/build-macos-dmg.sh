#!/usr/bin/env bash
set -euo pipefail

ARCH="both"
SKIP_INSTALL=0
SKIP_FFMPEG=0
BUILT_DMGS=()

usage() {
  cat <<'USAGE'
Usage: script/build-macos-dmg.sh [--arch arm64|x64|both] [--skip-install] [--skip-ffmpeg-download]

Build local macOS DMGs for LosslessCut, verify them with hdiutil, and print SHA-256 hashes.

Options:
  --arch arm64|x64|both       macOS architecture(s) to package. Default: both.
  --skip-install              Skip yarn install --immutable.
  --skip-ffmpeg-download      Use existing ffmpeg resources without downloading missing files.
  -h, --help                  Show this help.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch)
      ARCH="${2:-}"
      shift 2
      ;;
    --skip-install)
      SKIP_INSTALL=1
      shift
      ;;
    --skip-ffmpeg-download)
      SKIP_FFMPEG=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$ARCH" in
  arm64|x64|both) ;;
  *)
    echo "--arch must be one of: arm64, x64, both" >&2
    exit 2
    ;;
esac

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script can only build macOS DMGs on macOS." >&2
  exit 1
fi

if [[ ! -f package.json || ! -f .yarnrc.yml ]]; then
  echo "Run this script from the LosslessCut repository root." >&2
  exit 1
fi

if [[ " ${NODE_OPTIONS:-} " != *" --experimental-strip-types "* ]]; then
  export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--experimental-strip-types"
fi

download_file() {
  local url="$1"
  local output="$2"

  if command -v wget >/dev/null 2>&1; then
    wget "$url" -O "$output" && return 0
  fi

  curl -L --fail --retry 3 -o "$output" "$url"
}

ensure_macos_ffmpeg() {
  local arch_dir="$1"
  local label="$2"
  local url_arch="$3"

  mkdir -p "ffmpeg/${arch_dir}"

  if [[ ! -s "ffmpeg/${arch_dir}/ffmpeg" ]]; then
    download_file "https://github.com/mifi/ffmpeg-build-script/releases/download/8.0-1/ffmpeg-macos-${url_arch}" "ffmpeg/${arch_dir}/ffmpeg"
  fi

  if [[ ! -s "ffmpeg/${arch_dir}/ffprobe" ]]; then
    download_file "https://github.com/mifi/ffmpeg-build-script/releases/download/8.0-1/ffprobe-macos-${url_arch}" "ffmpeg/${arch_dir}/ffprobe"
  fi

  chmod +x "ffmpeg/${arch_dir}/ffmpeg" "ffmpeg/${arch_dir}/ffprobe"
  file "ffmpeg/${arch_dir}/ffmpeg" "ffmpeg/${arch_dir}/ffprobe"
  echo "Prepared ${label} ffmpeg resources."
}

build_dmg() {
  local arch="$1"
  local dmg_path="dist/LosslessCut-mac-${arch}.dmg"

  yarn electron-builder --mac dmg "--${arch}"
  hdiutil verify "$dmg_path"
  BUILT_DMGS+=("$dmg_path")
}

if [[ "$SKIP_INSTALL" -eq 0 ]]; then
  yarn install --immutable
fi

if [[ "$SKIP_FFMPEG" -eq 0 ]]; then
  if [[ "$ARCH" == "arm64" || "$ARCH" == "both" ]]; then
    ensure_macos_ffmpeg "darwin-arm64" "arm64" "ARM64"
  fi

  if [[ "$ARCH" == "x64" || "$ARCH" == "both" ]]; then
    ensure_macos_ffmpeg "darwin-x64" "x64" "X64"
  fi
fi

yarn build

if [[ "$ARCH" == "arm64" || "$ARCH" == "both" ]]; then
  build_dmg "arm64"
fi

if [[ "$ARCH" == "x64" || "$ARCH" == "both" ]]; then
  build_dmg "x64"
fi

shasum -a 256 "${BUILT_DMGS[@]}"
