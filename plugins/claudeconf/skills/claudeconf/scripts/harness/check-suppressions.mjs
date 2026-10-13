#!/usr/bin/env node
// Suppression approval gate (constitution §4.7.2 / contract §1) — a NOTIFIER, NOT AN ARBITER.
//
// It diffs this change against a base and reports every ADDED, CHANGED, or REMOVED thing that
// MATCHES ONE OF ITS PATTERNS and has no entry in `.claudeconf/suppressions.json`:
//
//   <token>            an inline suppression token (biome-ignore, nosemgrep, noqa, …)
//   exclusion-widening any added line in a scanner exclude/ignore file
//   config-weakening   an added line matching a weakening shape in a generated control config
//   control-removal    a control whose IDENTITY disappeared from the harness — a hook section,
//                      a named job, a workflow job or step, a SAST rule id, a pinned tool —
//                      or the deletion of a harness file outright. A command that is REWRITTEN
//                      while its identity survives is a modification, judged by the rules
//                      above; calling that a removal buries the one real finding under dozens
//                      of "the file moved" entries, and noise is how a real entry gets waved
//                      through.
//   pin-change         a PIN whose value changed while its identity survived: a release
//                      digest, a pinned tool version, an asset URL or archive member, a
//                      requirement's wheel-hash set. The one place where a surviving identity
//                      is NOT reassurance — the pin table is the trust root of the provisioned
//                      toolchain, so editing a digest puts different bytes on the machine with
//                      every structural check still green.
//
// WHAT THIS GATE DOES NOT DO — read this before trusting a green run.
//
// The pattern sets below are an ENUMERATION OF DANGEROUS SHAPES, and an enumeration is always
// one shape short. A green run means "nothing matched the patterns", which is NOT "no control
// was weakened". It cannot be: proving non-weakening across an arbitrary diff is not something
// a regex can demand, the way `check-project-checks.mjs` can demand proof of propagation for
// ONE named command. The enumeration is acceptable HERE and nowhere else in this harness for
// exactly one reason: this gate's output lands in a diff a human reviews, so a miss degrades
// to the review that was happening anyway. The checker's verdict is final and unreviewed, so
// the same construction there would be a false PASS nobody catches.
//
// THREE BOUNDS BELOW ARE DELIBERATE. Each was chosen against the alternative of reporting
// more, because a rule that files entries nobody acts on teaches reviewers that entries are
// routine — and that costs exactly the findings only this gate can catch.
//
//   1. In shell control files the weakening shapes are tested against the line's EXECUTABLE
//      text (`executableShell`), so a weakening hidden inside a quoted string — `bash -c
//      "scan || true"` — is not seen. Without it, every failure message containing the word
//      "skip" and every `v="$(probe || true)"` capture, whose status the next line asserts
//      anyway, becomes a ledger entry in the most safety-critical file in the harness.
//   2. Gate SCRIPTS (`check-project-checks.*`) are watched for IDENTITY only, never for the
//      weakening patterns. Their subject matter IS suppression, so the bare-word shapes match
//      seventy-odd of their own lines and none of the ways a program actually loses its teeth.
//      What matters for a program is whether the checks it defines still exist.
//   3. A changed `uses:` REF — an action SHA or an image digest — is NOT reported, even though
//      it is the same shape as `pin-change`. Workflows are already on the CODEOWNERS-protected
//      surface, so such a swap cannot land without a code-owner reading that diff; a ledger
//      entry would duplicate a control that already exists and would fire on every automated
//      dependency bump. The pin files are watched precisely BECAUSE nothing else reported
//      them. (Considered and decided — not an oversight. Revisit if workflows ever leave the
//      protected surface.)
//
// Therefore the success message states what was compared and that the pattern set is
// known-incomplete. Do not "simplify" it into a guarantee.
//
// FINGERPRINTS bind an approval to the OCCURRENCE — file + rule + (new-file line number, for
// additions) + the line's text + a digest of the surrounding hunk (spec §5 R-D8). Moving or
// duplicating an approved suppression, or editing the code around it, re-requires approval;
// that churn is deliberate and fails safe, and it is what stops a duplicate line from reusing
// an unrelated ledger entry.
//
// BASE SELECTION is the security-critical part (spec §5 R-D8, judge finding C2):
//   1. $SUPPRESSION_BASE — a LOCAL convenience only. In CI it is REFUSED (exit 2). There is no
//      allowlist env and no escape flag: an env-gated exemption is self-authorizing, because
//      any change to the workflow can set the env that exempts it.
//   2. A shallow repository in CI is exit 2, never an empty diff — a shallow clone otherwise
//      passes this gate by being unable to see, which is the quietest possible false pass.
//   3. The CI event's own base: the push event's `before` SHA, or the pull request's merge
//      base — used only when HEAD is the commit CI checked out, so a synthetic repo built
//      inside a CI job (the fixture-exec exemplar) never inherits an unrelated repo's base.
//   4. Otherwise the local merge base with origin/main (then main); if that IS HEAD (push to
//      main / merge commit) then HEAD~1; if HEAD has no parent, NOTHING IS COMPARED and the
//      run says so.
//
// Exit: 0 nothing matched (or nothing was comparable — stated loudly)
//       1 an unapproved match — each one listed with its fingerprint
//       2 environment error: the base cannot be trusted, or the ledger is unusable
//
// ZERO third-party dependencies. Shipped in the claudeconf bundle and VENDORED verbatim into
// `.claudeconf/bin/` (contract §1); its integrity there is checked against the bundle's catalog.
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

/**
 * The repository root: `--root <dir>`, else git's top level from the working directory — never
 * this file's own location, which is `.claudeconf/bin/` once the bundle is vendored.
 */
function repoRoot() {
  const i = process.argv.indexOf('--root');
  if (i !== -1) {
    const dir = process.argv[i + 1];
    if (!dir) {
      console.error('check-suppressions: --root needs a directory');
      process.exit(2);
    }
    return resolve(dir);
  }
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    console.error('check-suppressions: not inside a git work tree (pass --root <dir>)');
    process.exit(2);
  }
}

const root = repoRoot();
const LEDGER = join(root, '.claudeconf/suppressions.json');
const MAX_BUFFER = 128 * 1024 * 1024;

// Inline tokens that silence a control.
const TOKENS = new RegExp(
  `(${[
    'biome-ignore',
    'eslint-disable',
    'nosemgrep',
    String.raw`(?<![\w-])noqa\b`,
    String.raw`type:\s*ignore`,
    'trufflehog:ignore',
    String.raw`zizmor:\s*ignore`,
  ].join('|')})`,
);
// Files where ANY added line widens an exclusion (rule = exclusion-widening).
const WATCHED = [/\.claudeconf\/trufflehog-exclude\.txt$/, /(^|\/)zizmor\.yml$/];
// The harness's own control plane: the files that decide WHICH checks run at all. Deleting a
// control here is as effective as suppressing its findings, so disappearance is flagged too
// (rule = control-removal) — see `identities()` for what "disappearance" means.
const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const RULES_FILE = /^\.claudeconf\/rules\//;
// PIN files: the provisioning script, the version assertion, and the hash-locked requirement
// set. Their VALUES are the trust root of the whole pinned toolchain — a digest, a version, a
// wheel hash — so a changed value is reported as `pin-change` even though the pin's identity
// survives, which is the one place where "the identity is still there" is not reassurance.
const PROVISION_FILE = /(^|\/)provision-tools\.sh$/;
const ASSERT_FILE = /(^|\/)assert-tool-versions\.sh$/;
const REQUIREMENTS_FILE = /(^|\/)tools-requirements\.txt$/;
// Any OTHER provisioning script that carries the same pin-table grammar belongs here too: the
// newest integrity data in a repository must not be the only unwatched data.
const RUNNER_FETCH_FILE = /(^|\/)fetch-hook-runner\.sh$/;
// The checksum-provisioned toolchain (contract §2.5): every version, URL, digest, archive type
// and member in it is a pin — a direct edit is the one way to bypass the release-age cooldown.
const TOOLS_LOCK_FILE = /^\.claudeconf\/tools\.lock\.json$/;
const PIN_FILES = [
  PROVISION_FILE,
  ASSERT_FILE,
  REQUIREMENTS_FILE,
  RUNNER_FETCH_FILE,
  TOOLS_LOCK_FILE,
];
// Gate SCRIPTS: programs, not configs. Watched for identity (a check that disappears) but
// NEVER for the weakening patterns — see `classifyAdded` for why that is a judgement and not
// an exemption.
const GATE_SCRIPTS = [
  /(^|\/)check-project-checks\.(mjs|py)$/,
  /(^|\/)assert-gate-jobs\.mjs$/,
  // The vendored support-script bundle (contract §1, profile 6).
  /^\.claudeconf\/bin\/.+\.mjs$/,
];
const HARNESS_FILES = [
  /(^|\/)lefthook\.ya?ml$/,
  /^\.claudeconf\/lefthook\.yml$/,
  WORKFLOW_FILE,
  /^\.claudeconf\/manifest\.json$/,
  RULES_FILE,
  /^\.claudeconf\/trufflehog-exclude\.txt$/,
  ...PIN_FILES,
  ...GATE_SCRIPTS,
];
// Generated control configs: added lines matching weakening PATTERNS are flagged (rule =
// config-weakening). A best-effort net — CODEOWNERS review of these control-plane files is the
// backstop for what the patterns miss, and they miss things by construction.
const CONTROL_CONFIGS = [
  ...HARNESS_FILES,
  /(^|\/)\.npmrc$/,
  /^\.github\/CODEOWNERS$/,
  /^\.github\/dependabot\.yml$/,
  /^\.claude\/settings\.json$/,
  /(^|\/)biome\.json$/,
  /(^|\/)eslint\.config\.(js|mjs|cjs)$/,
  /(^|\/)\.eslintrc(\.\w+)?$/,
  /(^|\/)\.prettierignore$/,
  /(^|\/)ruff\.toml$/,
  /(^|\/)mypy\.ini$/,
  /(^|\/)pyproject\.toml$/,
  /(^|\/)tsconfig(\..+)?\.json$/,
];
const WEAKENING = new RegExp(
  `(${[
    'ignore',
    'exclude',
    'disable',
    'skip',
    '"off"',
    "'off'",
    String.raw`=\s*off\b`,
    'allowlist',
    'nofail',
    String.raw`\|\|\s*true`,
    String.raw`continue-on-error:\s*true`,
    String.raw`if:\s*false`,
    String.raw`^\s*skip:`,
    '--no-verify',
    'LEFTHOOK=0',
    'SUPPRESSION_BASE',
  ].join('|')})`,
  'i',
);
const SHELL_FILE = /\.sh$/;

/**
 * A shell line's EXECUTABLE text: command substitutions, string literals and trailing comments
 * removed. The weakening shapes above are bare words, and in a script the same words appear in
 * failure messages ("not a skipped check") and inside value captures
 * (`v="$(tool --version || true)"`, whose status the next line then asserts). Reading those as
 * weakenings would file a ledger entry for every message in the most safety-critical file in
 * the harness, and noise is how a real entry gets waved through. The cost is named in the
 * report: a weakening hidden INSIDE a quoted string (`bash -c "scan || true"`) is not seen.
 */
function executableShell(line) {
  let out = line;
  for (let i = 0; i < 8; i++) {
    const next = out.replace(/\$\([^()]*\)/g, '$()');
    if (next === out) break;
    out = next;
  }
  return out
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
    .replace(/#.*$/, '');
}
// The ledger itself and this script are reviewed as control-plane changes, not re-flagged as
// suppressions — the script NAMES every token it hunts for. It is exempt exactly where it lives:
// vendored under a harness root's `.claudeconf/bin/` (held byte for byte to the checker's catalog
// by A17, so the tokens it carries are the shipped ones), in the skill bundle that ships it
// wherever the skill is installed, and where a profile-5 harness kept it. A copy anywhere else is
// an ordinary file. Markdown is excluded because suppression tokens are INERT there — no scanner
// honors them in prose — and documentation must be able to name them.
const IGNORED = [
  /\.claudeconf\/suppressions\.json$/,
  /(^|\/)\.claudeconf\/bin\/check-suppressions\.mjs$/,
  /(^|\/)scripts\/harness\/check-suppressions\.mjs$/,
  /(^|\/)scripts\/check-suppressions\.mjs$/,
  /\.md$/,
];

const truthy = (v) => v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
/** Authoritative CI: the merge boundary. Broader than `=== 'true'` so `CI=1` cannot slip past. */
const IN_CI = truthy(process.env.CI) || truthy(process.env.GITHUB_ACTIONS);

function git(...args) {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
/** `git`, but a failing command is data (null), not an exception. */
function tryGit(...args) {
  try {
    return git(...args).trim();
  } catch {
    return null;
  }
}
function die(code, ...lines) {
  for (const l of lines) console.error(l);
  process.exit(code);
}
const short = (sha) => (typeof sha === 'string' ? sha.slice(0, 12) : String(sha));
const isSha = (v) => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);
const commitExists = (rev) =>
  tryGit('rev-parse', '--verify', '--quiet', `${rev}^{commit}`) !== null;

/**
 * The base the CI event itself names. Consulted ONLY when HEAD is the commit this CI run
 * checked out: a job that builds a synthetic repo (the fixture-exec exemplar does exactly
 * this) must not inherit the outer repository's base SHA, which does not exist there.
 */
function ciEventBase() {
  if (!IN_CI) return null;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !isSha(process.env.GITHUB_SHA)) return null;
  if (tryGit('rev-parse', 'HEAD') !== process.env.GITHUB_SHA) return null;
  let event;
  try {
    event = JSON.parse(readFileSync(eventPath, 'utf8'));
  } catch {
    return null;
  }
  const prBase = event?.pull_request?.base?.sha;
  if (isSha(prBase)) {
    const mergeBase = tryGit('merge-base', 'HEAD', prBase);
    if (mergeBase)
      return { base: mergeBase, source: `pull_request merge base with ${short(prBase)}` };
    console.error(
      `WARNING: the pull request base ${short(prBase)} is not in this repository; ` +
        'falling back to the local merge base.',
    );
    return null;
  }
  const before = event?.before;
  if (process.env.GITHUB_EVENT_NAME === 'push' && isSha(before) && !/^0{40}$/.test(before)) {
    if (commitExists(before)) return { base: before, source: 'push event before SHA' };
    console.log(
      `WARNING: the push event's before SHA ${short(before)} is not in this repository ` +
        '(force-push?); falling back to the local merge base.',
    );
  }
  return null;
}

/**
 * Resolves the base per spec §5 R-D8. Exits 2 rather than comparing against a base it cannot
 * trust.
 */
function resolveBase() {
  const override = process.env.SUPPRESSION_BASE;
  if (override) {
    console.log(`NOTICE: SUPPRESSION_BASE=${override}`);
    if (IN_CI) {
      die(
        2,
        'check-suppressions: SUPPRESSION_BASE override refused in CI — the base is derived ' +
          'from the push/PR event at the merge boundary.',
        'There is no allowlist env and no escape flag: an env-gated exemption would be ' +
          'self-authorizing, because the same change that adds a suppression can set the env ' +
          'that exempts it (spec §5 R-D8, judge C2). Unset SUPPRESSION_BASE.',
      );
    }
    const sha = tryGit('rev-parse', '--verify', '--quiet', `${override}^{commit}`);
    if (!sha) {
      die(2, `check-suppressions: SUPPRESSION_BASE=${override} does not resolve to a commit here.`);
    }
    return { base: sha, source: 'SUPPRESSION_BASE (local override)' };
  }

  if (tryGit('rev-parse', '--is-shallow-repository') === 'true') {
    if (IN_CI) {
      die(
        2,
        'check-suppressions: shallow repository in CI — the history this gate must read is ' +
          'absent, so it could only pass by being unable to see. Failing instead.',
        'Remediation: check out with `fetch-depth: 0`.',
      );
    }
    console.log(
      'WARNING: shallow repository — the base below may be wrong or missing. ' +
        'A shallow clone is an error in CI; locally it is only a warning.',
    );
  }

  const fromEvent = ciEventBase();
  if (fromEvent) return fromEvent;

  const head = tryGit('rev-parse', 'HEAD');
  for (const ref of ['origin/main', 'main']) {
    const mergeBase = tryGit('merge-base', 'HEAD', ref);
    if (!mergeBase) continue;
    if (mergeBase !== head) return { base: mergeBase, source: `merge base with ${ref}` };
    // HEAD is at or behind the branch tip: a push to main, or a merge commit. The change under
    // review is HEAD's own commit.
    const parent = tryGit('rev-parse', '--verify', '--quiet', 'HEAD~1^{commit}');
    if (parent) return { base: parent, source: `HEAD~1 (HEAD is the tip of ${ref})` };
    return { base: null, source: `HEAD is the root commit and the tip of ${ref}` };
  }
  const parent = tryGit('rev-parse', '--verify', '--quiet', 'HEAD~1^{commit}');
  if (parent) return { base: parent, source: 'HEAD~1 (no origin/main or main to compare against)' };
  return { base: null, source: 'no origin/main, no main, and HEAD has no parent' };
}

function loadLedger() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(LEDGER, 'utf8'));
  } catch (err) {
    die(2, `check-suppressions: ledger unreadable: ${err.message}`);
  }
  if (!Array.isArray(raw)) {
    die(2, `check-suppressions: ${LEDGER} must be a JSON array of approval entries.`);
  }
  const approved = new Set();
  raw.forEach((entry, i) => {
    const fp = entry?.fingerprint;
    const rationale = entry?.rationale;
    if (typeof fp !== 'string' || fp === '') {
      die(2, `check-suppressions: ledger entry ${i} has no "fingerprint" string.`);
    }
    if (typeof rationale !== 'string' || rationale.trim() === '') {
      die(
        2,
        `check-suppressions: ledger entry ${i} (${fp}) has no "rationale". An approval without ` +
          'a recorded reason is not an approval (constitution §4.7.2).',
      );
    }
    approved.add(fp);
  });
  return approved;
}

/**
 * Splits a unified diff into per-file entries. `--no-renames` is deliberate: a rename is read
 * as a delete plus an add, so renaming `.github/workflows/ci.yml` out of the way (which
 * disables CI completely) shows up as the file deletion it effectively is.
 */
function parseDiff(text) {
  const files = [];
  let current = null;
  let hunk = null;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      current = { newPath: null, oldPath: null, hunks: [] };
      hunk = null;
      files.push(current);
      continue;
    }
    if (current === null) continue;
    // File headers are only headers BEFORE the first hunk: a removed source line reading
    // `-- x` renders as `--- x`, and an added `++ x` renders as `+++ x`. Reading those as
    // headers would silently discard the rest of the hunk — content chosen by the change
    // under review must never be able to steer this parser.
    if (hunk === null && raw.startsWith('--- ')) {
      current.oldPath = diffPath(raw.slice(4));
      continue;
    }
    if (hunk === null && raw.startsWith('+++ ')) {
      current.newPath = diffPath(raw.slice(4));
      continue;
    }
    const header = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      hunk = { newLine: Number(header[2]), lines: [] };
      current.hunks.push(hunk);
      continue;
    }
    if (hunk === null) continue;
    const sign = raw[0];
    if (sign === '+' || sign === '-' || sign === ' ') hunk.lines.push({ sign, text: raw.slice(1) });
    // Anything else inside a hunk ("\ No newline at end of file") carries no content.
  }
  return files;
}

/** `a/path` / `b/path` / `/dev/null`, with git's C-style quoting undone when present. */
function diffPath(field) {
  const value = field.startsWith('"') ? unquote(field) : field.split('\t')[0];
  if (value === '/dev/null') return null;
  return value.slice(2);
}
function unquote(field) {
  try {
    return JSON.parse(field);
  } catch {
    return field;
  }
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
/** The hunk's own text — the "hunk context" of spec §5 R-D8. */
const hunkDigest = (h) => sha256(h.lines.map((l) => `${l.sign}${l.text.trim()}`).join('\n'));
const fingerprint = (parts) => sha256(parts.join('\n')).slice(0, 16);

function classifyAdded(file, line) {
  // Tokens are checked BEFORE the comment skip below: a suppression token IS a comment
  // (`# nosemgrep`, `# noqa`, `// biome-ignore`), and a standalone one on its own line is the
  // most common form of all. Only the config rules skip comments, where a commented-out line
  // genuinely is not in force.
  const token = line.match(TOKENS);
  if (token) return token[1];
  if (line.trim().startsWith('#')) return null;
  if (WATCHED.some((re) => re.test(file))) return 'exclusion-widening';
  // A gate SCRIPT is watched for what it still CHECKS, not for which words its lines contain.
  // Its subject matter is suppression, so the bare-word shapes below match seventy-odd of its
  // own lines (`if (rule === 'skip')`, prose about ignore files) while catching none of the
  // ways a program is actually weakened — an early return, a predicate flipped, an assertion
  // deleted. Seventy entries that mean nothing is how the one that means something gets waved
  // through, so identity is the whole signal here: `identities()` reads the checks it defines,
  // and a deleted one is a control-removal.
  if (GATE_SCRIPTS.some((re) => re.test(file))) return null;
  const executable = SHELL_FILE.test(file) ? executableShell(line) : line;
  if (CONTROL_CONFIGS.some((re) => re.test(file)) && WEAKENING.test(executable))
    return 'config-weakening';
  return null;
}

/** Every ADDED-line finding this diff carries, approved or not. Removals are not a diff
 * question — see `removals()`. */
function scan(files) {
  const findings = [];
  for (const entry of files) {
    const path = entry.newPath;
    if (path === null || IGNORED.some((re) => re.test(path))) continue;
    for (const hunk of entry.hunks) {
      const ctx = hunkDigest(hunk);
      let newLine = hunk.newLine - 1;
      for (const { sign, text } of hunk.lines) {
        if (sign !== '-') newLine += 1;
        if (sign !== '+') continue;
        const trimmed = text.trim();
        if (trimmed === '') continue;
        const rule = classifyAdded(path, text);
        if (rule === null) continue;
        findings.push({
          file: path,
          rule,
          lineNo: newLine,
          line: trimmed,
          fp: fingerprint([path, rule, String(newLine), trimmed, ctx]),
        });
      }
    }
  }
  return findings;
}

/**
 * The IDENTITIES a harness file declares — what each control IS, independent of the text that
 * spells it out (contract §1). A job or step keeps its identity when its command is rewritten,
 * and loses it when the job or step itself is dropped or renamed.
 *
 * This is a deliberately small reader, not a YAML parser: it must ship into projects with zero
 * dependencies. What it cannot see it under-reports, and the enumeration of file shapes is
 * named in the failure text so nobody mistakes silence for coverage.
 */
function identities(path, text) {
  const found = new Set();
  const lines = text.split('\n');
  const value = (raw) => raw.trim().replace(/^(['"])(.*)\1$/, '$2');

  if (RULES_FILE.test(path)) {
    // A vendored SAST rule is a control, and `id:` is its name.
    for (const line of lines) {
      const m = line.match(/^\s*-\s*id:\s*(\S.*)$/);
      if (m) found.add(`rule:${value(m[1])}`);
    }
    return found;
  }

  if (WORKFLOW_FILE.test(path)) {
    // A workflow job id is an identity in its own right — required status checks name it.
    let inJobs = false;
    let jobIndent = null;
    let job = '';
    for (const line of lines) {
      if (/^jobs:\s*$/.test(line)) {
        inJobs = true;
        jobIndent = null;
        continue;
      }
      // A blank line and a comment are not YAML structure: they close no mapping and carry no
      // identity. Skipping them here is load-bearing, not tidiness — the profile-4 CI layout
      // puts the managed-region sentinels at column 0 INSIDE `jobs:` (contract §1), and
      // reading a sentinel as the end of the mapping made every job below it — every job in
      // the file — look deleted, which is 20+ false removals burying any real one.
      if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
      if (inJobs && /^\S/.test(line)) inJobs = false;
      if (inJobs) {
        const key = line.match(/^(\s+)([A-Za-z0-9_.-]+):\s*$/);
        if (key && (jobIndent === null || key[1].length === jobIndent)) {
          jobIndent = key[1].length;
          job = key[2];
          found.add(`job:${job}`);
          continue;
        }
      }
      const name = line.match(/^\s*-\s*name:\s*(\S.*)$/);
      if (name) found.add(`step:${job}.${value(name[1])}`);
    }
    return found;
  }

  if (GATE_SCRIPTS.some((re) => re.test(path))) {
    // Each TOP-LEVEL function is a step of the assertion this script performs; one that
    // disappears is a check that no longer happens. Nested helpers are indented and therefore
    // not counted — they are implementation, not control surface.
    for (const line of lines) {
      const fn = line.match(/^(?:export\s+)?(?:async\s+)?(?:function|def)\s+([A-Za-z_]\w*)/);
      if (fn) found.add(`function:${fn[1]}`);
    }
    return found;
  }

  if (PIN_FILES.some((re) => re.test(path))) {
    for (const key of pinValues(path, text).keys()) found.add(key);
    return found;
  }

  // Hook configs: the top-level block keys are the hooks themselves (losing `extends:` or
  // `gate:` disconnects everything under them), and each named job hangs off one of them.
  let section = '';
  for (const line of lines) {
    const key = line.match(/^([A-Za-z0-9_.-]+):\s*$/);
    if (key) {
      section = key[1];
      found.add(`section:${section}`);
      continue;
    }
    const name = line.match(/^\s*-\s*name:\s*(\S.*)$/);
    if (name) found.add(`job:${section}.${value(name[1])}`);
  }
  return found;
}

const harnessPaths = (paths) => paths.filter((p) => HARNESS_FILES.some((re) => re.test(p)));

/**
 * The harness a file belongs to — its project root. A repository can carry more than one
 * harness (this one vendors four fixture harnesses; a monorepo has one per package), and an
 * identity in a DIFFERENT harness must never mask a removal in this one. Verified the hard
 * way: without this, deleting the dev repo's own `gate.e2e` job was silent, because four
 * fixture `lefthook.yml` files still declared a job by that name.
 */
function scopeOf(rel) {
  const parts = rel.split('/');
  const marker = parts.findIndex((p) => p === '.claudeconf' || p === '.github');
  return (marker >= 0 ? parts.slice(0, marker) : parts.slice(0, -1)).join('/');
}
const scoped = (rel, id) => `${scopeOf(rel)}\u0000${id}`;

/**
 * Controls that DISAPPEARED between the base and the working tree (contract §1). Removal is
 * defined by identity, not by text: an identity that survives anywhere in the harness — the
 * same file or another one — is a MODIFICATION, judged by the weakening rules above, however
 * much its command changed. Only an identity present in NO post-image is a removal.
 *
 * This compares whole trees rather than reading the diff, so a job that moves between harness
 * files (the profile 3 -> 4 hook split does exactly that) is silent, while a job that is
 * dropped or renamed is reported even when it moved house in the same change. "Anywhere in
 * the harness" means THIS harness — see `scopeOf`.
 */
function removals(base) {
  const preFiles = harnessPaths((tryGit('ls-tree', '-r', '--name-only', base) ?? '').split('\n'));
  const listed = tryGit('ls-files', '--cached', '--others', '--exclude-standard', '-z') ?? '';
  const postFiles = new Set([...harnessPaths(listed.split('\0')), ...preFiles]);

  const findings = [];
  const post = new Set();
  const gone = new Set();
  for (const rel of postFiles) {
    const text = readIfPresent(rel);
    if (text === null) continue;
    for (const id of identities(rel, text)) post.add(scoped(rel, id));
  }
  for (const rel of preFiles) {
    if (readIfPresent(rel) === null) {
      // The file itself is gone. Reporting it once beats reporting every control it held —
      // and it is the only signal for a harness file that declares no identities at all.
      gone.add(rel);
      findings.push({
        file: rel,
        rule: 'control-removal',
        line: '<file deleted>',
        fp: fingerprint([rel, 'control-removal', '<file deleted>']),
      });
    }
  }
  const seen = new Set();
  for (const rel of preFiles) {
    if (gone.has(rel) || IGNORED.some((re) => re.test(rel))) continue;
    const before = tryGit('show', `${base}:${rel}`);
    if (before === null) continue;
    for (const id of identities(rel, before)) {
      if (post.has(scoped(rel, id)) || seen.has(scoped(rel, id))) continue;
      seen.add(scoped(rel, id));
      findings.push({
        file: rel,
        rule: 'control-removal',
        line: `${id} exists in no harness file any more`,
        fp: fingerprint([rel, 'control-removal', id]),
      });
    }
  }
  return findings;
}

/**
 * The PINS a file declares, as identity -> value. The identity is what the pin is FOR (a tool,
 * a tool on a platform, a package); the value is the thing that makes it a pin (a version, a
 * digest and the URL and archive member it names, a wheel-hash set). Splitting them is what
 * lets a vanished pin be a removal and a rewritten one be a `pin-change`, instead of the two
 * being indistinguishable.
 *
 * Same contract as `identities()`: a deliberately small reader. A pin it cannot parse is a pin
 * it does not report — and a digest replaced by something unparsable stops being a pin at all,
 * so that edit surfaces as a removal rather than passing unseen.
 */
function pinValues(path, text) {
  const pins = new Map();
  const lines = text.split('\n');

  if (TOOLS_LOCK_FILE.test(path)) {
    // An unparseable lock yields NO pins, so every pin it held surfaces as a removal.
    let lock;
    try {
      lock = JSON.parse(text);
    } catch {
      return pins;
    }
    for (const [tool, entry] of Object.entries(lock ?? {})) {
      if (!entry || typeof entry !== 'object') continue;
      pins.set(`tool:${tool}`, String(entry.version));
      for (const [platform, asset] of Object.entries(entry.platforms ?? {})) {
        const a = asset ?? {};
        pins.set(`asset:${tool}:${platform}`, `${a.sha256} ${a.url} ${a.archive} ${a.member}`);
      }
    }
    return pins;
  }

  if (REQUIREMENTS_FILE.test(path)) {
    let current = null;
    const hashes = [];
    const flush = () => {
      if (current) pins.set(`req:${current.name}`, `${current.version} ${hashes.sort().join(' ')}`);
      hashes.length = 0;
    };
    for (const line of lines) {
      // A PEP 508 environment marker decides WHICH platforms the requirement installs on, so
      // it is part of the pin. Demanding the version be the last token made every
      // marker-bearing line invisible — no pin record, and its `--hash` lines attributed to
      // the preceding package — so widening `sys_platform == 'win32'` passed unseen.
      const req = line.match(
        /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*==\s*([^\s;\\]+)\s*(?:;\s*(.*?))?\s*\\?\s*$/,
      );
      if (req) {
        flush();
        const marker = (req[3] ?? '').trim();
        const version = marker ? `${req[2]} ; ${marker}` : req[2];
        current = { name: req[1].toLowerCase(), version };
        continue;
      }
      const hash = line.match(/--hash=(sha256:[0-9a-f]{64})/);
      if (hash && current) hashes.push(hash[1]);
    }
    flush();
    return pins;
  }

  for (const line of lines) {
    // `TOOL_VERSION=1.2.3` — the version the provisioning script installs.
    const version = line.match(/^([A-Z][A-Z0-9_]*)_VERSION=(\S+)\s*$/);
    if (version) {
      pins.set(`pin:${version[1].toLowerCase().replace(/_/g, '-')}`, version[2]);
      continue;
    }
    // A pin-table row: `<tool> <os>/<arch> <sha256> <url> <member>`. The value is everything
    // that decides WHICH bytes get installed and which file inside them is used.
    const row = line.match(/^([a-z][\w-]*) (\w+\/\w+) (\S+) (https?:\/\/\S+) (\S+)\s*$/);
    if (row) {
      pins.set(`asset:${row[1]}:${row[2]}`, `${row[3]} ${row[4]} ${row[5]}`);
      continue;
    }
    // `assert <tool> "<version>"` — the gate's version enforcement (harness-contract §3.4).
    const assertion = line.match(/^assert\s+(\S+)\s+"([^"]+)"/);
    if (assertion) pins.set(`assert:${assertion[1]}`, assertion[2]);
  }
  return pins;
}

const pinPaths = (paths) => paths.filter((p) => PIN_FILES.some((re) => re.test(p)));

/**
 * Pins whose VALUE changed between the base and the working tree. A digest, a pinned version,
 * or a wheel-hash set is the trust root of everything downstream of it: swapping one leaves
 * every structural check green — the row is still there, the tool is still asserted, the
 * install is still "hash-verified" — while the bytes that land on the machine are different
 * ones. That is the cheapest way past a pinned toolchain, so it is reported by value, not by
 * pattern. A pin that is ADDED is not a finding (a new pin is strictly more pinning); one that
 * DISAPPEARS is `removals()`' business.
 */
function pinChanges(base) {
  const preFiles = pinPaths((tryGit('ls-tree', '-r', '--name-only', base) ?? '').split('\n'));
  const findings = [];
  for (const rel of preFiles) {
    if (IGNORED.some((re) => re.test(rel))) continue;
    const before = tryGit('show', `${base}:${rel}`);
    const after = readIfPresent(rel);
    if (before === null || after === null) continue;
    const beforePins = pinValues(rel, before);
    const afterPins = pinValues(rel, after);
    for (const [key, was] of beforePins) {
      const now = afterPins.get(key);
      if (now === undefined || now === was) continue;
      findings.push({
        file: rel,
        rule: 'pin-change',
        line: `${key}: ${was} -> ${now}`,
        fp: fingerprint([rel, 'pin-change', key, was, now]),
      });
    }
  }
  return findings;
}

function readIfPresent(rel) {
  try {
    return readFileSync(join(root, rel), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Untracked files, rendered as the diff git itself would produce for a newly added file, so a
 * fingerprint approved before `git add` survives the `git add`.
 */
function untrackedDiff() {
  const listed = tryGit('ls-files', '--others', '--exclude-standard', '-z');
  if (!listed) return '';
  let out = '';
  for (const rel of listed.split('\0').filter(Boolean)) {
    if (IGNORED.some((re) => re.test(rel))) continue;
    let content;
    try {
      if (statSync(join(root, rel)).isDirectory()) continue;
      const buf = readFileSync(join(root, rel));
      if (buf.subarray(0, 8000).includes(0)) continue; // git's own binary heuristic
      content = buf.toString('utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (lines.length === 0) continue;
    out += `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n`;
    out += `@@ -0,0 +1,${lines.length} @@\n`;
    out += `${lines.map((l) => `+${l}`).join('\n')}\n`;
  }
  return out;
}

const approved = loadLedger();
const { base, source } = resolveBase();

if (base === null) {
  console.log(`NOTICE: no base commit is resolvable (${source}).`);
  console.log(
    'check-suppressions: NOTHING WAS COMPARED — this run proves nothing about suppressions. ' +
      'It is exit 0 because there is no history to compare against, not because the tree is ' +
      'clean. In CI a missing history is exit 2 (see the shallow-repository check).',
  );
  process.exit(0);
}

console.log(`check-suppressions: base ${short(base)} (${source})`);
let diff;
try {
  diff = git('diff', '--unified=3', '--no-color', '--no-renames', base, '--');
} catch (err) {
  die(2, `check-suppressions: cannot diff against ${short(base)}: ${err.message}`);
}
const parsed = [...parseDiff(diff), ...parseDiff(untrackedDiff())];
const findings = [...scan(parsed), ...removals(base), ...pinChanges(base)];
const violations = findings.filter((f) => !approved.has(f.fp));

if (violations.length > 0) {
  console.error(`check-suppressions: ${violations.length} unapproved suppression(s):`);
  for (const v of violations) {
    const where = v.lineNo === undefined ? v.file : `${v.file}:${v.lineNo}`;
    console.error(`  - ${where} [${v.rule}] fingerprint=${v.fp}\n      ${v.line}`);
  }
  console.error(
    'Approval path: add {fingerprint, file, rule, rationale} to ' +
      '.claudeconf/suppressions.json in this change — the code-owner review of the ' +
      'ledger edit is the human sign-off (constitution §4.7.2).',
  );
  process.exit(1);
}

const changed = new Set(parsed.map((f) => f.newPath ?? f.oldPath).filter(Boolean)).size;
console.log(
  `check-suppressions: ${changed} changed file(s) carry no unapproved match of this gate's ` +
    `patterns (${findings.length} approved in the ledger).`,
);
console.log(
  'This is a NOTIFIER, not a proof of non-weakening. It matched a KNOWN-INCOMPLETE set of ' +
    'shapes: inline suppression tokens, added lines in scanner exclude files, weakening ' +
    'patterns in control configs, harness controls (hook sections, named jobs, workflow jobs ' +
    'and steps, SAST rule ids, pinned tools) whose identity is gone, and pinned VALUES (a ' +
    'release digest, a tool version, an asset URL or member, a wheel-hash set) that changed. ' +
    'A control weakened in any other ' +
    'way — a rewritten command, a narrowed rule, a flipped flag this pattern set does not ' +
    'name — passes this gate silently. Reviewing the diff is the control; the gate only ' +
    "takes the known shapes off the reviewer's list.",
);
