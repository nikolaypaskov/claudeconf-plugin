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
(exit 127). Invoke each tool the way its ecosystem resolves project-local
binaries:

| Ecosystem | Resolve project-local tools via |
| --- | --- |
| Node | `npx <tool>` or `node_modules/.bin/<tool>` |
| Python | `poetry run <tool>` / `uv run <tool>` / the venv, or `python -m <tool>` |
| Ruby | `bundle exec <tool>` |
| JVM / Kotlin | `./gradlew <task>` / `./mvnw …` (the wrapper) |
| Elixir | `mix <task>` (tasks resolve within the project) |
| Rust | `cargo <subcommand>` |

Tools installed GLOBALLY (e.g. a system-wide scanner) are invoked by bare name —
the distinction is project-local vs global, not the tool. A bare name often works
in a package-manager `script` (the manager injects the local bin dir into `PATH`)
yet fails in a hook — do not rely on it.

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
