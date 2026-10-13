# Profile migrations (constitution §6)

Each list below is the COMPLETE delta between two ADJACENT conformance profiles —
everything a harness must change to satisfy the next one. The lists are what the
skill's `upgrade` mode applies, and what a human doing the same work by hand
follows.

The procedure around them is the same for every migration and is not repeated in
the lists:

1. **Check the harness against its RECORDED profile first**, with the bundled
   checker in its enforcing default. A harness already failing its own profile is
   fixed BEFORE it is migrated — otherwise the migration inherits the failure and
   the new profile's report hides it (constitution §4.8). ONE carve-out, because
   without it this step can be unsatisfiable: where the recorded-profile failure is
   the very thing the target profile's delta list EXISTS to fix, it cannot be fixed
   first without doing the migration. Carry that failure into the migration, name it
   in the report as carried, and require it GREEN at the end. Verified on this
   repository's own 3→4 move: its only profile-3 failure was the unpinned hook
   runner, which is a profile-4 control, so a literal reading of this step meant the
   migration could never start.
2. **Apply the delta list for recorded→next, in order**, using the managed-block
   and ownership rules (constitution §4.4). A multi-profile jump applies the lists
   in sequence — 2→4 is 2→3 and then 3→4 — never merged into one step.
3. **Check against the NEW profile.** A dry run before committing to the move uses
   the target-profile flag, which runs the target profile's checks IN ADDITION to
   the recorded profile's, never instead of them, so the dry run cannot hide a
   regression against what the harness claims today (contract §3.6).
4. **Verify by executing**: the pre-commit tier and the gate tier both actually run
   green, with every command executed rather than skipped (contract §3.4).
5. **Human-review gate**: present the checker's per-check output as the evidence,
   together with any classification decisions the list called for.
6. **Only then bump `constitutionVersion`.** Never bump first. The field is the
   harness's claim about itself and selects the checks it is judged by, so a bump
   ahead of the controls makes every later verification answer the wrong question
   (constitution §6).

Nothing here is retroactive: a harness at an older profile stays VALID against that
profile until it is migrated. The report says "upgrade available", never "invalid".

---

## 2 → 3

Profile 3 adds the merge trust root (constitution §4.7): the control plane gets a
human owner, and silencing a check becomes a recorded decision.

- Add the suppression approval ledger `.claudeconf/suppressions.json` (an empty
  array is valid) and its check script, and wire the check as a `suppressions` job
  in the gate AND as a step in CI (contract §1).
- Add ownership entries for the DERIVED control plane to `.github/CODEOWNERS` —
  every artifact capable of weakening the harness, including CODEOWNERS itself.
  Derive the list from the generated harness rather than hardcoding it
  (agent-hardening §1).
- Print the enforcement checklist with the outcome reported as `configured`; the
  branch rules that would make it `enforced` are a human action the harness cannot
  take (constitution §4.7).
- `.claude/settings.json`: add the agent-hardening module — the `permissions.deny`
  entries and the SessionStart advisory hook (agent-hardening §3, §4). No Stop hook.
- Manifest: add `agentUse` (default `true`; `false` is a review-gate decision and
  requires `agentUseRationale`), and upgrade `hookRunner` from a bare name to
  `{ name, version }` with the runner's exact pinned version.

## 3 → 4

Profile 4 splits OWNERSHIP so a regeneration cannot silently absorb or delete the
project's own checks (constitution §4.4), and makes a deterministic checker the
arbiter of conformance (§4.8).

Two of its steps are HUMAN decisions taken at the review gate, and every mechanical
step depends on their outcome. Do them first, and do not let a tool make them.

### Step A — classify every existing job (decision; nothing moves before it)

Profile 3 recorded no PER-JOB ownership metadata, so which existing jobs are managed
and which are project-owned cannot be DERIVED from the tree. (It is not that there is
no evidence at all: a profile-3 harness marked a whole-file managed REGION in both the
hook config and the workflow, which is provenance at region granularity. What it cannot
do is distinguish a generated job from one the project wrote and the region later
swallowed — which is exactly the case that matters.) It has to be decided, and SHOWN.
Build a table covering every job in the profile-3 hook config and every job and step in
the CI workflow:

| job / step | where it lives today | managed or project-owned | why |

Fill it under one rule: **everything defaults to project-owned, whatever it is
called.** A name matching a managed token (contract §2.4) is not evidence of
ownership — a project's own `lint`, `build`, `unit`, or `e2e` job is entirely
plausible. A job becomes managed only by explicit human approval at the review
gate, or by a positive provenance match (a generated template the harness
recognises); profile 3's region-level marking cannot supply that match, so for this
migration the answer is always the human.

The default is asymmetric on purpose. A managed job mis-classified as project-owned
merely stays where it is and gains a `projectChecks` entry — a preserved check and
a redundant declaration. A project-owned job mis-classified as MANAGED is moved
into the wholly-managed file, which the next regeneration rewrites wholesale: the
job disappears, the gate stays green, and nothing reports it. That is the exact
failure this profile exists to close. Say so at the gate — approving a job as
managed authorises a future regeneration to rewrite or delete it.

### Step B — decide every managed-name collision (decision; never automatic)

Contract §2.4 makes managed names a CLOSED set no project-owned job may use. The
reason is mechanical, not stylistic: the runner MERGES same-named jobs across the
composition boundary, so a project-layer job named for a managed one contributes
its fields to the managed job and can disable it while the merged configuration
still shows the correct command (wiring-principles §9). A collision left in place
is a check that reports green having run nothing.

For every existing job whose name is in the managed set, present BOTH options at
the gate and let the human pick:

- **Adopt** it as the generated milestone: it moves into the managed file and the
  harness owns it from now on. This is usually the right answer — an existing
  `lint` job normally IS the lint milestone, and the skill already prefers the tool
  the project is already using.
- **Rename** it out of the set and keep it project-owned, with a `projectChecks`
  entry under the NEW name. This is the right answer when the job merely shares a
  word: a `build` job that builds documentation is not the build milestone.

Never rename silently and never adopt silently. The first takes away a command the
team types every day; the second is precisely the absorption the ownership split
exists to prevent.

### Step C — mechanical changes

- **Split the hook config.** Create the wholly-managed `.claudeconf/lefthook.yml`
  holding every generated hook, headed by a comment saying it is generated and
  rewritten wholesale on re-run, with no sentinels — the whole file is the managed
  region. Replace the root file's managed region with a managed block holding the
  `extends` list naming that file, preserving any foreign entries already in the
  list, PLUS any top-level runner setting the runner does not merge across
  `extends` (see the next step — that block is defined by ownership, not by
  content). Jobs Step A classified project-owned move BELOW the block
  (contract §1). A constitution
  §5-exception runner (`.pre-commit-config.yaml`) has no composition mechanism:
  keep its single-file managed-region model, apply every other step here, and
  record the asymmetry instead of implying parity.
- **Apply the naming rule.** Rename managed jobs to the contract §2.4 tokens where
  they differ, and rename project-owned jobs out of that set per Step B.
- **Pin the runner — in the layer the runner actually READS.** Set the runner PATH
  field (the one the installed shim consults before `PATH`), the assert-installed
  flag so a missing runner aborts instead of printing a notice and exiting 0, and
  the minimum version equal to the manifest's `hookRunner.version`. Determine BY
  EXECUTION which of these the runner merges across `extends` and which it does
  not; a setting written only where the runner ignores it is a control that does not
  exist. Verified against lefthook 2.1.9: `assert_lefthook_installed` and
  `min_version` DO merge, and `lefthook:` DOES NOT — so the path goes in the ROOT
  file's managed block, with contract §1's copy in the managed file kept in
  agreement. Then confirm the pin by RESOLUTION, never by reading the setting back:
  with the path written only in the managed file, the config-reading checks passed
  while every hook ran a global binary. Add the runner to the version-assertion
  script, resolved exactly the way the shim resolves it —
  environment override, then the configured path, then `PATH` — so the assertion
  probes the executable that will actually run the hooks (contract §3.4). Where the
  ecosystem cannot provide a pinned path, record `hookRunner.runnerPinned: false`
  together with the REQUIRED `runnerPinnedRationale` string — that exact field name,
  not one you invent — rather than presenting the recorded version as a control
  (contract §2.3).
- **Remove every on-demand package runner.** Hooks, gate jobs, managed CI steps,
  the `.claude/settings.json` hook command, and the SessionStart advisory text all
  invoke tools by their pinned path, rooted at the repository. No form is exempt —
  including the no-install flag, which a cached foreign package of the same bin
  name still satisfies (wiring-principles §1).
- **Add the project-check assertion**, written in a runtime the project ALREADY
  requires (`scripts/check-project-checks.<ext>`), with zero third-party
  dependencies, wired as gate job `project-checks` AND as CI step `project-checks`
  — present even when nothing is declared, so declaring a check later needs no
  rewiring. A project with no scripting runtime at all omits the artifact and
  records `projectChecks: []` plus `projectChecksRationale` naming the missing
  runtime (contract §1, §2.3).
- **Audit every managed job for a swallowed exit status.** A trailing `|| true` on a
  hook or gate command, and `continue-on-error: true` on a managed CI step or on its
  job, leave a check present, running, and incapable of failing — so a profile-3
  harness that acquired one has been reporting green for a control that stopped
  working. Remove them everywhere EXCEPT the milestones the constitution records as
  ADVISORY in its §2 mode column — today `format` and `dependency-audit` — where the
  swallow is the specification and stays (contract §3.3).
- **Check what a raised runtime floor does to PRESERVED jobs.** Verified during this
  profile's own fixture migration: adding `engine-strict=true` alongside a raised
  `engines` floor turned a hand-written, project-owned CI job into a hard
  `EBADENGINE` failure. That is a harness action breaking a project-owned check — the
  exact class the ownership split exists to prevent — and no check catches it, because
  the harness only ever inspects what it owns. Before raising a floor, run the
  project-owned jobs; a migration that hardens the managed half by breaking the other
  half has not migrated anything.
- **Manifest, everything except the version field.** Add `projectChecks[]` — one
  entry per job or step Step A classified project-owned, each with `name`, the
  `tiers` it runs at, and the REQUIRED `run` substring of the command it must
  actually execute (a name alone protects nothing: `exit 0` satisfies it). Add
  `agentHardening.denyPatterns` (the exact deny strings the harness owns) and
  `agentHardening.managedHooks[]` (the authoritative record of which settings
  entries it owns). Add `hookRunner.runnerPinned`. The `constitutionVersion` bump
  is the LAST action of the whole migration, per the procedure above.
- **`.claude/settings.json` becomes entry-level managed.** Remove the file-level
  managed marker — a profile-3 harness marked the WHOLE file, which is why a re-run
  could take the project's own entries with it. Mark the managed entries themselves
  for human readers and record them in the manifest, which is the authority; a
  re-run then rewrites exactly those entries and nothing else.
  Replace the deny set with the `**/`-anchored patterns (agent-hardening §3),
  keeping project-added deny entries. Rewrite the hook command to parse its payload
  with the project's own runtime by an absolute project-rooted path — dropping any
  undeclared global helper, and any bare global interpreter for which a
  project-rooted path EXISTS (a Node runtime has none: `node` stays bare and the
  residual is recorded, contract §1) — and exclude lockfiles from its file glob.
- **Re-lay the CI workflow by ownership.** The managed block wraps ONLY the managed
  jobs and their managed steps; the header — `name`, `on`, `permissions`,
  `concurrency`, and the `jobs:` key — moves OUTSIDE the block and stays
  project-owned, constrained to exactly that allowlist: no workflow-level `env` or
  `defaults` (they alter managed jobs from outside), no duplicate job ids (they
  shadow managed definitions). Rename managed step names to the §2.4 tokens. Jobs
  and steps Step A classified project-owned move below the block and gain
  `projectChecks` entries, under a comment above the block saying that is where
  they belong. While in the file, re-check the triggers: the header is
  project-owned, so a narrowed trigger that produces no pre-merge signal is only
  catchable here (contract §3.3).
- **Hash-lock the interpreter-based tool environments.** A milestone tool or
  workflow auditor installed through a language package manager rather than as a
  single binary is installed from a hash-locked requirement file into an
  environment built on a PINNED interpreter — locally and in CI — and invoked by
  its path inside that environment. Compiling the requirements against whatever
  interpreter happens to be present is a pin in name only, so record which
  interpreter the compiled file targets. An on-demand runner is not an
  installation (contract §3.3).
- **Extend CODEOWNERS** to the artifacts this profile adds — the managed hook
  config and the project-check assertion — wherever the existing derived entries do
  not already cover them (constitution §4.7.1).
- **Re-run the runner's `install`.** REQUIRED wherever the harness is installed, not
  tidy-up: the runner-pinning fields are baked into the installed hook shims at install
  time, so without a reinstall the shims keep resolving the old runner and the pin is a
  claim. Confirm the installed shim now contains the pinned-path branch (contract §3.2).
  A harness that is not installed in this working copy — a shipped exemplar, a tree
  nobody has run `install` in — cannot satisfy this step, and that is machine state
  rather than harness content: the checker reports it unverified in both modes and the
  step is satisfied at the point the harness is actually installed.

Then the shared procedure resumes at step 3: the checker at profile 4 in enforcing
mode, the executable verify of pre-commit and gate, the human-review gate with the
classification table and the checker output as its evidence, and the
`constitutionVersion` bump last.

## 4 → 5

Profile 5 adds one artifact and one obligation on an existing one. It is the smallest
delta in the series: no ownership moves, no new tier, nothing to reclassify. Everything
the record names is already recorded in the manifest — the migration is writing it down
where the agents working in the repository will read it, and wiring the two checks that
keep it from rotting.

- **Write `.claudeconf/delegation.md`** to the contract §1.2 format: `## Rule`,
  `## Arbiters`, `## Never delegable`, `## What this record is not`. Derive the arbiter
  list from the harness rather than from memory — the pinned gate invocation (the runner
  path the hook config declares plus the gate subcommand), every `projectChecks[].name`,
  and `ci.workflow`. Deriving it any other way is precisely the drift `D9` exists to
  catch, and it will catch yours.
- **Extend the SessionStart advisory** to the two-sentence template: the declared profile
  and gate command as before, then the pointer at the record. Both interpolated values are
  now reconciled against the manifest, so an advisory left at `profile 4` FAILS after the
  bump — expected, and the reason this step comes before the bump rather than after.
- **Extend CODEOWNERS** to `.claudeconf/delegation.md` wherever the existing derived
  entries do not already cover `.claudeconf/`. The record is on the protected surface: it
  states what may be delegated, so an unreviewed edit to it widens what may be delegated.

Then the shared procedure resumes: the checker at profile 5 in enforcing mode, the
human-review gate, and the `constitutionVersion` bump last.

**What does NOT happen to a harness that stays at 4.** Nothing. `A16`, `D9`, and the
advisory reconciliation are level-5 checks; a profile-4 harness runs the profile-4 set and
reports the upgrade as INFO. If you see new failures on a profile-4 harness after taking
this release, that is a bug in the checker, not a migration you owe.

## 5 → 6

Profile 6 stops a harness from failing its own gate on the most ordinary event in a
repository's life — a dependency update — and makes the support scripts something a harness
SHIPS rather than something each generation writes. Every step below replaces a copy with a
reference: a version copied into the manifest becomes a pin into the file that owns it, and a
script written per project becomes the bundle's, vendored and verified byte for byte.

Order matters twice. The vendored scripts read the new pin form, so the bundle and the pins
land in ONE change — the vendored `assert-tool-versions.mjs` refuses a manifest of literals,
and a profile-6 manifest without the bundle fails A17. And every old script is deleted
in the same change that rewires its callers, never before: search the hook config, the CI
workflow and the docs for each old path, and delete only when nothing calls it.

- **Vendor the bundle.** Copy the skill's `scripts/harness/` directory — `lib/` included,
  byte for byte — to `.claudeconf/bin/`, and record `harnessScripts: { "version" }` from the
  bundle's `VERSION`. Rewire every caller to `node .claudeconf/bin/<script>.mjs`: the
  `suppressions`, `project-checks` and `tool-versions` gate jobs and CI steps, and the CI
  provisioning step. Then delete what they replace — the project's own
  `check-suppressions`, `check-project-checks` (`.mjs` and `.py`), `assert-tool-versions`
  and `provision-tools` scripts. A17 fails a hook or CI command that still runs one of these
  names from anywhere but `.claudeconf/bin/`. Do not port project-specific logic INTO a
  vendored file: A17 fails any byte that differs from the bundle. A check only this project needs becomes a
  `projectChecks` entry of its own.
- **Pin the runtime.** Add `runtimes` with at least `node` — a `version-file` pin to an
  exact version (`.nvmrc` holding `24.21.0`, never `lts/*` or `24`). The vendored scripts run
  on Node in EVERY stack, so a Python-only CI job gains a SHA-pinned `setup-node` step reading
  that file before the first vendored script runs. Pin any other runtime the harness
  provisions against the same way.
- **Replace every `version` with a typed `pin`** (contract §2.5) — each milestone and each
  `tools[]` element, each `ci.auditors[]` entry, and `hookRunner`. Choose the kind by where
  the tool is ACTUALLY pinned, never by convenience: `npm-lock` / `uv-lock` for a
  package-manager tool (the lockfile is its only version source — and `package.json` must
  declare that exact version, not a range), `requirements` for a hash-locked pip set,
  `tools-lock` for a checksum-provisioned binary, `runtime` for anything that versions
  through a runtime (it replaces `"n/a"`). A pin that does not resolve is a FAIL in every
  check that reads it, so the checker's run after this step is the test of every choice.
- **Move provisioning data into `.claudeconf/tools.lock.json`.** Every version, URL, sha256,
  archive type and member the old provisioning script held, for every platform it served —
  copied VALUE FOR VALUE from the script. Do not re-download to recompute a digest: one
  computed from a download already trusted proves nothing (§2.5). A hash-locked requirement
  file may stay where it is or move; the `requirements` pin names its path either way.
- **Leave the hook runner's `min_version` alone.** At profile 6 it is a FLOOR at or below the
  resolved runner pin, not a second copy of it — which is what lets an updater bump the
  runner in the lockfile and nowhere else.
- **Scan the candidate, not the working directory.** Rewire every whole-tree scanner in the
  gate to `node .claudeconf/bin/scan-tree.mjs -- <scanner> … {tree} …` — the scanner's own
  flags and exclude file unchanged, `{tree}` exactly once where the path argument was. It
  scans the index, which is what CI's checkout contains; ignored and untracked files leave
  the local scan, and they were never in CI's. CI keeps scanning its own checkout.
- **Remove updater keys the service rejects.** Dependabot accepts `semver-*-days` only for
  ecosystems that version by SemVer; under `github-actions`, `docker`, `terraform` and the
  other default-days-only ecosystems it rejects the WHOLE file, so updates stop for every
  ecosystem in it (checker A3). Keep `default-days` there.
- **Make every required check run on every pull request** (checker W21). A CI step answering
  a milestone or a declared project check, and the job holding it, carries no `if:` beyond
  `always()` / `success()` and references no repository secret other than `GITHUB_TOKEN`:
  bot and fork runs receive no repository secrets, and a skipped required check reports
  green. Secret-needing work moves into an ancillary step; actor identity may select what
  that step does, never whether a required check runs.

**The suppression gate sees this migration, and it should.** Each deleted script is a
`control-removal`, the moved provisioning values are `pin-change`s, and each rewritten scanner
line still carries its exclusion. Record one ledger entry per finding, naming what REPLACES
the control and — for the lock — that its values are the old script's, unchanged. That entry
is the reviewer's evidence that the migration moved controls rather than dropping them.

Then the shared procedure resumes: the checker at profile 6 in enforcing mode, with A17 and
every typed pin resolving; the executable verify of pre-commit and gate; the human-review
gate; and the `constitutionVersion` bump last. After the bump the history records 6, so the
harness is judged at 6 from then on — lowering the field later changes nothing.

**What does NOT happen to a harness that stays at 5.** A17, M13, the typed-pin rules, the
`min_version` floor, A3's updater keys and W21 are level-6 rules; a profile-5 harness reports
each as INFO naming the profile it arrives with. One of those INFOs is worth acting on
without migrating: an A3 updater-key INFO means Dependabot is rejecting the file TODAY, and
removing the key is a one-line fix that needs no profile change.
