# CI: GitHub Actions Pattern

> This is a skeleton starting point. Research the project's actual stack and tool
> versions, then fill in the entries. The structure (triggers, jobs, step order,
> supply-chain hardening) captures the convention; the exact commands must match
> what the harness generates for that project.

## Purpose

The CI workflow mirrors the `gate` tier and is the authoritative pass/fail signal
for pull requests (constitution §3 Non-Negotiable #4). It must cover all nine
milestones. Artifact path: `.github/workflows/ci.yml`.

## Skeleton

```yaml
name: ci

on:
  push:
    branches: ["main"]
  pull_request:

# Least privilege by default; escalate per-job only where needed.
permissions:
  contents: read

# Cancel superseded runs on the same ref.
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  harness:
    runs-on: ubuntu-latest   # macos-latest for Swift / Apple toolchains
    steps:
      # SHA-PIN every action (see Conventions). The trailing comment records the
      # human-readable version that Dependabot/Renovate bumps.
      - uses: actions/checkout@<40-char-sha>            # v4.x

      # Install the language runtime — replace with the stack-appropriate action,
      # also SHA-pinned, and enable dependency caching via its `cache:` input.
      #   Node:   actions/setup-node    (cache: 'npm'),   node-version-file: .nvmrc
      #   Python: actions/setup-python  (cache: 'pip'),   python-version-file: .python-version
      #   Java:   actions/setup-java    (cache: 'gradle') — Kotlin/Gradle
      #   Swift:  pre-installed on macos-latest; pin via .swift-version
      #   Elixir: erlef/setup-beam      with elixir-version + otp-version
      - name: set up runtime
        uses: actions/setup-node@<40-char-sha>          # v4.x — REPLACE for your stack
        with:
          node-version-file: .nvmrc                     # REPLACE or remove
          cache: 'npm'                                  # REPLACE for your package manager

      - name: install dependencies
        run: npm ci                                     # REPLACE: pip install … / mix deps.get / …

      # ── Milestone gates (tier order) — invoke project-local tools (npx/…) ───
      - name: format check
        run: npx biome format .                         # REPLACE with the stack formatter
      - name: lint
        run: npx biome lint .                           # REPLACE
      - name: typecheck
        run: npx tsc --noEmit                           # REPLACE
      - name: unit + coverage
        run: npx vitest run --coverage                  # REPLACE
      - name: e2e
        run: npx vitest run test/integration/           # REPLACE per interface (e2e.md)
      - name: build
        run: npm run build                              # REPLACE
      - name: dependency audit (advisory)
        run: npm audit --audit-level=high || true       # REPLACE; advisory, never blocks

  # Supply-chain review on PRs: blocks newly-introduced vulnerable deps and
  # disallowed licenses. Fulfils the gate-tier "license/dependency review" (§1).
  dependency-review:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<40-char-sha>            # v4.x
      - uses: actions/dependency-review-action@<40-char-sha>   # v4.x
        with:
          fail-on-severity: high
          # deny-licenses: GPL-3.0, AGPL-3.0            # set a license policy for the project

  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<40-char-sha>            # v4.x
      # Secret scan (whole tree). MUST exclude .git/ + lock files — the exclude file
      # is REGEXES (security.md, wiring-principles.md §5). The Docker tag IS the pin.
      - name: secret scan
        uses: docker://trufflesecurity/trufflehog:<x.y.z>
        with:
          args: filesystem . --no-update --no-verification --fail --exclude-paths .claudeconf/trufflehog-exclude.txt
      # SAST — pinned offline ruleset. The default is a SEED; vendor a curated pack
      # at a SHA or add CodeQL for real coverage (security.md).
      - name: SAST (semgrep)
        uses: docker://semgrep/semgrep:<x.y.z>
        with:
          args: semgrep scan --error --quiet --config .claudeconf/semgrep.yml
```

## Conventions

- **SHA-pin every third-party action.** Reference actions by a full 40-character
  commit SHA, never a mutable tag (`@v4`, `@main`) — tags can be repointed at
  malicious code (the `tj-actions/changed-files` compromise, CVE-2025-30066). Record
  the version in a trailing comment (`# v4.2.2`) and let Dependabot/Renovate bump the
  SHA. This is the pinned-versions invariant (constitution §4.1) applied to CI
  supply-chain inputs. Docker-image actions are pinned by the image tag.
- **Least-privilege `permissions:`.** Set `permissions: contents: read` at the top and
  escalate per-job only where required (e.g. `attestations: write` on a build job that
  signs provenance). Never rely on the default broad token.
- **`concurrency` + `cancel-in-progress: true`** so superseded runs on the same ref are
  cancelled.
- **Caching:** add the setup action's `cache:` input (`npm`/`pip`/`gradle`/…) to speed
  installs. Do not cache version-pinned tool binaries — let the install run fresh.
- **`dependency-review-action` on PRs** blocks vulnerable deps + disallowed licenses;
  this is the gate-tier "license/dependency review". It needs a public repo or GitHub
  Advanced Security — on a private repo without GHAS, guard it (`if: … &&
  github.event.repository.private == false`) so the job skips cleanly instead of failing.
- **e2e**: the step starts/stops any required server itself (or uses `services:`), per
  `e2e.md` — pick by interface, not a browser default.
- **Matrix builds**: add `strategy.matrix` only if the project tests multiple runtimes
  locally too; start single-target.
- **Supply-chain on the build** (for published artifacts): generate an SBOM
  (CycloneDX/SPDX) and attach build provenance with `actions/attest-build-provenance`.
  Scope `id-token: write` + `attestations: write` to the build job only — do not loosen
  the top-level token.
- **Repo hygiene**: ship `.editorconfig`, `.gitattributes` (`* text=auto eol=lf`), and
  `.github/CODEOWNERS`; print a post-generation checklist to enable branch protection +
  required status checks (the harness cannot change GitHub settings).
