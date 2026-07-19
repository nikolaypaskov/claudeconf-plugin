# Harness Doctor — evidence-driven check procedure

The specified procedure the `harness-doctor` agent executes against a repository
holding a claudeconf harness. It is ADVISORY and read-only: report, never fix.

## Ground rules

- **Run on a high-capability model.** PASS/FAIL judgments hinge on whether cited
  evidence is SUFFICIENT, and no downstream verifier re-checks that judgment —
  UNKNOWN-on-ambiguity is a prompt policy, not a mechanical safeguard, so a
  cheaper model can false-PASS. (A plugin-bundled deterministic checker is the
  planned profile-4 mitigation; until then, do not route the doctor down.)

- **Validate against the RECORDED profile.** Read `constitutionVersion` from
  `.claudeconf/manifest.json` and apply that profile's checks (profile 2 lacks
  §4.7 artifacts — their absence is not a failure there; report "profile 3
  upgrade available" instead). Unknown/missing profile → the report is UNKNOWN,
  not FAIL.
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

1. Manifest completeness per the recorded profile (contract §3.1): nine
   milestones, pin rules, tiers incl. gate+ci, `ci.auditors` (profile ≥2),
   `agentUse` + `hookRunner{name,version}` (profile ≥3).
2. Artifact existence per the recorded profile (contract §3.2).
3. Wiring: every manifest tier has a matching hook/CI entry; gate carries the
   full battery; format advisory; managed `uses:` SHA/digest-pinned;
   `persist-credentials: false`; auditors wired (profile ≥2); ledger check wired
   (profile ≥3).
4. Drift: manifest pins vs the versions configs/lockfiles actually reference;
   lockfile present + frozen installs; `git config core.hooksPath` /
   runner-installed hooks actually pointing at the runner. Executor ambiguity
   (which package provides a binary) → UNKNOWN, not a guess.
5. Profile status: recorded profile vs current — report "upgrade available"
   with the §6 migration path when behind; never "invalid".

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
End with: profile status, configured-vs-enforced summary for §4.7,
`runtimeIsolation` state, and the three most valuable next actions (advisory).
