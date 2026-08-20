# Harness Wiring Principles (technology-agnostic)

These are the cross-cutting correctness principles for wiring **any** harness,
independent of language, framework, or tool. They are the generic "how to wire it
so it actually runs" layer:

- `constitution.md` fixes **what** must be true (tiers, milestones, determinism).
- `patterns/*.md` are thin, OPTIONAL per-stack anchors — a starting tool per
  milestone, nothing more.
- **This file** is where harnesses actually break. It is not bound to any stack;
  it states the principle, then shows the equivalent across ecosystems so you can
  research and apply it to whatever project is in front of you.

Apply every principle to the tools you actually researched and chose. The examples
are illustrative, not a menu — find the project's real equivalent. This is part of
practising modern AI-assisted-coding hygiene: the generated harness must run
unattended and deterministically, with zero claudeconf/Claude involvement at
execution time.

---

## 1. Hook commands must resolve the project's OWN tools

A git hook runs in a minimal shell that does NOT inherit the developer's
interactive `PATH`. A tool installed as a project-local dependency is therefore
not on the hook's `PATH`; invoking it by bare name fails with `command not found`
(exit 127). Invoke each tool by the PINNED PATH its ecosystem installs it at, so a
missing install fails loudly instead of resolving to something else:

| Ecosystem | Resolve project-local tools via |
| --- | --- |
| Node | `node_modules/.bin/<tool>` (never `npx` / `npm exec` — see below) |
| Python | `.venv/bin/<tool>`, `python -m <tool>`, or a locked-env runner (`uv run`) |
| Ruby | `bundle exec <tool>` |
| JVM / Kotlin | `./gradlew <task>` / `./mvnw …` (the wrapper) |
| Elixir | `mix <task>` (tasks resolve within the project) |
| Rust | `cargo <subcommand>` |

Root every relative path at the REPOSITORY, not at the process working directory —
a git hook, an editor hook, and a CI step do not all start in the same place. Use
the runner's repo-root variable, the editor's project-directory variable, or
`git rev-parse --show-toplevel`.

**Pinning the binary you invoke is not enough if that binary resolves its OWN
helpers by bare name.** Verified on 2026-08-19 in this repository: a hash-locked
semgrep 1.168.0, invoked by its pinned path, answered `--version` with `1.171.0` —
its entry point looks up the companion `pysemgrep` through `PATH` and APPENDS its
own directory rather than prepending it, so a homebrew copy won. Every integrity
property upstream of that lookup was intact and irrelevant; the pin was verified
and the wrong program ran.

So a provisioned tool directory must come FIRST on the `PATH` the checks run
with, not merely be referenced by absolute path, and a version assertion must
probe the executable that will actually run (contract §3.4) rather than the one
the config names. Treat any pinned tool that shells out to a companion — a Python
console script calling its own module, a wrapper calling a driver binary, a linter
invoking a formatter — as unpinned until the companion's resolution is pinned too.
This is the same defect as an on-demand package runner, one level further down: in
both cases something resolves by NAME at execution time, and a name is not an
identity.

Tools installed GLOBALLY (e.g. a system-wide scanner) are invoked by bare name —
the distinction is project-local vs global, not the tool. A bare name often works
in a package-manager `script` (the manager injects the local bin dir into `PATH`)
yet fails in a hook — do not rely on it.

**Never reach a pinned tool through an on-demand package runner — in ANY form.**
An on-demand runner (`npx`, `npm exec`, `uvx`, `pipx run`, `bunx`, `pnpm dlx`)
resolves by BIN NAME: when the pinned dependency is absent it FETCHES whatever
registry package is named like the binary and runs that instead. Observed on
2026-08-18 in a checkout whose `node_modules/` was empty — `npx tsc` ran the
unrelated `tsc` package ("This is not the tsc command you are looking for"), `npx
biome` ran the unrelated `biome` package, and `npx lefthook` ran 2.1.10 while the
lockfile pinned 2.1.9. A pre-commit run therefore executed foreign code, and a
different runner version, silently.

The no-install flag is NOT a safe alternative. It only declines to install NOW: a
foreign package of the same bin name that an earlier stray invocation left in the
runner's cache still satisfies it. Verified the same day, with no `node_modules`
present and no global install, `npx --no-install biome --version` and `npm exec
--no -- biome --version` both printed `0.3.3` — the unrelated `biome` package from
the cache, not `@biomejs/biome`. There is no safe on-demand form for a pinned tool,
so the rule is unconditional; the consequence — a missing install now fails the
hook at exit 127 instead of running something nobody pinned — is the intended
behaviour (constitution §4.2/§4.3).

This reaches the EDIT-tier hook too, which is a hook like any other: it parses its
JSON payload with the runtime the project ALREADY requires, invoked by an absolute
project-rooted path (`$CLAUDE_PROJECT_DIR/node_modules/.bin/…`,
`$CLAUDE_PROJECT_DIR/.venv/bin/python`) — never an undeclared global helper such as
`jq`, whose absence a trailing `|| true` hides forever, and never a bare global
interpreter (contract §1). BOUND, where the runtime IS the interpreter: a project
whose runtime is Node has no `$CLAUDE_PROJECT_DIR/node_modules/.bin/node` to name,
so a bare `node` is accepted there and the residual is recorded — four of the five
harnesses built from this document do exactly that, and a rule none of them can
satisfy teaches generators to skip the sentence rather than to obey it. Where a
project-rooted path exists (`.venv/bin/python`, `node_modules/.bin/<tool>`), it is
required. Exclude lockfiles from its file glob: an autofix that
rewrites `package-lock.json` on edit churns a file the package manager owns.

## 2. Coverage at the gate needs its provider installed and pinned

Asking a test runner for coverage usually requires a SEPARATE, pinned coverage
provider/plugin. Wiring the coverage flag without it fails at the gate.

| Ecosystem | Coverage needs |
| --- | --- |
| Node + vitest | `@vitest/coverage-v8` pinned to the vitest version |
| Python + pytest | `pytest-cov` |
| JVM | the JaCoCo plugin |
| Elixir | `mix test --cover` (built in) or `excoveralls` |
| Go | `go test -cover` (built in) |

When the coverage milestone is wired, add the provider as a pinned dependency too.

## 3. The CI environment must match the researched stack

The CI runner OS and the language-setup step follow the project's stack — never a
default. Pick them from what the research step found, not from a template.

| Stack | Runner / setup |
| --- | --- |
| Node | `ubuntu-latest` + `actions/setup-node` |
| Python | `ubuntu-latest` + `actions/setup-python` |
| JVM / Kotlin | `ubuntu-latest` + `actions/setup-java` + the gradle/maven wrapper |
| Elixir | `ubuntu-latest` + `erlef/setup-beam` (elixir + otp versions) |
| Swift / Apple | `macos-latest` (the Xcode toolchain is macOS-only) |

A node-shaped CI (`ubuntu-latest` + `setup-node`) on a Swift or JVM project simply
won't run.

## 4. Formatters and linters must not scan generated or foreign config

A whole-tree format/lint pass descends into directories it should not touch.
Exclude:

- the harness's OWN generated metadata (`.claudeconf/`, the Claude settings dir) —
  re-formatting or linting generated files produces spurious failures;
- nested or sub-project tool configs (a `biome.json` / `.eslintrc` / `ruff.toml`
  inside a fixtures or sub-package directory) — many formatters error on a nested
  "root" config they discover during the walk;
- vendored / generated code already ignored by VCS.

Use the tool's own ignore mechanism (an `includes` / `ignore` field, or the VCS
ignore file) scoped to the project's real source.

The exclusion interacts with staged-files hooks: a changed-files job can hand the
tool a list where EVERY file is ignored by its config, and many tools treat "no
files processed" as an ERROR (biome exits non-zero unless invoked with
`--no-errors-on-unmatched`), failing the hook on an innocent commit. Wire the
tool's unmatched-files escape hatch (or narrow the runner's glob) so an
all-ignored file list is a no-op, not a failure.

## 5. Whole-tree security scanners exclude VCS metadata and vendored paths

A secret scan or SAST pass that runs over the WHOLE tree in CI (not just changed
files) must exclude:

- **VCS metadata — `.git/` above all.** CI checkout actions inject an ephemeral
  access token into `.git/config`; a secret scanner will flag it and fail every
  run. This is a guaranteed false positive, not a finding.
- lock files and vendored dependencies (noise, not project secrets).

Use the SCANNER'S OWN exclude syntax — it differs per tool and per surface. A hook
runner's file filter may take GLOBS while the scanner's `--exclude-paths` file
takes REGEXES; the same intent is spelled two ways, and a glob handed to a regex
engine fails to compile. (See `patterns/security.md` for the trufflehog/semgrep
instantiation.)

## 6. Verify by EXECUTING, at the tier that actually runs the command

A self-verify that does not run the tools proves nothing. A clean-tree hook run
SKIPS every file-scoped command, so it exits 0 without invoking anything.

- Run the pre-commit hook with files actually present (a staged file, or the
  runner's all-files / force mode) — confirms tool resolution (principle 1).
- Run the GATE sequence (whole-repo format/lint, coverage, e2e, SAST, whole-tree
  secret-scan, build) — confirms what pre-commit's changed-files scope never
  exercises (principles 2–5).

Surface failures at generation time, before the human-review gate — not on the
first CI push. (This is `harness-contract.md` §3.4.)

## 7. Confirm every chosen tool and version actually exists

Tool and version choices come from research, and research can be wrong: LLMs (and
people) hallucinate package names and pick versions that were never published. A
*pinned* wrong version is worse than a floating range — it looks deliberate — and a
hallucinated-but-registerable name is a supply-chain hole (slopsquatting).

Before writing a tool+version into the manifest or a config, confirm BOTH exist on the
authoritative registry:

| Ecosystem | Confirm existence with |
| --- | --- |
| npm | `npm view <pkg>@<version> version` (errors if the pair doesn't exist) |
| PyPI | the JSON API / `pip index versions <pkg>` |
| Cargo | crates.io / `cargo search` |
| Go | the module proxy (`go list -m <mod>@<version>`) |
| Docker images | the registry's tag list |
| GitHub Actions | the ref resolves to a real commit — and you SHA-pin it anyway (principle 3, §4.1) |

Treat a name or version that cannot be confirmed as a hard error: do not pin it. This
check is cheap and closes the gap between "research said X" and "X is real."

## 8. Execute the bits you pinned

Recording a version proves nothing about what actually runs. Three gaps recur, and
each has a mechanical close:

- **Fresh resolution behind a pinned facade.** An install without the lockfile's
  frozen mode re-resolves transitive dependencies at run time — `npm install`
  instead of `npm ci`, `pip install` instead of a locked sync. Worse is a silent
  fallback (`npm ci || npm install`): the pipeline stays green while quietly
  switching to fresh resolution. Commit the lockfile (generated with the pinned
  package-manager version) and use ONLY the frozen mode, with no fallback.

  | Ecosystem | Frozen install |
  | --- | --- |
  | npm | `npm ci` |
  | pnpm | `pnpm install --frozen-lockfile` |
  | Python (uv) | `uv sync --locked` |
  | Ruby | `bundle install --frozen` / `BUNDLE_FROZEN=true` |
  | Rust | `cargo build --locked` |

- **Mutable image tags.** A docker image tag (`tool:1.2.3`) can be repointed just
  like a git tag. Pin images by immutable `@sha256:` digest and record the
  human-readable tag in a comment for the updater to bump.
- **Untracked global binaries.** A hook that invokes a globally-installed scanner
  by bare name executes whatever version the machine happens to have — the manifest
  pin is a claim, not a control. Add a gate-tier assertion that parses each such
  tool's `--version` and hard-fails on a mismatch with the manifest OR on output it
  cannot parse. (This is version enforcement; checksum/Sigstore-verified
  provisioning is the stronger control where the effort is warranted.)

  **Say what that assertion does NOT cover, because its tier is part of its meaning.**
  It is a GATE-tier control (contract §3.4), so every earlier tier that invokes the
  same global by bare name still runs whatever is installed. Observed in this project
  on 2026-08-19: a pre-commit run's banner reported trufflehog 3.96.0 while the
  manifest pinned 3.95.6, and the gate — run with the provisioned toolchain — asserted
  3.95.6 and passed. That is the specification working as written, not a defect; but a
  harness that presents pre-commit as pinned is claiming a control it does not have at
  that tier. Report the pre-commit scan as a fast first layer, and the gate and CI as
  where the pin is enforced.

## 9. Ownership before sentinels: managed content needs an "outside"

A sentinel-delimited block says WHERE the generator writes. It does not by itself
say what the generator OWNS — and when the two are conflated, a regeneration
deletes the project's own checks while the pipeline stays green, now checking less
than it did. Decide ownership FIRST, then pick a file layout that can express it.

**A managed region only protects what is outside it.** In a config whose single
top-level key holds every job, any project-owned job lands INSIDE the region, so
there is no outside and a wholesale rewrite takes it along. Where one file cannot
host both owners, the managed content moves into a WHOLLY MANAGED file that the
project-owned file composes, and the project-owned file keeps only the composition
statement inside a one-line managed block (constitution §4.4).

- **A runner config with a composition mechanism** (an `extends` / `include`
  list): the managed file holds every generated job; the project-owned file names
  it in that list and carries the project's own jobs itself.
- **A CI workflow with no include mechanism** (GitHub Actions): the block wraps
  ONLY the managed jobs; the header — `name`, `on`, `permissions`, `concurrency`,
  and the `jobs:` key — is written once outside it and stays project-owned;
  project jobs go BELOW the block.
- **A format with no composition at all** (`.pre-commit-config.yaml`): a
  single-file managed region, in which the manifest declaration described below
  is the ONLY protection a project-owned check has. Record the asymmetry; never imply parity.

**Composition is a MERGE, and a merge is a namespace.** Where the runner merges
entries by NAME across layers, a project-layer entry named for a managed one does
not replace it — it contributes fields to it, and can disable it while the merged
configuration still shows the correct command. Verified on lefthook 2.1.9: a
managed `gate.lint` running a real command, plus a root-file `gate.lint` carrying
nothing but `skip: true`, merged into one job whose dump still showed the managed
command — and the run reported `lint (skip) by condition` and exited 0. Two
mechanical consequences:

- Managed names are a CLOSED set that no project-owned entry may use (contract
  §2.4). The set exists to be tested against, not as a naming convention.
- Verify the RAW layers as well as the merged view, because the merge hides exactly
  the divergence you are looking for: every managed entry must survive into the
  merged configuration FIELD-IDENTICAL to its declaration, and no project layer may
  declare a managed name, nor an execution control (`skip`/`only`) at hook scope or at
  job scope on a job the harness guarantees — a managed-named one, or one a
  `projectChecks` entry declares (contract §3.3). `exclude` is a FILE FILTER, not an
  execution control, and is only judged on a guaranteed job, where a filter that
  cannot be shown to leave files stops being a filter.

**Declare what the PROJECT owns, on the other side of the boundary.** Ownership is
symmetric, so the protection is too: the manifest lists the project's own checks
with the tiers each runs at and a substring of the command each must actually
execute, and a generated assertion fails when a declared check stops resolving
(contract §1, §2.3). Without it, a regeneration that drops a project check is
silent — the one failure a green gate cannot show you.

**Ask the runner for the merged view; never hand-merge it.** Whatever produces the
merged configuration is the authority on what will run. Two practicalities recur. A
runner that locates the repository root through VCS dumps the OUTER repository's
configuration when a harness is nested inside another repo (a fixture tree, a
vendored example) — copy the project-owned file, the managed file, and any
local-override file into a temp directory, initialise a repository there, and dump
inside it. And a VCS-IGNORED local override layer (e.g. `lefthook-local.yml`)
overrides every other layer by design: report its presence as what it is — a local
bypass equivalent to `--no-verify` — never as a merge-boundary control.
