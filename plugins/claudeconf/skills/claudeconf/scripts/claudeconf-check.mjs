#!/usr/bin/env node
/**
 * claudeconf-check.mjs — the deterministic conformance checker for a generated harness.
 *
 * It is a GENERATION-TIME and doctor tool: it ships with the plugin and runs FROM the plugin
 * against a project directory. A generated harness never invokes it (constitution §4.8).
 *
 * Usage:
 *   node claudeconf-check.mjs [--root <dir>] [--format text|json] [--lefthook <bin>]
 *                             [--profile <n>] [--no-git] [--enforce|--advisory]
 *
 *   --enforce (DEFAULT)  "cannot verify" is not a pass: an unsupported or missing profile, a
 *                        malformed managed region, an unparseable artifact, and any CRITICAL
 *                        check that cannot be established are reported FAIL.
 *   --advisory           UNKNOWN stays UNKNOWN and the exit code is 0. It reports; it does not
 *                        gate. A DEMONSTRABLY broken control still FAILs in this mode.
 *   --profile <n>        runs profile <n>'s checks IN ADDITION TO the recorded profile's.
 *
 * Exit codes: 0 = no FAIL (always, under --advisory), 1 = at least one FAIL, 2 = usage error
 * or an internal crash (stack trace on stderr).
 *
 * Determinism: no wall clock, no randomness, no network. The same tree yields the same output.
 * Robustness: a missing or malformed artifact is recorded as FAIL/UNKNOWN and the run
 * continues — one bad file must never hide every other finding.
 */

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareToEntry, hashTree } from './harness/lib/catalog.mjs';
import { compareVersions, resolvePin } from './harness/lib/pins.mjs';
import {
  analyseCommand,
  classifyWork,
  commandInvokesTool,
  commandMatchesTool,
  continueOnErrorVerdict,
  escapeRx,
  executableText,
  firstLine,
  liveScriptLines,
  norm,
  operationalArgs,
  runContains,
  safeRead,
  signalVerdict,
  splitTopLevel,
  stripComment,
  tokenize,
} from './harness/lib/shell.mjs';
import { pinnedConfigFor, TOOL_CONFIGS } from './harness/lib/tool-configs.mjs';
import { load as yamlLoad } from './vendor/js-yaml.mjs';

// ---------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------

export const KNOWN_PROFILES = ['2', '3', '4', '5', '6'];
export const CURRENT_PROFILE = 6;

const MILESTONES = [
  'format',
  'lint',
  'typecheck',
  'unit',
  'e2e',
  'sast',
  'secret-scan',
  'dependency-audit',
  'build',
];
const TIERS = ['edit', 'pre-commit', 'pre-push', 'gate', 'ci'];
const HOOK_TIERS = ['pre-commit', 'pre-push', 'gate'];

/**
 * Contract §2.4 — managed hook-job names BY MILESTONE. A managed CI STEP name LEADS with any
 * name in its milestone's row, so `format-check (biome)` and `unit-coverage (vitest)` are the
 * managed steps for `format` and `unit`; demanding the bare milestone token rejected the names
 * the generator actually emits.
 */
const MILESTONE_JOB_NAMES = {
  format: ['format', 'format-check'],
  lint: ['lint'],
  typecheck: ['typecheck'],
  unit: ['unit', 'unit-changed', 'unit-full', 'unit-coverage'],
  e2e: ['e2e'],
  sast: ['sast'],
  'secret-scan': ['secret-scan'],
  'dependency-audit': ['dependency-audit'],
  build: ['build'],
};

/** Contract §2.4 — harness-infrastructure jobs that belong to no milestone. */
const INFRA_JOB_NAMES = [
  'tool-versions',
  'workflow-audit',
  'suppressions',
  'project-checks',
  'commitlint',
];

/**
 * Contract §2.4 — the CLOSED managed-name set a project-owned name may never collide with.
 *
 * TWO name spaces, not three: hook job NAMES (the runner merges same-named jobs across layers)
 * and the leading token of CI step names (that is how a step is located). A CI JOB ID is
 * neither — a managed CI job is located by POSITION, inside the managed region, and its id is
 * free (`8fb4664`). Denying ids from a set asserted from one workflow rejects a legitimate
 * project id the moment one collides, and five harnesses built from this contract already use
 * four conventions.
 */
const MANAGED_NAMES = [...Object.values(MILESTONE_JOB_NAMES).flat(), ...INFRA_JOB_NAMES];

/** Every managed name for `token`: its milestone's row, or the token itself for an infra job. */
function managedNamesFor(token) {
  return MILESTONE_JOB_NAMES[norm(token)] ?? [token];
}

/**
 * Tools whose version comes from the runtime, so `"n/a"` is a legitimate pin (contract §2.3).
 * `node` is a repository script the runtime executes: the script is versioned by the
 * repository itself and the interpreter by the runtime pin, so there is no third version.
 */
const RUNTIME_VERSIONED = [
  'node',
  'npm-audit',
  'pip-audit',
  'cargo-audit',
  'mix-audit',
  'go-vulncheck',
  'govulncheck',
  'node-test',
];

/** UNKNOWN in these is a FAIL under --enforce (contract §3.6 CRITICAL set). */
export const CRITICAL = new Set([
  'A14',
  'A15',
  'W1',
  'W2',
  'W3',
  'W12',
  'W16',
  'W17',
  'W20',
  'D1',
  'D8',
]);

/** Deterministic report order. Only APPLICABLE ids are printed. */
export const CHECK_ORDER = [
  'M1',
  'M2',
  'M3',
  'M4',
  'M5',
  'M6',
  'M7',
  'M8',
  'M9',
  'M10',
  'M11',
  'M12',
  'M13',
  'A1',
  'A2',
  'A3',
  'A4',
  'A5',
  'A6',
  'A7',
  'A8',
  'A9',
  'A10',
  'A11',
  'A12',
  'A13',
  'A16',
  'A17',
  'A14',
  'A15',
  'W1',
  'W2',
  'W3',
  'W4',
  'W5',
  'W6',
  'W7',
  'W8',
  'W9',
  'W10',
  'W11',
  'W12',
  'W13',
  'W14',
  'W15',
  'W16',
  'W17',
  'W18',
  'W19',
  'W20',
  'W21',
  'D1',
  'D2',
  'D3',
  'D4',
  'D5',
  'D6',
  'D7',
  'D8',
  'D9',
  'P1',
];

/**
 * Which ids each check group is expected to produce, and the minimum profile at which each
 * applies. Used ONLY to backfill after a group throws, so a crash fails checks instead of
 * removing them.
 */
export const GROUP_IDS = {
  'M*': [
    ['M1', 1],
    ['M2', 1],
    ['M3', 1],
    ['M4', 1],
    ['M5', 1],
    ['M6', 1],
    ['M7', 2],
    ['M8', 3],
    ['M9', 4],
    ['M10', 1],
    ['M11', 1],
    ['M12', 4],
    ['M13', 6],
  ],
  'A*': [
    ['A1', 1],
    ['A2', 1],
    ['A3', 2],
    ['A4', 1],
    ['A5', 1],
    ['A6', 1],
    ['A7', 1],
    ['A8', 1],
    ['A9', 3],
    ['A10', 3],
    ['A11', 4],
    ['A12', 1],
    ['A13', 4],
    ['A16', 5],
    ['A17', 6],
  ],
  'A14/A15': [
    ['A14', 4],
    ['A15', 4],
  ],
  'W*': [
    ['W1', 1],
    ['W2', 1],
    ['W3', 1],
    ['W4', 1],
    ['W5', 1],
    ['W6', 1],
    ['W7', 1],
    ['W8', 1],
    ['W9', 2],
    ['W10', 3],
    ['W11', 4],
    ['W12', 4],
    ['W13', 1],
    ['W14', 1],
    ['W15', 1],
    ['W16', 1],
    ['W17', 1],
    ['W18', 1],
    ['W19', 4],
    ['W20', 1],
    ['W21', 6],
  ],
  'D*': [
    ['D1', 1],
    ['D2', 1],
    ['D3', 1],
    ['D4', 1],
    ['D5', 1],
    ['D6', 1],
    ['D7', 1],
    ['D8', 1],
    ['D9', 5],
  ],
};

/**
 * SINCE — the conformance profile whose normative text introduced the rule each check enforces
 * (PLAN.md AD6). A CLOSED registry: every id in CHECK_ORDER has an entry, and a finding may
 * name a subrule (a dotted key such as A3.keys) only if that key is registered here — `judgeFinding`
 * refuses anything else, so no call site can invent its own leniency. A finding whose rule is
 * newer than the profile the harness is judged at reports INFO instead of FAIL/UNKNOWN, unless
 * it is CRITICAL or a hard UNKNOWN; CRITICAL checks gate their newer rules explicitly in code.
 * Values: the per-id audit against the constitution/contract of each released profile (v0.2.0
 * ff19ff4 … v0.5.0 c19fb0f), recorded in PLAN.md's appendix. `CRITICAL_UNKNOWN` is the profile
 * at which a CRITICAL UNKNOWN became a FAIL under --enforce (contract §3.6).
 */
export const SINCE = {
  M1: 2,
  M2: 2,
  M3: 2,
  M4: 2,
  M5: 2,
  M6: 2,
  M7: 2,
  M8: 3,
  M9: 4,
  M10: 2,
  M11: 2,
  M12: 4,
  M13: 6,
  'M4.pin': 6,
  'M7.pin': 6,
  'M8.pin': 6,
  'A13.floor': 6,
  A1: 2,
  A2: 2,
  A3: 2,
  'A3.keys': 6,
  A4: 2,
  A5: 2,
  A6: 2,
  A7: 2,
  A8: 2,
  A9: 3,
  'A9.path': 6,
  A10: 3,
  A11: 4,
  A12: 2,
  A13: 4,
  A16: 5,
  A17: 6,
  'A17.callers': 6,
  A14: 4,
  A15: 4,
  W1: 2,
  'W1.naming': 4,
  'W1.inert': 4,
  W2: 2,
  'W2.region': 4,
  'W2.reach': 4,
  W3: 2,
  'W3.naming': 4,
  W4: 2,
  'W4.naming': 4,
  'W4.reach': 4,
  W5: 2,
  'W5.naming': 4,
  'W5.inert': 4,
  'W5.reach': 4,
  W6: 2,
  'W6.dockerRun': 4,
  W7: 2,
  'W7.header': 4,
  W8: 3,
  W9: 2,
  'W9.region': 4,
  'W9.reach': 4,
  W10: 3,
  'W10.naming': 4,
  'W10.inert': 4,
  'W10.region': 4,
  'W10.reach': 4,
  W11: 4,
  'W11.naming': 4,
  'W11.inert': 4,
  'W11.reach': 4,
  'W11.region': 4,
  W12: 4,
  W13: 2,
  'W13.ci': 4,
  W14: 2,
  'W14.pipHashes': 4,
  W15: 4,
  W16: 2,
  'W16.narrowing': 4,
  W17: 4,
  W18: 4,
  W19: 4,
  W20: 2,
  W21: 6,
  D1: 2,
  'D1.unreconciled': 4,
  D2: 2,
  'D2.path': 6,
  D3: 2,
  D4: 2,
  D5: 2,
  D6: 4,
  D7: 3,
  'D7.catchAll': 4,
  D8: 4,
  D9: 5,
  P1: 2,
  CRITICAL_UNKNOWN: 4,
};

/**
 * The profile a harness is JUDGED at (PLAN.md AD6). Pure.
 *
 * J = max(recorded, --profile target, the highest profile the manifest's git history records).
 * History is what makes the record trustworthy: lowering the field cannot lower J, because the
 * old value is still in history. Without history (no git, `--no-git`, a shallow clone) the
 * record cannot be trusted at all, so J is the CURRENT profile — fail closed, as for a missing,
 * unparseable or future value. Profile 1 is a real profile this checker never knew: it is an
 * explicit unsupported mode rather than a number to compare against.
 *
 * @param {{recorded: string|null, target: number|null,
 *   history: {available: boolean, max: number|null, why?: string}}} input
 * @returns {{profile: number, unsupported: boolean, notes: string[]}}
 */
export function judgmentProfile({ recorded, target, history }) {
  const notes = [];
  if (!history.available) {
    notes.push(
      `the manifest's git history is unavailable (${history.why}), so the recorded profile cannot be trusted — judged at the current profile ${CURRENT_PROFILE}; run with full history to be judged at the recorded one`,
    );
    return { profile: CURRENT_PROFILE, unsupported: false, notes };
  }
  let base = CURRENT_PROFILE;
  if (recorded === '1') base = 1;
  else if (recorded && KNOWN_PROFILES.includes(recorded)) base = Number(recorded);
  const historical = history.max ?? 0;
  const profile = Math.min(CURRENT_PROFILE, Math.max(base, historical, target ?? 0));
  if (historical > base) {
    notes.push(
      `the manifest records ${JSON.stringify(recorded)} but its history records ${historical} — judged at ${profile}: a recorded profile can be raised, never lowered`,
    );
  }
  return { profile, unsupported: profile === 1, notes };
}

/**
 * Applies a judgment to ONE finding. Pure. Returns `null` when the finding stands, or the
 * replacement `{ status, prefix }`.
 *
 * @param {{id: string, rule?: string, status: string, hard?: boolean, integrity?: boolean}} finding
 * @param {{profile: number, unsupported: boolean}} judgment
 * @param {{since?: Record<string, number>, critical?: Set<string>}} [tables] test seam
 */
export function judgeFinding(finding, judgment, tables = {}) {
  const since = tables.since ?? SINCE;
  const critical = tables.critical ?? CRITICAL;
  const key = finding.rule ?? finding.id;
  if (!Object.hasOwn(since, key)) throw new Error(`rule ${key} is not registered in SINCE`);
  if (finding.status !== 'FAIL' && finding.status !== 'UNKNOWN') return null;
  // The checker vouching for its OWN integrity (a crash, an internal error, the judgment's own
  // sentinel) is never demoted, by anything.
  if (finding.integrity) return null;
  if (judgment.unsupported) {
    return { status: 'INFO', prefix: 'not judged (profile 1 is not supported by this checker): ' };
  }
  if (finding.hard) return null;
  // A CRITICAL id is never demoted by its id alone: only a finding its emitter TAGGED with a
  // registered rule key (`rule:`) can be — the call site states which newer rule produced it.
  if (critical.has(finding.id) && finding.rule === undefined) return null;
  if (since[key] > judgment.profile) {
    return {
      status: 'INFO',
      prefix: `newer rule (profile ${since[key]}; judged at ${judgment.profile}): `,
    };
  }
  return null;
}

const OPEN_SENTINEL = '>>> claudeconf managed >>>';
const CLOSE_SENTINEL = '<<< claudeconf managed <<<';

/**
 * The report's verdict DOMAIN. `Report.add` refuses anything else (see below): a status outside
 * this table has no severity, so it can never become the worst finding — it disappears from the
 * comparison and leaves whatever else the check said standing, PASS included.
 */
export const SEVERITY = { PASS: 0, INFO: 1, UNKNOWN: 2, FAIL: 3 };

// ---------------------------------------------------------------------------------------
// Exported helpers (unit-tested)
// ---------------------------------------------------------------------------------------

/**
 * Extracts EVERY `>>> claudeconf managed >>>` … `<<< claudeconf managed <<<` pair.
 *
 * Returns an array of `{ start, end, body }` with 1-based line numbers of the sentinel lines
 * and the text strictly between them. Structural problems — an unterminated opener, an
 * unmatched closer, a nested opener — never produce a silent region-to-EOF; they are recorded
 * on the returned array's `errors` property, and the caller turns them into FAIL (--enforce)
 * or UNKNOWN (--advisory).
 *
 * @param {string} text
 * @returns {Array<{start: number, end: number, body: string}> & {errors: string[]}}
 */
export function extractManagedRegions(text) {
  const lines = String(text ?? '').split('\n');
  const regions = [];
  const errors = [];
  let openLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    if (line.includes(OPEN_SENTINEL)) {
      if (openLine) {
        errors.push(`nested managed-region opener at line ${lineNo} (opener at line ${openLine})`);
        continue;
      }
      openLine = lineNo;
    } else if (line.includes(CLOSE_SENTINEL)) {
      if (!openLine) {
        errors.push(`unmatched managed-region closer at line ${lineNo}`);
        continue;
      }
      regions.push({
        start: openLine,
        end: lineNo,
        body: lines.slice(openLine, lineNo - 1).join('\n'),
      });
      openLine = 0;
    }
  }
  if (openLine) errors.push(`unterminated managed region opened at line ${openLine}`);
  Object.defineProperty(regions, 'errors', { value: errors, enumerable: false });
  return regions;
}

/**
 * A pinned version is an ALLOWLIST, never a denylist of range operators: an exact dotted
 * version, a 40-hex commit ref, or the literal `n/a`.
 *
 * @param {string} v
 * @returns {boolean}
 */
export function isPinnedVersion(v) {
  if (typeof v !== 'string') return false;
  return /^\d+(\.\d+){1,3}([-+][0-9A-Za-z.]+)?$/.test(v) || /^[0-9a-f]{40}$/.test(v) || v === 'n/a';
}

/**
 * Parses a CODEOWNERS file into ordered `{ pattern, owners }` rules (comments and blank lines
 * dropped). Order is preserved because CODEOWNERS is LAST-match-wins.
 *
 * @param {string} text
 * @returns {Array<{pattern: string, owners: string[]}>}
 */
export function parseCodeowners(text) {
  const rules = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const pattern = parts.shift();
    if (!pattern) continue;
    rules.push({ pattern, owners: parts.filter(Boolean) });
  }
  return rules;
}

/**
 * Resolves the owners of a repository-relative path — LAST matching rule wins, with `*`,
 * `/dir/`, and `/file` semantics.
 *
 * @param {string} path
 * @param {Array<{pattern: string, owners: string[]}>} rules
 * @returns {string[]}
 */
export function ownersFor(path, rules) {
  const target = String(path ?? '').replace(/^\.\//, '');
  let owners = [];
  for (const rule of rules) {
    if (codeownersMatch(rule.pattern, target)) owners = rule.owners;
  }
  return owners;
}

/** True when a CODEOWNERS pattern matches every path (so it can never OWN the control plane). */
function isCatchAllPattern(pattern) {
  return pattern === '*' || pattern === '**' || pattern === '/' || pattern === '/*';
}

function codeownersMatch(pattern, target) {
  if (isCatchAllPattern(pattern)) return true;
  const anchored = pattern.startsWith('/');
  const core = pattern.replace(/^\//, '').replace(/\/$/, '');
  const rx = new RegExp(
    `^${core
      .split('/')
      .map((seg) =>
        seg
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*/g, ' ')
          .replace(/\*/g, '[^/]*')
          .replace(/ /g, '.*'),
      )
      .join('/')}(/.*)?$`,
  );
  if (anchored) return rx.test(target);
  const segments = target.split('/');
  for (let i = 0; i < segments.length; i++) {
    if (rx.test(segments.slice(i).join('/'))) return true;
  }
  return false;
}

/**
 * Resolves the hook runner the way the INSTALLED SHIM does, so the checks assert the binary
 * that will actually run the hooks (spec §5 R-D10):
 * `--lefthook` → `$LEFTHOOK_BIN` → the `lefthook:` path in the managed config → `lefthook` on
 * PATH → `<root>/node_modules/.bin/lefthook` → null.
 *
 * @param {string} root
 * @param {object|null} cfg managed hook config (parsed) or null
 * @param {string|null} flag value of --lefthook, if any
 * @returns {{path: string, source: string}|null}
 */
export function resolveRunner(root, cfg, flag) {
  const candidates = [];
  if (flag) candidates.push({ path: resolveFrom(process.cwd(), flag), source: 'flag' });
  if (process.env.LEFTHOOK_BIN) {
    candidates.push({
      path: resolveFrom(root, process.env.LEFTHOOK_BIN),
      source: 'env:LEFTHOOK_BIN',
    });
  }
  if (cfg && typeof cfg.lefthook === 'string' && cfg.lefthook) {
    candidates.push({ path: resolveFrom(root, cfg.lefthook), source: 'config:lefthook' });
  }
  const onPath = whichOnPath('lefthook');
  if (onPath) candidates.push({ path: onPath, source: 'PATH' });
  candidates.push({ path: join(root, 'node_modules', '.bin', 'lefthook'), source: 'node_modules' });
  for (const c of candidates) {
    if (c.path && existsSync(c.path)) return c;
  }
  return null;
}

/** The first config layer that DECLARES a runner path — evidence only, never a verification. */
function declaredRunnerLayer(ctx) {
  for (const layer of [ctx.rootHook, ctx.managedHook]) {
    if (layer?.exists && typeof layer.doc?.lefthook === 'string' && layer.doc.lefthook)
      return layer;
  }
  return null;
}

/**
 * Directories a package manager CREATES on install. A pinned runner path under one of these is
 * unresolvable-because-uninstalled rather than broken when the directory itself is absent.
 */
const INSTALL_ROOTS = new Set(['node_modules', '.venv', 'venv']);

/**
 * Does the shim's own resolution LAND on the pinned path? Contract §3.2: runner pinning is
 * verified by resolution, never by reading the setting back, because a config can carry a
 * setting the runner ignores — and then the config-reading checks pass while every hook runs a
 * global binary.
 */
function pinResolution(ctx) {
  const pin = ctx.mergedRunnerPin;
  if (!pin) return { state: 'unpinned' };
  const target = resolveFrom(ctx.root, pin);
  if (!existsSync(target)) {
    // A pin the project's PACKAGE MANAGER supplies cannot resolve in a tree where nothing has
    // been installed — a fresh clone, or a shipped exemplar. That is machine state, the same
    // class §3.2 already carves out for an uninstalled hook shim ("report it, never fail on
    // it"), and failing on it reports "the pin resolves nothing" about a harness whose pin is
    // exactly right. The two cases are told apart by the install ROOT, not by the binary:
    // absent means nothing is installed here; PRESENT without the binary means the pin names
    // something the install does not provide, which is a broken pin and stays a FAIL. Only the
    // roots below are read this way, so an unrecognised path fails closed.
    const first = isAbsolute(pin) ? null : pin.split('/').filter(Boolean)[0];
    if (first && INSTALL_ROOTS.has(first) && !existsSync(join(ctx.root, first)))
      return { state: 'uninstalled', pin, target, tree: first };
    return { state: 'missing', pin, target };
  }
  const shim = ctx.shimRunner;
  if (!shim) return { state: 'unresolved', pin, target };
  if (realPath(shim.path) === realPath(target)) return { state: 'pinned', pin, target, shim };
  // `$LEFTHOOK_BIN` outranks the pin in the shim itself, so this is the machine overriding the
  // harness — local state, reported and never failed (the same rule D6 applies to install).
  if (shim.source === 'env:LEFTHOOK_BIN') return { state: 'overridden', pin, target, shim };
  return { state: 'mismatch', pin, target, shim };
}

function resolveFrom(base, p) {
  return isAbsolute(p) ? p : resolve(base, p);
}

function whichOnPath(name) {
  const dirs = (process.env.PATH || '').split(':').filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, name);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not there; keep looking
    }
  }
  return null;
}

/**
 * Returns the MERGED lefthook configuration (`lefthook dump -f json`) — the config the runner
 * actually executes, with its full `extends` closure resolved by lefthook itself.
 *
 * When `root` is a git toplevel the dump runs THERE, in place. Otherwise (a harness nested in
 * another repository, e.g. the eval fixtures) the root config plus its recursively resolved
 * `extends` closure is copied into a temp git repo, preserving relative paths.
 *
 * @param {string} root
 * @param {string|null} bin
 * @returns {object|null}
 */
export function lefthookDump(root, bin) {
  return dumpDetail(root, bin).dump;
}

/** @returns {{dump: object|null, unresolved: string[], error: string|null, mode: string}} */
function dumpDetail(root, bin) {
  if (!bin) {
    return { dump: null, unresolved: [], error: 'no lefthook binary resolved', mode: 'none' };
  }
  if (isGitToplevel(root)) {
    const out = runCommand(bin, ['dump', '-f', 'json'], root);
    if (out.error) return { dump: null, unresolved: [], error: out.error, mode: 'in-place' };
    try {
      return { dump: JSON.parse(out.stdout), unresolved: [], error: null, mode: 'in-place' };
    } catch (e) {
      return {
        dump: null,
        unresolved: [],
        error: `unparseable dump: ${e.message}`,
        mode: 'in-place',
      };
    }
  }
  let tmp = null;
  try {
    tmp = mkdtempSync(join(tmpdir(), 'claudeconf-dump-'));
    const unresolved = [];
    const seen = new Set();
    for (const rel of [
      'lefthook.yml',
      'lefthook.yaml',
      'lefthook-local.yml',
      'lefthook-local.yaml',
    ]) {
      copyClosure(root, tmp, rel, seen, unresolved, false);
    }
    const init = runCommand('git', ['init', '-q'], tmp);
    if (init.error) return { dump: null, unresolved, error: init.error, mode: 'temp-copy' };
    const out = runCommand(bin, ['dump', '-f', 'json'], tmp);
    if (out.error) return { dump: null, unresolved, error: out.error, mode: 'temp-copy' };
    try {
      return { dump: JSON.parse(out.stdout), unresolved, error: null, mode: 'temp-copy' };
    } catch (e) {
      return { dump: null, unresolved, error: `unparseable dump: ${e.message}`, mode: 'temp-copy' };
    }
  } catch (e) {
    return { dump: null, unresolved: [], error: e.message, mode: 'temp-copy' };
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

/** Copies one config plus, recursively, everything it `extends`, preserving relative paths. */
function copyClosure(root, tmp, rel, seen, unresolved, required) {
  if (seen.has(rel)) return;
  seen.add(rel);
  const src = join(root, rel);
  if (!existsSync(src)) {
    if (required) unresolved.push(rel);
    return;
  }
  const dest = join(tmp, rel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  const parsed = parseYaml(safeRead(src).text ?? '');
  const ext = parsed.doc?.extends;
  if (!Array.isArray(ext)) return;
  for (const entry of ext) {
    if (typeof entry !== 'string') continue;
    if (entry.includes('*')) {
      const matches = expandGlob(root, entry);
      if (!matches.length) unresolved.push(entry);
      for (const match of matches) copyClosure(root, tmp, match, seen, unresolved, true);
      continue;
    }
    copyClosure(root, tmp, entry, seen, unresolved, true);
  }
}

/** Minimal single-directory glob support for `extends` entries such as `.claudeconf/*.yml`. */
function expandGlob(root, pattern) {
  const dir = dirname(pattern);
  const base = basename(pattern);
  const rx = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
  try {
    return readdirSync(join(root, dir))
      .filter((f) => rx.test(f))
      .sort()
      .map((f) => (dir === '.' ? f : `${dir}/${f}`));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------------------

function parseYaml(text) {
  try {
    return { doc: yamlLoad(text), error: null };
  } catch (e) {
    return { doc: null, error: e.message.split('\n')[0] };
  }
}

function runCommand(cmd, args, cwd) {
  try {
    const stdout = execFileSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, error: null };
  } catch (e) {
    return { stdout: e.stdout ?? '', error: (e.stderr || e.message || '').split('\n')[0] };
  }
}

function isGitToplevel(root) {
  const out = runCommand('git', ['rev-parse', '--show-toplevel'], root);
  if (out.error) return false;
  // git reports the REAL path, so compare real paths: a root reached through a symlink (a
  // macOS temp dir, a symlinked home) is still the top level it resolves to.
  try {
    return realpathSync(out.stdout.trim()) === realpathSync(resolve(root));
  } catch {
    return false;
  }
}

/**
 * The highest conformance profile `.claudeconf/manifest.json` has EVER recorded, read from git
 * history (PLAN.md AD6): one `git log -p` over the manifest, every `constitutionVersion` value on
 * an added or removed line. Values outside the profiles this checker can name are ignored.
 * `available: false` whenever the history cannot be trusted to be complete — the caller then
 * refuses to trust the record at all.
 */
function manifestHistory(root, noGit) {
  const none = (why) => ({ available: false, max: null, why });
  if (noGit) return none('--no-git');
  const inside = runCommand('git', ['rev-parse', '--is-inside-work-tree'], root);
  if (inside.error || inside.stdout.trim() !== 'true') return none('not a git work tree');
  const shallow = runCommand('git', ['rev-parse', '--is-shallow-repository'], root);
  if (shallow.error) return none(`shallow state unknown: ${shallow.error}`);
  if (shallow.stdout.trim() === 'true') return none('shallow clone');
  const log = runCommand(
    'git',
    [
      'log',
      '--format=',
      '-p',
      '--unified=0',
      '--no-color',
      '--no-ext-diff',
      '--',
      '.claudeconf/manifest.json',
    ],
    root,
  );
  if (log.error) return none(`git log failed: ${log.error}`);
  let max = null;
  for (const m of log.stdout.matchAll(/^[+-].*"constitutionVersion"\s*:\s*"([^"]*)"/gm)) {
    const v = m[1];
    if (v === '1' || KNOWN_PROFILES.includes(v)) max = Math.max(max ?? 0, Number(v));
  }
  return { available: true, max };
}

function uniq(list) {
  return [...new Set(list)];
}

function isInside(root, path) {
  const r = resolve(path);
  const base = resolve(root);
  return r === base || r.startsWith(base + sep);
}

/** 1-based line number of the first line satisfying `test`, searching from `from` (1-based). */
function findLine(lines, test, from = 1) {
  for (let i = Math.max(0, from - 1); i < lines.length; i++) {
    if (test(lines[i], i + 1)) return i + 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------------------
// Report plumbing — ONE aggregated result per check id
// ---------------------------------------------------------------------------------------

export class Report {
  constructor(mode) {
    this.mode = mode;
    this.findings = new Map();
    this.applicable = new Set();
    this.emittedBy = new Map();
    this.group = null;
    /** Set before any check runs (PLAN.md AD6); `null` judges nothing. */
    this.judgment = null;
  }

  /** Marks a check as applicable at this profile even before it has findings. */
  enable(id) {
    this.applicable.add(id);
    if (!this.findings.has(id)) this.findings.set(id, []);
  }

  /**
   * @param {string} id check id
   * @param {'PASS'|'FAIL'|'UNKNOWN'|'INFO'} status
   * @param {string} evidence must name a path and, where determinable, a 1-based line
   * @param {{file?: string, line?: number, hard?: boolean}} [opts] `hard` ⇒ this UNKNOWN is a
   *   failure under --enforce even when the id is not in the CRITICAL set
   */
  add(id, status, evidence, opts = {}) {
    this.enable(id);
    if (this.group) {
      if (!this.emittedBy.has(this.group)) this.emittedBy.set(this.group, new Set());
      this.emittedBy.get(this.group).add(id);
    }
    // FAIL CLOSED on a status outside the domain. `signalVerdict`'s internal `UNRESOLVED`
    // sentinel reached this method once: with no severity it lost every comparison in
    // `results()`, so W12 reported PASS while its own evidence said the check was not
    // signal-bearing. A verdict the report contradicts in the same line is the worst kind of
    // false PASS, and the shape has now recurred three times (an id absent from GROUP_IDS, a
    // hardcoded id in the crash handler, a verdict absent from SEVERITY), so it is closed here
    // — at the one door every finding goes through — rather than at each call site.
    const known = Object.hasOwn(SEVERITY, status);
    const entry = {
      status: known ? status : 'UNKNOWN',
      evidence: known
        ? evidence
        : `internal: ${id} was reported with \`${status}\`, which is not one of ${Object.keys(SEVERITY).join('/')} — ${evidence}`,
      file: opts.file,
      line: opts.line,
      hard: known ? !!opts.hard : true,
      // An out-of-domain status is the checker contradicting itself: an integrity finding.
      integrity: known ? !!opts.integrity : true,
      acknowledged: !!opts.acknowledged,
    };
    // The judgment (PLAN.md AD6) is applied HERE, at the one door every finding goes through,
    // and only from the closed SINCE registry — an unregistered subrule is an internal error,
    // never a quiet pass.
    try {
      const verdict = this.judgment
        ? judgeFinding(
            {
              id,
              rule: opts.rule,
              status: entry.status,
              hard: entry.hard,
              integrity: entry.integrity,
            },
            this.judgment,
          )
        : opts.rule && !Object.hasOwn(SINCE, opts.rule)
          ? judgeFinding({ id, rule: opts.rule, status: 'PASS' }, { profile: 0 })
          : null;
      if (verdict) {
        entry.evidence = `${verdict.prefix}${entry.evidence}`;
        entry.status = verdict.status;
      }
    } catch (e) {
      entry.status = 'UNKNOWN';
      entry.hard = true;
      entry.integrity = true;
      entry.evidence = `internal: ${e.message} — ${entry.evidence}`;
    }
    this.findings.get(id).push(entry);
  }

  /**
   * Every id a group EMITTED must be registered under THAT group. The crash backfill is keyed
   * per group, so an id filed under the wrong label satisfies "belongs to some group" — the
   * property a test can assert statically — and still vanishes when its own group throws.
   * Checked at runtime on every run, so it cannot rot between fixtures.
   */
  misfiledIds() {
    const out = [];
    for (const [group, ids] of this.emittedBy) {
      const registered = new Set((GROUP_IDS[group] ?? []).map(([id]) => id));
      for (const id of ids) {
        if (!registered.has(id)) out.push({ id, group, why: `not registered under ${group}` });
        else if (!CHECK_ORDER.includes(id)) out.push({ id, group, why: 'absent from CHECK_ORDER' });
      }
    }
    return out;
  }

  results() {
    const out = [];
    for (const id of CHECK_ORDER) {
      if (!this.applicable.has(id)) continue;
      const items = this.findings.get(id) ?? [];
      if (!items.length) {
        out.push({ id, status: 'UNKNOWN', evidence: 'check produced no evidence' });
        continue;
      }
      let worst = items[0];
      for (const item of items) {
        if (SEVERITY[item.status] > SEVERITY[worst.status]) worst = item;
      }
      let status = worst.status;
      // Worst first (a stable sort, on the copy `filter` returns — no `toSorted`, which a
      // consumer's older Node lacks): the row's status comes from its worst finding, so its
      // evidence leads with that one — a demoted note such as a newer rule's INFO must never
      // read as the reason a row FAILed.
      let evidence = items
        .filter((i) => SEVERITY[i.status] === SEVERITY[worst.status] || items.length <= 4)
        .sort((a, b) => SEVERITY[b.status] - SEVERITY[a.status])
        .map((i) => i.evidence)
        .join(' | ');
      // "A CRITICAL UNKNOWN is a FAIL under --enforce" is itself a profile-4 rule (contract
      // §3.6, constitution §4.8): a harness judged below it keeps UNKNOWN as UNKNOWN. A hard
      // UNKNOWN escalates at every profile — it is the checker's own structural claim.
      const criticalEscalates =
        !this.judgment ||
        this.judgment.unsupported ||
        this.judgment.profile >= SINCE.CRITICAL_UNKNOWN;
      if (
        status === 'UNKNOWN' &&
        this.mode === 'enforce' &&
        ((criticalEscalates && CRITICAL.has(id)) ||
          items.some((i) => i.status === 'UNKNOWN' && i.hard))
      ) {
        status = 'FAIL';
        evidence = `unverifiable under --enforce: ${evidence}`;
      }
      const result = { id, status, evidence };
      // Acknowledged only when EVERY finding is one: a single open finding beside an owned one
      // means the check still has something nobody has taken responsibility for.
      if (items.every((i) => i.acknowledged)) result.acknowledged = true;
      if (worst.file) result.file = worst.file;
      if (worst.line) result.line = worst.line;
      out.push(result);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------
// Context loading
// ---------------------------------------------------------------------------------------

function loadContext(opts) {
  const root = resolve(opts.root);
  const ctx = { root, opts, manifest: null, manifestError: null, pkg: null };
  // The shared shell reader asks the caller which pinned config drives a tool (shell.mjs).
  ctx.workOptions = (analysis, tool) => workOptionsFor(ctx, analysis, tool);

  const manifestRead = safeRead(join(root, '.claudeconf/manifest.json'));
  if (manifestRead.text === null) {
    ctx.manifestError = `missing (${manifestRead.error})`;
  } else {
    try {
      ctx.manifest = JSON.parse(manifestRead.text);
    } catch (e) {
      ctx.manifestError = `invalid JSON: ${e.message.split('\n')[0]}`;
    }
  }
  ctx.manifestPath = '.claudeconf/manifest.json';

  const pkgRead = safeRead(join(root, 'package.json'));
  if (pkgRead.text !== null) {
    try {
      ctx.pkg = JSON.parse(pkgRead.text);
    } catch {
      ctx.pkg = null;
    }
  }
  return ctx;
}

/** Loads a YAML file together with its raw lines and managed regions. */
function loadYamlArtifact(root, relPath) {
  const abs = join(root, relPath);
  const read = safeRead(abs);
  if (read.text === null) {
    return {
      path: relPath,
      exists: false,
      text: '',
      lines: [],
      regions: [],
      regionErrors: [],
      doc: null,
    };
  }
  const regions = extractManagedRegions(read.text);
  const parsed = parseYaml(read.text);
  return {
    path: relPath,
    exists: true,
    text: read.text,
    lines: read.text.split('\n'),
    regions,
    regionErrors: regions.errors,
    doc: parsed.doc,
    parseError: parsed.error,
  };
}

function inRegion(artifact, line) {
  return artifact.regions.some((r) => line > r.start && line < r.end);
}

// ---------------------------------------------------------------------------------------
// Manifest accessors
// ---------------------------------------------------------------------------------------

function milestoneEntries(manifest) {
  const m = manifest?.milestones;
  return m && typeof m === 'object' ? m : {};
}

/** The tools a milestone entry records: `[tool]` or every `tools[].tool`. */
function toolsOf(entry) {
  if (!entry || typeof entry !== 'object') return [];
  if (Array.isArray(entry.tools)) {
    return entry.tools.filter((t) => t && typeof t.tool === 'string').map((t) => t.tool);
  }
  return typeof entry.tool === 'string' ? [entry.tool] : [];
}

function tiersOf(entry) {
  return entry && Array.isArray(entry.tiers) ? entry.tiers : [];
}

function auditorsOf(manifest) {
  const list = manifest?.ci?.auditors;
  return Array.isArray(list) ? list : [];
}

function stacksOf(manifest) {
  return manifest && Array.isArray(manifest.stacks) ? manifest.stacks : [];
}

function projectChecksOf(manifest) {
  return manifest && Array.isArray(manifest.projectChecks) ? manifest.projectChecks : null;
}

/**
 * Modes read from the CONSTITUTION THE PLUGIN SHIPS: §1's tier ladder and §2's milestone
 * gates each carry a mode column, and both exemptions are read from them.
 *
 * A mode is a PROPERTY, never a memorised list of names — of milestones or of tiers. A list
 * goes stale the moment a mode changes, and the checker would then either fail something the
 * constitution mandates be advisory or stop checking something it made blocking. The column is
 * located by its HEADER, so a reordered table keeps working. An unreadable table yields an
 * empty map, which the caller reports as UNVERIFIED rather than guessing an exemption.
 */
const modeCache = new Map();
function constitutionModes(section) {
  const cached = modeCache.get(section);
  if (cached) return cached;
  const modes = new Map();
  modeCache.set(section, modes);
  const here = dirname(fileURLToPath(import.meta.url));
  const read = safeRead(join(here, '..', 'references', 'constitution.md'));
  if (read.text === null) return modes;
  const heading = new RegExp(`^##\\s+${escapeRx(section)}\\b`);
  let inSection = false;
  let modeColumn = -1;
  for (const line of read.text.split('\n')) {
    if (heading.test(line)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (/^##\s/.test(line)) break;
    if (!line.trim().startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (modeColumn < 0) {
      modeColumn = cells.findIndex((c) => /mode/i.test(c));
      continue;
    }
    if (cells.every((c) => /^-+$/.test(c))) continue;
    const name = norm(cells[0] ?? '');
    const mode = cells[modeColumn] ?? '';
    if (!name) continue;
    if (/advisory/i.test(mode)) modes.set(name, 'advisory');
    else if (/blocking/i.test(mode)) modes.set(name, 'blocking');
  }
  return modes;
}

const milestoneModes = () => constitutionModes('2. Milestone Gates');
const tierModes = () => constitutionModes('1. Tier Ladder');

/**
 * A signal verdict mapped onto a REPORTED status. `UNRESOLVED` is the reader's internal
 * sentinel — never a verdict — and the contract's floor rule places it at INFO below profile 4
 * and UNKNOWN at 4 and above. Every caller that reports a `signalVerdict` goes through here, so
 * the sentinel cannot reach a report by being forgotten at one call site.
 */
function reportedSignalStatus(status, level) {
  if (Object.hasOwn(SEVERITY, status)) return status;
  return level >= 4 ? 'UNKNOWN' : 'INFO';
}

/** How to SAY a non-PASS signal verdict: a demonstrated swallow, or one that cannot be shown. */
function signalPhrase(status) {
  return status === 'FAIL' ? 'is not signal-bearing' : 'cannot be shown to be signal-bearing';
}

/** Work-classification options for a command: which pinned config, if any, drives it. */
function workOptionsFor(ctx, analysis, tool) {
  const configFile = pinnedConfigFor(ctx.root, tool ?? analysis.tool);
  return configFile ? { configFile } : {};
}

// ---------------------------------------------------------------------------------------
// Workflow model
// ---------------------------------------------------------------------------------------

function buildWorkflow(ctx, relPath) {
  const wf = loadYamlArtifact(ctx.root, relPath);
  wf.jobs = [];
  if (!wf.exists || !wf.doc || typeof wf.doc !== 'object') return wf;
  const jobs = wf.doc.jobs;
  if (!jobs || typeof jobs !== 'object') return wf;
  const jobsLine = findLine(wf.lines, (l) => /^jobs:\s*$/.test(l));
  for (const [id, def] of Object.entries(jobs)) {
    const jobLine = findLine(
      wf.lines,
      (l) => new RegExp(`^\\s+${escapeRx(id)}:\\s*(#.*)?$`).test(l),
      jobsLine || 1,
    );
    const job = { id, def: def ?? {}, line: jobLine, steps: [], managed: inRegion(wf, jobLine) };
    const steps = def && Array.isArray(def.steps) ? def.steps : [];
    let cursor = jobLine || 1;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i] ?? {};
      const line = locateStep(wf.lines, step, cursor);
      if (line) cursor = line;
      job.steps.push({
        index: i,
        name: typeof step.name === 'string' ? step.name : '',
        uses: typeof step.uses === 'string' ? step.uses : '',
        run: typeof step.run === 'string' ? step.run : '',
        with: step.with && typeof step.with === 'object' ? step.with : {},
        if: step.if,
        continueOnError: step['continue-on-error'] === true,
        continueOnErrorRaw: step['continue-on-error'],
        shell: typeof step.shell === 'string' ? step.shell : null,
        line: line || jobLine,
        managed: inRegion(wf, line || jobLine),
        job,
      });
    }
    wf.jobs.push(job);
  }
  return wf;
}

function locateStep(lines, step, from) {
  if (typeof step.name === 'string' && step.name) {
    const rx = new RegExp(`^\\s*-?\\s*name:\\s*['"]?${escapeRx(step.name)}['"]?\\s*$`);
    const line = findLine(lines, (l) => rx.test(l), from);
    if (line) return line;
  }
  if (typeof step.uses === 'string' && step.uses) {
    const line = findLine(lines, (l) => l.includes(`uses: ${step.uses}`), from);
    if (line) return line;
  }
  if (typeof step.run === 'string' && step.run) {
    const head = firstLine(step.run).trim();
    if (head) {
      const line = findLine(lines, (l) => l.includes(head), from);
      if (line) return line;
    }
  }
  return 0;
}

/**
 * The command a step executes: its `run`, or a docker action's `args` prefixed by the image's
 * binary name (the image IS the executable, so `args: filesystem .` runs `trufflehog filesystem .`).
 */
function stepCommand(step) {
  if (step.run) return step.run;
  if (step.uses?.startsWith('docker://')) {
    const image = basename(step.uses.slice('docker://'.length).split('@')[0].split(':')[0]);
    const args = typeof step.with.args === 'string' ? step.with.args.trim() : '';
    if (!args) return image;
    return tokenize(args)[0] === image ? args : `${image} ${args}`;
  }
  return '';
}

/** The 1-based line of a step's own `uses:` (the step's line is its `- name:`). */
function usesLineOf(wf, step) {
  if (!step.uses) return step.line;
  return findLine(wf.lines, (l) => l.includes(`uses: ${step.uses}`), step.line) || step.line;
}

/** The 1-based line inside a multi-line command where `rx` first matches. */
function matchLineOf(text, rx, baseLine, lines) {
  const parts = String(text).split('\n');
  for (const part of parts) {
    if (!rx.test(part)) continue;
    const abs = findLine(lines ?? [], (l) => l.includes(part.trim()), baseLine ?? 1);
    return { line: abs || baseLine, text: part.trim() };
  }
  return { line: baseLine, text: firstLine(text).trim() };
}

// ---------------------------------------------------------------------------------------
// Hook model
// ---------------------------------------------------------------------------------------

const HOOK_KEYS = new Set([
  'pre-commit',
  'pre-push',
  'commit-msg',
  'prepare-commit-msg',
  'post-checkout',
  'post-merge',
  'post-commit',
  'gate',
]);

/** True when a top-level lefthook key describes a hook (rather than a runner setting). */
function isHookNode(key, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return HOOK_KEYS.has(key) || Array.isArray(value.jobs) || !!value.commands || !!value.scripts;
}

function jobsOfHook(node) {
  return node && Array.isArray(node.jobs) ? node.jobs : [];
}

/** Every job of the merged dump, flattened as `{hook, name, def}` (nested groups included). */
function mergedJobs(dump) {
  const out = [];
  if (!dump || typeof dump !== 'object') return out;
  for (const [hook, node] of Object.entries(dump)) {
    if (!isHookNode(hook, node)) continue;
    for (const job of jobsOfHook(node)) {
      if (!job || typeof job !== 'object') continue;
      out.push({ hook, name: typeof job.name === 'string' ? job.name : '', def: job });
    }
  }
  return out;
}

/** Milestone-token match for a hook JOB name: `<token>` or `<token>-<suffix>`. */
function jobMatchesToken(name, token) {
  const n = String(name ?? '');
  return n === token || n.startsWith(`${token}-`);
}

/** The `run` text of a job (a group job has none of its own). */
function jobRun(def) {
  return typeof def.run === 'string' ? def.run : '';
}

/**
 * EVERY command a job executes, flattening lefthook's nested groups.
 *
 * The runner's nesting shape is `job.group.jobs` — verified against the pinned runner, which
 * DROPS a `job.jobs` key entirely — and the old reader walked the shape that does not exist. A
 * job carrying only a group therefore had no command at all: `no command to judge`, INFO, and a
 * `|| true` inside the group neutered the suppression ledger with a zero-FAIL run. Every reader
 * of a job's command goes through here, so the nesting is handled once rather than per check.
 */
function jobCommands(def, depth = 0) {
  if (!def || typeof def !== 'object' || depth > 4) return [];
  const own = jobRun(def);
  if (own) return [own];
  const inner = def.group && Array.isArray(def.group.jobs) ? def.group.jobs : [];
  return inner.flatMap((job) => jobCommands(job, depth + 1));
}

/** A job's commands as one text, for token searches that do not care which command matched. */
function jobText(def) {
  return jobCommands(def).join('\n');
}

// ---------------------------------------------------------------------------------------
// Where the harness runs a tool (A12)
// ---------------------------------------------------------------------------------------

/** Runners whose directory flag moves the command into another directory, and those flags. */
const DIR_FLAG_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'uv', 'poetry', 'make']);
const DIR_FLAGS = new Set(['--prefix', '-C', '--dir', '--cwd', '--directory', '--project']);

/**
 * `dir` joined onto the root-relative `base` ('' is the root) — or null for a directory this
 * checker cannot place inside the repository: absolute, an expression or a variable, or one
 * that climbs out of it.
 */
function repoDir(base, dir) {
  if (base === null || typeof dir !== 'string' || !dir.trim()) return base;
  const d = dir.trim().replace(/^["']|["']$/g, '');
  if (isAbsolute(d) || /[$`{~]/.test(d)) return null;
  const joined = posix.normalize(posix.join(base || '.', d)).replace(/\/$/, '');
  if (joined === '..' || joined.startsWith('../')) return null;
  return joined === '.' ? '' : joined;
}

/**
 * Every root-relative directory the harness runs `tool` from. Each hook job starts in its
 * lefthook `root:` (nested groups included) and each CI step in its `working-directory` (else
 * the job's or the workflow's default); a `cd <dir>` earlier on the same line moves it, and so
 * does a runner's directory flag (`npm --prefix app`, `pnpm -C app`, `yarn --cwd app`, `uv run
 * --directory app`, `make -C app`). `npm run <script>` is resolved through THAT directory's
 * package.json, which is where the script the runner executes is defined, and every command of
 * the script's body is read — `prisma generate && tsc --noEmit` runs tsc too.
 */
function toolRunDirs(ctx, tool) {
  const dirs = new Set();
  const visit = (base, text, depth = 0) => {
    if (base === null || depth > 3) return;
    for (const line of executableText(text).split('\n')) {
      let dir = base;
      for (const segment of splitTopLevel(line, '&&').flatMap((s) => splitTopLevel(s, ';'))) {
        const cd = /^\s*cd\s+(\S+)\s*$/.exec(segment);
        if (cd) {
          dir = repoDir(dir, cd[1]);
          if (dir === null) break;
          continue;
        }
        const tokens = tokenize(segment);
        const runner = DIR_FLAG_RUNNERS.has(basename(tokens[0] ?? ''));
        let at = dir;
        const kept = [];
        for (let i = 0; i < tokens.length; i++) {
          const assigned = runner ? /^(--[a-z]+)=(.+)$/.exec(tokens[i]) : null;
          if (assigned && DIR_FLAGS.has(assigned[1])) at = repoDir(at, assigned[2]);
          else if (runner && i > 0 && DIR_FLAGS.has(tokens[i]) && i + 1 < tokens.length) {
            at = repoDir(at, tokens[++i]);
          } else kept.push(tokens[i]);
        }
        if (at === null) continue;
        const pkg = readJson(join(ctx.root, at, 'package.json'));
        const body = packageScript(kept, pkg);
        if (body !== null) visit(at, body, depth + 1);
        else if (commandMatchesTool(analyseCommand(kept.join(' '), pkg), tool)) dirs.add(at);
      }
    }
  };
  const walkJob = (def, base, depth = 0) => {
    if (!def || typeof def !== 'object' || depth > 4) return;
    const here = typeof def.root === 'string' ? repoDir('', def.root) : base;
    if (typeof def.run === 'string') visit(here, def.run);
    for (const inner of Array.isArray(def.group?.jobs) ? def.group.jobs : []) {
      walkJob(inner, here, depth + 1);
    }
  };
  for (const job of mergedJobs(ctx.dump?.dump)) walkJob(job.def, '');
  const wf = ctx.workflow;
  if (wf?.exists) {
    const fallback = wf.doc?.defaults?.run?.['working-directory'];
    for (const job of wf.jobs) {
      const jobDir = job.def?.defaults?.run?.['working-directory'] ?? fallback;
      for (const step of job.steps) {
        if (!step.run) continue;
        const own = job.def?.steps?.[step.index]?.['working-directory'];
        visit(repoDir('', own ?? jobDir ?? ''), step.run);
      }
    }
  }
  return dirs;
}

/** The body of the package.json script `tokens` run (`npm run x`, `npm test`, …), or null. */
function packageScript(tokens, pkg) {
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(basename(tokens[0] ?? ''))) return null;
  const args = tokens.slice(1);
  const name = args[0] === 'run' || args[0] === 'run-script' ? args[1] : args[0];
  const body = name && !name.startsWith('-') ? pkg?.scripts?.[name] : undefined;
  return typeof body === 'string' ? body : null;
}

/** The first of `candidates` in `dir` or in a directory above it, root-relative, or null. */
function configAtOrAbove(dir, candidates, exists) {
  for (let d = dir; ; d = posix.dirname(d) === '.' ? '' : posix.dirname(d)) {
    const hit = candidates.map((c) => (d ? posix.join(d, c) : c)).find(exists);
    if (hit) return hit;
    if (!d) return null;
  }
}

// ---------------------------------------------------------------------------------------
// Checks — manifest (M*)
// ---------------------------------------------------------------------------------------

function checkManifest(ctx, r, level) {
  const { manifest } = ctx;
  const file = ctx.manifestPath;

  if (!manifest) {
    r.add('M1', 'FAIL', `${file}: ${ctx.manifestError}`, { file });
    return;
  }
  r.add('M1', 'PASS', `${file}: valid JSON`, { file });

  const recorded = manifest.constitutionVersion;
  if (recorded === '1' && ctx.judgment?.unsupported) {
    r.add(
      'M2',
      'UNKNOWN',
      `${file}: constitutionVersion "1" — profile 1 is not supported by this checker, so nothing in this report is judged; regenerate the harness at profile ${CURRENT_PROFILE} (references/migrations.md)`,
      { file, hard: true, integrity: true },
    );
  } else if (typeof recorded === 'string' && KNOWN_PROFILES.includes(recorded)) {
    r.add('M2', 'PASS', `${file}: constitutionVersion "${recorded}"`, { file });
  } else {
    r.add(
      'M2',
      'UNKNOWN',
      `${file}: constitutionVersion ${JSON.stringify(recorded)} is not a profile this checker knows (${KNOWN_PROFILES.join('/')}) — judged at profile ${ctx.judgment?.profile ?? CURRENT_PROFILE} instead of trusting it`,
      { file, hard: true },
    );
  }
  for (const note of ctx.judgment?.notes ?? []) r.add('M2', 'INFO', `${file}: ${note}`, { file });

  const keys = Object.keys(milestoneEntries(manifest));
  const missing = MILESTONES.filter((m) => !keys.includes(m));
  const extra = keys.filter((k) => !MILESTONES.includes(k));
  if (missing.length || extra.length) {
    r.add(
      'M3',
      'FAIL',
      `${file}: milestones missing [${missing.join(', ')}] extra [${extra.join(', ')}]`,
      { file },
    );
  } else {
    r.add('M3', 'PASS', `${file}: all nine milestone keys present`, { file });
  }

  for (const [key, entry] of Object.entries(milestoneEntries(manifest))) {
    const where = `${file} milestones.${key}`;
    const hasSingle = typeof entry?.tool === 'string' && entry.tool !== '';
    const multi = Array.isArray(entry?.tools) ? entry.tools : null;
    // A holder names its version by a literal (profile ≤5) or a typed pin (profile 6,
    // contract §2.5) — never both.
    const versioned = (h) =>
      (typeof h?.version === 'string' && h.version !== '') || h?.pin !== undefined;
    const both = (h) => h?.pin !== undefined && h?.version !== undefined;
    if (hasSingle && multi) {
      r.add('M4', 'FAIL', `${where}: has BOTH tool and tools[]`, { file });
    } else if (multi) {
      if (!multi.length) r.add('M4', 'FAIL', `${where}: tools[] is empty`, { file });
      for (const t of multi) {
        if (!t?.stack || !t.tool || !versioned(t)) {
          r.add('M4', 'FAIL', `${where}: tools[] entry needs stack+tool+version (or pin)`, {
            file,
          });
        } else if (both(t)) {
          r.add('M4', 'FAIL', `${where}: ${t.tool} records BOTH version and pin`, { file });
        }
      }
      if (multi.length && multi.every((t) => t?.stack && t?.tool && versioned(t) && !both(t))) {
        r.add('M4', 'PASS', `${where}: ${multi.length} per-stack tools`, { file });
      }
    } else if (hasSingle) {
      if (both(entry)) {
        r.add('M4', 'FAIL', `${where}: ${entry.tool} records BOTH version and pin`, { file });
      } else if (versioned(entry)) {
        r.add('M4', 'PASS', `${where}: ${entry.tool} ${entry.version ?? '(typed pin)'}`, { file });
      } else {
        r.add('M4', 'FAIL', `${where}: tool without version`, { file });
      }
    } else {
      r.add('M4', 'FAIL', `${where}: neither tool+version nor tools[]`, { file });
    }
    const holders = multi ?? (hasSingle ? [entry] : []);
    if (level >= SINCE['M4.pin']) {
      for (const h of holders) {
        if (h?.pin === undefined && typeof h?.version === 'string') {
          r.add(
            'M4',
            'FAIL',
            `${where}: ${h.tool} records a copied version "${h.version}" — profile 6 records a typed pin into the file that pins it (contract §2.5)`,
            { file, rule: 'M4.pin' },
          );
        }
      }
    }

    for (const h of holders) {
      const tool = h?.tool;
      const rec = pinRecordOf(ctx, h);
      if (rec?.form === 'pin') {
        if (rec.error) {
          r.add('M5', 'FAIL', `${where}: ${tool} pin does not resolve — ${rec.error.why}`, {
            file,
          });
        } else {
          r.add('M5', 'PASS', `${where}: ${tool} ${rec.version} (${rec.provenance})`, { file });
        }
        continue;
      }
      const version = h?.version;
      if (typeof version !== 'string') continue;
      if (!isPinnedVersion(version)) {
        r.add('M5', 'FAIL', `${where}: ${tool} version "${version}" is not a pinned version`, {
          file,
        });
      } else if (
        version === 'n/a' &&
        !RUNTIME_VERSIONED.includes(tool) &&
        key !== 'dependency-audit'
      ) {
        r.add(
          'M5',
          'FAIL',
          `${where}: ${tool} records "n/a" but does not version through the runtime`,
          { file },
        );
      } else {
        r.add('M5', 'PASS', `${where}: ${tool} ${version}`, { file });
      }
    }

    const tiers = tiersOf(entry);
    const badTiers = tiers.filter((t) => !TIERS.includes(t));
    if (!tiers.length || badTiers.length || !tiers.includes('gate') || !tiers.includes('ci')) {
      r.add(
        'M6',
        'FAIL',
        `${where}: tiers ${JSON.stringify(tiers)} must be non-empty, a subset of ${TIERS.join('/')}, and include gate + ci`,
        { file },
      );
    } else {
      r.add('M6', 'PASS', `${where}: tiers ${tiers.join(',')}`, { file });
    }
  }

  if (level >= 2) {
    const auditors = auditorsOf(manifest);
    if (!auditors.length) {
      r.add('M7', 'FAIL', `${file}: ci.auditors is empty — the workflow itself is unaudited`, {
        file,
      });
    } else {
      for (const a of auditors) {
        const rec = pinRecordOf(ctx, a);
        if (rec?.form === 'pin' && typeof a.tool === 'string') {
          if (rec.error) {
            r.add(
              'M7',
              'FAIL',
              `${file}: auditor ${a.tool} pin does not resolve — ${rec.error.why}`,
              {
                file,
              },
            );
          } else {
            r.add('M7', 'PASS', `${file}: auditor ${a.tool} ${rec.version} (${rec.provenance})`, {
              file,
            });
          }
        } else if (!a || typeof a.tool !== 'string' || !isPinnedVersion(a.version)) {
          r.add(
            'M7',
            'FAIL',
            `${file}: ci.auditors entry ${JSON.stringify(a)} needs tool + pinned version`,
            { file },
          );
        } else {
          r.add('M7', 'PASS', `${file}: auditor ${a.tool} ${a.version}`, { file });
          if (level >= SINCE['M7.pin']) {
            r.add(
              'M7',
              'FAIL',
              `${file}: auditor ${a.tool} records a copied version — profile 6 records a typed pin (contract §2.5)`,
              { file, rule: 'M7.pin' },
            );
          }
        }
      }
    }
  }

  if (level >= 3) {
    const hr = manifest.hookRunner;
    const rec = pinRecordOf(ctx, hr);
    if (rec?.form === 'pin' && typeof hr.name === 'string' && hr.name) {
      if (rec.error) {
        r.add('M8', 'FAIL', `${file}: hookRunner pin does not resolve — ${rec.error.why}`, {
          file,
        });
      } else {
        r.add('M8', 'PASS', `${file}: hookRunner ${hr.name} ${rec.version} (${rec.provenance})`, {
          file,
        });
      }
    } else if (!hr || typeof hr.name !== 'string' || !hr.name || !isPinnedVersion(hr.version)) {
      r.add('M8', 'FAIL', `${file}: hookRunner must record name + pinned version`, { file });
    } else {
      r.add('M8', 'PASS', `${file}: hookRunner ${hr.name} ${hr.version}`, { file });
      if (level >= SINCE['M8.pin']) {
        r.add(
          'M8',
          'FAIL',
          `${file}: hookRunner records a copied version — profile 6 records a typed pin (contract §2.5)`,
          { file, rule: 'M8.pin' },
        );
      }
    }
    if (typeof manifest.agentUse !== 'boolean') {
      r.add('M8', 'FAIL', `${file}: agentUse must be a boolean`, { file });
    } else if (manifest.agentUse === false && !manifest.agentUseRationale) {
      r.add('M8', 'FAIL', `${file}: agentUse false requires agentUseRationale`, { file });
    }
  }

  // M13 — the harness runtimes are pinned (profile 6, contract §2.5): the vendored support
  // scripts run on Node in every stack, so its version is a pin like any tool's.
  if (level >= SINCE.M13) {
    const runtimeRecs = (ctx.pinRecords ?? []).filter((x) => x.where.startsWith('runtimes.'));
    if (!runtimeRecs.some((x) => x.where === 'runtimes.node')) {
      r.add('M13', 'FAIL', `${file}: runtimes.node is required — the support scripts run on Node`, {
        file,
      });
    }
    for (const rec of runtimeRecs) {
      if (rec.error) {
        r.add('M13', 'FAIL', `${file}: ${rec.where} does not resolve — ${rec.error.why}`, { file });
      } else {
        r.add('M13', 'PASS', `${file}: ${rec.where} ${rec.version} (${rec.provenance})`, { file });
      }
    }
  }

  if (level >= 4) {
    const checks = projectChecksOf(manifest);
    if (checks === null) {
      r.add(
        'M9',
        'FAIL',
        `${file}: projectChecks is REQUIRED at profile 4 (an empty array is the explicit "none declared")`,
        { file },
      );
    } else {
      const seen = new Set();
      const managedNames = new Set([...MANAGED_NAMES, ...ctx.managedJobNames]);
      for (const entry of checks) {
        const name = entry?.name;
        if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name)) {
          r.add('M9', 'FAIL', `${file}: projectChecks name ${JSON.stringify(name)} is invalid`, {
            file,
          });
          continue;
        }
        if (seen.has(name)) {
          r.add('M9', 'FAIL', `${file}: duplicate projectChecks name "${name}"`, { file });
        }
        seen.add(name);
        if (managedNames.has(name)) {
          r.add(
            'M9',
            'FAIL',
            `${file}: projectChecks name "${name}" collides with a MANAGED name (contract §2.4)`,
            { file },
          );
        }
        const tiers = Array.isArray(entry.tiers) ? entry.tiers : [];
        if (
          !tiers.length ||
          tiers.some((t) => !['pre-commit', 'pre-push', 'gate', 'ci'].includes(t))
        ) {
          r.add(
            'M9',
            'FAIL',
            `${file}: projectChecks "${name}" tiers ${JSON.stringify(tiers)} invalid`,
            { file },
          );
        }
        if (typeof entry.run !== 'string' || !entry.run.trim()) {
          r.add(
            'M9',
            'FAIL',
            `${file}: projectChecks "${name}" has no \`run\` — name-only protection is not protection (R-C5)`,
            { file },
          );
        }
      }
      if (!checks.length) r.add('M9', 'INFO', `${file}: projectChecks: none declared`, { file });
      else r.add('M9', 'PASS', `${file}: ${checks.length} project check(s) declared`, { file });
    }
  }

  const rules = milestoneEntries(manifest).sast?.rules;
  if (rules && typeof rules === 'object') {
    if (rules.source !== 'hand-authored') {
      const okRef = typeof rules.ref === 'string' && /^[0-9a-f]{40}$/.test(rules.ref);
      const okSrc = typeof rules.source === 'string' && rules.source.startsWith('https://');
      if (!okRef || !okSrc) {
        r.add(
          'M10',
          'FAIL',
          `${file}: sast.rules vendored from ${JSON.stringify(rules.source)} needs an https:// source and a 40-hex ref`,
          { file },
        );
      } else {
        r.add('M10', 'PASS', `${file}: sast.rules ${rules.source}@${rules.ref}`, { file });
      }
    } else {
      r.add('M10', 'PASS', `${file}: sast.rules hand-authored`, { file });
    }
  } else {
    r.add('M10', 'INFO', `${file}: sast.rules provenance not recorded (optional)`, { file });
  }

  const volatile = [];
  walkJson(manifest, '', (path, key) => {
    if (/(created|generated)At|timestamp|date|seed/i.test(key)) volatile.push(path);
  });
  if (volatile.length) {
    r.add(
      'M11',
      'FAIL',
      `${file}: volatile field(s) ${volatile.join(', ')} break the determinism invariant`,
      { file },
    );
  } else {
    r.add('M11', 'PASS', `${file}: no volatile fields`, { file });
  }

  if (level >= 4) {
    const deny = manifest.agentHardening?.denyPatterns;
    if (manifest.agentUse === true) {
      if (!Array.isArray(deny) || !deny.length) {
        r.add(
          'M12',
          'FAIL',
          `${file}: agentUse true requires a non-empty agentHardening.denyPatterns`,
          { file },
        );
      } else {
        r.add('M12', 'PASS', `${file}: ${deny.length} recorded deny patterns`, { file });
      }
    } else if (deny) {
      r.add(
        'M12',
        'FAIL',
        `${file}: agentHardening.denyPatterns recorded while agentUse is not true`,
        { file },
      );
    } else {
      r.add('M12', 'PASS', `${file}: agentUse false, no agentHardening record expected`, { file });
    }
  }
}

function walkJson(value, path, visit) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) walkJson(value[i], `${path}[${i}]`, visit);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    visit(childPath, key);
    walkJson(child, childPath, visit);
  }
}

// ---------------------------------------------------------------------------------------
// Checks — artifacts (A*)
// ---------------------------------------------------------------------------------------

/**
 * Dependabot ecosystems whose cooldown supports `default-days` ONLY — the `semver-*-days` keys
 * are "Not supported" (GitHub Docs, Dependabot options reference, `cooldown` support table;
 * YAML values from its `package-ecosystem` table; read 2026-10-13).
 */
const SEMVER_COOLDOWN_UNSUPPORTED = new Set([
  'bazel',
  'devcontainers',
  'docker',
  'docker-compose',
  'github-actions',
  'gitsubmodule',
  'helm',
  'nix',
  'opentofu',
  'pre-commit',
  'terraform',
  'vcpkg',
]);

/** Tools that legitimately have no config file of their own. */
const NO_CONFIG_TOOLS = new Set([...RUNTIME_VERSIONED, 'build', 'commitlint']);

const LOCKFILES = {
  node: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'],
  python: ['uv.lock', 'poetry.lock', 'Pipfile.lock'],
  elixir: ['mix.lock'],
  swift: ['Package.resolved'],
  kotlin: ['gradle.lockfile'],
  java: ['gradle.lockfile'],
};

function checkArtifacts(ctx, r, level) {
  const { root, manifest } = ctx;
  const exists = (p) => existsSync(join(root, p));

  // A1 — hook config (split by ownership at profile 4)
  const rootHookPath = ['lefthook.yml', 'lefthook.yaml'].find(exists) ?? null;
  const preCommitPath = exists('.pre-commit-config.yaml') ? '.pre-commit-config.yaml' : null;
  if (level >= 4) {
    if (!exists('.claudeconf/lefthook.yml')) {
      r.add(
        'A1',
        'FAIL',
        '.claudeconf/lefthook.yml is missing — profile 4 splits hooks by ownership',
        { file: '.claudeconf/lefthook.yml' },
      );
    } else {
      r.add('A1', 'PASS', '.claudeconf/lefthook.yml exists (managed hooks)', {
        file: '.claudeconf/lefthook.yml',
      });
    }
    if (!rootHookPath) {
      r.add('A1', 'FAIL', 'root lefthook.yml is missing — it carries the managed `extends` block', {
        file: 'lefthook.yml',
      });
    } else {
      const art = ctx.rootHook;
      // The VERDICT comes from the parsed `extends` list; the line only says WHERE, and it is
      // comment-stripped. The managed block carries prose that names the managed file (this
      // repo's own does), so a line match alone passed a block whose `extends` was empty.
      const extendsList = Array.isArray(art.doc?.extends)
        ? art.doc.extends.filter((e) => typeof e === 'string')
        : [];
      const declared = extendsList.some(
        (e) => e.replace(/^\.\//, '') === '.claudeconf/lefthook.yml',
      );
      const line = declared
        ? findLine(
            art.lines,
            (l, n) => inRegion(art, n) && stripComment(l).includes('.claudeconf/lefthook.yml'),
          )
        : 0;
      if (!art.doc || typeof art.doc !== 'object') {
        r.add(
          'A1',
          'UNKNOWN',
          `${rootHookPath}: unparseable (${art.parseError ?? 'no document'})`,
          {
            file: rootHookPath,
            hard: true,
          },
        );
      } else if (line) {
        r.add(
          'A1',
          'PASS',
          `${rootHookPath}:${line}: managed block extends .claudeconf/lefthook.yml`,
          { file: rootHookPath, line },
        );
      } else {
        r.add(
          'A1',
          'FAIL',
          `${rootHookPath}: the managed block does not list .claudeconf/lefthook.yml in \`extends\``,
          { file: rootHookPath },
        );
      }
    }
  } else if (rootHookPath || preCommitPath) {
    r.add('A1', 'PASS', `${rootHookPath ?? preCommitPath}: hook config present`, {
      file: rootHookPath ?? preCommitPath,
    });
  } else {
    r.add('A1', 'FAIL', 'no hook config (lefthook.yml / .pre-commit-config.yaml)', {
      file: 'lefthook.yml',
    });
  }

  // A2 — CI workflow
  const wfPath = ctx.workflow.path;
  if (ctx.workflow.exists) r.add('A2', 'PASS', `${wfPath}: exists`, { file: wfPath });
  else r.add('A2', 'FAIL', `${wfPath}: manifest ci.workflow does not exist`, { file: wfPath });

  // A3 — dependency-update config with a cooldown
  if (level >= 2) {
    const updater = ['.github/dependabot.yml', '.github/dependabot.yaml', 'renovate.json'].find(
      exists,
    );
    if (!updater) {
      r.add('A3', 'FAIL', 'no .github/dependabot.yml or renovate.json', {
        file: '.github/dependabot.yml',
      });
    } else if (updater === 'renovate.json') {
      const json = readJson(join(root, updater));
      const rules = Array.isArray(json?.packageRules) ? json.packageRules : [];
      if (!json) {
        r.add('A3', 'UNKNOWN', `${updater}: unparseable JSON`, { file: updater, hard: true });
      } else if (
        json.minimumReleaseAge != null ||
        (rules.length && rules.every((rule) => rule?.minimumReleaseAge != null))
      ) {
        r.add('A3', 'PASS', `${updater}: minimumReleaseAge configured`, { file: updater });
      } else {
        r.add('A3', 'FAIL', `${updater}: no minimumReleaseAge (constitution §4.6)`, {
          file: updater,
        });
      }
    } else {
      // PARSED, not matched. The word `cooldown` appears in a COMMENT the generator itself
      // writes ("security updates bypass cooldown by design"), so a raw-line regex reported
      // `PASS … release-age cooldown configured` for a file with no cooldown block at all —
      // with its own evidence pointing at the comment. Parsing also answers the question the
      // regex could not: the cooldown has to cover EVERY `updates[]` entry, not just one.
      const art = loadYamlArtifact(root, updater);
      const updates = Array.isArray(art.doc?.updates) ? art.doc.updates : null;
      if (!art.doc || typeof art.doc !== 'object') {
        r.add('A3', 'UNKNOWN', `${updater}: unparseable (${art.parseError ?? 'no document'})`, {
          file: updater,
          hard: true,
        });
      } else if (!updates?.length) {
        r.add('A3', 'FAIL', `${updater}: no \`updates:\` entries`, { file: updater });
      } else {
        const uncovered = updates
          .map((entry, i) => ({
            entry,
            name:
              entry && typeof entry['package-ecosystem'] === 'string'
                ? entry['package-ecosystem']
                : `entry ${i + 1}`,
          }))
          .filter(({ entry }) => !entry?.cooldown || typeof entry.cooldown !== 'object')
          .map(({ name }) => name);
        if (uncovered.length) {
          r.add(
            'A3',
            'FAIL',
            `${updater}: no cooldown block for ${uncovered.join(', ')} (constitution §4.6)`,
            { file: updater },
          );
        } else {
          const line = findLine(art.lines, (l) => /^\s*cooldown:/.test(stripComment(l)));
          r.add(
            'A3',
            'PASS',
            `${updater}:${line}: release-age cooldown on ${updates.length} ecosystem(s)`,
            { file: updater, line },
          );
        }
        // A key the SERVICE rejects is not a cooldown — Dependabot rejects the WHOLE file, so
        // no update of any ecosystem runs (three field repositories had never received one).
        for (const entry of updates) {
          const eco = entry?.['package-ecosystem'];
          const keys = Object.keys(entry?.cooldown ?? {}).filter((k) => /^semver-.*-days$/.test(k));
          if (typeof eco === 'string' && SEMVER_COOLDOWN_UNSUPPORTED.has(eco) && keys.length) {
            r.add(
              'A3',
              'FAIL',
              `${updater}: ${keys.join(', ')} under \`${eco}\` — Dependabot does not support SemVer cooldowns for ${eco} and rejects the WHOLE file, so no ecosystem receives updates (keep only default-days there)`,
              { file: updater, rule: 'A3.keys' },
            );
          }
        }
      }
    }
  }

  // A4 — a committed lockfile per stack
  for (const stack of stacksOf(manifest)) {
    const candidates = LOCKFILES[stack];
    if (!candidates) {
      r.add('A4', 'UNKNOWN', `stack "${stack}" has no known lockfile mapping in this checker`);
      continue;
    }
    const found = candidates.find(exists);
    if (found) {
      r.add('A4', 'PASS', `${found}: lockfile for the ${stack} stack`, { file: found });
      continue;
    }
    if (stack === 'python') {
      const req = readdirSafe(root).find((f) => /^requirements.*\.txt$/.test(f));
      if (req && executableText(safeRead(join(root, req)).text ?? '').includes('--hash')) {
        r.add('A4', 'PASS', `${req}: hash-locked requirements`, { file: req });
        continue;
      }
    }
    r.add('A4', 'FAIL', `no lockfile for the ${stack} stack (looked for ${candidates.join(', ')})`);
  }

  // A5 — the format milestone is wired into the edit hook
  const settings = ctx.settings;
  if (!settings.json) {
    r.add('A5', 'FAIL', `.claude/settings.json: ${settings.error ?? 'missing'}`, {
      file: '.claude/settings.json',
    });
  } else {
    const formatTools = toolsOf(milestoneEntries(manifest).format);
    const entries = settingsHookEntries(settings.json, 'PostToolUse');
    // The rule is that the edit hook RUNS the format tool. A hook that runs a project script
    // which runs it satisfies that at every profile; reading only the literal command made
    // four field harnesses fail a rule they keep.
    const runsFormat = (command) =>
      formatTools.some(
        (t) => command.includes(t) || executableText(hookScriptText(ctx, command)).includes(t),
      );
    const match = entries.find(
      (e) => runsFormat(e.command) || (level >= 4 && e.marker && e.marker.milestone === 'format'),
    );
    if (match) {
      r.add('A5', 'PASS', `.claude/settings.json: PostToolUse hook runs ${formatTools.join('/')}`, {
        file: '.claude/settings.json',
      });
    } else {
      r.add(
        'A5',
        'FAIL',
        `.claude/settings.json: no PostToolUse entry invoking the format tool (${formatTools.join('/') || 'none recorded'})`,
        { file: '.claude/settings.json' },
      );
    }
  }

  // A6 — e2e suite exists and holds tests
  const suites = [].concat(manifest?.e2e?.suite ?? []);
  if (!suites.length) {
    r.add('A6', 'FAIL', `${ctx.manifestPath}: e2e.suite is not recorded`, {
      file: ctx.manifestPath,
    });
  }
  for (const suite of suites) {
    if (typeof suite !== 'string') continue;
    const files = listFilesRecursive(join(root, suite));
    if (!files.length) {
      r.add('A6', 'FAIL', `${suite}: e2e suite is missing or empty`, { file: suite });
    } else if (!files.some((f) => /(test|spec)/i.test(basename(f)))) {
      r.add('A6', 'FAIL', `${suite}: no file named like a test`, { file: suite });
    } else {
      r.add('A6', 'PASS', `${suite}: ${files.length} file(s), at least one test`, { file: suite });
    }
  }

  // A7 — repo hygiene staples
  for (const p of ['.editorconfig', '.github/CODEOWNERS']) {
    if (exists(p)) r.add('A7', 'PASS', `${p}: present`, { file: p });
    else r.add('A7', 'FAIL', `${p}: missing`, { file: p });
  }
  if (!exists('.gitattributes')) {
    r.add('A7', 'FAIL', '.gitattributes: missing', { file: '.gitattributes' });
  } else {
    const text = safeRead(join(root, '.gitattributes')).text ?? '';
    // Comment-stripped: `# * text=auto` configures nothing (the A3 class).
    const line = findLine(text.split('\n'), (l) => stripComment(l).includes('text=auto'));
    if (line)
      r.add('A7', 'PASS', `.gitattributes:${line}: text=auto`, { file: '.gitattributes', line });
    else
      r.add('A7', 'FAIL', '.gitattributes: no `text=auto` (line-ending determinism)', {
        file: '.gitattributes',
      });
  }

  // A8 — the scanner exclude file the secret-scan command names
  const excludes = ctx.secretScanExcludes;
  if (!excludes.length) r.add('A8', 'UNKNOWN', 'no secret-scan command names an exclude file');
  for (const ex of excludes) {
    const relExclude = ex.path.replace(/^\/repo\//, '').replace(/^\/github\/workspace\//, '');
    if (!exists(relExclude)) {
      r.add('A8', 'FAIL', `${ex.where}: exclude file ${relExclude} does not exist`, {
        file: relExclude,
      });
      continue;
    }
    const text = safeRead(join(root, relExclude)).text ?? '';
    // Comment-stripped: a commented-out pattern excludes nothing (the A3 class).
    const line = findLine(text.split('\n'), (l) => stripComment(l).includes('.git'));
    if (line) r.add('A8', 'PASS', `${relExclude}:${line}: covers .git`, { file: relExclude, line });
    else
      r.add('A8', 'FAIL', `${relExclude}: does not cover .git (a checkout token lives there)`, {
        file: relExclude,
      });
  }

  // A9 — the suppression ledger and its checker
  if (level >= 3) {
    const ledger = '.claudeconf/suppressions.json';
    const read = safeRead(join(root, ledger));
    if (read.text === null) {
      r.add('A9', 'FAIL', `${ledger}: missing`, { file: ledger });
    } else {
      try {
        const parsed = JSON.parse(read.text);
        if (Array.isArray(parsed)) {
          r.add('A9', 'PASS', `${ledger}: ${parsed.length} approved suppression(s)`, {
            file: ledger,
          });
        } else {
          r.add('A9', 'FAIL', `${ledger}: must be a JSON array`, { file: ledger });
        }
      } catch (e) {
        r.add('A9', 'FAIL', `${ledger}: invalid JSON (${e.message.split('\n')[0]})`, {
          file: ledger,
        });
      }
    }
    const script = findScript(root, 'check-suppressions');
    if (script) r.add('A9', 'PASS', `${script}: suppression checker present`, { file: script });
    // Profiles 3–5 named this path only as an example ("e.g."); the gate WIRING is W10's. The
    // path becomes normative with the vendored bundle (profile 6).
    else {
      r.add('A9', 'FAIL', 'scripts/check-suppressions.* is missing', {
        file: 'scripts/',
        rule: 'A9.path',
      });
    }
  }

  // A10 — agent hardening in settings.json
  if (level >= 3 && manifest?.agentUse === true) {
    const json = settings.json;
    if (!json) {
      r.add('A10', 'FAIL', `.claude/settings.json: ${settings.error ?? 'missing'}`, {
        file: '.claude/settings.json',
      });
    } else {
      const deny =
        json.permissions && Array.isArray(json.permissions.deny) ? json.permissions.deny : [];
      if (!deny.length) {
        r.add('A10', 'FAIL', '.claude/settings.json: permissions.deny is empty', {
          file: '.claude/settings.json',
        });
      } else {
        r.add('A10', 'PASS', `.claude/settings.json: ${deny.length} deny rule(s)`, {
          file: '.claude/settings.json',
        });
      }
      const sessionStart = settingsHookEntries(json, 'SessionStart');
      if (!sessionStart.length) {
        r.add('A10', 'FAIL', '.claude/settings.json: no SessionStart advisory hook', {
          file: '.claude/settings.json',
        });
      } else {
        r.add('A10', 'PASS', '.claude/settings.json: SessionStart advisory hook present', {
          file: '.claude/settings.json',
        });
        // At profile 5 the advisory is a fixed two-sentence template (contract §1). Both of
        // its interpolated values are checked against the manifest, because an advisory is a
        // SECOND record of the profile: left unchecked it goes on announcing the profile the
        // harness used to be at, and it announces it straight into an agent's context.
        if (level >= 5) {
          const text = sessionStart.map((e) => e.command).join('\n');
          const declared = `profile ${ctx.manifest?.constitutionVersion}`;
          if (!text.includes(declared)) {
            r.add(
              'A10',
              'FAIL',
              `.claude/settings.json: the SessionStart advisory does not declare "${declared}" — it announces a profile the manifest does not record`,
              { file: '.claude/settings.json' },
            );
          } else if (!text.includes(DELEGATION_RECORD)) {
            r.add(
              'A10',
              'FAIL',
              `.claude/settings.json: the SessionStart advisory does not point at ${DELEGATION_RECORD}`,
              { file: '.claude/settings.json' },
            );
          } else {
            r.add(
              'A10',
              'PASS',
              `.claude/settings.json: the SessionStart advisory declares ${declared} and points at ${DELEGATION_RECORD}`,
              { file: '.claude/settings.json' },
            );
          }
        }
      }
      if (level >= 4) {
        const recorded = manifest.agentHardening?.denyPatterns ?? [];
        const missingDeny = recorded.filter((p) => !deny.includes(p));
        if (missingDeny.length) {
          r.add(
            'A10',
            'FAIL',
            `.claude/settings.json: permissions.deny is missing recorded pattern(s) ${missingDeny.join(', ')}`,
            { file: '.claude/settings.json' },
          );
        }
        const managed = [...settingsHookEntries(json, 'PostToolUse'), ...sessionStart].filter(
          (e) => e.marker,
        );
        if (!managed.length) {
          r.add(
            'A10',
            'FAIL',
            '.claude/settings.json: no hook entry carries a `_claudeconf` ownership marker object',
            { file: '.claude/settings.json' },
          );
        }
        // Contract §3.3 requires the format milestone to be wired at the edit tier, and a
        // MULTI-STACK milestone can be wired for one stack only: polyglot's hook formatted its
        // Node half while A10, W2 and W17 all passed, because nothing compared the entry
        // against the milestone's `tools[]` (Task 6.1 F6). §2.3's `(event, matcher)`
        // uniqueness rule means the fix is ONE entry that dispatches, never one per stack.
        //
        // The entry is an opaque one-liner in a foreign runtime (a `node -e` payload, a shell
        // dispatcher), so this is a NAMING test and it says so: it establishes that the tool
        // is named in the command that runs, not that it is executed. That is the failure that
        // occurred — a stack absent from the entry entirely — and a hook that reaches its
        // formatter through a wrapper that never names it reads as uncovered here, which the
        // evidence states plainly rather than implying execution was proved.
        const formatTools = toolsOf(milestoneEntries(manifest).format);
        const formatHook = managed.find((e) => e.marker?.milestone === 'format');
        if (formatHook && formatTools.length) {
          const missing = formatTools.filter(
            (tool) =>
              !new RegExp(`\\b${String(tool).replace(/[^\w-]/g, '\\$&')}\\b`).test(
                formatHook.command,
              ),
          );
          if (missing.length) {
            r.add(
              'A10',
              'FAIL',
              `.claude/settings.json: the managed format edit-hook entry never names ${missing.join(', ')} — the milestone records ${formatTools.join(', ')}, so that half of it is not wired at the edit tier`,
              { file: '.claude/settings.json' },
            );
          } else {
            r.add(
              'A10',
              'PASS',
              `.claude/settings.json: the format edit-hook entry names every tool the milestone records (${formatTools.join(', ')})`,
              { file: '.claude/settings.json' },
            );
          }
        }
      }
    }
  }

  // A11 — the project-check assertion artifact
  if (level >= 4) {
    const script = findScript(root, 'check-project-checks');
    if (script) {
      r.add('A11', 'PASS', `${script}: project-check assertion present`, { file: script });
    } else if ((projectChecksOf(manifest) ?? []).length === 0 && manifest?.projectChecksRationale) {
      r.add(
        'A11',
        'INFO',
        `${ctx.manifestPath}: no scripting runtime — projectChecksRationale recorded`,
        { file: ctx.manifestPath },
      );
    } else {
      r.add(
        'A11',
        'FAIL',
        'scripts/check-project-checks.* is missing (required even when projectChecks is empty)',
        { file: 'scripts/' },
      );
    }
  }

  // A12 — a pinned config per tool
  const seenTools = new Set();
  for (const entry of Object.values(milestoneEntries(manifest))) {
    for (const tool of toolsOf(entry)) {
      if (seenTools.has(tool)) continue;
      seenTools.add(tool);
      if (tool === 'trufflehog') {
        if (ctx.secretScanExcludes.length)
          r.add('A12', 'PASS', 'trufflehog: exclude file recorded (see A8)');
        else r.add('A12', 'UNKNOWN', 'trufflehog: no exclude file located');
        continue;
      }
      if (NO_CONFIG_TOOLS.has(tool)) {
        r.add('A12', 'INFO', `${tool}: no tool config file applies`);
        continue;
      }
      const candidates = TOOL_CONFIGS[tool];
      if (!candidates) {
        r.add('A12', 'UNKNOWN', `${tool}: no config mapping known to this checker`);
        continue;
      }
      // Judged where the harness RUNS the tool (a monorepo runs it from `app/`), accepting a
      // config there or in any directory above it, as tools look upward; a tool the harness is
      // never seen running is judged at the root, as before.
      const dirs = [...toolRunDirs(ctx, tool)].sort();
      if (!dirs.length) dirs.push('');
      const found = [];
      const missing = [];
      for (const dir of dirs) {
        const hit = configAtOrAbove(dir, candidates, exists);
        if (hit) found.push(hit);
        else missing.push(dir || '.');
      }
      const where = dirs.some(Boolean) ? ` (runs in ${dirs.map((d) => d || '.').join(', ')})` : '';
      if (!missing.length) {
        r.add('A12', 'PASS', `${tool}: config ${uniq(found).join(', ')}${where}`, {
          file: found[0],
        });
      } else {
        r.add(
          'A12',
          'FAIL',
          `${tool}: no config file for its run in ${missing.join(', ')} (looked for ${candidates.join(', ')} there and in every directory above it)`,
        );
      }
    }
  }

  // A13 — the managed hook config pins the runner
  if (level >= 4) checkRunnerPinning(ctx, r);

  // A16 — the delegability record's required sections (profile 5+, agent-driven only)
  if (level >= 5 && manifest?.agentUse === true) checkDelegationSections(ctx, r);
}

/**
 * The delegability record (contract §1.2), new at profile 5.
 *
 * Split deliberately across two ids because only half of it is verifiable. A16 establishes
 * that the four sections exist and carry content; D9 compares the arbiter list against the
 * harness BY VALUE. Nothing here reads the prose — whether the rule is stated well is model
 * work, and the evidence strings avoid any word that would imply otherwise.
 */
const DELEGATION_RECORD = '.claudeconf/delegation.md';
const DELEGATION_SECTIONS = ['Rule', 'Arbiters', 'Never delegable', 'What this record is not'];

/** Splits a markdown file into `## ` sections: heading text -> body. */
function markdownSections(text) {
  const out = new Map();
  let heading = null;
  let body = [];
  for (const line of text.split('\n')) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (heading !== null) out.set(heading, body.join('\n'));
      heading = m[1];
      body = [];
    } else if (heading !== null) body.push(line);
  }
  if (heading !== null) out.set(heading, body.join('\n'));
  return out;
}

/**
 * The arbiters this harness actually has. The gate invocation is derived the way the
 * runner-pinning checks derive it — from the PATH declared in the hook config — because
 * `hookRunner` records a name and a version but never a path, and a record naming a bare
 * `lefthook run gate` would cite an invocation the harness deliberately does not use.
 */
function expectedArbiters(ctx) {
  const out = new Set();
  const pinned = declaredRunnerLayer(ctx)?.doc?.lefthook;
  const runner = ctx.manifest?.hookRunner?.name ?? 'lefthook';
  out.add(`${typeof pinned === 'string' && pinned ? pinned : runner} run gate`);
  for (const c of ctx.manifest?.projectChecks ?? []) {
    if (c && typeof c.name === 'string' && c.name) out.add(c.name);
  }
  const wf = ctx.manifest?.ci?.workflow;
  if (typeof wf === 'string' && wf) out.add(wf);
  return out;
}

/** The backticked strings listed under `## Arbiters`, in order. Prose elsewhere is not read. */
function recordedArbiters(sections) {
  const body = sections.get('Arbiters');
  if (body === undefined) return null;
  const out = [];
  for (const line of body.split('\n')) {
    const m = /^\s*-\s+`([^`]+)`/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

function checkDelegationSections(ctx, r) {
  const file = DELEGATION_RECORD;
  const { text, error } = safeRead(join(ctx.root, file));
  if (text === null) {
    r.add('A16', 'FAIL', `${file}: missing (${error})`, { file });
    return;
  }
  const sections = markdownSections(text);
  const missing = DELEGATION_SECTIONS.filter((h) => !sections.has(h));
  const empty = DELEGATION_SECTIONS.filter((h) => sections.has(h) && !sections.get(h).trim());
  if (missing.length) {
    r.add('A16', 'FAIL', `${file}: required section(s) absent: ${missing.join(', ')}`, { file });
  } else if (empty.length) {
    r.add('A16', 'FAIL', `${file}: required section(s) empty: ${empty.join(', ')}`, { file });
  } else {
    r.add(
      'A16',
      'PASS',
      `${file}: all ${DELEGATION_SECTIONS.length} required section(s) present and non-empty (section presence only; the prose is not read)`,
      { file },
    );
  }
}

/**
 * D9 — the recorded arbiters against the ones the harness has. Emitted by the DRIFT group,
 * not the artifact group that owns A16: an id must be registered under the group that emits
 * it, or a crash in that group deletes it from the report instead of failing it.
 *
 * Silent when the record is missing or has no `## Arbiters` section — A16 has already failed
 * on exactly that, and a second FAIL restating it would bury the one that names the cause.
 */
function checkDelegationArbiters(ctx, r) {
  const file = DELEGATION_RECORD;
  const { text } = safeRead(join(ctx.root, file));
  if (text === null) return;
  const recorded = recordedArbiters(markdownSections(text));
  if (recorded === null) return;
  const expected = expectedArbiters(ctx);
  const listed = new Set(recorded);
  const quote = (xs) => xs.map((a) => `\`${a}\``).join(', ');
  const absent = [...expected].filter((a) => !listed.has(a));
  const stale = [...listed].filter((a) => !expected.has(a));
  if (absent.length || stale.length) {
    const parts = [];
    if (absent.length)
      parts.push(`declared by the harness but absent from the record: ${quote(absent)}`);
    if (stale.length)
      parts.push(`named in the record but not declared by the harness: ${quote(stale)}`);
    r.add('D9', 'FAIL', `${file}: arbiter set disagrees with the harness — ${parts.join('; ')}`, {
      file,
    });
  } else {
    r.add('D9', 'PASS', `${file}: arbiter set matches the harness (${quote([...expected])})`, {
      file,
    });
  }
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function listFilesRecursive(dir, depth = 0) {
  if (depth > 4) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory()) out.push(...listFilesRecursive(join(dir, e.name), depth + 1));
    else out.push(join(dir, e.name));
  }
  return out;
}

/** Where a profile-6 harness vendors the bundle's support scripts. */
const VENDORED_BIN = '.claudeconf/bin';

function findScript(root, stem) {
  // Profile 6: the vendored bundle (contract §1) — its integrity is A17's to judge.
  const vendored = `${VENDORED_BIN}/${stem}.mjs`;
  if (existsSync(join(root, vendored))) return vendored;
  for (const ext of ['mjs', 'js', 'cjs', 'py', 'sh', 'rb', 'ts']) {
    const p = `scripts/${stem}.${ext}`;
    if (existsSync(join(root, p))) return p;
  }
  return null;
}

/** Flattens `.claude/settings.json` hook entries for one event. */
function settingsHookEntries(json, event) {
  const groups = json?.hooks && Array.isArray(json.hooks[event]) ? json.hooks[event] : [];
  const out = [];
  for (const group of groups) {
    for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
      out.push({
        matcher: typeof group.matcher === 'string' ? group.matcher : '',
        command: typeof hook?.command === 'string' ? hook.command : '',
        marker: hook && typeof hook._claudeconf === 'object' ? hook._claudeconf : null,
      });
    }
  }
  return out;
}

/**
 * A13 — the harness pins the runner, verified BY RESOLUTION (contract §3.2).
 *
 * The three settings are read from the MERGED configuration the runner itself computes, not
 * from whichever file this checker happens to open: lefthook 2.1.9 merges
 * `assert_lefthook_installed` and `min_version` across `extends` but NOT `lefthook:`, so a
 * harness that pinned the path in the extended file alone ran every hook through `PATH` while
 * both config-reading checks reported PASS. Which layer a setting must live in is the
 * generator's problem; whether the runner actually has it is this check's.
 */
function checkRunnerPinning(ctx, r) {
  const managedFile = '.claudeconf/lefthook.yml';
  const art = ctx.managedHook;
  if (!art.exists) {
    r.add('A13', 'FAIL', `${managedFile}: missing, so the runner cannot be pinned`, {
      file: managedFile,
    });
    return;
  }
  if (!art.doc || typeof art.doc !== 'object') {
    r.add('A13', 'UNKNOWN', `${managedFile}: unparseable (${art.parseError})`, {
      file: managedFile,
      hard: true,
    });
    return;
  }
  if (!ctx.mergedRunnerKnown) {
    r.add(
      'A13',
      'UNKNOWN',
      `the runner's merged configuration is unavailable (${ctx.dump.error ?? 'no dump'}) — runner pinning is verified by RESOLUTION (contract §3.2), never by reading the setting back out of a file`,
      { file: managedFile, hard: true },
    );
    return;
  }
  const merged = ctx.dump.dump;
  const declaring = declaredRunnerLayer(ctx);
  const at = (layer) => {
    if (!layer) return { file: managedFile };
    const line = findLine(layer.lines, (l) => l.startsWith('lefthook:'));
    return line ? { file: layer.path, line } : { file: layer.path };
  };
  const pinnedDeclared = ctx.manifest?.hookRunner?.runnerPinned;
  const resolution = pinResolution(ctx);

  if (pinnedDeclared === false) {
    const rationale = ctx.manifest?.hookRunner?.runnerPinnedRationale;
    r.add(
      'A13',
      rationale ? 'INFO' : 'FAIL',
      rationale
        ? `${ctx.manifestPath}: runnerPinned false — ${rationale}`
        : `${ctx.manifestPath}: runnerPinned false without runnerPinnedRationale`,
      { file: ctx.manifestPath },
    );
  } else if (resolution.state === 'unpinned') {
    r.add(
      'A13',
      'FAIL',
      declaring
        ? `${declaring.path}: \`lefthook: ${declaring.doc.lefthook}\` is declared but is ABSENT from the merged configuration the runner computes — the runner does not read it in that layer, so every hook resolves the runner from PATH (contract §1/§3.2)`
        : `no \`lefthook:\` runner path in the merged configuration — the shim falls back to PATH`,
      at(declaring),
    );
  } else if (resolution.state === 'missing') {
    r.add(
      'A13',
      'FAIL',
      `\`lefthook: ${resolution.pin}\` (merged configuration) does not exist, so the pin resolves nothing`,
      at(declaring),
    );
  } else if (resolution.state === 'uninstalled') {
    r.add(
      'A13',
      'UNKNOWN',
      `\`lefthook: ${resolution.pin}\` is pinned, but \`${resolution.tree}/\` does not exist in this tree — the project's dependencies are not installed here, so the pin cannot be RESOLVED. Machine state, not harness content (the rule §3.2 states for the installed shim): install the dependencies and re-run to verify it`,
      at(declaring),
    );
  } else if (resolution.state === 'overridden') {
    r.add(
      'A13',
      'INFO',
      `\`lefthook: ${resolution.pin}\` is pinned, but $LEFTHOOK_BIN points the hooks at ${resolution.shim.path} on this machine — local state, not harness content`,
      at(declaring),
    );
  } else if (resolution.state !== 'pinned') {
    r.add(
      'A13',
      'FAIL',
      `\`lefthook: ${resolution.pin}\` is pinned, but the shim's own resolution lands on ${resolution.shim ? `${resolution.shim.path} (source: ${resolution.shim.source})` : 'nothing'} — a pinned path the runner does not resolve to is not a pin (contract §3.2)`,
      at(declaring),
    );
  } else {
    r.add(
      'A13',
      'PASS',
      `runner pinned to ${resolution.pin} in the merged configuration, and the shim's own resolution lands on it (${resolution.shim.path})`,
      at(declaring),
    );
  }

  // §3.2: where a setting must be written in TWO layers (§1 — the runner merges some settings
  // and not others), the copies must AGREE, and that equality is itself checked. The runner
  // reads `lefthook:` from the ROOT block because it does NOT merge that key, while a reader
  // that opens a file sees the managed copy first — so the two records drift in both
  // directions and the harness pins one runner while running another, with every check that
  // reads either copy alone reporting fine. The evidence names WHICH layer holds which value:
  // a mismatch report that does not say which copy is wrong sends someone editing the wrong
  // file.
  const copies = [ctx.rootHook, ctx.managedHook].filter(
    (l) => l?.exists && typeof l.doc?.lefthook === 'string' && l.doc.lefthook,
  );
  if (pinnedDeclared !== false && copies.length === 2) {
    const say = (l) => `${l.path}: \`lefthook: ${l.doc.lefthook}\``;
    if (copies[0].doc.lefthook !== copies[1].doc.lefthook) {
      r.add(
        'A13',
        'FAIL',
        `the two copies of the runner pin DISAGREE — ${say(copies[0])} but ${say(copies[1])}. The runner reads ${copies[0].path} (it does not merge \`lefthook:\` across \`extends\`), so the harness pins one runner and runs another`,
        at(copies[0]),
      );
    } else {
      r.add(
        'A13',
        'PASS',
        `runner pin \`${copies[0].doc.lefthook}\` recorded identically in both layers (${copies[0].path}, ${copies[1].path})`,
        at(copies[0]),
      );
    }
  }

  if (merged.assert_lefthook_installed !== true) {
    r.add(
      'A13',
      'FAIL',
      `merged configuration: assert_lefthook_installed is not true — a missing runner would exit 0`,
      { file: managedFile },
    );
  } else {
    r.add('A13', 'PASS', 'merged configuration: assert_lefthook_installed: true', {
      file: managedFile,
    });
  }
  const pin = versionOf(ctx, ctx.manifest?.hookRunner);
  const floor = merged.min_version == null ? null : String(merged.min_version);
  if (ctx.level >= SINCE['A13.floor']) {
    // Profile 6: `min_version` is a FLOOR under the resolved pin, not a second copy of it —
    // an updater bump of the runner moves the lock and leaves the floor valid (contract §2.5).
    if (!pin || !floor || !isPinnedVersion(floor) || compareVersions(floor, pin) > 0) {
      r.add(
        'A13',
        'FAIL',
        `merged configuration: min_version ${JSON.stringify(floor)} must be an exact version at or below the resolved runner pin ${JSON.stringify(pin)}`,
        { file: managedFile, rule: 'A13.floor' },
      );
    } else {
      r.add('A13', 'PASS', `merged configuration: min_version ${floor} ≤ runner ${pin}`, {
        file: managedFile,
      });
    }
  } else if (String(floor ?? '') !== String(pin ?? '')) {
    r.add(
      'A13',
      'FAIL',
      `merged configuration: min_version ${JSON.stringify(floor)} does not equal manifest hookRunner.version ${JSON.stringify(pin)}`,
      { file: managedFile },
    );
  } else {
    r.add('A13', 'PASS', `merged configuration: min_version ${pin}`, { file: managedFile });
  }
}

// ---------------------------------------------------------------------------------------
// A14 / A15 — ownership split
// ---------------------------------------------------------------------------------------

/** Canonicalises a value so the runner's own normalisation is not read as a divergence. */
function canonical(value) {
  if (Array.isArray(value)) {
    if (value.length === 1) return canonical(value[0]);
    return value.map(canonical);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

function sameValue(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function checkOwnershipSplit(ctx, r) {
  const managedFile = '.claudeconf/lefthook.yml';
  const art = ctx.managedHook;

  // ---- A14: managed-job identity against the MERGED configuration ----
  if (!art.exists || !art.doc || typeof art.doc !== 'object') {
    r.add(
      'A14',
      'UNKNOWN',
      `${managedFile}: absent or unparseable, so identity cannot be established`,
      { file: managedFile, hard: true },
    );
  } else if (!ctx.dump.dump) {
    r.add('A14', 'UNKNOWN', `merged hook config unavailable (${ctx.dump.error ?? 'no runner'})`, {
      hard: true,
    });
  } else {
    const merged = mergedJobs(ctx.dump.dump);
    let compared = 0;
    for (const [hook, node] of Object.entries(art.doc)) {
      if (!isHookNode(hook, node)) continue;
      for (const declared of jobsOfHook(node)) {
        if (!declared || typeof declared !== 'object') continue;
        const name = typeof declared.name === 'string' ? declared.name : '';
        if (!name) {
          r.add(
            'A14',
            'UNKNOWN',
            `${managedFile}: an unnamed job under \`${hook}\` cannot be matched in the merged config`,
            { file: managedFile, hard: true },
          );
          continue;
        }
        const found = merged.find((j) => j.hook === hook && j.name === name);
        if (!found) {
          r.add(
            'A14',
            'FAIL',
            `${managedFile}: managed job ${hook}.${name} is absent from the merged config`,
            { file: managedFile },
          );
          continue;
        }
        compared++;
        const keys = uniq([...Object.keys(declared), ...Object.keys(found.def)]).sort();
        for (const key of keys) {
          if (sameValue(declared[key], found.def[key])) continue;
          const contributor = findFieldContributor(ctx, hook, name, key);
          r.add(
            'A14',
            'FAIL',
            `${hook}.${name}: merged field \`${key}\` is ${JSON.stringify(found.def[key])} but ${managedFile} declares ${JSON.stringify(declared[key])}${contributor ? ` — contributed by ${contributor}` : ''}`,
            { file: contributor ? contributor.split(':')[0] : managedFile },
          );
        }
      }
    }
    if (compared) {
      r.add(
        'A14',
        'PASS',
        `${managedFile}: ${compared} managed job(s) field-identical in the merged config`,
        { file: managedFile },
      );
    }
  }

  // ---- A15: raw-layer ownership ----
  const managedNames = new Set(ctx.managedJobNames);
  const declaredNames = new Set(
    (projectChecksOf(ctx.manifest) ?? []).map((c) => c?.name).filter(Boolean),
  );
  const rawLayers = rawProjectLayers(ctx);
  let collisions = 0;
  for (const target of rawLayers.unresolved) {
    collisions++;
    r.add(
      'A15',
      'UNKNOWN',
      `${ctx.rootHook.path}: \`extends\` target ${target} cannot be resolved — the project layer cannot be inspected`,
      { file: ctx.rootHook.path, hard: true },
    );
  }
  // `remotes:` outranks the managed `extends` in lefthook's precedence order, so a remote can
  // redefine a managed job exactly as a root job can (spec §5 R-D1 / F13, second door). A
  // generated harness never uses them; adopting one is a review-gate decision, not a silence.
  for (const layer of [...rawLayers, ctx.managedHook]) {
    if (!layer?.exists || !layer.doc?.remotes) continue;
    collisions++;
    const line = findLine(layer.lines, (l) => /^\s*remotes:/.test(l));
    r.add(
      'A15',
      'FAIL',
      `${layer.path}:${line}: \`remotes:\` outranks the managed \`extends\` — a remote config can redefine or disable any managed job, and its content is not in this repository`,
      { file: layer.path, line },
    );
  }
  for (const layer of rawLayers) {
    if (!layer.doc || typeof layer.doc !== 'object') {
      r.add('A15', 'UNKNOWN', `${layer.path}: unparseable (${layer.parseError ?? 'no document'})`, {
        file: layer.path,
        hard: true,
      });
      continue;
    }
    for (const [hook, node] of Object.entries(layer.doc)) {
      if (!isHookNode(hook, node)) continue;
      // Hook-scope execution control reaches the managed jobs, so it always fails here.
      for (const control of EXECUTION_CONTROLS) {
        const finding = controlFinding(node[control], control);
        if (!finding) continue;
        collisions++;
        const line = findLine(layer.lines, (l) => new RegExp(`^\\s*${control}:`).test(l));
        r.add(
          'A15',
          finding.status,
          `${layer.path}:${line}: hook-scope \`${control}\` on \`${hook}\` in the project layer ${finding.why}`,
          { file: layer.path, line, hard: finding.status === 'UNKNOWN' },
        );
      }
      // Job scope binds only where the harness made a PROMISE: a job whose name is managed, or
      // one a `projectChecks` entry declares. There a `skip` disables that check while the run
      // still reports success — F13 aimed at a single job. On a project-owned job that nothing
      // declares, `skip`/`only` are the project's own business: the harness constrains what it
      // was asked to guarantee, not every line a project writes.
      for (const job of jobsOfHook(node)) {
        const jobName = typeof job?.name === 'string' ? job.name : '';
        if (!jobName || !(managedNames.has(jobName) || declaredNames.has(jobName))) continue;
        const guarantee = managedNames.has(jobName) ? 'a managed job' : 'a declared projectCheck';
        for (const control of GUARANTEED_JOB_CONTROLS) {
          const finding = controlFinding(job[control], control);
          if (!finding) continue;
          collisions++;
          const line = findLine(layer.lines, (l) =>
            new RegExp(`name:\\s*['"]?${escapeRx(jobName)}['"]?\\s*$`).test(l),
          );
          r.add(
            'A15',
            finding.status,
            `${layer.path}:${line}: job-scope \`${control}\` on \`${hook}.${jobName}\` — ${guarantee} the harness guarantees — ${finding.why}`,
            { file: layer.path, line, hard: finding.status === 'UNKNOWN' },
          );
        }
      }
      for (const job of jobsOfHook(node)) {
        const name = job && typeof job.name === 'string' ? job.name : '';
        if (name && managedNames.has(name)) {
          collisions++;
          const line = findLine(layer.lines, (l) =>
            new RegExp(`name:\\s*['"]?${escapeRx(name)}['"]?\\s*$`).test(l),
          );
          r.add(
            'A15',
            'FAIL',
            `${layer.path}:${line}: project-layer job "${name}" collides with a managed job name — the runner MERGES same-named jobs, so it can disable the managed check while the merged command still reads correctly`,
            { file: layer.path, line },
          );
        }
      }
    }
  }
  if (rawLayers.length && !collisions) {
    r.add(
      'A15',
      'PASS',
      `${rawLayers.map((l) => l.path).join(', ')}: no managed-name collision, no hook-scope control`,
    );
  }
  if (ctx.hasLocalOverride) {
    r.add(
      'A15',
      'INFO',
      `${ctx.localOverridePath}: present — it is VCS-ignored and overrides EVERY layer including managed jobs, so it is a local bypass equivalent to --no-verify, not a merge-boundary control`,
      { file: ctx.localOverridePath },
    );
  }
}

/**
 * The fields that decide WHETHER a job runs. `exclude` is deliberately absent: it selects which
 * FILES a job runs on — excluding lockfiles from a secret scan is ordinary — and a project-layer
 * `exclude` applied to a MANAGED job is caught by managed-job field identity (A14), which fails
 * on any divergence and names the field. Duplicating it here would only add false positives.
 */
const EXECUTION_CONTROLS = ['skip', 'only'];
/**
 * At JOB scope on a job the harness GUARANTEES, a file filter is read too — the round that
 * removed `exclude` outright reasoned that managed-job field identity catches it, which is
 * true only for MANAGED jobs: a `projectChecks`-declared job is never in the managed config
 * to be compared, so a filter matching every file disabled it with no finding anywhere.
 */
const GUARANTEED_JOB_CONTROLS = ['skip', 'only', 'exclude'];

/**
 * A15's verdict on one execution-control field in the PROJECT layer, at hook or job scope.
 * A list-valued `skip` that demonstrably narrows (the allowlist above) is a legitimate
 * condition and is not reported; anything else is, because it can disable a check while the
 * run still reports success.
 */
function controlFinding(value, control) {
  if (value === undefined || value === null || value === false) return null;
  if (Array.isArray(value) && !value.length) return null;
  if (control === 'exclude') {
    // A file filter, judged only on a job the harness GUARANTEES: at the limit it stops
    // filtering and becomes a bypass (`exclude: ["**/*"]` → `no files for inspection`, hook
    // exits 0). On a project-owned job nothing declares it is not examined at all.
    const why = unfilteredBy(value);
    return why
      ? { status: 'UNKNOWN', why: `cannot be shown to leave the job any files — ${why}` }
      : null;
  }
  if (control === 'only') {
    return {
      status: 'UNKNOWN',
      why: 'names the only contexts in which the job runs, and none of them can be shown to include the pre-merge context',
    };
  }
  if (Array.isArray(value)) {
    const why = unnarrowedBy(value);
    return why
      ? {
          status: 'UNKNOWN',
          why: `cannot be shown to narrow anything — ${why}; a condition that matches everywhere is \`${control}: true\` with one extra line`,
        }
      : null;
  }
  return {
    status: 'FAIL',
    why: `is execution control the project layer must not carry (\`${control}: ${JSON.stringify(value)}\`)`,
  };
}

/**
 * The project-owned raw layers: the root config and every non-managed `extends` target,
 * including GLOB entries — a glob that is skipped is a layer nobody checks. Unresolvable
 * entries are recorded so the wiring checks can refuse to pass on a partial configuration.
 */
function rawProjectLayers(ctx) {
  const layers = [];
  const unresolved = [];
  if (ctx.rootHook.exists) layers.push(ctx.rootHook);
  const ext = Array.isArray(ctx.rootHook.doc?.extends) ? ctx.rootHook.doc.extends : [];
  for (const entry of ext) {
    if (typeof entry !== 'string') continue;
    const targets = entry.includes('*') ? expandGlob(ctx.root, entry) : [entry];
    if (!targets.length) unresolved.push(entry);
    for (const target of targets) {
      if (target === '.claudeconf/lefthook.yml') continue;
      const art = loadYamlArtifact(ctx.root, target);
      if (art.exists) layers.push(art);
      else unresolved.push(target);
    }
  }
  Object.defineProperty(layers, 'unresolved', { value: unresolved, enumerable: false });
  return layers;
}

/** Best-effort: which project-layer file declares `field` on a job of this name. */
function findFieldContributor(ctx, hook, name, field) {
  const layers = [...rawProjectLayers(ctx), ...(ctx.localOverride ? [ctx.localOverride] : [])];
  for (const layer of layers) {
    const node = layer.doc?.[hook];
    if (!isHookNode(hook, node)) continue;
    for (const job of jobsOfHook(node)) {
      if (job && job.name === name && job[field] !== undefined) {
        const line = findLine(layer.lines, (l) =>
          new RegExp(`name:\\s*['"]?${escapeRx(name)}['"]?\\s*$`).test(l),
        );
        return `${layer.path}:${line || 1}`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Checks — wiring (W*)
// ---------------------------------------------------------------------------------------

/** Does this verdict mean the job cannot be relied on to run? (An unknown COMMAND does not.) */
function blocksWiring(verdict) {
  return verdict.status === 'FAIL' || (verdict.status === 'UNKNOWN' && verdict.kind === 'control');
}

/**
 * Is a wired hook job actually going to run something? `skip: true` and a non-empty `only:`
 * disable it as thoroughly as `run: true` does — the runner prints it as skipped by condition
 * and exits 0 GREEN. A LIST-valued `skip` (`[merge, rebase]`) is a legitimate narrowing and is
 * not treated as inert.
 */

/**
 * Skip conditions this checker can DEMONSTRATE narrow the job — an ALLOWLIST, deliberately.
 *
 * `skip: [{ref: "*"}]` and `skip: [{run: "true"}]` match in every context and disable the job
 * unconditionally (verified against the pinned runner: `skipped-by-glob (skip) by condition`),
 * which is `skip: true` with one extra line. Enumerating the DANGEROUS shapes is the mistake
 * §2.4 and managed-job identity already refuse to make: the dangerous shape nobody enumerated
 * is the one that gets used. So this names what is ACCEPTED, and everything else — including
 * every shape a future runner release invents — is unresolved.
 */
const NARROWING_STATES = new Set(['merge', 'rebase', 'merge-commit']);
const UNIVERSAL_REFS = new Set(['*', '**', '*/*', '']);

function narrowingElement(element) {
  if (typeof element === 'string') {
    return NARROWING_STATES.has(element.trim())
      ? null
      : `\`${element}\` is not a git state this checker can show narrows the job`;
  }
  if (element && typeof element === 'object' && !Array.isArray(element)) {
    const keys = Object.keys(element);
    if (keys.length === 1 && keys[0] === 'ref') {
      const ref = element.ref;
      if (typeof ref !== 'string' || UNIVERSAL_REFS.has(ref.trim())) {
        return `\`ref: ${JSON.stringify(ref)}\` matches every ref, so it narrows nothing`;
      }
      return null;
    }
    return `\`${JSON.stringify(element)}\` is not a condition this checker can evaluate`;
  }
  return `\`${JSON.stringify(element)}\` is not a recognised skip condition`;
}

/**
 * File filters this checker can DEMONSTRATE still leave files to run on — an ALLOWLIST, for the
 * same reason `skip` is one. Runner-verified on the pinned runner with one staged `a.ts` and a
 * job whose command exits 7: `exclude: [a-z]*`, `*.*` and `?*` each report
 * `no files for inspection` and the hook exits 0, while `*.md` exits 1. A denylist of the eight
 * literals someone thought of accepts every pattern nobody thought of.
 *
 * Accepted: a pattern whose only metacharacters are `*`/`**` AND which still contains a literal
 * name character, so some path is demonstrably outside it (`*.lock`, `package-lock.json`,
 * `src/**`). Everything else — character classes, `?`, braces, and wildcard-only patterns such
 * as a bare star, `*.*` and a recursive star-slash-star — is UNRESOLVED.
 */
function unfilteredBy(value) {
  const list = Array.isArray(value) ? value : [value];
  if (!list.length) return null;
  for (const element of list) {
    if (typeof element !== 'string') {
      return `\`${JSON.stringify(element)}\` is not a pattern this checker can evaluate`;
    }
    const pattern = element.trim();
    if (/[?[\]{}!]/.test(pattern)) {
      return `\`${pattern}\` uses a glob construct this checker cannot bound, so it cannot be shown to leave any file`;
    }
    const literal = pattern.replace(/\*+/g, '').replace(/[./\\]/g, '');
    if (!literal) {
      return `\`${pattern}\` has no literal component, so it can match every file and leave the job nothing to run on`;
    }
  }
  return null;
}

/** null when the whole list demonstrably narrows; otherwise why it does not. */
function unnarrowedBy(list) {
  if (!Array.isArray(list) || !list.length) return 'an empty condition list narrows nothing';
  for (const element of list) {
    const why = narrowingElement(element);
    if (why) return why;
  }
  return null;
}

/**
 * Is a wired hook job actually going to run something? `skip: true` and `only:` disable it as
 * thoroughly as `run: true` does — the runner prints it as skipped by condition and exits 0
 * GREEN. A LIST-valued `skip` is judged against the allowlist above: live when every element
 * demonstrably narrows, UNRESOLVED otherwise, which never satisfies a requirement.
 */
function inertnessOf(ctx, def, opts = {}) {
  if (def?.skip === true) {
    return { status: 'FAIL', kind: 'control', why: '`skip: true` — the job never runs' };
  }
  if (Array.isArray(def?.skip)) {
    const why = unnarrowedBy(def.skip);
    if (why) {
      return {
        status: 'UNKNOWN',
        kind: 'control',
        why: `\`skip: ${JSON.stringify(def.skip)}\` cannot be shown to narrow the job — ${why}`,
      };
    }
  }
  const only = def?.only;
  const hasOnly =
    only !== undefined && only !== null && only !== false && !(Array.isArray(only) && !only.length);
  if (hasOnly) {
    // `only` INVERTS the `skip` reading: it names the only contexts in which the job runs, so a
    // literal-ref `only` leaves the check inert everywhere else — runner-verified, a gate job
    // with `only: [{ref: main}]` exits 1 on `main` and 0 on a feature branch, which is the
    // branch the gate exists to check before a PR. Nothing this checker can read demonstrates
    // that a condition INCLUDES the pre-merge context, so an `only` is never shown to leave the
    // job live.
    return {
      status: 'UNKNOWN',
      kind: 'control',
      why: `\`only: ${JSON.stringify(only)}\` cannot be shown to include the pre-merge context — the job is inert wherever the condition does not hold`,
    };
  }
  const filter = def?.exclude;
  if (filter !== undefined && filter !== null) {
    const why = unfilteredBy(filter);
    if (why) {
      return {
        status: 'UNKNOWN',
        kind: 'control',
        why: `\`exclude: ${JSON.stringify(filter)}\` cannot be shown to leave the job any files — ${why}`,
      };
    }
  }
  const commands = jobCommands(def ?? {});
  if (!commands.length) {
    if (def?.group) {
      return {
        status: 'FAIL',
        kind: 'control',
        why: 'the job is an EMPTY group, so it runs nothing',
      };
    }
    return { status: 'UNKNOWN', kind: 'work', why: 'no command' };
  }
  const command = commands.join('\n');
  // Classify the statement that INVOKES the tool. Reading the command's head instead called
  // `echo src | xargs biome lint` a no-op, because `echo` is what the head happens to be.
  let statement = command;
  for (const tool of opts.tools ?? []) {
    const invocation = commandInvokesTool(ctx, command, tool);
    if (invocation) {
      statement = invocation;
      break;
    }
  }
  const analysis = analyseCommand(statement, ctx.pkg);
  return { ...classifyWork(analysis, analysis.args, workOptionsFor(ctx, analysis)), kind: 'work' };
}

function checkWiring(ctx, r, level) {
  const { manifest } = ctx;
  const wf = ctx.workflow;
  const dump = ctx.dump.dump;
  const jobs = mergedJobs(dump);

  // ---- W1: milestone → hook job, against the MERGED config ----
  if (!dump) {
    r.add(
      'W1',
      'UNKNOWN',
      `merged hook config unavailable (${ctx.dump.error ?? 'no runner resolved'})`,
    );
  } else {
    for (const milestone of MILESTONES) {
      const entry = milestoneEntries(manifest)[milestone];
      if (!entry) continue;
      for (const tier of tiersOf(entry)) {
        if (!HOOK_TIERS.includes(tier)) continue;
        const matches = jobs.filter((j) => j.hook === tier && jobMatchesToken(j.name, milestone));
        if (matches.length) {
          // A job with the right NAME that runs `true` / `echo ok` / `<tool> --version`, or
          // that carries `skip: true` / a non-empty `only:`, is the cheapest way to satisfy a
          // name-only wiring check while checking nothing. Both are the same failure, and both
          // are caught at EVERY profile — A14/A15 only exist from profile 4.
          const inert = matches
            .map((m) => ({ m, verdict: inertnessOf(ctx, m.def, { tools: toolsOf(entry) }) }))
            .filter((x) => blocksWiring(x.verdict));
          if (inert.length) {
            r.add(
              'W1',
              inert[0].verdict.status,
              `${tier}.${inert[0].m.name}: wired but inert — ${inert[0].verdict.why}`,
              { rule: 'W1.inert' },
            );
          } else {
            r.add(
              'W1',
              'PASS',
              `${tier}: ${milestone} wired as ${matches.map((m) => m.name).join(', ')}`,
            );
          }
        } else {
          const names = jobs
            .filter((j) => j.hook === tier)
            .map((j) => j.name)
            .join(', ');
          // Jobs are found by their §2.4 managed NAMES, which are normative from profile 4.
          r.add(
            'W1',
            'FAIL',
            `${tier}: no job for the ${milestone} milestone (jobs: ${names || 'none'})`,
            { rule: 'W1.naming' },
          );
        }
      }
    }
  }

  // ---- W2: milestone → managed CI step ----
  if (!wf.exists) {
    r.add('W2', 'UNKNOWN', `${wf.path}: workflow missing, CI wiring cannot be established`, {
      file: wf.path,
    });
  } else if (!wf.doc) {
    r.add('W2', 'UNKNOWN', `${wf.path}: unparseable (${wf.parseError})`, {
      file: wf.path,
      hard: true,
    });
  } else {
    for (const milestone of MILESTONES) {
      const entry = milestoneEntries(manifest)[milestone];
      if (!entry || !tiersOf(entry).includes('ci')) continue;
      const found = findCiSteps(ctx, milestone, level);
      if (found.scope === 'managed') {
        r.add(
          'W2',
          'PASS',
          `${wf.path}:${found.steps[0].line}: ${milestone} step "${found.steps[0].name}"`,
          { file: wf.path, line: found.steps[0].line },
        );
      } else if (found.scope === 'blocked') {
        const b = blockedVerdict(found);
        r.add(
          'W2',
          b.status,
          `${wf.path}:${b.step.line}: the ${milestone} step "${b.step.name}" cannot run — ${b.why}; a step that is present and never runs is indistinguishable from a deleted one`,
          { file: wf.path, line: b.step.line, rule: 'W2.reach' },
        );
      } else if (found.scope === 'outside') {
        r.add(
          'W2',
          level >= 4 ? 'FAIL' : 'INFO',
          `${wf.path}:${found.steps[0].line}: ${milestone} is wired OUTSIDE the managed region ("${found.steps[0].name}") — a project-owned step answers for it, and regeneration cannot reach it; profile 4 requires a MANAGED step`,
          { file: wf.path, line: found.steps[0].line },
        );
      } else {
        r.add('W2', 'FAIL', `${wf.path}: no CI step or job for the ${milestone} milestone`, {
          file: wf.path,
        });
      }
    }
  }

  // ---- W3: the gate carries the full battery ----
  if (!dump) {
    r.add('W3', 'UNKNOWN', 'merged hook config unavailable, gate battery cannot be established');
  } else {
    const gateJobs = jobs.filter((j) => j.hook === 'gate');
    const gateText = gateJobs.map((j) => executableText(jobText(j.def))).join('\n');
    const required = [...MILESTONES];
    if (level >= 3) required.push('suppressions');
    if (level >= 4) required.push('project-checks');
    const missing = required.filter(
      (token) => !gateJobs.some((j) => jobMatchesToken(j.name, token)),
    );
    if (missing.length) {
      r.add('W3', 'FAIL', `gate: missing job(s) for ${missing.join(', ')}`, {
        rule: 'W3.naming',
      });
    } else r.add('W3', 'PASS', `gate: ${gateJobs.length} jobs cover the full battery`);
    if (level >= 2) {
      for (const auditor of auditorsOf(manifest)) {
        if (!auditor || typeof auditor.tool !== 'string') continue;
        if (!new RegExp(`\\b${escapeRx(auditor.tool)}\\b`).test(gateText)) {
          r.add('W3', 'FAIL', `gate: no job runs the CI auditor ${auditor.tool}`);
        }
      }
    }
  }

  // ---- W4: format stays advisory at every tier ----
  checkFormatAdvisory(ctx, r, level, jobs);

  // ---- W5: e2e in gate and CI ----
  const e2eEntry = milestoneEntries(manifest).e2e;
  const e2eGate = jobs.filter((j) => j.hook === 'gate' && jobMatchesToken(j.name, 'e2e'));
  if (!dump) r.add('W5', 'UNKNOWN', 'merged hook config unavailable');
  else if (!e2eGate.length) r.add('W5', 'FAIL', 'gate: no e2e job', { rule: 'W5.naming' });
  else {
    const inert = e2eGate
      .map((j) => ({ j, verdict: inertnessOf(ctx, j.def, { tools: toolsOf(e2eEntry) }) }))
      .find((x) => blocksWiring(x.verdict));
    if (inert) {
      r.add(
        'W5',
        inert.verdict.status,
        `gate.${inert.j.name}: e2e is inert — ${inert.verdict.why}`,
        { rule: 'W5.inert' },
      );
    } else r.add('W5', 'PASS', 'gate: e2e job present');
  }
  if (!wf.exists || !wf.doc) {
    r.add(
      'W5',
      'UNKNOWN',
      `${wf.path}: ${wf.exists ? `unparseable (${wf.parseError})` : 'missing'}`,
      {
        file: wf.path,
        hard: wf.exists,
      },
    );
  } else {
    const e2eCi = findCiSteps(ctx, 'e2e', level);
    if (e2eCi.scope === 'blocked') {
      const b = blockedVerdict(e2eCi);
      r.add('W5', b.status, `${wf.path}:${b.step.line}: the e2e step cannot run — ${b.why}`, {
        file: wf.path,
        line: b.step.line,
        rule: 'W5.reach',
      });
    } else if (e2eCi.scope === 'none') {
      r.add('W5', 'FAIL', `${wf.path}: no e2e step`, { file: wf.path });
    } else {
      r.add('W5', 'PASS', `${wf.path}:${e2eCi.steps[0].line}: e2e step`, {
        file: wf.path,
        line: e2eCi.steps[0].line,
      });
    }
  }

  // ---- W6/W8/W18: supply chain, inside and outside the managed regions ----
  checkSupplyChain(ctx, r);

  // ---- W7: header allowlist and least privilege; W19: managed-region placement ----
  checkWorkflowHeader(ctx, r);
  if (level >= 4) checkRegionPlacement(ctx, r);

  // ---- W9/W10/W11: auditors and infrastructure steps ----
  if (level >= 2) {
    for (const auditor of auditorsOf(manifest)) {
      if (!auditor || typeof auditor.tool !== 'string') continue;
      const rx = new RegExp(`\\b${escapeRx(auditor.tool)}\\b`);
      const inGate = jobs.some(
        (j) =>
          j.hook === 'gate' &&
          rx.test(executableText(jobText(j.def))) &&
          inertnessOf(ctx, j.def).status !== 'FAIL',
      );
      const candidates = managedSteps(ctx).filter((s) => rx.test(executableText(stepCommand(s))));
      const ciStep = candidates.find((s) => stepReach(ctx, s).status === 'PASS');
      if (!dump) r.add('W9', 'UNKNOWN', 'merged hook config unavailable');
      else if (!inGate) r.add('W9', 'FAIL', `gate: CI auditor ${auditor.tool} is not run locally`);
      if (!ciStep && candidates.length) {
        const reach = stepReach(ctx, candidates[0]);
        r.add(
          'W9',
          reach.status,
          `${wf.path}:${candidates[0].line}: the ${auditor.tool} step cannot run — ${reach.why}`,
          { file: wf.path, line: candidates[0].line, rule: 'W9.reach' },
        );
      } else if (!ciStep) {
        r.add('W9', 'FAIL', `${wf.path}: CI auditor ${auditor.tool} is not run in a managed step`, {
          file: wf.path,
          rule: 'W9.region',
        });
      }
      if (inGate && ciStep) {
        r.add('W9', 'PASS', `${auditor.tool}: runs in the gate and in ${wf.path}:${ciStep.line}`, {
          file: wf.path,
          line: ciStep.line,
        });
      }
    }
  }
  if (level >= 3) checkInfraStep(ctx, r, 'W10', 'suppressions', 'check-suppressions', jobs);
  if (level >= 4) checkInfraStep(ctx, r, 'W11', 'project-checks', 'check-project-checks', jobs);

  // ---- W12: every declared project check resolves ----
  if (level >= 4) checkProjectChecks(ctx, r, jobs, level);

  // ---- W13/W14/W15: runtime fetches, frozen installs, package runners ----
  checkCommandHygiene(ctx, r, level);

  // ---- W16: the workflow proves a PRE-MERGE signal ----
  checkTriggers(ctx, r);

  // ---- W17: Gate ≡ CI at the TOOL, with demonstrable work ----
  checkGateEquivalence(ctx, r, level, jobs);

  // ---- W20: every enforcing command must still be able to fail ----
  checkSignalBearing(ctx, r, level, jobs);
}

/** Every step inside a managed region of the workflow. */
function managedSteps(ctx) {
  const out = [];
  for (const job of ctx.workflow.jobs) {
    for (const step of job.steps) if (step.managed) out.push(step);
  }
  return out;
}

/**
 * Locates the CI step(s) for a milestone. Managed-region scoping is the profile-4 rule
 * (contract §3.3): at profile ≤3 a project-owned step may still ANSWER for a milestone — an
 * additive install over a project's own CI — and that is reported as `outside`, never as a
 * managed pass.
 */

/**
 * Locates the CI step(s) for a milestone, and REJECTS a located step that cannot run: a
 * managed step behind `if: false`, an unreachable `needs` chain or an empty matrix reports
 * `blocked`, never `managed` — existence is not reachability (contract §3.3).
 *
 * Managed-region scoping is the profile-4 rule: at profile ≤3 a project-owned step may still
 * ANSWER for a milestone (an additive install over a project's own CI) and that is reported as
 * `outside`, which the callers treat as INFO at ≤3 and FAIL at ≥4 — never as a managed pass.
 */
function findCiSteps(ctx, token, level) {
  const wf = ctx.workflow;
  if (!wf.exists || !wf.doc) return { steps: [], scope: 'none', blocked: [] };
  // §2.4: the leading whitespace-delimited word must be a name in the milestone's ROW — not
  // the bare milestone token. `format-check (biome)` and `unit-coverage (vitest)` are managed.
  const names = managedNamesFor(token).map(norm);
  const strict = (name) =>
    names.includes(
      norm(
        String(name ?? '')
          .trim()
          .split(/\s+/)[0] ?? '',
      ),
    );
  const lenient = (name) => !!name && norm(name).startsWith(norm(token));
  const managed = [];
  const outside = [];
  for (const job of wf.jobs) {
    // A CI job id is a FREE name (§2.4): it locates nothing, so at profile 4 — where managed
    // membership is decided by the region — it can never answer for a managed step. Below
    // profile 4 this stays as a DISCOVERY heuristic for an additive install over a project's
    // own CI, which may have a whole job per milestone; it reports `outside`, never managed.
    const jobIsToken = level < 4 && norm(job.id) === norm(token);
    for (const step of job.steps) {
      if (!(strict(step.name) || (level < 4 && lenient(step.name)))) continue;
      (step.managed ? managed : outside).push(step);
    }
    if (jobIsToken && !job.steps.some((s) => strict(s.name))) {
      const runners = job.steps.filter((s) => stepCommand(s));
      if (runners.length) (job.managed ? managed : outside).push(...runners);
    }
  }
  const partition = (steps) => {
    const ok = [];
    const blocked = [];
    for (const step of steps) {
      const reach = stepReach(ctx, step);
      if (reach.status === 'PASS') ok.push(step);
      else blocked.push({ step, reach });
    }
    return { ok, blocked };
  };
  const m = partition(managed);
  if (m.ok.length) return { steps: m.ok, scope: 'managed', blocked: m.blocked };
  const o = partition(outside);
  if (m.blocked.length) return { steps: [], scope: 'blocked', blocked: m.blocked };
  if (o.ok.length) return { steps: o.ok, scope: 'outside', blocked: o.blocked };
  if (o.blocked.length) return { steps: [], scope: 'blocked', blocked: o.blocked };
  if (level < 4) {
    // Profile ≤3 additive installs preserve a project's own step under its own prose name;
    // fall back to the recorded TOOL appearing in a step outside the managed region.
    const tools = toolsOf(milestoneEntries(ctx.manifest)[token] ?? {});
    const byTool = [];
    for (const job of wf.jobs) {
      for (const step of job.steps) {
        const command = stepCommand(step);
        // The step NAME plus its EXECUTABLE command — never the raw text. A decoy whose whole
        // command is `# runs tsc under the hood` + `true` must not be credited with wiring the
        // typecheck milestone (it was, at profile ≤3, on every harness in existence).
        const text = `${step.name}\n${executableText(command)}`;
        const analysis = analyseCommand(command, ctx.pkg);
        const hit = tools.some(
          (t) =>
            commandMatchesTool(analysis, t) || new RegExp(`\\b${escapeRx(t)}\\b`, 'i').test(text),
        );
        if (hit) byTool.push(step);
      }
    }
    const b = partition(byTool);
    if (b.ok.length) return { steps: b.ok, scope: 'outside', blocked: b.blocked };
    if (b.blocked.length) return { steps: [], scope: 'blocked', blocked: b.blocked };
  }
  return { steps: [], scope: 'none', blocked: [] };
}

/** The blocked-step verdict a caller reports: FAIL for dead, UNKNOWN for unprovable. */
function blockedVerdict(found) {
  const worst = found.blocked.find((b) => b.reach.status === 'FAIL') ?? found.blocked[0];
  return { status: worst.reach.status, why: worst.reach.why, step: worst.step };
}

/** Commands that cannot fail, so `cmd || <one of these>` cannot exit non-zero. */
const NEVER_FAILS = new Set(['true', ':', 'echo', 'printf']);

/**
 * Can this hook command never block? The rule (format is advisory, constitution §2) is about
 * the exit status, not the spelling: `cmd || echo "drift"` is exactly as advisory as
 * `cmd || true`. Every top-level statement must end in `|| <command that cannot fail>`; one
 * statement that can fail on its own is enough to block.
 */
function cannotBlock(run) {
  const statements = run
    .split('\n')
    .flatMap((line) => splitTopLevel(line, ';'))
    .map((st) => st.trim())
    .filter(Boolean);
  if (!statements.length) return false;
  return statements.every((st) => {
    const parts = splitTopLevel(st, '||');
    if (parts.length < 2) return false;
    const head = tokenize(parts[parts.length - 1].trim())[0] ?? '';
    return NEVER_FAILS.has(head);
  });
}

function checkFormatAdvisory(ctx, r, level, jobs) {
  const wf = ctx.workflow;
  const gateFormat = jobs.filter((j) => j.hook === 'gate' && jobMatchesToken(j.name, 'format'));
  if (!ctx.dump.dump) {
    r.add('W4', 'UNKNOWN', 'merged hook config unavailable');
  } else if (!gateFormat.length) {
    r.add('W4', 'FAIL', 'gate: no format job', { rule: 'W4.naming' });
  } else {
    for (const job of gateFormat) {
      const run = executableText(jobText(job.def)).trim();
      if (cannotBlock(run))
        r.add('W4', 'PASS', `gate.${job.name}: advisory (every statement swallowed)`);
      else {
        r.add(
          'W4',
          'FAIL',
          `gate.${job.name}: \`${run}\` can exit non-zero — every statement must end in \`|| true\` (or another command that cannot fail); format must never block`,
        );
      }
    }
    for (const tier of ['pre-commit', 'pre-push']) {
      for (const job of jobs.filter((j) => j.hook === tier && jobMatchesToken(j.name, 'format'))) {
        r.add(
          'W4',
          'FAIL',
          `${tier}.${job.name}: format must not sit in a blocking group (contract §3.3)`,
        );
      }
    }
  }
  if (!wf.exists || !wf.doc) {
    r.add(
      'W4',
      'UNKNOWN',
      `${wf.path}: ${wf.exists ? `unparseable (${wf.parseError})` : 'missing'}`,
      {
        file: wf.path,
        hard: wf.exists,
      },
    );
    return;
  }
  const ci = findCiSteps(ctx, 'format', level);
  if (ci.scope === 'blocked') {
    const b = blockedVerdict(ci);
    r.add('W4', b.status, `${wf.path}:${b.step.line}: the format step cannot run — ${b.why}`, {
      file: wf.path,
      line: b.step.line,
      rule: 'W4.reach',
    });
  } else if (ci.scope === 'none') {
    r.add('W4', 'FAIL', `${wf.path}: no format step`, { file: wf.path });
  } else if (ci.scope === 'outside') {
    r.add(
      'W4',
      level >= 4 ? 'FAIL' : 'INFO',
      `${wf.path}:${ci.steps[0].line}: the format step is project-owned (outside the managed region); profile 4 requires a MANAGED step, so its advisory flag is enforceable`,
      { file: wf.path, line: ci.steps[0].line },
    );
  } else {
    for (const step of ci.steps) {
      if (step.continueOnError) {
        r.add('W4', 'PASS', `${wf.path}:${step.line}: continue-on-error: true`, {
          file: wf.path,
          line: step.line,
        });
      } else {
        r.add(
          'W4',
          'FAIL',
          `${wf.path}:${step.line}: format step "${step.name}" is blocking (no continue-on-error)`,
          { file: wf.path, line: step.line },
        );
      }
    }
  }
}

/**
 * §2.3: an additive install's `existing` record may ACKNOWLEDGE a supply-chain INFO raised
 * against a PRESERVED job — the harness is forbidden to edit that job, so the finding has no
 * resolution path and would otherwise sit open forever, which is training in ignoring
 * findings. The acknowledgement is the `<path>#<job>` token (the form `preserved` already
 * uses) appearing in `note`, and it is an acknowledgement ONLY when `preserved` names the same
 * job: the record says who owns a finding, it never silences one. A token that names no
 * preserved job is itself a finding, or the field becomes a way to silence anything.
 */
function acknowledgedJobs(ctx) {
  const record = ctx.manifest?.existing;
  if (!record || typeof record !== 'object') return { owned: new Set(), unpreserved: [] };
  const preserved = new Set(
    (Array.isArray(record.preserved) ? record.preserved : []).filter((x) => typeof x === 'string'),
  );
  const tokens = uniq(String(record.note ?? '').match(/[\w./-]+#[\w.-]+/g) ?? []);
  return {
    owned: new Set(tokens.filter((t) => preserved.has(t))),
    unpreserved: tokens.filter((t) => !preserved.has(t)),
  };
}

function checkSupplyChain(ctx, r) {
  const wf = ctx.workflow;
  if (!wf.exists || !wf.doc) {
    // `wf.jobs` is empty when the document did not parse, and the loop below would then emit
    // "every managed ref is digest-pinned" — a PASS on evidence that was never read.
    const why = wf.exists ? `unparseable (${wf.parseError})` : 'missing';
    for (const id of ['W6', 'W8', 'W18']) {
      r.add(id, 'UNKNOWN', `${wf.path}: ${why} — supply-chain pinning cannot be established`, {
        file: wf.path,
        hard: wf.exists,
      });
    }
    return;
  }
  const declaredJobs = new Set((projectChecksOf(ctx.manifest) ?? []).map((c) => c?.name));
  const ack = acknowledgedJobs(ctx);
  for (const token of ack.unpreserved) {
    r.add(
      'W18',
      'FAIL',
      `${ctx.manifestPath}: existing.note acknowledges \`${token}\`, which existing.preserved does not name — an acknowledgement may only cover a PRESERVED job (contract §2.3)`,
      { file: ctx.manifestPath },
    );
  }
  let managedFindings = 0;
  let outsideFindings = 0;

  const preservedJobs = new Set(
    (Array.isArray(ctx.manifest?.existing?.preserved)
      ? ctx.manifest.existing.preserved
      : []
    ).filter((x) => typeof x === 'string'),
  );
  for (const job of wf.jobs) {
    // §2.3: a supply-chain finding against a PRESERVED job "can never be resolved by a harness
    // forbidden to edit it". Declaring such a job in `projectChecks` says "do not lose this
    // check" — it does not hand the harness ownership of the job's supply chain, so the
    // finding stays an INFO (and stays acknowledgeable). A declared job the `existing` record
    // does NOT preserve opted in, and still fails.
    const declared = declaredJobs.has(job.id) && !preservedJobs.has(`${wf.path}#${job.id}`);
    // An acknowledgement covers INFO only. A FAIL is a job that opted INTO the harness (or a
    // managed one), and an UNKNOWN is a thing not established — neither is someone's to own.
    const owned = ack.owned.has(`${wf.path}#${job.id}`);
    const record = (id2, sev, text, at2) =>
      sev === 'INFO' && owned && id2 === 'W18'
        ? r.add(id2, sev, `acknowledged (${ctx.manifestPath} existing.note): ${text}`, {
            ...at2,
            acknowledged: true,
          })
        : r.add(id2, sev, text, at2);
    for (const step of job.steps) {
      const managed = step.managed || job.managed;
      const inside = managed || declared;
      // The id follows the REGION (W6 inside, W18 outside); the severity follows ownership —
      // a job the project DECLARED in projectChecks opted into the harness, so it fails.
      const id = managed ? 'W6' : 'W18';
      const severity = inside ? 'FAIL' : 'INFO';
      const at = { file: wf.path, line: step.line };
      if (step.uses) {
        const uLine = usesLineOf(wf, step);
        const issue = usesPinIssue(step.uses, wf.lines[uLine - 1] ?? '');
        if (issue) {
          if (managed) managedFindings++;
          else outsideFindings++;
          record(id, severity, `${wf.path}:${step.line}: \`uses: ${step.uses}\` ${issue}`, at);
        } else if (managed) {
          r.add('W6', 'PASS', `${wf.path}:${step.line}: ${step.uses} pinned`, at);
        }
        if (/actions\/checkout/.test(step.uses)) {
          const pc = step.with?.['persist-credentials'];
          if (pc !== false) {
            if (managed) {
              r.add(
                'W8',
                'FAIL',
                `${wf.path}:${step.line}: checkout without \`persist-credentials: false\``,
                at,
              );
            } else {
              outsideFindings++;
              record(
                'W18',
                severity,
                `${wf.path}:${step.line}: ${declared ? 'a job this project DECLARED in projectChecks' : 'a project-owned job'} checks out without \`persist-credentials: false\``,
                at,
              );
            }
          } else if (managed) {
            r.add('W8', 'PASS', `${wf.path}:${step.line}: persist-credentials: false`, at);
          }
        }
      }
      if (step.run) {
        for (const finding of dockerRunIssues(step.run, step.line, wf.lines)) {
          if (managed) managedFindings++;
          else outsideFindings++;
          // `docker run` digest + version comment: first normative at profile 4 (SINCE).
          record(id, severity, `${wf.path}:${finding.line}: ${finding.message}`, {
            file: wf.path,
            line: finding.line,
            rule: id === 'W6' ? 'W6.dockerRun' : undefined,
          });
        }
      }
    }
  }
  if (!managedFindings)
    r.add('W6', 'PASS', `${wf.path}: every managed ref is digest-pinned`, { file: wf.path });
  if (!outsideFindings)
    r.add('W18', 'PASS', `${wf.path}: no unpinned refs outside the managed regions`, {
      file: wf.path,
    });
  if (!wf.jobs.some((j) => j.steps.some((s) => /actions\/checkout/.test(s.uses)))) {
    r.add('W8', 'INFO', `${wf.path}: no checkout step to harden`, { file: wf.path });
  }
}

function usesPinIssue(uses, rawLine) {
  if (uses.startsWith('./') || uses.startsWith('.github/')) return null;
  if (uses.startsWith('docker://')) {
    if (!/@sha256:[0-9a-f]{64}/.test(uses)) return 'is not pinned to an immutable @sha256: digest';
    if (!/#\s*\S/.test(rawLine)) return 'has no trailing version comment';
    return null;
  }
  const ref = uses.split('@')[1] ?? '';
  if (!/^[0-9a-f]{40}$/.test(ref)) return 'is not pinned to a full 40-character commit SHA';
  if (!/#\s*\S/.test(rawLine)) return 'has no trailing version comment';
  return null;
}

function dockerRunIssues(run, stepLine, lines) {
  const out = [];
  const runLines = executableText(run).split('\n');
  for (let i = 0; i < runLines.length; i++) {
    const line = runLines[i];
    if (!/\bdocker\s+run\b/.test(line)) continue;
    const absLine = findLine(lines, (l) => l.includes(line.trim()), stepLine) || stepLine;
    const window = runLines.slice(i, i + 4).join('\n');
    if (!/@sha256:[0-9a-f]{64}/.test(window)) {
      out.push({ line: absLine, message: '`docker run` image is not pinned by @sha256: digest' });
    } else if (!/\d+\.\d+\.\d+/.test(run)) {
      out.push({
        line: absLine,
        message: '`docker run` digest carries no human-readable version comment',
      });
    }
  }
  return out;
}

const HEADER_ALLOWLIST = new Set(['name', 'on', 'permissions', 'concurrency', 'jobs']);

function checkWorkflowHeader(ctx, r) {
  const wf = ctx.workflow;
  const file = wf.path;
  if (!wf.exists) {
    r.add('W7', 'UNKNOWN', `${file}: missing`, { file });
    return;
  }
  for (const err of wf.regionErrors ?? []) {
    r.add('W7', 'UNKNOWN', `${file}: malformed managed region — ${err}`, { file, hard: true });
  }
  if (!wf.doc) {
    const dup = /duplicated mapping key \((\d+):/.exec(wf.parseError ?? '');
    if (dup) {
      r.add(
        'W7',
        'FAIL',
        `${file}:${dup[1]}: duplicate key — a later job id shadows an earlier (managed) definition`,
        { file, line: Number(dup[1]), rule: 'W7.header' },
      );
    } else {
      r.add('W7', 'UNKNOWN', `${file}: unparseable (${wf.parseError})`, { file, hard: true });
    }
    return;
  }
  const extra = Object.keys(wf.doc).filter((k) => !HEADER_ALLOWLIST.has(k));
  for (const key of extra) {
    const line = findLine(wf.lines, (l) => new RegExp(`^${escapeRx(key)}:`).test(l));
    r.add(
      'W7',
      'FAIL',
      `${file}:${line}: workflow-level \`${key}\` is outside the header allowlist (${[...HEADER_ALLOWLIST].join(', ')}) — it alters managed jobs from outside the block`,
      { file, line, rule: 'W7.header' },
    );
  }
  const perms = wf.doc.permissions;
  if (perms && typeof perms === 'object' && perms.contents === 'read') {
    const line = findLine(wf.lines, (l) => /^permissions:/.test(l));
    r.add('W7', 'PASS', `${file}:${line}: top-level permissions contents: read`, { file, line });
  } else {
    const managedJobs = wf.jobs.filter((j) => j.managed);
    const allScoped =
      managedJobs.length > 0 &&
      managedJobs.every((j) => j.def.permissions && j.def.permissions.contents === 'read');
    if (allScoped) {
      r.add('W7', 'PASS', `${file}: every managed job sets \`permissions: contents: read\``, {
        file,
      });
    } else {
      r.add(
        'W7',
        'FAIL',
        `${file}: no least-privilege \`permissions: contents: read\` at the workflow or managed-job level`,
        { file },
      );
    }
  }
  if (!extra.length && wf.doc.jobs)
    r.add('W7', 'PASS', `${file}: header limited to the allowlist`, { file });
}

/**
 * W19 — the managed CI region is PLACED correctly, not merely present (contract §3.3): it must
 * not begin at line 1 and must not swallow a header key. A region spanning the whole file has
 * no "outside", so every project-owned job falls inside it and the next regeneration deletes
 * them. The header allowlist (W7) cannot catch this: a whole-file region satisfies it perfectly.
 */
function checkRegionPlacement(ctx, r) {
  const wf = ctx.workflow;
  const file = wf.path;
  if (!wf.exists) {
    r.add('W19', 'UNKNOWN', `${file}: missing`, { file });
    return;
  }
  for (const err of wf.regionErrors ?? []) {
    r.add('W19', 'UNKNOWN', `${file}: malformed managed region — ${err}`, { file, hard: true });
  }
  if (!wf.regions.length) {
    r.add('W19', 'FAIL', `${file}: no managed region — nothing marks what regeneration owns`, {
      file,
    });
    return;
  }
  const first = wf.regions[0];
  const headerLines = ['name:', 'on:', 'permissions:', 'concurrency:', 'jobs:']
    .map((key) => findLine(wf.lines, (l) => l.startsWith(key)))
    .filter(Boolean);
  const swallowed = headerLines.filter((line) => inRegion(wf, line));
  if (first.start === 1 || swallowed.length) {
    r.add(
      'W19',
      'FAIL',
      `${file}:${first.start}: the managed region swallows the project-owned header — a whole-file region has no "outside", so regeneration deletes every project-owned job inside it`,
      { file, line: first.start },
    );
  } else {
    r.add('W19', 'PASS', `${file}:${first.start}: the managed region starts below the header`, {
      file,
      line: first.start,
    });
  }
}

function checkInfraStep(ctx, r, id, jobName, scriptStem, jobs) {
  const wf = ctx.workflow;
  const gateJob = jobs.find((j) => j.hook === 'gate' && j.name === jobName);
  if (!ctx.dump.dump) r.add(id, 'UNKNOWN', 'merged hook config unavailable');
  else if (!gateJob) r.add(id, 'FAIL', `gate: no \`${jobName}\` job`, { rule: `${id}.naming` });
  else {
    const inert = inertnessOf(ctx, gateJob.def);
    if (blocksWiring(inert)) {
      r.add(id, inert.status, `gate.${jobName}: inert — ${inert.why}`, { rule: `${id}.inert` });
    } else r.add(id, 'PASS', `gate.${jobName}: present`);
  }
  if (!wf.exists || !wf.doc) {
    r.add(
      id,
      'UNKNOWN',
      `${wf.path}: ${wf.exists ? `unparseable (${wf.parseError})` : 'missing'}`,
      {
        file: wf.path,
        hard: wf.exists,
      },
    );
    return;
  }
  const candidates = managedSteps(ctx).filter((s) =>
    executableText(stepCommand(s)).includes(scriptStem),
  );
  const step = candidates.find((s) => stepReach(ctx, s).status === 'PASS');
  if (step) {
    r.add(id, 'PASS', `${wf.path}:${step.line}: runs ${scriptStem}`, {
      file: wf.path,
      line: step.line,
    });
  } else if (candidates.length) {
    const reach = stepReach(ctx, candidates[0]);
    r.add(
      id,
      reach.status,
      `${wf.path}:${candidates[0].line}: the ${scriptStem} step cannot run — ${reach.why}`,
      { file: wf.path, line: candidates[0].line, rule: `${id}.reach` },
    );
  } else {
    r.add(id, 'FAIL', `${wf.path}: no managed CI step running ${scriptStem}`, {
      file: wf.path,
      rule: `${id}.region`,
    });
  }
}

// ---------------------------------------------------------------------------------------
// W12 — project-check resolution, with reachability
// ---------------------------------------------------------------------------------------

function checkProjectChecks(ctx, r, jobs, level) {
  const checks = projectChecksOf(ctx.manifest);
  if (checks === null) {
    r.add('W12', 'UNKNOWN', `${ctx.manifestPath}: projectChecks is absent`, {
      file: ctx.manifestPath,
      hard: true,
    });
    return;
  }
  if (!checks.length) {
    r.add('W12', 'INFO', `${ctx.manifestPath}: projectChecks: none declared`, {
      file: ctx.manifestPath,
    });
    return;
  }
  for (const check of checks) {
    const name = check?.name;
    const run = typeof check?.run === 'string' ? check.run : '';
    for (const tier of Array.isArray(check?.tiers) ? check.tiers : []) {
      if (tier === 'ci') {
        resolveCiProjectCheck(ctx, r, name, run, level);
        continue;
      }
      if (!ctx.dump.dump) {
        r.add('W12', 'UNKNOWN', `${name}@${tier}: merged hook config unavailable`);
        continue;
      }
      const job = jobs.find((j) => j.hook === tier && j.name === name);
      if (!job) {
        r.add('W12', 'FAIL', `${name}@${tier}: no job of that name in the merged hook config`);
        continue;
      }
      const inert = inertnessOf(ctx, job.def);
      if (blocksWiring(inert)) {
        r.add('W12', inert.status, `${name}@${tier}: the job is inert — ${inert.why}`);
        continue;
      }
      const commands = jobCommands(job.def);
      const holder = commands.find((c) => runContains(c, run) === true) ?? commands.join('\n');
      const signal = signalVerdict(ctx, holder, { needle: run });
      if (signal.status !== 'PASS') {
        r.add(
          'W12',
          reportedSignalStatus(signal.status, level),
          `${name}@${tier}: the declared check ${signalPhrase(signal.status)} — ${signal.why}; a check that cannot turn red is the same signal as a deleted one (W20)`,
        );
        continue;
      }
      reportRunMatch(r, `${name}@${tier}`, holder, run, {});
    }
  }
}

/** Shared verdict for "the declared `run` substring must execute in this command". */
function reportRunMatch(r, label, command, needle, at) {
  const verdict = runContains(command, needle);
  if (verdict === true)
    r.add('W12', 'PASS', `${label}: \`${needle}\` runs in ${firstLine(command).trim()}`, at);
  else if (verdict === false) {
    r.add(
      'W12',
      'FAIL',
      `${label}: \`${needle}\` is not in an executed position of \`${firstLine(command).trim()}\``,
      at,
    );
  } else {
    r.add(
      'W12',
      'UNKNOWN',
      `${label}: \`${needle}\` appears only inside a quoted string or an unresolvable construct in \`${firstLine(command).trim()}\` — it is not shown to execute`,
      at,
    );
  }
}

function resolveCiProjectCheck(ctx, r, name, run, level) {
  const wf = ctx.workflow;
  if (!wf.exists || !wf.doc) {
    r.add('W12', 'UNKNOWN', `${name}@ci: ${wf.path} ${wf.exists ? 'unparseable' : 'missing'}`, {
      file: wf.path,
      hard: wf.exists,
    });
    return;
  }
  const job = wf.jobs.find((j) => j.id === name);
  const step = wf.jobs.flatMap((j) => j.steps).find((s) => s.name === name);
  if (!job && !step) {
    r.add('W12', 'FAIL', `${name}@ci: no job id or step name "${name}" in ${wf.path}`, {
      file: wf.path,
    });
    return;
  }
  const target = step ?? (job ? job.steps.find((s) => stepCommand(s)) : null);
  const owner = step ? step.job : job;
  const line = (target ?? owner).line;
  // The matched step is `step` when the entry named a STEP and `target` when it named a JOB
  // ID; either way the step whose command is read must have its own `if` evaluated, not only
  // its job's (contract §3.3 reachability).
  const reach = reachability(ctx, owner, step ?? target ?? null);
  if (reach.status !== 'PASS') {
    r.add('W12', reach.status, `${name}@ci: ${reach.why}`, { file: wf.path, line });
    return;
  }
  const command = target ? stepCommand(target) : '';
  const analysis = analyseCommand(command, ctx.pkg);
  const work = classifyWork(analysis, analysis.args, workOptionsFor(ctx, analysis));
  if (work.status === 'FAIL') {
    r.add('W12', 'FAIL', `${name}@ci: ${work.why}`, { file: wf.path, line });
    return;
  }
  for (const [scope, value] of [
    ['step', target?.continueOnErrorRaw],
    ['job', owner?.def?.['continue-on-error']],
  ]) {
    const coe = continueOnErrorVerdict(value);
    if (!coe) continue;
    r.add(
      'W12',
      coe.status,
      coe.status === 'UNKNOWN'
        ? `${name}@ci: \`continue-on-error: ${coe.text}\` on the ${scope} is expression-valued — whether a failure can surface cannot be established`
        : `${name}@ci: \`continue-on-error: true\` on the ${scope} swallows the result — the check runs and can never turn anything red (W20)`,
      { file: wf.path, line },
    );
    return;
  }
  const signal = signalVerdict(ctx, command, {
    needle: run,
    ci: true,
    shell: target ? stepShell(target) : null,
  });
  if (signal.status !== 'PASS') {
    r.add(
      'W12',
      reportedSignalStatus(signal.status, level),
      `${name}@ci: the declared check ${signalPhrase(signal.status)} — ${signal.why} (W20)`,
      { file: wf.path, line },
    );
    return;
  }
  reportRunMatch(r, `${name}@ci`, command, run, { file: wf.path, line });
}

/** Reachability of a CI job/step for the authoritative pull-request event (spec §5 R-I3). */

/**
 * Reachability of a CI job/step for the authoritative pull-request event (spec §5 R-I3).
 * `seen` is a PER-PATH visited set: a diamond (`a` and `b` both needing `base`) visits `base`
 * on two different paths and is NOT a cycle, while a genuine loop still terminates.
 */
function reachability(ctx, job, step, seen = new Set()) {
  if (!job) return { status: 'UNKNOWN', why: 'job could not be located' };
  if (seen.has(job.id)) return { status: 'FAIL', why: `cyclic \`needs\` at ${job.id}` };
  const path = new Set(seen).add(job.id);
  const matrix = job.def.strategy?.matrix;
  if (matrix !== undefined) {
    if (!matrix || typeof matrix !== 'object')
      return { status: 'FAIL', why: 'strategy.matrix schedules nothing' };
    const dimensions = Object.entries(matrix).filter(([k]) => k !== 'include' && k !== 'exclude');
    const emptyDim = dimensions.some(([, v]) => Array.isArray(v) && v.length === 0);
    const include = Array.isArray(matrix.include) ? matrix.include : null;
    if (emptyDim || (!dimensions.length && include && include.length === 0)) {
      return { status: 'FAIL', why: 'strategy.matrix expands to zero combinations' };
    }
    if (!dimensions.length && !include) {
      return { status: 'UNKNOWN', why: 'strategy.matrix cannot be expanded statically' };
    }
  }
  const jobIf = conditionVerdict(job.def.if);
  if (jobIf.status !== 'PASS')
    return { status: jobIf.status, why: `job \`${job.id}\` if: ${jobIf.why}` };
  if (step) {
    const stepIf = conditionVerdict(step.if);
    if (stepIf.status !== 'PASS')
      return { status: stepIf.status, why: `step \`${step.name}\` if: ${stepIf.why}` };
  }
  for (const need of [].concat(job.def.needs ?? [])) {
    const dep = ctx.workflow.jobs.find((j) => j.id === need);
    if (!dep) return { status: 'FAIL', why: `\`needs: ${need}\` does not exist` };
    const depReach = reachability(ctx, dep, null, path);
    if (depReach.status !== 'PASS')
      return { status: depReach.status, why: `via needs → ${depReach.why}` };
  }
  return { status: 'PASS', why: 'reachable for a pull_request event' };
}

/** Reachability of one located step, including its own `if:` and its job's `needs` closure. */
function stepReach(ctx, step) {
  return reachability(ctx, step.job, step);
}

/** Can this `if:` be shown TRUE for the authoritative pull-request event? */
function conditionVerdict(expr) {
  if (expr === undefined || expr === null || expr === true)
    return { status: 'PASS', why: 'unconditional' };
  const text = String(expr)
    .replace(/^\$\{\{/, '')
    .replace(/\}\}$/, '')
    .trim();
  if (!text || text === 'true') return { status: 'PASS', why: 'unconditional' };
  if (text === 'false') return { status: 'FAIL', why: 'always false' };
  let verdict = 'PASS';
  for (const part of text.split('&&').map((p) => p.trim())) {
    if (/^github\.event_name\s*==\s*'pull_request'$/.test(part)) continue;
    if (/^github\.event_name\s*!=\s*'pull_request'$/.test(part)) {
      return { status: 'FAIL', why: `\`${part}\` excludes pull_request` };
    }
    verdict = 'UNKNOWN';
  }
  return verdict === 'PASS'
    ? { status: 'PASS', why: 'true for pull_request' }
    : { status: 'UNKNOWN', why: `\`${text}\` cannot be shown true for the pull-request event` };
}

// ---------------------------------------------------------------------------------------
// W13 / W14 / W15 — command hygiene
// ---------------------------------------------------------------------------------------

const FETCH_RX =
  /\bpipx run\b|\buvx\b|\bnpx\s+(-y|--yes)\b|\bpip install\b(?!.*--require-hashes)|curl [^\n]*\|\s*(ba)?sh/;
const FROZEN_RX = [
  {
    rx: /\bnpm ci\b\s*\|\|\s*npm install\b/,
    why: '`npm ci || npm install` silently re-resolves the tree',
  },
  {
    rx: /\bnpm install\b(?!.*\s-g\b)(?!.*--global)/,
    why: 'bare `npm install` re-resolves; use `npm ci`',
  },
  { rx: /\buv sync\b(?!.*(--locked|--frozen))/, why: '`uv sync` without `--locked`/`--frozen`' },
  {
    rx: /\bpnpm install\b(?!.*--frozen-lockfile)/,
    why: '`pnpm install` without `--frozen-lockfile`',
  },
  {
    rx: /\bpip install\b[^\n]*-r\b(?!.*--require-hashes)/,
    why: '`pip install -r` without `--require-hashes`',
    rule: 'W14.pipHashes',
  },
];
const NPX_RX = /(^|[\s;&|(])npx\s|\bnpm\s+exec\b/;

function checkCommandHygiene(ctx, r, level) {
  const sources = commandSources(ctx);
  let fetch = 0;
  let frozen = 0;
  let npx = 0;
  for (const src of sources) {
    const lines = src.artifactLines ?? [];
    const text = executableText(src.text);
    if (FETCH_RX.test(text)) {
      fetch++;
      const at = matchLineOf(text, FETCH_RX, src.line, lines);
      // Hooks were bound by this rule from profile 2; CI steps and agent-settings hooks from 4
      // (the profile-2 CI template itself prescribed `pipx run`).
      r.add('W13', 'FAIL', `${src.where}: fetches tooling at execution time — \`${at.text}\``, {
        file: src.file,
        line: at.line,
        rule: src.kind === 'hook' ? undefined : 'W13.ci',
      });
    }
    for (const { rx, why, rule } of FROZEN_RX) {
      if (rx.test(text)) {
        frozen++;
        const at = matchLineOf(text, rx, src.line, lines);
        r.add('W14', 'FAIL', `${src.where}: ${why} — \`${at.text}\``, {
          file: src.file,
          line: at.line,
          rule,
        });
        break;
      }
    }
    if (NPX_RX.test(text)) {
      npx++;
      const at = matchLineOf(text, NPX_RX, src.line, lines);
      r.add(
        'W15',
        level >= 4 ? 'FAIL' : 'INFO',
        `${src.where}: on-demand package runner in \`${at.text}\` — use node_modules/.bin/<tool> (spec D9)`,
        { file: src.file, line: at.line },
      );
    }
  }
  if (!fetch)
    r.add('W13', 'PASS', `${sources.length} hook/CI command(s): no execution-time tool fetch`);
  if (!frozen)
    r.add('W14', 'PASS', `${sources.length} hook/CI command(s): every install is frozen`);
  if (!npx) r.add('W15', 'PASS', `${sources.length} hook/CI command(s): no npx / npm exec`);
}

/** Every command the harness executes: hook jobs, managed CI steps, settings.json hooks. */
function commandSources(ctx) {
  const out = [];
  for (const layer of [ctx.managedHook, ctx.rootHook]) {
    if (!layer?.exists || !layer.doc || typeof layer.doc !== 'object') continue;
    for (const [hook, node] of Object.entries(layer.doc)) {
      if (!isHookNode(hook, node)) continue;
      for (const job of jobsOfHook(node)) {
        const run = jobCommands(job ?? {}).join('\n');
        if (!run) continue;
        const line = findLine(layer.lines, (l) => l.includes(firstLine(run).trim()));
        if (layer === ctx.rootHook && ctx.level >= 4 && !inRegion(layer, line)) continue;
        out.push({
          kind: 'hook',
          where: `${layer.path}:${line} ${hook}.${job.name ?? '?'}`,
          text: run,
          file: layer.path,
          line,
          artifactLines: layer.lines,
        });
      }
    }
  }
  for (const step of managedSteps(ctx)) {
    const command = step.run || (typeof step.with.args === 'string' ? step.with.args : '');
    if (!command) continue;
    out.push({
      kind: 'ci',
      where: `${ctx.workflow.path}:${step.line} step "${step.name || step.uses}"`,
      text: command,
      file: ctx.workflow.path,
      line: step.line,
      artifactLines: ctx.workflow.lines,
    });
  }
  if (ctx.settings.json) {
    for (const event of ['PostToolUse', 'SessionStart', 'PreToolUse', 'Stop']) {
      for (const entry of settingsHookEntries(ctx.settings.json, event)) {
        if (!entry.command) continue;
        out.push({
          kind: 'settings',
          where: `.claude/settings.json ${event} hook`,
          text: entry.command,
          file: '.claude/settings.json',
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// W16 — the workflow must actually fire, pre-merge
// ---------------------------------------------------------------------------------------

const PRE_MERGE_TYPES = ['opened', 'synchronize'];

function checkTriggers(ctx, r) {
  const wf = ctx.workflow;
  const file = wf.path;
  if (!wf.exists) {
    r.add('W16', 'UNKNOWN', `${file}: missing`, { file });
    return;
  }
  if (!wf.doc) {
    r.add('W16', 'UNKNOWN', `${file}: unparseable (${wf.parseError})`, { file, hard: true });
    return;
  }
  const on = wf.doc.on ?? wf.doc.true;
  const onLine = findLine(wf.lines, (l) => /^on:/.test(l));
  if (!on) {
    r.add('W16', 'FAIL', `${file}: no \`on:\` triggers — the workflow never runs`, { file });
    return;
  }
  const branch = ctx.defaultBranch;
  const branchNote = branch.resolved
    ? `default branch "${branch.name}"`
    : `assumed default branch (no remote to resolve it; accepted one of ${branch.candidates.join('/')})`;

  const normalised = normaliseTriggers(on);
  const pr = normalised.pull_request;
  const push = normalised.push;
  if (!pr) {
    r.add(
      'W16',
      'FAIL',
      `${file}:${onLine}: no \`pull_request\` trigger — no pre-merge status exists`,
      { file, line: onLine },
    );
  } else {
    if (!coversBranch(pr, branch)) {
      r.add(
        'W16',
        'FAIL',
        `${file}:${onLine}: the pull_request trigger excludes the ${branchNote}`,
        { file, line: onLine, rule: 'W16.narrowing' },
      );
    }
    const types = Array.isArray(pr.types) ? pr.types : null;
    if (types) {
      const missing = PRE_MERGE_TYPES.filter((t) => !types.includes(t));
      if (missing.length) {
        r.add(
          'W16',
          'FAIL',
          `${file}:${onLine}: pull_request types ${JSON.stringify(types)} omit ${missing.join(', ')} — no pre-merge signal`,
          { file, line: onLine, rule: 'W16.narrowing' },
        );
      }
    }
    if (pr.paths || pr['paths-ignore']) {
      r.add(
        'W16',
        'FAIL',
        `${file}:${onLine}: the pull_request trigger carries a paths filter — the check silently does not run for some changes`,
        { file, line: onLine, rule: 'W16.narrowing' },
      );
    }
  }
  if (!push) {
    r.add('W16', 'FAIL', `${file}:${onLine}: no \`push\` trigger for the ${branchNote}`, {
      file,
      line: onLine,
    });
  } else {
    if (!coversBranch(push, branch)) {
      r.add('W16', 'FAIL', `${file}:${onLine}: the push trigger excludes the ${branchNote}`, {
        file,
        line: onLine,
        rule: 'W16.narrowing',
      });
    }
    if (push.paths || push['paths-ignore']) {
      r.add('W16', 'FAIL', `${file}:${onLine}: the push trigger carries a paths filter`, {
        file,
        line: onLine,
        rule: 'W16.narrowing',
      });
    }
  }
  if (pr && push) {
    r.add(
      'W16',
      'PASS',
      `${file}:${onLine}: pull_request + push cover the ${branchNote} with no paths filter`,
      { file, line: onLine },
    );
  }
}

function normaliseTriggers(on) {
  if (typeof on === 'string') return { [on]: {} };
  if (Array.isArray(on)) return Object.fromEntries(on.map((k) => [k, {}]));
  if (on && typeof on === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(on)) out[k] = v && typeof v === 'object' ? v : {};
    return out;
  }
  return {};
}

function coversBranch(trigger, branch) {
  const names = branch.resolved ? [branch.name] : branch.candidates;
  const include = trigger.branches;
  const ignore = trigger['branches-ignore'];
  if (Array.isArray(ignore) && names.some((n) => ignore.some((p) => globMatch(p, n)))) return false;
  if (!Array.isArray(include)) return true;
  return names.some((n) => include.some((p) => globMatch(p, n)));
}

function globMatch(pattern, value) {
  const rx = new RegExp(
    `^${String(pattern)
      .replace(/[.+^${}()|[\]\\?]/g, '\\$&')
      .replace(/\*\*/g, ' ')
      .replace(/\*/g, '[^/]*')
      .replace(/ /g, '.*')}$`,
  );
  return rx.test(value);
}

/**
 * The repository's default branch, offline: `origin/HEAD`, then an existing `origin/main` /
 * `origin/master`. When nothing authoritative resolves, the conventional names are CANDIDATES
 * and the evidence says the check accepted an assumption.
 */
function resolveDefaultBranch(root, noGit) {
  const candidates = ['main', 'master'];
  if (noGit) return { resolved: false, name: 'main', candidates };
  const head = runCommand('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], root);
  if (!head.error && head.stdout.trim()) {
    return { resolved: true, name: head.stdout.trim().replace(/^origin\//, ''), candidates };
  }
  for (const name of candidates) {
    const ref = runCommand(
      'git',
      ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`],
      root,
    );
    if (!ref.error && ref.stdout.trim()) return { resolved: true, name, candidates };
  }
  return { resolved: false, name: 'main', candidates };
}

// ---------------------------------------------------------------------------------------
// W17 — Gate ≡ CI at the tool, with demonstrable work
// ---------------------------------------------------------------------------------------

/**
 * W20 — signal-bearing (contract §3.3). A check that runs to completion but cannot report
 * failure produces exactly the signal of a check that was deleted, so every command a tier is
 * meant to ENFORCE must be able to exit non-zero — and that has to be SHOWN, not assumed from
 * the absence of known swallow shapes.
 *
 * Two exemptions, both read from the constitution's recorded MODE columns rather than from any
 * list of names: a milestone §2 records ADVISORY (`format`, `dependency-audit` today), and a
 * tier §1 records ADVISORY (`edit`). (`format` additionally REQUIRES its swallow, and W4 owns
 * that direction; W20 only ever fires on a non-advisory milestone at a blocking tier.)
 *
 * A DEMONSTRATED swallow FAILs at every profile — advisory withholds judgment on the unknown,
 * never on the known-bad, and the same reasoning applies to a profile-3 harness. What the
 * profile gates is the UNRESOLVED verdict: INFO at ≤3, UNKNOWN at ≥4, so a new normative rule
 * does not retroactively fail a harness merely because this reader cannot read its shell.
 */
function checkSignalBearing(ctx, r, level, jobs) {
  r.enable('W20');
  const unverified = level >= 4 ? 'UNKNOWN' : 'INFO';
  const milestones = milestoneModes();
  const tiers = tierModes();
  const wf = ctx.workflow;
  let judged = 0;

  if (!milestones.size || !tiers.size) {
    r.add(
      'W20',
      unverified,
      "the constitution's mode columns could not be read, so the advisory exemptions cannot be established",
      { hard: true },
    );
    return;
  }

  const report = (label, verdict, at) => {
    if (verdict.status === 'PASS') {
      judged++;
      return;
    }
    r.add('W20', verdict.status === 'FAIL' ? 'FAIL' : unverified, `${label}: ${verdict.why}`, at);
  };

  const judgeCommand = (label, command, opts, at) =>
    report(label, signalVerdict(ctx, command, opts), at);

  const judgeStep = (label, step, opts) => {
    const at = { file: wf.path, line: step.line };
    for (const [scope, value] of [
      ['step', step.continueOnErrorRaw],
      ['job', step.job?.def?.['continue-on-error']],
    ]) {
      const coe = continueOnErrorVerdict(value);
      if (!coe) continue;
      r.add(
        'W20',
        coe.status === 'UNKNOWN' ? unverified : 'FAIL',
        coe.status === 'UNKNOWN'
          ? `${label}: \`continue-on-error: ${coe.text}\` on the ${scope} is expression-valued — whether a failure can surface cannot be established`
          : `${label}: \`continue-on-error: true\` on the ${scope} discards the result — the check runs and can never turn anything red`,
        at,
      );
      return;
    }
    judgeCommand(label, stepCommand(step), { ...opts, ci: true, shell: stepShell(step) }, at);
  };

  const isBlocking = (tier) => tiers.get(norm(tier)) === 'blocking';

  for (const milestone of MILESTONES) {
    const entry = milestoneEntries(ctx.manifest)[milestone];
    if (!entry) continue;
    const mode = milestones.get(norm(milestone));
    if (mode === undefined) {
      r.add(
        'W20',
        unverified,
        `${milestone}: the constitution's §2 mode column records no mode for it, so the advisory exemption cannot be established`,
        { hard: true },
      );
      continue;
    }
    if (mode === 'advisory') {
      r.add(
        'W20',
        'PASS',
        `${milestone}: advisory in constitution §2 — a swallow is its specification`,
      );
      continue;
    }
    const tools = toolsOf(entry);
    for (const tier of tiersOf(entry)) {
      if (!isBlocking(tier)) continue;
      if (HOOK_TIERS.includes(tier) && ctx.dump.dump) {
        for (const job of jobs.filter(
          (j) => j.hook === tier && jobMatchesToken(j.name, milestone),
        )) {
          for (const command of jobCommands(job.def)) {
            judgeCommand(`${tier}.${job.name}`, command, { tools }, {});
          }
          if (!jobCommands(job.def).length && job.def?.group) {
            r.add(
              'W20',
              'FAIL',
              `${tier}.${job.name}: the job is an EMPTY group, so it runs nothing`,
            );
          }
        }
      }
      if (tier === 'ci' && wf.exists && wf.doc) {
        const found = findCiSteps(ctx, milestone, level);
        for (const step of found.steps)
          judgeStep(`${wf.path}:${step.line} ${milestone}`, step, { tools });
      }
    }
  }

  // The harness-infrastructure checks enforce too, and no mode column exempts them — at the
  // gate AND in CI. Each is given the locator for what it invokes: without one, the reader
  // falls back to the command's last statement, which is how a trailing `true` on the
  // suppression ledger passed for a whole round.
  const infrastructure = [
    { name: 'tool-versions', needle: 'assert-tool-versions' },
    {
      name: 'workflow-audit',
      tools: auditorsOf(ctx.manifest)
        .map((a) => a?.tool)
        .filter(Boolean),
    },
    { name: 'suppressions', needle: 'check-suppressions' },
    { name: 'project-checks', needle: 'check-project-checks' },
  ];
  for (const infra of infrastructure) {
    const opts = infra.needle ? { needle: infra.needle } : { tools: infra.tools ?? [] };
    if (ctx.dump.dump && isBlocking('gate')) {
      for (const job of jobs.filter((j) => j.hook === 'gate' && j.name === infra.name)) {
        for (const command of jobCommands(job.def)) {
          judgeCommand(`gate.${job.name}`, command, opts, {});
        }
        if (!jobCommands(job.def).length) {
          r.add('W20', 'FAIL', `gate.${job.name}: the job runs no command at all`);
        }
      }
    }
    if (!wf.exists || !wf.doc || !isBlocking('ci')) continue;
    // Located by WHAT THE STEP RUNS, exactly as W10/W11 locate it. Matching the §2.4 token
    // against the step NAME finds nothing in any shipped harness — every one of them calls the
    // step `suppression approval ledger`, and `suppression` is not `suppressions` — so the
    // control-plane gate was never judged at all.
    const matches = managedSteps(ctx).filter((step) => {
      const text = executableText(stepCommand(step));
      if (infra.needle) return text.includes(infra.needle);
      return (infra.tools ?? []).some((t) => new RegExp(`\\b${escapeRx(t)}\\b`).test(text));
    });
    const byToken = findCiSteps(ctx, infra.name, level);
    const steps = uniq([...matches, ...(byToken.scope === 'managed' ? byToken.steps : [])]);
    for (const step of steps) judgeStep(`${wf.path}:${step.line} ${infra.name}`, step, opts);
  }
  if (judged) {
    r.add('W20', 'PASS', `${judged} command(s) shown to propagate a non-zero exit`);
  }
}

/** A step's declared shell, including a job-level `defaults.run.shell`; null when default. */
function stepShell(step) {
  const own = typeof step.shell === 'string' ? step.shell : null;
  const fromJob = step.job?.def?.defaults?.run?.shell;
  return own ?? (typeof fromJob === 'string' ? fromJob : null);
}

function checkGateEquivalence(ctx, r, level, jobs) {
  const wf = ctx.workflow;
  for (const milestone of MILESTONES) {
    const entry = milestoneEntries(ctx.manifest)[milestone];
    if (!entry) continue;
    const tiers = tiersOf(entry);
    if (!tiers.includes('gate') || !tiers.includes('ci')) continue;
    const required = toolsOf(entry);
    const gateJobs = jobs.filter((j) => j.hook === 'gate' && jobMatchesToken(j.name, milestone));
    const ci = findCiSteps(ctx, milestone, level);
    const gateCommands = gateJobs.map((j) => ({
      label: `gate.${j.name}`,
      command: jobText(j.def),
    }));
    const ciCommands = ci.steps.map((s) => ({
      label: `${wf.path}:${s.line} "${s.name || s.uses}"`,
      command: stepCommand(s),
    }));
    const gateText = gateCommands.map((c) => stripComment(c.command).trim()).join(' ; ') || 'none';
    const ciText =
      ciCommands.map((c) => firstLine(stripComment(c.command)).trim()).join(' ; ') || 'none';
    const pair = `${milestone}: gate [${gateText}] vs ci [${ciText}]`;

    if (!ctx.dump.dump) {
      r.add('W17', 'UNKNOWN', `${milestone}: merged hook config unavailable — ${pair}`, {
        rule: 'W17',
      });
      continue;
    }
    if (!gateCommands.length || !ciCommands.length) {
      r.add('W17', 'FAIL', `${pair} — a tier has no command`, { rule: 'W17' });
      continue;
    }
    const gateTools = matchedTools(ctx, gateCommands, required);
    const ciTools = matchedTools(ctx, ciCommands, required);
    const sameSubset =
      gateTools.tools.length &&
      gateTools.tools.length === ciTools.tools.length &&
      gateTools.tools.every((t) => ciTools.tools.includes(t));
    if (!sameSubset || gateTools.tools.length !== required.length) {
      // A tool this reader cannot identify — `make lint`, `scripts/lint.sh`, a workspace
      // filter — is not the same finding as a tool that is demonstrably DIFFERENT. Closing
      // those shape by shape is the mistake the swallow list already taught; the class fix is
      // to report what is true: the equivalence could not be established.
      const unidentified = [...gateTools.unidentified, ...ciTools.unidentified];
      if (unidentified.length) {
        r.add(
          'W17',
          'UNKNOWN',
          `${pair} — the tool could not be identified in ${unidentified.map((c) => `\`${firstLine(c).trim()}\``).join(', ')}, so gate ≡ CI cannot be established`,
          { file: wf.path, rule: 'W17' },
        );
        continue;
      }
      r.add(
        'W17',
        'FAIL',
        `${pair} — gate references {${gateTools.tools.join(',')}}, CI references {${ciTools.tools.join(',')}}, manifest records {${required.join(',')}}`,
        { file: wf.path, rule: 'W17' },
      );
      continue;
    }
    const verdicts = [...gateTools.work, ...ciTools.work];
    const failed = verdicts.find((v) => v.status === 'FAIL');
    if (failed) {
      r.add('W17', 'FAIL', `${pair} — ${failed.why}`, { file: wf.path, rule: 'W17' });
      continue;
    }
    const unknown = verdicts.find((v) => v.status === 'UNKNOWN');
    if (unknown) {
      r.add('W17', 'UNKNOWN', `${pair} — ${unknown.why}`, { file: wf.path, rule: 'W17' });
      continue;
    }
    r.add('W17', 'PASS', pair, { file: wf.path });
  }
}

function matchedTools(ctx, commands, required) {
  const tools = [];
  const work = [];
  const unidentified = [];
  for (const { command } of commands) {
    // The tool may sit on any statement of a multi-line command — after a `set -euo pipefail`
    // prologue, inside a guard block, behind a `cd … &&`. Reading only the first line lost the
    // identity of the very shapes the signal-bearing rule pushes authors towards.
    let hit = null;
    let statement = command;
    for (const candidate of required) {
      const invocation = commandInvokesTool(ctx, command, candidate);
      if (!invocation) continue;
      hit = candidate;
      statement = invocation;
      break;
    }
    const analysis = analyseCommand(statement, ctx.pkg);
    if (hit) {
      if (!tools.includes(hit)) tools.push(hit);
      work.push(
        classifyWork(analysis, operationalArgs(analysis, hit), workOptionsFor(ctx, analysis, hit)),
      );
    } else {
      unidentified.push(command);
      work.push(classifyWork(analysis, analysis.args, workOptionsFor(ctx, analysis)));
    }
  }
  return { tools, work, unidentified };
}

// ---------------------------------------------------------------------------------------
// Checks — drift (D*)
// ---------------------------------------------------------------------------------------

const NODE_PACKAGES = {
  biome: '@biomejs/biome',
  tsc: 'typescript',
  vitest: 'vitest',
  tsup: 'tsup',
  playwright: '@playwright/test',
  eslint: 'eslint',
  prettier: 'prettier',
  lefthook: 'lefthook',
  commitlint: '@commitlint/cli',
};

/** Where the harness declares that the version assertion RUNS — hook jobs and CI steps. */
function assertionRunners(ctx) {
  const out = [];
  for (const job of mergedJobs(ctx.dump?.dump)) {
    if (jobText(job.def).includes('assert-tool-versions')) out.push(`${job.hook}.${job.name}`);
  }
  for (const step of managedSteps(ctx)) {
    if (executableText(stepCommand(step)).includes('assert-tool-versions')) {
      out.push(`${ctx.workflow.path}:${step.line}`);
    }
  }
  return uniq(out);
}

function checkDrift(ctx, r, level) {
  const { root, manifest } = ctx;
  const pins = manifestPins(ctx);
  const wf = ctx.workflow;
  /** tool → where its pin was reconciled, so D1 can tell "no lockfile" from "unreconciled". */
  const reconciled = new Map();

  // ---- D2: assert-tool-versions.sh literals ----
  const assertPath = findScript(root, 'assert-tool-versions') ?? 'scripts/assert-tool-versions.sh';
  const assertRead = safeRead(join(root, assertPath)).text;
  const assertText = assertRead === null ? null : liveScriptLines(assertRead);
  if (assertText !== null && assertPath.startsWith(`${VENDORED_BIN}/`)) {
    // The vendored assertion carries no literals to drift: it resolves every pin from the
    // manifest at run time, and A17 vouches that the script is the bundle's.
    r.add('D2', 'PASS', `${assertPath}: the vendored assertion reads every pin from the manifest`, {
      file: assertPath,
    });
  } else if (assertText === null) {
    // A MISSING control is a failure, not a note. Deleting `check-suppressions.mjs` FAILs A9
    // and `check-project-checks.mjs` FAILs A11; this one degraded to INFO while the gate job
    // that EXECUTES it still passed W3 — wired, unrunnable, and reported conforming. Two
    // conditions, both about what the harness CLAIMS: something runs it, or the manifest
    // records pins that §3.4 requires a run-time assertion for.
    const runsIt = assertionRunners(ctx);
    if (runsIt.length) {
      r.add(
        'D2',
        'FAIL',
        `${assertPath}: not present, but ${runsIt.join(', ')} runs it — the check is wired and cannot run`,
        { file: assertPath, rule: 'D2.path' },
      );
    } else if (pins.length) {
      r.add(
        'D2',
        'FAIL',
        `${assertPath}: not present, and the manifest records ${pins.length} pinned tool(s) that nothing asserts at run time (contract §3.4)`,
        // Located by NAME, which no profile before 6 made normative (a harness may assert under
        // any name — `check-tool-versions.sh` in the field); the vendored bundle fixes it at 6.
        { file: assertPath, rule: 'D2.path' },
      );
    } else {
      r.add('D2', 'INFO', `${assertPath}: not present, and nothing records or runs it`, {
        file: assertPath,
      });
    }
  } else {
    const pinMap = new Map(pins);
    let matched = 0;
    for (const m of assertText.matchAll(/^assert\s+(\S+)\s+"([^"]+)"/gm)) {
      const [, tool, version] = m;
      const expected = pinMap.get(tool);
      if (expected === undefined) {
        r.add(
          'D2',
          'UNKNOWN',
          `${assertPath}: asserts ${tool} ${version}, which the manifest does not record`,
          { file: assertPath },
        );
        continue;
      }
      matched++;
      reconciled.set(tool, assertPath);
      if (expected !== version) {
        const line = findLine(
          assertText.split('\n'),
          (l) => l.includes(`assert ${tool}`) || l.includes(`assert  ${tool}`),
        );
        r.add(
          'D2',
          'FAIL',
          `${assertPath}:${line}: asserts ${tool} ${version}, manifest pins ${expected}`,
          { file: assertPath, line },
        );
      }
    }
    if (matched)
      r.add('D2', 'PASS', `${assertPath}: ${matched} assertion(s) match the manifest`, {
        file: assertPath,
      });
  }

  // ---- D3: provisioning script + any *_VERSION= in hook/CI text ----
  const provPath = findScript(root, 'provision-tools') ?? 'scripts/provision-tools.sh';
  const provRead = safeRead(join(root, provPath)).text;
  const provText = provRead === null ? null : liveScriptLines(provRead);
  const versionSources = [];
  const provVendored = provText !== null && provPath.startsWith(`${VENDORED_BIN}/`);
  if (provVendored) {
    // The vendored provisioner installs from `.claudeconf/tools.lock.json`, the pins' own
    // source; it has no version of its own to drift (A17 vouches for the script).
    r.add('D3', 'PASS', `${provPath}: the vendored provisioner reads .claudeconf/tools.lock.json`, {
      file: provPath,
    });
  } else if (provText !== null) versionSources.push({ path: provPath, text: provText });
  else r.add('D3', 'INFO', `${provPath}: not present`, { file: provPath });
  for (const src of commandSources(ctx)) {
    versionSources.push({ path: src.where, text: executableText(src.text) });
  }
  let checkedVars = 0;
  for (const src of versionSources) {
    const rx = /\b([A-Z][A-Z0-9_]*)_VERSION\s*=\s*"?\$?\{?[^\s"}]*?([0-9]+\.[0-9]+(?:\.[0-9]+)?)/g;
    for (const m of src.text.matchAll(rx)) {
      const tool = m[1].toLowerCase().replace(/_/g, '-');
      const expected = lookupPin(pins, tool);
      if (expected === undefined || expected === 'n/a') continue;
      checkedVars++;
      reconciled.set(tool, src.path);
      if (expected !== m[2]) {
        r.add(
          'D3',
          'FAIL',
          `${src.path}: ${m[1]}_VERSION=${m[2]} but the manifest pins ${tool} ${expected}`,
          { file: src.path.split(':')[0] },
        );
      }
    }
  }
  if (checkedVars) r.add('D3', 'PASS', `${checkedVars} *_VERSION assignment(s) match the manifest`);
  else if (provText !== null && !provVendored)
    r.add('D3', 'UNKNOWN', `${provPath}: no *_VERSION assignment maps to a manifest tool`, {
      file: provPath,
    });

  // ---- D4: CI image digests carry the manifest version ----
  let digests = 0;
  for (const job of wf.jobs) {
    for (const step of job.steps) {
      const uLine = usesLineOf(wf, step);
      const line = wf.lines[uLine - 1] ?? '';
      if (!/@sha256:[0-9a-f]{64}/.test(`${step.uses}${line}`)) continue;
      const comment = /#\s*v?([0-9]+\.[0-9]+\.[0-9]+)/.exec(line);
      const image = (step.uses || line).replace(/.*docker:\/\//, '').split('@')[0];
      const tool = basename(image);
      const expected = lookupPin(pins, tool);
      if (expected === undefined) continue;
      digests++;
      reconciled.set(tool, `${wf.path}:${uLine}`);
      if (!comment) {
        r.add(
          'D4',
          'FAIL',
          `${wf.path}:${uLine}: digest-pinned ${tool} has no version comment to reconcile`,
          { file: wf.path, line: uLine },
        );
      } else if (comment[1] !== expected) {
        r.add(
          'D4',
          'FAIL',
          `${wf.path}:${uLine}: ${tool} comment says ${comment[1]}, manifest pins ${expected}`,
          { file: wf.path, line: uLine },
        );
      } else {
        r.add('D4', 'PASS', `${wf.path}:${uLine}: ${tool} ${expected}`, {
          file: wf.path,
          line: uLine,
        });
      }
    }
  }
  if (!digests)
    r.add('D4', 'INFO', `${wf.path}: no digest-pinned image maps to a manifest tool`, {
      file: wf.path,
    });

  // ---- D5: auditor versions quoted in gate/CI text ----
  const auditorText = [
    ...commandSources(ctx).map((s) => ({ where: s.where, text: s.text })),
    ...(ctx.rootHook.exists ? [{ where: ctx.rootHook.path, text: ctx.rootHook.text }] : []),
    ...(ctx.managedHook.exists
      ? [{ where: ctx.managedHook.path, text: ctx.managedHook.text }]
      : []),
    ...(wf.exists ? [{ where: wf.path, text: managedText(wf) }] : []),
  ];
  let auditorHits = 0;
  for (const auditor of auditorsOf(manifest)) {
    const pinned = versionOf(ctx, auditor);
    if (!auditor || typeof auditor.tool !== 'string' || !isPinnedVersion(pinned)) continue;
    for (const src of auditorText) {
      const rx = new RegExp(
        `\\b${escapeRx(auditor.tool)}\\b[^\\n]{0,80}?([0-9]+\\.[0-9]+\\.[0-9]+)`,
        'g',
      );
      for (const m of src.text.matchAll(rx)) {
        auditorHits++;
        if (m[1] !== pinned) {
          r.add(
            'D5',
            'FAIL',
            `${src.where}: ${auditor.tool} ${m[1]} but ci.auditors pins ${pinned}`,
            { file: src.where.split(':')[0] },
          );
        }
      }
    }
  }
  if (auditorHits)
    r.add('D5', 'PASS', `${auditorHits} auditor version reference(s) match ci.auditors`);
  else r.add('D5', 'UNKNOWN', 'no auditor version appears in the gate or CI text to reconcile');

  checkLockfileReconciliation(ctx, r, pins, reconciled);
  checkShim(ctx, r, level);
  checkCodeowners(ctx, r);
  checkRunnerVersion(ctx, r);
  if (level >= 5 && manifest?.agentUse === true) checkDelegationArbiters(ctx, r);
}

/**
 * D1 — every manifest pin reconciled against the ecosystem lockfile. A tool that versions
 * outside a lockfile (a global scanner, a docker image) is not silently forgiven: it is INFO
 * only when ANOTHER reconciliation actually covered it (D2 assertion literal, D3 provisioning
 * variable, D4 image digest comment); otherwise it stays UNKNOWN, which --enforce fails.
 */
function checkLockfileReconciliation(ctx, r, pins, reconciled) {
  const { root, manifest } = ctx;
  const lockNode = readJson(join(root, 'package-lock.json'));
  const uvLock = safeRead(join(root, 'uv.lock')).text;
  const stacks = stacksOf(manifest);
  // An unparseable lockfile must be said out loud: otherwise every node pin below would
  // quietly fall through to "no lockfile mapping" and read like a mapping gap.
  if (stacks.includes('node') && !lockNode && existsSync(join(root, 'package-lock.json'))) {
    r.add('D1', 'UNKNOWN', 'package-lock.json exists but is not parseable JSON', {
      file: 'package-lock.json',
      hard: true,
    });
  }
  for (const [tool, version, rec] of pins) {
    // A typed pin IS a reference into its lock (contract §2.5): resolving it is the
    // reconciliation, and a pin that does not resolve is unreconciled by definition.
    if (rec?.form === 'pin') {
      if (rec.error) {
        r.add('D1', 'FAIL', `${tool}: pin does not resolve — ${rec.error.why}`);
      } else {
        r.add('D1', 'PASS', `${tool} ${version}: pinned by ${rec.provenance}`);
      }
      continue;
    }
    if (version === 'n/a') continue;
    let compared = false;
    if (stacks.includes('node') && NODE_PACKAGES[tool] && lockNode) {
      const pkgEntry = lockNode.packages?.[`node_modules/${NODE_PACKAGES[tool]}`];
      if (pkgEntry && typeof pkgEntry.version === 'string') {
        compared = true;
        if (pkgEntry.version !== version) {
          r.add(
            'D1',
            'FAIL',
            `package-lock.json: ${NODE_PACKAGES[tool]} is ${pkgEntry.version}, manifest pins ${tool} ${version}`,
            { file: 'package-lock.json' },
          );
        } else {
          r.add('D1', 'PASS', `package-lock.json: ${tool} ${version}`, {
            file: 'package-lock.json',
          });
        }
      }
    }
    if (!compared && stacks.includes('python') && uvLock) {
      const found = new RegExp(`name = "${escapeRx(tool)}"\\nversion = "([^"]+)"`).exec(uvLock);
      if (found) {
        compared = true;
        if (found[1] !== version) {
          r.add('D1', 'FAIL', `uv.lock: ${tool} is ${found[1]}, manifest pins ${version}`, {
            file: 'uv.lock',
          });
        } else {
          r.add('D1', 'PASS', `uv.lock: ${tool} ${version}`, { file: 'uv.lock' });
        }
      }
    }
    if (compared) continue;
    const elsewhere = reconciled.get(tool);
    if (elsewhere) {
      r.add('D1', 'INFO', `${tool} ${version}: not in a lockfile; reconciled by ${elsewhere}`);
    } else {
      r.add(
        'D1',
        'UNKNOWN',
        `${tool}: the pin ${version} is reconciled NOWHERE — no lockfile entry, no version assertion, no provisioning variable, no image digest comment`,
        { rule: 'D1.unreconciled' },
      );
    }
  }
}

function managedText(wf) {
  return wf.regions.map((region) => region.body).join('\n');
}

/**
 * Every version the manifest names, resolved ONCE (contract §2.5). A literal `version` is taken
 * as written (the profile ≤5 form); a typed `pin` is resolved through harness/lib/pins.mjs —
 * the same resolver every vendored script imports. Every version-reading check reads from
 * here, so no two checks can disagree about a tool's version.
 */
function resolveManifestPins(ctx) {
  const m = ctx.manifest;
  const runtimes = m?.runtimes && typeof m.runtimes === 'object' ? m.runtimes : {};
  const records = [];
  const add = (where, tool, holder) => {
    if (!holder || typeof holder !== 'object') return;
    if (holder.pin !== undefined) {
      const res = resolvePin(ctx.root, holder.pin, { runtimes });
      records.push({
        where,
        tool,
        holder,
        form: 'pin',
        version: res.ok ? res.version : null,
        provenance: res.ok ? res.provenance : null,
        error: res.ok ? null : res,
      });
    } else {
      const version = typeof holder.version === 'string' ? holder.version : null;
      records.push({
        where,
        tool,
        holder,
        form: 'literal',
        version,
        provenance: null,
        error: null,
      });
    }
  };
  for (const [key, entry] of Object.entries(milestoneEntries(m))) {
    if (Array.isArray(entry?.tools)) {
      for (const t of entry.tools) add(`milestones.${key}`, t?.tool, t);
    } else add(`milestones.${key}`, entry?.tool, entry);
  }
  for (const [i, a] of auditorsOf(m).entries()) add(`ci.auditors[${i}]`, a?.tool, a);
  if (m?.hookRunner && typeof m.hookRunner === 'object') {
    add('hookRunner', m.hookRunner.name, m.hookRunner);
  }
  for (const [name, pin] of Object.entries(runtimes)) add(`runtimes.${name}`, name, { pin });
  return records;
}

/** The resolution record for THIS manifest object (by identity, not by tool name). */
function pinRecordOf(ctx, holder) {
  return (ctx.pinRecords ?? []).find((rec) => rec.holder === holder) ?? null;
}

/** A holder's version — the literal, or its resolved pin; null when a pin does not resolve. */
function versionOf(ctx, holder) {
  const rec = pinRecordOf(ctx, holder);
  if (rec) return rec.version;
  return typeof holder?.version === 'string' ? holder.version : null;
}

/** `[tool, version, record]` for every tool pin (runtimes excluded), resolved. */
function manifestPins(ctx) {
  return (ctx.pinRecords ?? [])
    .filter((rec) => !rec.where.startsWith('runtimes.') && rec.tool)
    .map((rec) => [rec.tool, rec.version, rec]);
}

/** Numeric comparison of dotted versions (pre-release suffixes ignored). */
function lookupPin(pins, tool) {
  const target = norm(tool);
  for (const [name, version] of pins) if (norm(name) === target) return version;
  return undefined;
}

function readJson(path) {
  const read = safeRead(path);
  if (read.text === null) return null;
  try {
    return JSON.parse(read.text);
  } catch {
    return null;
  }
}

function checkShim(ctx, r, level) {
  if (ctx.opts.noGit) {
    r.add('D6', 'UNKNOWN', '--no-git: hook installation is not inspected');
    return;
  }
  if (!isGitToplevel(ctx.root)) {
    r.add(
      'D6',
      'UNKNOWN',
      `${ctx.root} is not a git toplevel — hook installation is local machine state`,
    );
    return;
  }
  const hooksPath = runCommand('git', ['config', '--get', 'core.hooksPath'], ctx.root);
  const dir = !hooksPath.error && hooksPath.stdout.trim() ? hooksPath.stdout.trim() : '.git/hooks';
  const shim = safeRead(join(ctx.root, dir, 'pre-commit'));
  if (shim.text === null) {
    r.add(
      'D6',
      'UNKNOWN',
      `${dir}/pre-commit: hooks are not installed in this working copy (local state, never a failure)`,
    );
    return;
  }
  if (!/lefthook/i.test(shim.text)) {
    r.add('D6', 'FAIL', `${dir}/pre-commit: the installed shim does not mention lefthook`, {
      file: `${dir}/pre-commit`,
    });
    return;
  }
  r.add('D6', 'PASS', `${dir}/pre-commit: lefthook shim installed`, { file: `${dir}/pre-commit` });
  if (level >= 4) {
    // The value the RUNNER is configured with (the merged dump), not the one a file happens to
    // carry: a setting the runner does not merge never reaches `install`, so comparing the shim
    // against it would report a mismatch the harness cannot fix — or hide one it has.
    const pinned = ctx.mergedRunnerPin;
    if (typeof pinned === 'string' && pinned && !shim.text.includes(pinned)) {
      r.add(
        'D6',
        'FAIL',
        `${dir}/pre-commit: the shim does not contain the pinned runner path \`${pinned}\` — it resolves the runner from PATH; re-run \`lefthook install\``,
        { file: `${dir}/pre-commit` },
      );
    }
  }
}

/**
 * The body of the PROJECT script an agent-settings hook command runs — `bash scripts/x.sh`,
 * `sh ./x.sh`, `bash "$CLAUDE_PROJECT_DIR/x.sh"`, or the script path alone — or '' when the
 * command does not name a readable script inside the root. Evidence for "does this hook run
 * tool T", never an execution.
 */
function hookScriptText(ctx, command) {
  const m = String(command ?? '')
    .trim()
    .match(
      /^(?:(?:ba|z)?sh\s+)?"?(?:\$\{?CLAUDE_PROJECT_DIR\}?\/)?(?:\.\/)?([\w./-]+\.(?:sh|bash))"?(?:\s|$)/,
    );
  if (!m) return '';
  const target = resolve(ctx.root, m[1]);
  if (!isInside(ctx.root, target)) return '';
  return safeRead(target).text ?? '';
}

// ---------------------------------------------------------------------------------------
// A17 — the vendored support-script bundle (contract §1, profile 6, PLAN.md AD2)
// ---------------------------------------------------------------------------------------

const BUNDLE_DIR = dirname(fileURLToPath(import.meta.url));

/** The bundle catalog THIS checker ships, and the harness version it carries. */
function bundleCatalog() {
  const catalog = readJson(join(BUNDLE_DIR, 'harness-catalog.json')) ?? {};
  const current = safeRead(join(BUNDLE_DIR, 'harness', 'VERSION')).text?.trim() ?? null;
  return { catalog, current };
}

/**
 * A consumer's `.claudeconf/bin/` is judged against the catalog the CHECKER ships for the
 * declared version — never against hashes the consumer could edit next to the files. The file
 * set must be EXACT: a missing, extra, edited or symlinked entry fails, and so does a managed
 * directory whose declaration was removed (that would be the cheapest way to escape the check).
 */
function checkVendoredBundle(ctx, r, level) {
  const binRel = '.claudeconf/bin';
  const bin = join(ctx.root, binRel);
  const file = ctx.manifestPath;
  const declared = ctx.manifest?.harnessScripts;
  const hasBin = existsSync(bin);
  if (!hasBin && declared === undefined) {
    if (level >= SINCE.A17) {
      r.add(
        'A17',
        'FAIL',
        `${binRel}: missing — profile 6 vendors the support scripts from the bundle and records \`harnessScripts\` (contract §1)`,
        { file: binRel },
      );
    }
    return;
  }
  if (declared === undefined) {
    r.add(
      'A17',
      'FAIL',
      `${binRel} exists but ${file} records no \`harnessScripts\` — a managed path cannot drop its declaration to escape its integrity check`,
      { file },
    );
    return;
  }
  const version = declared?.version;
  const { catalog, current } = bundleCatalog();
  if (typeof version !== 'string' || !catalog[version]) {
    r.add(
      'A17',
      'FAIL',
      `${file}: harnessScripts.version ${JSON.stringify(version)} is not a released bundle version (${Object.keys(catalog).join(', ') || 'catalog unreadable'})`,
      { file },
    );
    return;
  }
  if (!hasBin) {
    r.add('A17', 'FAIL', `${binRel}: missing, though ${file} declares bundle ${version}`, {
      file: binRel,
    });
    return;
  }
  if (lstatSync(bin).isSymbolicLink()) {
    r.add('A17', 'FAIL', `${binRel} is a symlink — the vendored bundle must be real files`, {
      file: binRel,
    });
    return;
  }
  const tree = hashTree(bin);
  const { missing, extra, edited } = compareToEntry(tree.files, catalog[version]);
  const problems = [
    ...tree.problems.map((p) => `${binRel}/${p}`),
    ...missing.map((f) => `${binRel}/${f}: missing (bundle ${version} ships it)`),
    ...extra.map((f) => `${binRel}/${f}: not part of bundle ${version}`),
    ...edited.map((f) => `${binRel}/${f}: edited after vendoring (differs from bundle ${version})`),
  ];
  for (const p of problems) r.add('A17', 'FAIL', p, { file: binRel });
  if (!problems.length) {
    r.add(
      'A17',
      'PASS',
      `${binRel}: ${Object.keys(tree.files).length} files identical to bundle ${version}`,
      { file: binRel },
    );
  }
  if (current && version !== current) {
    r.add(
      'A17',
      'INFO',
      `${binRel}: bundle ${version} is behind this checker's ${current} — re-vendor it (refresh)`,
      { file: binRel },
    );
  }
  if (level >= SINCE['A17.callers']) checkBundleCallers(ctx, r, catalog[version]);
}

/**
 * Profile 6: the harness must EXECUTE the copy A17 verified. A pristine `.claudeconf/bin/`
 * proves nothing while the gate calls a mutable script of the same name elsewhere, or while
 * the gate's secret scan bypasses `scan-tree.mjs` and reads the working directory again — W10,
 * W11 and D2 find their callers by NAME, so this is where the PATH is held to the vendored one.
 * Every invocation of a bundle script, under any extension or directory, must be exactly
 * `.claudeconf/bin/<script>.mjs`: a nested `.claudeconf/bin/` elsewhere is a copy A17 never
 * reads.
 */
function checkBundleCallers(ctx, r, entry) {
  const binRel = '.claudeconf/bin';
  const stems = Object.keys(entry)
    .filter((f) => !f.includes('/') && f.endsWith('.mjs'))
    .map((f) => f.slice(0, -'.mjs'.length));
  // A path token starts where a shell word can (start, whitespace, a quote, an operator, a
  // substitution) and ends where no path character follows — so `…mjs>/dev/null` and
  // `$(node …)` are read, and `mycheck-suppressions.mjs` is not mistaken for the bundle's. A
  // path straight after a redirection (`> out/check-suppressions.mjs`) is a file being written
  // or read, not a program being run, so it is not an invocation.
  const word = '\\s\'"=;&|()`';
  const invokes = new RegExp(
    `(?<![^${word}])(?<![<>]\\s*)((?:[^${word}<>]*/)?(${stems.map(escapeRx).join('|')})\\.(?:mjs|cjs|js|ts|sh|bash|py))(?![\\w.-])`,
    'gm',
  );
  let callers = 0;
  let wrong = 0;
  for (const src of commandSources(ctx)) {
    for (const m of executableText(src.text).matchAll(invokes)) {
      callers++;
      if (m[1].replace(/^\.\//, '') === `${binRel}/${m[2]}.mjs`) continue;
      wrong++;
      r.add(
        'A17',
        'FAIL',
        `${src.where}: runs ${m[1]} — profile 6 runs the vendored ${binRel}/${m[2]}.mjs, the copy A17 verifies, and no other`,
        { file: src.file, line: src.line, rule: 'A17.callers' },
      );
    }
  }
  const dump = ctx.dump?.dump;
  if (!dump) {
    r.add(
      'A17',
      'UNKNOWN',
      `merged hook config unavailable — cannot establish that the gate's secret scan runs through ${binRel}/scan-tree.mjs`,
      { rule: 'A17.callers' },
    );
    return;
  }
  const scans = mergedJobs(dump).filter(
    (j) => j.hook === 'gate' && jobMatchesToken(j.name, 'secret-scan'),
  );
  const throughTree = new RegExp(
    `(?:^|[\\s'"])(?:\\./)?${escapeRx(binRel)}/scan-tree\\.mjs(?:\\s+--root\\s+\\S+)?\\s+--\\s`,
  );
  for (const job of scans) {
    if (throughTree.test(executableText(jobText(job.def)))) continue;
    wrong++;
    r.add(
      'A17',
      'FAIL',
      `gate.${job.name}: the whole-tree secret scan does not run through ${binRel}/scan-tree.mjs — it reads the working directory, whose ignored and untracked files CI never sees (contract §2.5)`,
      { rule: 'A17.callers' },
    );
  }
  if (!wrong) {
    r.add(
      'A17',
      'PASS',
      `${callers} hook/CI invocation(s) of the bundle run ${binRel}; the gate's secret scan (${scans.length} job(s)) runs through scan-tree.mjs`,
    );
  }
}

// ---------------------------------------------------------------------------------------
// W21 — a required check cannot be skipped on a bot or fork pull request (profile 6, AD9)
// ---------------------------------------------------------------------------------------

/**
 * The body of every `${{ … }}` in `text`, read to its REAL end: a `}}` inside a single-quoted
 * string (`format('{{0}}', …)`, with `''` as the escaped quote) does not close the expression.
 * An unterminated expression runs to the end of the text rather than being dropped.
 */
function githubExpressions(text) {
  const s = String(text);
  const out = [];
  let at = s.indexOf('${{');
  while (at !== -1) {
    let i = at + 3;
    let quoted = false;
    for (; i < s.length; i++) {
      if (s[i] === "'") {
        if (quoted && s[i + 1] === "'") i++;
        else quoted = !quoted;
      } else if (!quoted && s[i] === '}' && s[i + 1] === '}') break;
    }
    out.push(s.slice(at + 3, i));
    at = s.indexOf('${{', i + 2);
  }
  return out;
}

/**
 * Every use of the `secrets` context in the GitHub expressions of `text`, other than the token
 * GitHub gives every run (bots and forks included): `secrets.NAME`, `secrets['NAME']`, and any
 * other use — `toJSON(secrets)`, a computed index — which hands over secrets no bot or fork run
 * receives. Contexts and property names are case-insensitive, so the exemption is too.
 */
function secretRefs(text) {
  const refs = [];
  for (const raw of githubExpressions(text)) {
    // A string literal is data, not a context access — except the name inside `secrets['…']`.
    const expr = raw.replace(/'(?:[^']|'')*'/g, (lit, at) =>
      /secrets\s*\[\s*$/i.test(raw.slice(0, at)) ? lit : "''",
    );
    const uses = expr.matchAll(
      /(?<![.\w-])secrets\b(?:\s*\.\s*([A-Za-z_][\w-]*)|\s*\[\s*\\?['"]([^'"\\]+)\\?['"]\s*\])?/gi,
    );
    for (const m of uses) {
      const name = m[1] ?? m[2];
      if (name?.toUpperCase() === 'GITHUB_TOKEN') continue;
      refs.push(name ? `secrets.${name}` : `the whole secrets context (\`${expr.trim()}\`)`);
    }
  }
  return uniq(refs);
}

/**
 * A required CI step — one answering a milestone or a declared project check — and its job must
 * run on EVERY pull request. Dependabot and fork runs get no repository secrets, and a step
 * conditioned on the actor or on a secret is simply skipped there, which GitHub reports as a
 * green check: the check is "present" and nothing ran. Actor identity is also spoofable, so it
 * may select ancillary behaviour but never whether a required check runs.
 */
function checkBotSafeRequiredSteps(ctx, r, level) {
  const wf = ctx.workflow;
  if (!wf.exists || !wf.doc) return; // W2/W7 report the workflow itself
  const targets = [];
  for (const milestone of MILESTONES) {
    const entry = milestoneEntries(ctx.manifest)[milestone];
    if (!entry || !tiersOf(entry).includes('ci')) continue;
    // BLOCKED steps included: a step reachability cannot show to run is exactly the step a
    // condition can skip — W2 says it may not run, W21 says why that is not acceptable.
    const found = findCiSteps(ctx, milestone, level);
    for (const step of [...(found.steps ?? []), ...(found.blocked ?? []).map((b) => b.step)]) {
      targets.push({ label: `the ${milestone} step`, step });
    }
  }
  for (const pc of projectChecksOf(ctx.manifest) ?? []) {
    if (!Array.isArray(pc?.tiers) || !pc.tiers.includes('ci')) continue;
    const job = wf.jobs.find((j) => j.id === pc.name);
    const named = wf.jobs.flatMap((j) => j.steps).find((st) => st.name === pc.name);
    const step = named ?? (job ? job.steps.find((st) => stepCommand(st)) : null);
    if (step) targets.push({ label: `project check ${pc.name}`, step });
  }
  let findings = 0;
  const seen = new Set();
  for (const { label, step } of targets) {
    const raw = step.job?.def?.steps?.[step.index] ?? {};
    for (const [scope, cond] of [
      ['step', step.if],
      ['job', step.job?.def?.if],
    ]) {
      if (cond === undefined || cond === null) continue;
      const text = String(cond)
        .replace(/^\$\{\{\s*|\s*\}\}$/g, '')
        .trim();
      if (/^(always|success)\(\)$/.test(text)) continue;
      const key = `${scope}:${scope === 'job' ? step.job.id : step.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings++;
      r.add(
        'W21',
        'FAIL',
        `${wf.path}:${scope === 'job' ? step.job.line : step.line}: ${label} runs under its ${scope}'s \`if: ${cond}\` — a condition can skip a required check, and a skipped check reports green (bot and fork PRs)`,
        { file: wf.path, line: step.line },
      );
    }
    const text = [step.run, raw.with, raw.env, step.job?.def?.env]
      .map((v) => (typeof v === 'string' ? v : JSON.stringify(v ?? '')))
      .join('\n');
    const refs = secretRefs(text);
    if (refs.length) {
      findings++;
      r.add(
        'W21',
        'FAIL',
        `${wf.path}:${step.line}: ${label} needs ${refs.join(', ')} — Dependabot and fork runs get no repository secrets, so it cannot pass there; move the work that needs it into an ancillary step`,
        { file: wf.path, line: step.line },
      );
    }
  }
  if (!findings && targets.length) {
    r.add(
      'W21',
      'PASS',
      `${wf.path}: ${targets.length} required CI step(s) run unconditionally and without repository secrets`,
      { file: wf.path },
    );
  }
}

function checkCodeowners(ctx, r) {
  const file = '.github/CODEOWNERS';
  const read = safeRead(join(ctx.root, file));
  if (read.text === null) {
    r.add('D7', 'FAIL', `${file}: missing`, { file });
    return;
  }
  const rules = parseCodeowners(read.text);
  const controlPlane = controlPlanePaths(ctx);
  let owned = 0;
  for (const path of controlPlane) {
    const owners = ownersFor(path, rules);
    const effective = effectiveRule(path, rules);
    if (!owners.length) {
      r.add('D7', 'FAIL', `${file}: ${path} has no code owner`, { file });
    } else if (!effective || isCatchAllPattern(effective.pattern)) {
      r.add(
        'D7',
        'FAIL',
        `${file}: ${path} is only covered by the catch-all \`${effective ? effective.pattern : '*'}\` — a control-plane path needs its own ownership entry`,
        { file, rule: 'D7.catchAll' },
      );
    } else {
      owned++;
    }
  }
  if (owned === controlPlane.length) {
    r.add('D7', 'PASS', `${file}: all ${owned} control-plane path(s) have an explicit owner`, {
      file,
    });
  }
}

function effectiveRule(path, rules) {
  let found = null;
  for (const rule of rules) if (codeownersMatch(rule.pattern, path)) found = rule;
  return found;
}

function controlPlanePaths(ctx) {
  const paths = new Set([
    '.github/CODEOWNERS',
    '.claudeconf/manifest.json',
    '.claude/settings.json',
  ]);
  if (ctx.workflow.exists) paths.add(ctx.workflow.path);
  if (ctx.rootHook.exists) paths.add(ctx.rootHook.path);
  if (ctx.managedHook.exists) paths.add(ctx.managedHook.path);
  for (const p of [
    '.github/dependabot.yml',
    'renovate.json',
    'package.json',
    'pyproject.toml',
    '.npmrc',
  ]) {
    if (existsSync(join(ctx.root, p))) paths.add(p);
  }
  for (const stack of stacksOf(ctx.manifest)) {
    for (const lock of LOCKFILES[stack] ?? [])
      if (existsSync(join(ctx.root, lock))) paths.add(lock);
  }
  for (const entry of Object.values(milestoneEntries(ctx.manifest))) {
    for (const tool of toolsOf(entry)) {
      for (const cfg of TOOL_CONFIGS[tool] ?? []) {
        if (cfg.endsWith('/')) continue;
        if (existsSync(join(ctx.root, cfg))) paths.add(cfg);
      }
    }
  }
  for (const stem of [
    'assert-tool-versions',
    'check-suppressions',
    'check-project-checks',
    'provision-tools',
  ]) {
    const found = findScript(ctx.root, stem);
    if (found) paths.add(found);
  }
  return [...paths].sort();
}

function checkRunnerVersion(ctx, r) {
  const runner = ctx.runner;
  const pin = versionOf(ctx, ctx.manifest?.hookRunner);
  // D8 is CRITICAL, so judgment never demotes it: its newer rule is gated HERE (PLAN.md AD6).
  // A runner version to assert against exists only from the profile that introduced
  // `hookRunner` — below it, "manifest pins undefined" was a rule the harness never claimed.
  if (ctx.level < SINCE.D8) {
    r.add(
      'D8',
      'INFO',
      `not applicable: a recorded hook-runner version (\`hookRunner\`) is required from profile ${SINCE.D8}; this harness is judged at ${ctx.level}`,
    );
    return;
  }
  if (typeof pin !== 'string' || !pin) {
    r.add(
      'D8',
      'UNKNOWN',
      `${ctx.manifestPath}: no resolvable \`hookRunner\` version, so there is no pin to assert the runner against (see M8)`,
    );
    return;
  }
  if (!runner) {
    r.add(
      'D8',
      'UNKNOWN',
      'no hook runner resolved (flag / $LEFTHOOK_BIN / config path / PATH / node_modules)',
    );
    return;
  }
  // The `--lefthook` FLAG is a checker-side override, not part of the shim's resolution
  // order. When it points OUTSIDE the target root (checking a fixture with this repo's
  // binary) it names an unrelated executable, and asserting the pin against it would be
  // theatre. Every other source — $LEFTHOOK_BIN, the configured `lefthook:` path, PATH,
  // the project's node_modules — IS what the shim resolves, so it is asserted, and the
  // evidence names the source so "matched, but only because PATH happened to agree" shows.
  if (runner.source === 'flag' && !isInside(ctx.root, runner.path)) {
    r.add(
      'D8',
      'UNKNOWN',
      `runner ${runner.path} came from --lefthook and is not inside the target root ${ctx.root} — it is an unrelated binary, so the manifest pin ${pin} cannot be asserted against it (install the project's own runner to verify)`,
    );
    return;
  }
  const out = runCommand(runner.path, ['version'], ctx.root);
  const version = (out.stdout.match(/\d+\.\d+\.\d+/) ?? [])[0];
  if (!version) {
    r.add(
      'D8',
      'UNKNOWN',
      `runner ${runner.path} (source: ${runner.source}): unparsable version output`,
    );
    return;
  }
  if (version !== pin) {
    // Name the CAUSE when the shim fell through to PATH: that is the field failure (a global
    // runner silently running every hook), and its fix is a pinned path, not a version bump.
    let cause = '';
    if (runner.source === 'PATH') {
      cause = ctx.mergedRunnerPin
        ? ` — the pinned runner path ${ctx.mergedRunnerPin} does not resolve, so the installed shim falls through to PATH; install the pinned runner`
        : ' — the hook configuration pins no runner path (`lefthook:` in the ROOT config), so the installed shim runs whatever `lefthook` is first on PATH; fix: pin the runner path (contract §3.2) and re-run `lefthook install`';
    }
    r.add(
      'D8',
      'FAIL',
      `runner ${runner.path} (source: ${runner.source}) is ${version}, manifest pins ${pin}${cause}`,
    );
  } else {
    r.add(
      'D8',
      'PASS',
      `runner ${runner.path} (source: ${runner.source}) is ${version}, matching the manifest`,
    );
  }
}

// ---------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------

class UsageError extends Error {}

const USAGE = `Usage: claudeconf-check.mjs [--root <dir>] [--format text|json] [--lefthook <bin>]
                            [--profile <n>] [--no-git] [--enforce|--advisory]`;

function parseArgs(argv) {
  const opts = {
    root: '.',
    format: 'text',
    lefthook: null,
    profile: null,
    noGit: false,
    mode: 'enforce',
  };
  const needsValue = new Set(['--root', '--format', '--lefthook', '--profile']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (needsValue.has(arg) && (i + 1 >= argv.length || String(argv[i + 1]).startsWith('--'))) {
      throw new UsageError(`${arg} needs a value`);
    }
    switch (arg) {
      case '--root':
        opts.root = argv[++i];
        break;
      case '--format':
        opts.format = argv[++i];
        break;
      case '--lefthook':
        opts.lefthook = argv[++i];
        break;
      case '--profile':
        opts.profile = argv[++i];
        break;
      case '--no-git':
        opts.noGit = true;
        break;
      case '--enforce':
        opts.mode = 'enforce';
        break;
      case '--advisory':
        opts.mode = 'advisory';
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      default:
        throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  if (!['text', 'json'].includes(opts.format))
    throw new UsageError('--format must be text or json');
  if (opts.profile !== null && !KNOWN_PROFILES.includes(String(opts.profile))) {
    throw new UsageError(`--profile must be one of ${KNOWN_PROFILES.join(', ')}`);
  }
  return opts;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`${e.message}\n${USAGE}\n`);
      return 2;
    }
    throw e;
  }
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (!existsSync(opts.root)) {
    process.stderr.write(`--root ${opts.root} does not exist\n${USAGE}\n`);
    return 2;
  }

  const ctx = loadContext(opts);
  const report = new Report(opts.mode);

  const recordedRaw = ctx.manifest?.constitutionVersion;
  const recorded = typeof recordedRaw === 'string' ? recordedRaw : null;
  const recordedLevel =
    recorded && KNOWN_PROFILES.includes(recorded) ? Number(recorded) : CURRENT_PROFILE;
  // The JUDGMENT profile (PLAN.md AD6): fail closed on a record that is missing, unparseable,
  // from the future, or not backed by complete git history; never lower than what history or
  // an explicit --profile target says. Profile 1 runs every check and judges none of them.
  const judgment = judgmentProfile({
    recorded,
    target: opts.profile ? Number(opts.profile) : null,
    history: manifestHistory(ctx.root, opts.noGit),
  });
  ctx.judgment = judgment;
  report.judgment = judgment;
  const level = judgment.unsupported ? CURRENT_PROFILE : judgment.profile;
  ctx.level = level;
  ctx.pinRecords = resolveManifestPins(ctx);

  ctx.workflow = buildWorkflow(ctx, ctx.manifest?.ci?.workflow ?? '.github/workflows/ci.yml');
  ctx.rootHook = loadYamlArtifact(
    ctx.root,
    existsSync(join(ctx.root, 'lefthook.yaml')) ? 'lefthook.yaml' : 'lefthook.yml',
  );
  ctx.managedHook = loadYamlArtifact(ctx.root, '.claudeconf/lefthook.yml');
  ctx.localOverridePath =
    ['lefthook-local.yml', 'lefthook-local.yaml'].find((p) => existsSync(join(ctx.root, p))) ??
    null;
  ctx.localOverride = ctx.localOverridePath
    ? loadYamlArtifact(ctx.root, ctx.localOverridePath)
    : null;
  ctx.hasLocalOverride = !!ctx.localOverridePath;
  ctx.settings = loadSettings(ctx.root);
  // BOOTSTRAP only: any runner can compute the merge, and a declared path is a hint for FINDING
  // one — never evidence that the runner reads it. The verdicts below resolve against the
  // runner's own merged answer instead (contract §3.2: pinning is verified by RESOLUTION).
  ctx.runner = resolveRunner(ctx.root, declaredRunnerLayer(ctx)?.doc ?? null, opts.lefthook);
  ctx.dump = dumpDetail(ctx.root, ctx.runner ? ctx.runner.path : null);
  ctx.defaultBranch = resolveDefaultBranch(ctx.root, opts.noGit);
  ctx.managedJobNames = collectManagedJobNames(ctx, level);
  ctx.secretScanExcludes = collectSecretScanExcludes(ctx);

  // The merged dump is only evidence when the WHOLE closure was resolvable. An `extends`
  // target that could not be read, or a `remotes:` entry whose content is not in this
  // repository at all, means the wiring checks would be reading a PARTIAL configuration —
  // they report UNKNOWN naming what was unresolved rather than passing on it.
  const partial = [...ctx.dump.unresolved];
  for (const layer of [ctx.rootHook, ctx.managedHook, ctx.localOverride]) {
    if (layer?.exists && layer.doc?.remotes) partial.push(`remotes declared in ${layer.path}`);
  }
  for (const target of rawProjectLayers(ctx).unresolved) partial.push(`extends: ${target}`);
  if (partial.length && ctx.dump.dump) {
    ctx.dump = {
      ...ctx.dump,
      dump: null,
      error: `configuration is only partially resolvable — ${uniq(partial).join('; ')}`,
    };
  }

  // The runner's OWN answer to "what runner path am I configured with". Verified by execution
  // (lefthook 2.1.9): `assert_lefthook_installed` and `min_version` merge across `extends`,
  // `lefthook:` does NOT — so a value present in an extended file is absent here, and a harness
  // that pins only there runs every hook through whatever `PATH` supplies. When the merge
  // cannot be computed at all, the DECLARED value is used to keep resolution working, and the
  // checks that assert the pin report UNKNOWN rather than passing on a file read.
  const mergedLefthook = ctx.dump.dump?.lefthook;
  ctx.mergedRunnerPin =
    typeof mergedLefthook === 'string' && mergedLefthook ? mergedLefthook : null;
  ctx.mergedRunnerKnown = !!ctx.dump.dump;
  const resolutionPin = ctx.mergedRunnerKnown
    ? ctx.mergedRunnerPin
    : (declaredRunnerLayer(ctx)?.doc?.lefthook ?? null);
  ctx.runner = resolveRunner(ctx.root, { lefthook: resolutionPin }, opts.lefthook);
  // What the installed SHIM resolves: the same order without the checker-side `--lefthook`
  // override, which the shim does not have.
  ctx.shimRunner = resolveRunner(ctx.root, { lefthook: resolutionPin }, null);

  // A malformed managed region is a failure signal in its own right.
  for (const artifact of [ctx.workflow, ctx.rootHook, ctx.managedHook]) {
    for (const err of artifact.regionErrors ?? []) {
      report.add('A1', 'UNKNOWN', `${artifact.path}: ${err}`, { file: artifact.path, hard: true });
    }
  }

  const crashed = [];
  const track = (label, fn) => {
    report.group = label;
    if (!runGuarded(label, fn)) crashed.push(label);
    report.group = null;
  };
  track('M*', () => checkManifest(ctx, report, level));
  track('A*', () => {
    checkArtifacts(ctx, report, level);
    checkVendoredBundle(ctx, report, level);
  });
  if (level >= 4) track('A14/A15', () => checkOwnershipSplit(ctx, report));
  track('W*', () => {
    checkWiring(ctx, report, level);
    checkBotSafeRequiredSteps(ctx, report, level);
  });
  track('D*', () => checkDrift(ctx, report, level));

  // A crashed group must FAIL its checks, never silently REMOVE them: under --enforce a thrown
  // error would otherwise drop ids from the report and shrink the arbiter's surface. Ids the
  // group had already answered are ALSO marked unverified — a group that died halfway cannot
  // vouch for the verdicts it happened to record first — while an id that already FAILED keeps
  // its finding, since that is the stronger statement.
  for (const label of crashed) {
    const owed = GROUP_IDS[label] ?? [];
    if (!owed.length) {
      report.add('M1', 'UNKNOWN', `internal error in an unmapped check group (${label})`, {
        hard: true,
        integrity: true,
      });
      continue;
    }
    for (const [id, minLevel] of owed) {
      if (level < minLevel) continue;
      const found = report.findings.get(id) ?? [];
      if (found.some((f) => f.status === 'FAIL')) continue;
      report.add(id, 'UNKNOWN', `check did not complete: internal error in the ${label} group`, {
        hard: true,
        integrity: true,
      });
    }
  }

  // Reported against an id that IS printable and DOES belong to the offending group: filing
  // the complaint under the misfiled id would put it exactly where the report cannot show it.
  for (const { id, group, why } of report.misfiledIds()) {
    const carrier = (GROUP_IDS[group] ?? [])[0]?.[0];
    if (!carrier) continue;
    report.add(
      carrier,
      'UNKNOWN',
      `internal: ${id} is emitted by the ${group} group but is ${why}, so a crash in that group would delete it from the report`,
      { hard: true, integrity: true },
    );
  }

  if (recorded && recordedLevel < CURRENT_PROFILE) {
    report.add(
      'P1',
      'INFO',
      `upgrade available: ${recorded} → ${CURRENT_PROFILE} (references/migrations.md)`,
      { file: ctx.manifestPath },
    );
  }

  const results = report.results();
  if (opts.format === 'json') {
    process.stdout.write(
      `${JSON.stringify({ profile: recorded ?? 'unknown', judgedAt: judgment.profile, results }, null, 2)}\n`,
    );
  } else {
    for (const res of results) process.stdout.write(`${res.status} ${res.id} — ${res.evidence}\n`);
  }
  if (opts.mode === 'advisory') return 0;
  return results.some((res) => res.status === 'FAIL') ? 1 : 0;
}

/**
 * Runs one check group; an unexpected error becomes evidence, never a lost report. Returns
 * false when the group threw, so the caller backfills the ids THAT GROUP owes.
 *
 * The failure is deliberately NOT recorded here: it used to be attributed to M1 whichever
 * group threw, so a crash in the artifact, wiring or drift group rewrote a legitimately
 * passing manifest verdict into UNKNOWN — the arbiter mislabelling its own evidence. The
 * caller's backfill records it against every id the crashed group owed, and against nothing
 * else.
 */
function runGuarded(label, fn) {
  try {
    fn();
    return true;
  } catch (e) {
    process.stderr.write(`claudeconf-check: internal error in ${label}: ${e.stack}\n`);
    return false;
  }
}

function loadSettings(root) {
  const read = safeRead(join(root, '.claude/settings.json'));
  if (read.text === null) return { json: null, error: 'missing' };
  try {
    return { json: JSON.parse(read.text), error: null };
  } catch (e) {
    return { json: null, error: `invalid JSON: ${e.message.split('\n')[0]}` };
  }
}

/** The names the harness OWNS: everything declared in the managed hook config. */
function collectManagedJobNames(ctx, level) {
  const names = [];
  const source = level >= 4 && ctx.managedHook.exists ? ctx.managedHook : null;
  if (!source?.doc || typeof source.doc !== 'object') return names;
  for (const [hook, node] of Object.entries(source.doc)) {
    if (!isHookNode(hook, node)) continue;
    for (const job of jobsOfHook(node)) {
      if (job && typeof job.name === 'string') names.push(job.name);
    }
  }
  return uniq(names);
}

/**
 * Exclude FILES named by a secret-scan command, wherever that command lives. Secret scanners
 * name a file (`--exclude-paths`, `--exclude-file`); a bare `--exclude` is a PATTERN in every
 * tool that has one — `semgrep --exclude .claudeconf/bin` — and reading it as a file failed a
 * sast command for not covering .git (field: olymp, 0.6.3).
 */
function collectSecretScanExcludes(ctx) {
  const out = [];
  for (const src of commandSources(ctx)) {
    for (const m of executableText(src.text).matchAll(/--exclude-(?:paths|file)[=\s]+(\S+)/g)) {
      out.push({ path: m[1], where: src.where });
    }
  }
  return out;
}

/**
 * Is this file being EXECUTED (rather than imported for its helpers)? Compared through
 * `realpathSync`, because `import.meta.url` is always the real path while `process.argv[1]`
 * keeps the symlinks the caller typed. Comparing them unresolved made the whole checker a
 * silent no-op — exit 0, no output, no verdicts — whenever the plugin lived under a symlinked
 * directory, which is the worst failure an arbiter can have.
 */
const realPath = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const isDirectRun =
  !!process.argv[1] && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url));

if (isDirectRun) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`claudeconf-check: ${e.stack}\n`);
    process.exitCode = 2;
  }
}
