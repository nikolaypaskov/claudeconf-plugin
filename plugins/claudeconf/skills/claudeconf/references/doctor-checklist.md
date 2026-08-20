# Harness Doctor — evidence-driven check procedure

The specified procedure the `harness-doctor` agent executes against a repository
holding a claudeconf harness. It is ADVISORY and read-only: report, never fix.

## Ground rules

- **Run on a high-capability model.** The bundled checker (step 0) decides every
  check it covers; what remains for the model is judging whether cited evidence is
  SUFFICIENT for the rest, and no downstream verifier re-checks that judgment —
  UNKNOWN-on-ambiguity is a prompt policy, not a mechanical safeguard, so a
  cheaper model can false-PASS. Until the checker covers a check, judgment is
  model work.

- **Validate against the RECORDED profile.** Read `constitutionVersion` from
  `.claudeconf/manifest.json` and apply that profile's checks (profile 2 lacks
  §4.7 artifacts — their absence is not a failure there; report the upgrade to the
  current profile instead). Unknown/missing profile → the report is UNKNOWN, not
  FAIL. (An ENFORCING run fails on it — but that is the gate's mode, not the
  doctor's; see step 0.)
- **Three verdicts.** PASS requires cited evidence (the exact file/line or the
  exact command + output). Anything ambiguous, unreadable, or unprobeable is
  UNKNOWN — never guessed. FAIL requires the same evidence standard as PASS.
  API 404s, permission denials, and offline registries are UNKNOWN, never
  "unprotected"/"missing".
- **Read-only policy.** No Write/Edit. Bash only for read-only inspection
  (`cat`, `git diff`, `tool --version`, `git config core.hooksPath`). This is a
  behavioral policy, not a mechanical sandbox — do not run project code, tests,
  installs, or the gate unless the user EXPLICITLY asks for the execution probe.
- **Never:** regenerate artifacts, install tools, stage/commit, change
  authentication, apply rulesets, or upgrade the profile.
- **Separate `configured` from `enforced`** in every §4.7 finding, and report
  `runtimeIsolation: not-configured` when no OS-level sandboxing is set up.

## Default (offline, static) checks

Step 0 is the deterministic one and runs first; checks 1–5 are what the model
reads to interpret what step 0 could not establish, and the manual fallback when
the checker cannot run at all.

0. **Run the bundled deterministic checker** (constitution §4.8):
   `node "${CLAUDE_PLUGIN_ROOT}/skills/claudeconf/scripts/claudeconf-check.mjs" --root . --format json --advisory`
   Its PASS and FAIL verdicts are AUTHORITATIVE and are never overturned by
   reading the tree; the model interprets the UNKNOWNs and adds probes 6–8.
   `--advisory` is the doctor's mode: UNKNOWN stays UNKNOWN and the run exits 0,
   because the doctor reports and does not gate — no advisory run ever declares a
   harness conforming. The enforcing default, where an unverifiable critical check
   fails, is what the gate job and CI use (contract §3.6). If `node` is
   unavailable, every mechanical check is UNKNOWN and the manual list below is all
   there is — say so in the report rather than presenting a read-through as
   equivalent.
1. Manifest completeness per the recorded profile (contract §3.1): nine
   milestones, pin rules, tiers incl. gate+ci, `ci.auditors` (profile ≥2),
   `agentUse` + `hookRunner{name,version}` (profile ≥3), `projectChecks` +
   `agentHardening` + `hookRunner.runnerPinned` (profile ≥4).
2. Artifact existence per the recorded profile (contract §3.2). At profile ≥5 with
   `agentUse: true` that includes `.claudeconf/delegation.md` with its four §1.2
   elements, and its `## Arbiters` set agreeing with the manifest in both directions.
   Report it as what it is — a declared rule, not an enforced one: the arbiters being
   named correctly says nothing about whether any agent followed them.
3. Wiring: every manifest tier has a matching hook/CI entry; gate carries the
   full battery; format advisory; managed `uses:` SHA/digest-pinned;
   `persist-credentials: false`; auditors wired (profile ≥2); ledger check wired
   (profile ≥3). At profile ≥4 hook wiring is read from the MERGED configuration
   AND the raw layers, since the merge hides a project-layer job that disables a
   managed one by name (contract §3.3).
4. Drift: manifest pins vs the versions configs/lockfiles actually reference;
   lockfile present + frozen installs; `git config core.hooksPath` /
   runner-installed hooks actually pointing at the runner. Executor ambiguity
   (which package provides a binary) → UNKNOWN, not a guess.
5. Profile status: recorded profile vs current — report "upgrade available"
   with the §6 migration path (`references/migrations.md`) when behind; never
   "invalid".

## `--online` (opt-in; discloses network access)

6. Registry existence of every pinned tool+version (wiring-principles §7 table).
7. GitHub protection state via read-only `gh api`: branch rules/rulesets on the
   default branch — code-owner review required, stale-review dismissal, latest
   push approval, bypass actors. Map results to `enforced` per §4.7; any API
   failure → UNKNOWN.

## Execution probe (only on explicit request)

8. `tool --version` assertions for bare-name globals (contract §3.4), and — only
   if the user asks — the gate run itself. State clearly that this executes
   project-defined commands.

## Report shape

Group by profile section; one line per check: `PASS|FAIL|UNKNOWN — <evidence>`.
Reproduce the checker's verdicts as it reported them and mark which lines are model
judgment, so a reader can tell the deterministic result from the interpretation.
End with: profile status, configured-vs-enforced summary for §4.7,
`runtimeIsolation` state, and the three most valuable next actions (advisory).
