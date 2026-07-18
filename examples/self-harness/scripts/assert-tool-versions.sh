#!/usr/bin/env bash
# Gate-tier version enforcement (contract §3.4 / wiring-principles §8): hooks
# invoke these globally-installed tools by bare name, so prove the executing
# binary IS the manifest pin. Hard-fails on mismatch or unparsable output.
# This is version enforcement, not binary provenance.
set -euo pipefail

fail=0
assert() { # tool expected actual
  local tool="$1" expected="$2" actual="$3"
  if [[ -z "$actual" ]]; then
    echo "assert-tool-versions: cannot parse \`$tool --version\` output" >&2
    fail=1
  elif [[ "$actual" != "$expected" ]]; then
    echo "assert-tool-versions: $tool is $actual, manifest pins $expected" >&2
    fail=1
  fi
}

assert semgrep    "1.168.0" "$(semgrep --version 2>/dev/null | grep -Eo '^[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
assert trufflehog "3.95.6"  "$(trufflehog --version 2>&1 | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
assert actionlint "1.7.12"  "$(actionlint --version 2>/dev/null | head -1 | grep -Eo '^[0-9]+\.[0-9]+\.[0-9]+' || true)"
assert zizmor     "1.27.0"  "$(zizmor --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"

# npm FLOOR (not an exact pin — npm versions through the runtime): the .npmrc
# release-age quarantine is silently ignored before npm 11.10.
npmv="$(npm --version 2>/dev/null || true)"
if [[ -z "$npmv" ]]; then
  echo "assert-tool-versions: cannot determine npm version" >&2; fail=1
elif [[ "$(printf '%s\n' "11.10.0" "$npmv" | sort -V | head -1)" != "11.10.0" ]]; then
  echo "assert-tool-versions: npm $npmv < 11.10 — min-release-age would be silently ignored" >&2; fail=1
fi

if [[ "$fail" -ne 0 ]]; then
  echo "assert-tool-versions: FAIL — re-pin the manifest or fix the installed tool" >&2
  exit 1
fi
echo "assert-tool-versions: all global tools match their manifest pins"
