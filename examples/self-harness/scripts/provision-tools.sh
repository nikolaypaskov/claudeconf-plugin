#!/usr/bin/env bash
# CI provisioning module (wiring-principles §8 / contract §3.4) — Linux/x86_64
# ONLY. Provisions the pinned scanner/auditor toolchain a harness gate needs:
#
#   trufflehog, actionlint — release binaries, sha256 CHECKSUM-VERIFIED, unpacked
#     into a fresh runner-owned dir (never a writable project-local bin).
#   semgrep, zizmor        — pipx-installed at exact versions: VERSION-PINNED,
#     NOT checksum-verified (hash-locked Python environments are the profile-4
#     bar; limitation recorded here on purpose). Installed at provision time —
#     the gate itself never fetches (constitution §4.2).
#   npm                    — pinned >= the min-release-age floor (11.17.0).
#
# On any other OS/arch this module is NOT APPLICABLE (exit 0 with a notice):
# local machines keep bare-name tools + the gate's version assertions.
set -euo pipefail

os="$(uname -s)" arch="$(uname -m)"
if [[ "$os" != "Linux" || "$arch" != "x86_64" ]]; then
  echo "provision-tools: not applicable on $os/$arch (Linux/x86_64 CI module);"
  echo "provision-tools: local hooks rely on preinstalled tools + gate version assertions"
  exit 0
fi

TRUFFLEHOG_VERSION=3.95.6
TRUFFLEHOG_SHA256=1b62ea3cbc672ed5fd36e0eebb00b1fb50bbb7ee35090f42437a5852a299e16b
ACTIONLINT_VERSION=1.7.12
ACTIONLINT_SHA256=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
SEMGREP_VERSION="${SEMGREP_VERSION:-1.168.0}"
ZIZMOR_VERSION=1.27.0
NPM_VERSION=11.17.0

bin="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/claudeconf-tools"
mkdir -p "$bin"

fetch_verified() { # url sha256 member
  local url="$1" sha="$2" member="$3" archive="$bin/archive.tgz"
  curl -fsSL "$url" -o "$archive"
  echo "$sha  $archive" | sha256sum -c - >/dev/null
  tar -xzf "$archive" -C "$bin" "$member"
  rm -f "$archive"
}

fetch_verified \
  "https://github.com/trufflesecurity/trufflehog/releases/download/v${TRUFFLEHOG_VERSION}/trufflehog_${TRUFFLEHOG_VERSION}_linux_amd64.tar.gz" \
  "$TRUFFLEHOG_SHA256" trufflehog
fetch_verified \
  "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz" \
  "$ACTIONLINT_SHA256" actionlint

pipx install --force "semgrep==${SEMGREP_VERSION}" >/dev/null
pipx install --force "zizmor==${ZIZMOR_VERSION}" >/dev/null
npm install -g "npm@${NPM_VERSION}" >/dev/null

if [[ -n "${GITHUB_PATH:-}" ]]; then
  echo "$bin" >> "$GITHUB_PATH"
else
  echo "provision-tools: add to PATH manually: $bin"
fi

echo "provision-tools: trufflehog ${TRUFFLEHOG_VERSION} (checksum-verified)," \
  "actionlint ${ACTIONLINT_VERSION} (checksum-verified)," \
  "semgrep ${SEMGREP_VERSION} (version-pinned)," \
  "zizmor ${ZIZMOR_VERSION} (version-pinned), npm ${NPM_VERSION}"
