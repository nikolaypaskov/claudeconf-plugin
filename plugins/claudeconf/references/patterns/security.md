# Security Pattern

> These conventions are strongly recommended for determinism and network-safety.
> The tool choices (semgrep, trufflehog) are the archived prototype's defaults; if
> the project already uses a different SAST tool, preserve the offline/pinned
> convention and adjust the command.
>
> **Be honest about coverage.** The default offline ruleset is a SEED — a few
> high-signal patterns, not comprehensive analysis. The deterministic/offline
> stance below trades coverage for reproducibility on purpose. Do not present a
> green SAST or secret-scan check as a security guarantee. For real assurance,
> vendor a curated ruleset at a pinned commit and/or add CodeQL at the CI tier
> (see "Making the SAST gate credible" below), and pair the local secret scan with
> server-side push protection.

## Stack-agnostic security checks

Mined from `src/policy/catalog/security.ts` and `src/engine/scope.ts` in the
`cli-prototype` tag. These checks are composed into every harness regardless of
stack.

| Milestone | Tier | Tool | Mode | Scope |
| --- | --- | --- | --- | --- |
| secret-scan | pre-commit | `trufflehog filesystem` | blocking | changed files |
| secret-scan | gate + CI | `trufflehog filesystem .` | blocking | whole tree (with `--exclude-paths`) |
| SAST | pre-push + gate + CI | `semgrep scan` | blocking | all |

## trufflehog: required flags

```sh
# Secret scan on changed files. Network-free + deterministic:
#   --no-update        never check for updates (no network)
#   --no-verification  don't verify candidates against live services
#   --fail             exit non-zero if a secret is found
trufflehog filesystem <changed-files...> --no-update --no-verification --fail
```

- `--no-update` and `--no-verification` keep the scan deterministic and
  network-free (constitution §4.3). Without them trufflehog may fetch detector
  updates or attempt live verification, making results non-reproducible.
- Runs on changed files only at pre-commit so it stays fast.
- **`--no-verification` is a deliberate tradeoff, not a free win.** Verification is
  trufflehog's accuracy feature — it confirms whether a candidate credential is
  live. Disabling it keeps the scan network-free and deterministic but surfaces
  every candidate as UNVERIFIED, which is noisier (more false positives to triage),
  most of all on the whole-tree CI scan. Say so; don't imply high precision.
- **A pre-commit secret scan is a first layer, not a guarantee.** Local hooks are
  bypassable (`git commit --no-verify`), absent on a fresh clone until
  `lefthook install`, and scan the working tree — not history. Treat them as fast
  feedback and make **server-side push protection** (e.g. GitHub secret scanning /
  push protection) the authoritative, non-bypassable layer.

## trufflehog at gate/CI: whole-tree scan + `--exclude-paths`

At the gate and in CI the secret scan runs over the WHOLE tree, not just changed
files:

```sh
trufflehog filesystem . --no-update --no-verification --fail \
  --exclude-paths .claudeconf/trufflehog-exclude.txt
```

The exclude file has two non-obvious requirements:

- **Each line is a REGEX, not a glob.** trufflehog compiles every line as a
  regular expression; a glob such as `*.lock` fails to compile (`can not compile
  regular expression`). Write `\.lock$`, `package-lock\.json`, etc. This differs
  from lefthook's `exclude:` key, which DOES take globs — the same intent is
  spelled two ways: globs in `lefthook.yml`, regexes in the trufflehog exclude
  file.
- **Always exclude `.git/`.** `trufflehog filesystem .` scans `.git/`, and
  `actions/checkout` injects the runner's ephemeral `GITHUB_TOKEN` into
  `.git/config`; trufflehog flags it as an unverified GitHub secret and `--fail`
  turns every CI run red — a guaranteed false positive. Add `\.git/`.

- **Exclude vendored dependency trees** (`node_modules/`, `.venv/`, `vendor/`).
  Dependencies legitimately contain example credentials in docs and test fixtures
  (URI-style `user:pass@` hosts in `@types/node`'s docs), and in CI the install step
  often runs before the scan in the same job — so the tree is present when the
  scanner walks it. Noise, not project secrets (wiring-principles §5).

A minimal `.claudeconf/trufflehog-exclude.txt` (Node project):

```
\.git/
package-lock\.json
\.lock$
node_modules/
```

## semgrep: use a pinned offline config, never `--config auto`

```sh
semgrep scan \
  --error           # exit non-zero on findings
  --quiet           # suppress progress output
  --config .claudeconf/rules/   # vendored, pinned, offline ruleset directory
```

The canonical config is the `.claudeconf/rules/` DIRECTORY of vendored rule files,
committed into the repository and pinned to an exact source (see below) — never
`--config auto` or a URL that fetches rules at scan time. Using `--config auto`
makes scan results depend on the current Semgrep registry state, violating the
determinism invariant (constitution §4.3).

### Making the SAST gate credible (not just a couple of regexes)

A handful of hand-written rules is a SEED, not real coverage — and `pattern-regex`
rules in particular bypass Semgrep's AST/dataflow engine, so they amount to `grep`.
To make the SAST milestone mean something while keeping determinism:

- **Vendor a curated ruleset at a pinned commit.** Check out a high-confidence pack
  (e.g. Semgrep's `p/default`) at a specific SHA, copy the rule files into
  `.claudeconf/rules/`, and point `--config .claudeconf/rules/` at the directory.
  This keeps the scan offline and reproducible (§4.3) while giving genuine AST
  coverage. Prefer AST `pattern:`/`patterns:` rules over `pattern-regex`. Do NOT
  block on audit-style packs (e.g. `p/security-audit` / `r2c-security-audit`) —
  they are high-false-positive by design and meant for monitor mode, not a gate.
- **Or add CodeQL at the CI tier.** For deep dataflow on JS/TS/Python, GitHub
  CodeQL outclasses a hand-rolled ruleset. Its query packs are versioned but not
  air-gapped-deterministic the way a vendored directory is, so it fits the CI tier
  (not the offline pre-push tier) — a legitimate determinism-vs-coverage split to
  state openly.

The rules shipped by default are a minimal starter: extend or replace them (vendor
a pack, or add CodeQL) before relying on the SAST gate for security.

## Scope guard (pentest / security context only)

Source: `src/engine/scope.ts`.

When the harness is generated for a pentest engagement, all network-aware hooks
must respect a `.scope` file at the repository root. The scope guard:

1. Reads `.scope` line by line; empty lines and lines starting with `#` are
   ignored; each remaining line is a bare hostname or IPv4 (e.g. `example.com`,
   `192.168.1.0/24`).
2. Before running any network tool, extracts candidate targets from the command:
   - URL hosts from any `scheme://authority/…` pattern.
   - Bare IPv4 addresses matching `\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}`.
   - When the command invokes a known network tool (curl, wget, nmap, nikto,
     gobuster, ffuf, sqlmap, etc.), also bare hostnames — but NOT tokens that
     look like filenames (have a file extension like `.json`, `.ts`, `.sh`).
3. Refuses to run if any extracted target is not in scope (no match and no
   subdomain match of a scope entry).

The host-extraction heuristic distinguishes `package.json` (file, not a target)
from `example.com` (hostname) by checking that the last label is alphabetic and
not in a known file-extension set.

Wire the scope guard as a wrapper script around the hook invocation, not as a
separate hook step, so it can intercept any tool command.
