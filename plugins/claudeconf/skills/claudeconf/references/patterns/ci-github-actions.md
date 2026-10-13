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

# The header above — name / on / permissions / concurrency — plus the `jobs:` key
# is written ONCE and stays PROJECT-OWNED; the managed block below wraps ONLY the
# managed jobs, so a regeneration cannot swallow the project's own (contract §1,
# wiring-principles §9). Keep the header to those keys: workflow-level `env` or
# `defaults` would alter managed jobs from outside the block.
jobs:
# >>> claudeconf managed >>>
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
        # FROZEN install against the committed lockfile — never `npm install`, and
        # never a `|| npm install` fallback (wiring-principles §8).
        run: npm ci                                     # REPLACE: uv sync --locked / mix deps.get / …

      # ── Milestone gates (tier order) ────────────────────────────────────────
      # Step NAMES are the managed tokens (contract §2.4) — a parenthetical for
      # humans may follow, but the token comes first, because managed steps are
      # located by token and never by prose. Invoke project-local tools by their
      # PINNED PATH, never through an on-demand runner (wiring-principles §1).
      - name: format-check (advisory)
        run: node_modules/.bin/biome format .           # REPLACE with the stack formatter
        continue-on-error: true                         # format is advisory (constitution §2)
      - name: lint
        run: node_modules/.bin/biome lint .             # REPLACE
      - name: typecheck
        run: node_modules/.bin/tsc --noEmit             # REPLACE
      - name: unit-coverage
        run: node_modules/.bin/vitest run --coverage    # REPLACE
      - name: e2e
        run: node_modules/.bin/vitest run test/integration/   # REPLACE per interface (e2e.md)
      - name: build
        run: npm run build                              # REPLACE
      - name: dependency-audit (advisory)
        run: npm audit --audit-level=high || true       # REPLACE; advisory, never blocks
      # Harness infrastructure — both REQUIRED, both run in the local gate too.
      # Both run the VENDORED bundle (contract §1) — copied verbatim, never re-authored;
      # Node runs it in every stack, so a non-Node project still sets up Node above.
      - name: suppressions
        run: node .claudeconf/bin/check-suppressions.mjs
      # `project-checks` is required even when projectChecks[] is empty.
      - name: project-checks
        run: node .claudeconf/bin/check-project-checks.mjs

  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<40-char-sha>            # v4.x
      # Secret scan (whole tree). MUST exclude .git/ + lock files + vendored trees —
      # the exclude file is REGEXES (security.md, wiring-principles.md §5). Images
      # are pinned by immutable DIGEST; the comment records the tag Dependabot bumps.
      - name: secret-scan
        uses: docker://trufflesecurity/trufflehog@sha256:<digest>   # <x.y.z>
        with:
          args: filesystem . --no-update --no-verification --fail --exclude-paths .claudeconf/trufflehog-exclude.txt
      # SAST — pinned offline ruleset. The default is a SEED; vendor a curated pack
      # at a SHA or add CodeQL for real coverage (security.md).
      - name: sast (semgrep)
        uses: docker://semgrep/semgrep@sha256:<digest>              # <x.y.z>
        with:
          args: semgrep scan --error --quiet --config .claudeconf/rules/

  # The workflow file is itself a supply-chain artifact (contract §1): audit it
  # with a pinned SYNTAX auditor + pinned SECURITY auditor, recorded in the
  # manifest's ci.auditors. Run both in the local gate too — if the YAML is
  # malformed, this job never starts, so CI alone cannot be the only auditor.
  workflow-audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<40-char-sha>            # v4.x
      - name: actionlint (workflow syntax + shellcheck)
        uses: docker://rhysd/actionlint@sha256:<digest>             # <x.y.z>
      - name: zizmor (workflow security audit)
        # No `pipx run` / `uvx` — a managed step never fetches tooling at run time
        # (constitution §4.2, contract §3.3). Provision the pinned auditor first
        # (hash-locked venv, digest-pinned image, or a SHA-pinned action) and
        # invoke it by that pinned path.
        run: node .claudeconf/bin/provision-tools.mjs && zizmor .github/workflows/
# <<< claudeconf managed <<<

  # ── Project-owned jobs go BELOW the block ───────────────────────────────────
  # A regeneration rewrites the block, never what follows it. Declare each job in
  # .claudeconf/manifest.json projectChecks[] (name + tiers + a `run` substring)
  # so a regeneration that loses one FAILS instead of passing quietly.
  #
  # Supply-chain review on PRs: blocks newly-introduced vulnerable deps and
  # disallowed licenses. `dependency-review` is not a managed name (contract
  # §2.4), so it is emitted here on first generation and owned by the project
  # afterwards — not rewritten by a re-run.
  dependency-review:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<40-char-sha>            # v4.x
      - uses: actions/dependency-review-action@<40-char-sha>   # v4.x
        with:
          fail-on-severity: high
          # deny-licenses: GPL-3.0, AGPL-3.0            # set a license policy for the project
```

## Conventions

- **SHA-pin every third-party action.** Reference actions by a full 40-character
  commit SHA, never a mutable tag (`@v4`, `@main`) — tags can be repointed at
  malicious code (the `tj-actions/changed-files` compromise, CVE-2025-30066). Record
  the version in a trailing comment (`# v4.2.2`) and let Dependabot/Renovate bump the
  SHA. This is the pinned-versions invariant (constitution §4.1) applied to CI
  supply-chain inputs. Docker-image actions are pinned by immutable `@sha256:`
  digest — an exact tag is mutable and can be repointed just like `@v4`
  (wiring-principles §8); record the human-readable tag in the trailing comment.
- **Ownership: the managed block wraps ONLY the managed jobs.** The workflow header
  (`name`, `on`, `permissions`, `concurrency`, and `jobs:`) is emitted once on first
  generation and is project-owned thereafter — constrained to exactly those keys, with
  no duplicate job ids. Project jobs go BELOW the block and are declared in the
  manifest's `projectChecks[]`. A region that spans the whole file has no "outside",
  and the next regeneration deletes whatever the project added (wiring-principles §9).
  Because the header is project-owned, a regeneration cannot restore a trigger someone
  narrowed: the trigger check (contract §3.3) is the only place that is catchable.
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
  required status checks — prefer RULESETS. A generated ruleset JSON is optional
  desired-state input that a human reviews and imports (`gh api`); never imply it is
  applied (the harness cannot change GitHub settings).
