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
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as yamlLoad } from './vendor/js-yaml.mjs';

// ---------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------

const KNOWN_PROFILES = ['2', '3', '4', '5'];
const CURRENT_PROFILE = 5;

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

/** Tools whose version comes from the runtime, so `"n/a"` is a legitimate pin (contract §2.3). */
const RUNTIME_VERSIONED = [
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

function safeRead(path) {
  try {
    return { text: readFileSync(path, 'utf8'), error: null };
  } catch (e) {
    return { text: null, error: e.message };
  }
}

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
  try {
    return resolve(out.stdout.trim()) === resolve(root);
  } catch {
    return false;
  }
}

/** Normalises a name for tolerant comparison: lowercase, alphanumerics only. */
function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Strips a trailing ` # comment` that is not inside quotes. */
function stripComment(cmd) {
  const s = String(cmd ?? '');
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i).trimEnd();
    }
  }
  return s;
}

/**
 * A command's EXECUTABLE text: every line stripped of its shell comment.
 *
 * This is the ONE way command text is prepared for matching anywhere in this file. Matching a
 * raw `run:` block lets a comment answer for the command — `# runs tsc under the hood` beside
 * `true` reads as a typecheck — and that is a class of bug, not a site: every tool-token
 * search, every fetch/install/package-runner scan, and the command analyser all route here.
 * The single deliberate exception is D5, which reconciles VERSION CLAIMS and therefore MUST
 * read comments (a stale `# 1.27.0` beside a digest is exactly the drift it exists to catch).
 */
function executableText(command) {
  return String(command ?? '')
    .split('\n')
    .map(stripComment)
    .join('\n');
}

/** Splits a shell command into whitespace-delimited tokens, honouring simple quoting. */
function tokenize(cmd) {
  const tokens = [];
  let current = '';
  let quote = null;
  for (const c of String(cmd ?? '')) {
    if (quote) {
      if (c === quote) quote = null;
      else current += c;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (/\s/.test(c)) {
      if (current) tokens.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

/** The command's leading segment, with any `&&`/`||`/`;` continuation removed. */
function primarySegment(cmd) {
  const line =
    executableText(cmd)
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? '';
  const segments = line.split(/\s*(?:&&|\|\||;)\s*/).filter((seg) => seg.trim());
  return segments[0] ?? '';
}

function firstLine(s) {
  return String(s ?? '').split('\n')[0];
}

function uniq(list) {
  return [...new Set(list)];
}

function isInside(root, path) {
  const r = resolve(path);
  const base = resolve(root);
  return r === base || r.startsWith(base + sep);
}

function escapeRx(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    this.findings.get(id).push({
      status: known ? status : 'UNKNOWN',
      evidence: known
        ? evidence
        : `internal: ${id} was reported with \`${status}\`, which is not one of ${Object.keys(SEVERITY).join('/')} — ${evidence}`,
      file: opts.file,
      line: opts.line,
      hard: known ? !!opts.hard : true,
      acknowledged: !!opts.acknowledged,
    });
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
      let evidence = items
        .filter((i) => SEVERITY[i.status] === SEVERITY[worst.status] || items.length <= 4)
        .map((i) => i.evidence)
        .join(' | ');
      if (
        status === 'UNKNOWN' &&
        this.mode === 'enforce' &&
        (CRITICAL.has(id) || items.some((i) => i.status === 'UNKNOWN' && i.hard))
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

// ---------------------------------------------------------------------------------------
// Command analysis — which TOOL does a command invoke, and does it do work?
// ---------------------------------------------------------------------------------------

const SCRIPT_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
/**
 * Runners whose first argument NAMES A TASK rather than a target (contract §3.3). `npm test`,
 * `make lint` and `cargo test` all carry their operation in the task definition, so they are not
 * bare invocations — three of the four shipped fixtures failed their own arbiter's default run
 * because this rule read them as "no operational argument".
 */
const TASK_RUNNERS = new Set([
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'make',
  'cargo',
  'go',
  'mix',
  'rake',
  'just',
  'task',
  'gradle',
  'mvn',
  'dotnet',
  'poetry',
  'uv',
  'tox',
  'nox',
  'hatch',
  'pdm',
  'composer',
  'swift',
]);
/**
 * Wrappers that run another command and report ITS status. `xargs <tool>` is the shape that
 * matters: the reader saw `xargs` as the tool, lost the identity, and then classified the whole
 * pipeline by its head (`echo`) as a no-op — a FAIL on a command the runner exits 1 on.
 */
const PREFIX_DROP = new Set([
  'sudo',
  'command',
  'env',
  'time',
  'exec',
  '!',
  'xargs',
  'nice',
  'nohup',
  'stdbuf',
]);

/**
 * Reduces a command to `{ tool, candidates, args }`: strips env assignments and wrapper
 * prefixes, resolves `npm run <script>` through package.json, unwraps `python -m <mod>`, and
 * reduces a path to its basename.
 */
function analyseCommand(cmd, pkg, depth = 0) {
  const segment = primarySegment(cmd);
  let tokens = tokenize(segment);
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1);
  while (tokens.length && PREFIX_DROP.has(tokens[0])) tokens = tokens.slice(1);
  // On-demand package runners are their own finding (W13/W15); for tool identity, unwrap them.
  if (tokens[0] === 'npx' || tokens[0] === 'uvx' || tokens[0] === 'pipx') {
    tokens = tokens.slice(1);
    if (tokens[0] === 'run') tokens = tokens.slice(1);
    while (tokens.length && tokens[0].startsWith('-')) tokens = tokens.slice(1);
  } else if ((tokens[0] === 'uv' || tokens[0] === 'poetry') && tokens[1] === 'run') {
    tokens = tokens.slice(2);
  } else if (tokens[0] === 'npm' && tokens[1] === 'exec') {
    tokens = tokens.slice(2);
    while (tokens.length && (tokens[0].startsWith('-') || tokens[0] === '--')) {
      tokens = tokens.slice(1);
    }
  }
  if (!tokens.length) return { tool: '', candidates: [], args: [], raw: segment };

  let head = tokens[0];
  let args = tokens.slice(1);

  // `npm run <script>` / `npm test` — resolve through package.json scripts.
  if (SCRIPT_RUNNERS.has(head) && pkg?.scripts && depth < 3) {
    let script = null;
    if (args[0] === 'run' || args[0] === 'run-script') script = args[1];
    else if (args[0] && !args[0].startsWith('-') && pkg.scripts[args[0]]) script = args[0];
    if (script && typeof pkg.scripts[script] === 'string') {
      const inner = analyseCommand(pkg.scripts[script], pkg, depth + 1);
      if (inner.tool)
        return { ...inner, raw: segment, resolvedFrom: script, task: `the script \`${script}\`` };
    }
  }

  if (head.includes('/')) head = basename(head);

  let viaTask = null;
  if (/^python[0-9.]*$/.test(head) && args[0] === '-m' && args[1]) {
    viaTask = `the module \`${args[1]}\``;
    head = args[1];
    args = args.slice(2);
  }
  if (TASK_RUNNERS.has(head) && args[0] && !args[0].startsWith('-')) {
    viaTask = `the task \`${args[0]}\``;
  }

  const candidates = [norm(head)];
  const task = viaTask;
  if (args[0]) candidates.push(norm(head + args[0]));
  if (args[1]) candidates.push(norm(head + args[0] + args[1]));
  return { tool: head, candidates, args, raw: segment, task };
}

/**
 * The commands an indirection actually runs, when its definition lives in this repository.
 *
 * Closing `xargs`, `cd &&` and `time` one at a time was the shape-by-shape mistake; the class is
 * "the command names something whose body is in the tree". That is: an npm/pnpm/yarn script
 * (resolved in `analyseCommand`), a project script file, and a `make` target. Following them
 * keeps the indirection from being either a blind spot for identity or a hiding place for a
 * swallow — a `Makefile` target of `true` fails exactly as a bare `true` does.
 */
function resolveIndirection(ctx, command) {
  const analysis = analyseCommand(command, ctx.pkg);
  if (analysis.resolvedFrom) return null; // already resolved by the script resolver
  const tokens = tokenize(primarySegment(command));
  const head = tokens[0] ?? '';
  if (head === 'make' && tokens[1] && !tokens[1].startsWith('-')) {
    for (const name of ['Makefile', 'makefile', 'GNUmakefile']) {
      const read = safeRead(join(ctx.root, name));
      if (read.text === null) continue;
      const rx = new RegExp(`^${escapeRx(tokens[1])}\\s*:[^=\\n]*\\n((?:\\t[^\\n]*\\n?)+)`, 'm');
      const found = rx.exec(read.text);
      if (found) {
        return {
          source: `${name} target \`${tokens[1]}\``,
          commands: found[1]
            .split('\n')
            .map((l) => l.replace(/^\t[-@+]*/, '').trim())
            .filter(Boolean),
        };
      }
    }
    return null;
  }
  if (/^[.\w][\w./-]*\.(sh|bash|mjs|js|cjs|py)$/.test(head) || head.startsWith('./')) {
    const rel = head.replace(/^\.\//, '');
    const read = safeRead(join(ctx.root, rel));
    if (read.text === null) return null;
    if (/\.(mjs|js|cjs|py)$/.test(rel)) return null; // not a shell script; its body is not shell
    // The FULL text, not the live-line view: propagation needs the control flow an early
    // `exit 1` lives in, and the pin scanner's view deliberately drops exactly that.
    return { source: rel, commands: [read.text] };
  }
  return null;
}

/** Matches a manifest tool name against a command's candidate tokens. */
function commandMatchesTool(analysis, tool) {
  return analysis.candidates.includes(norm(tool));
}

/** The arguments left after the matched tool's own tokens. */
function operationalArgs(analysis, tool) {
  const index = analysis.candidates.indexOf(norm(tool));
  if (index <= 0) return analysis.args;
  return analysis.args.slice(index);
}

const NO_OP_HEADS = new Set(['true', ':', 'echo', 'printf', 'exit']);
const PROBE_FLAGS = new Set(['--version', '-V', '--help', '-h', 'version', '--usage']);

/**
 * Classifies a command's usefulness (spec §5 R-C3): FAIL for a no-op or a pure version/help
 * probe, PASS when it carries an operational argument, UNKNOWN otherwise.
 */

/**
 * Classifies a command's usefulness (spec §5 R-C3 + controller ruling): FAIL for a no-op or
 * for a command carrying a version/help probe flag AT ALL (a config cannot launder
 * `--version`); PASS when it carries an operational argument OR when the tool's PINNED CONFIG
 * carries the operation (`tsup`, `mypy`, `vitest` are config-driven by design and A12 has
 * already verified that config exists); UNKNOWN otherwise.
 */
function classifyWork(analysis, args, opts = {}) {
  if (!analysis.tool) return { status: 'FAIL', why: 'empty command' };
  if (NO_OP_HEADS.has(analysis.tool)) {
    return { status: 'FAIL', why: `no-op command \`${analysis.raw}\`` };
  }
  if (args.some((a) => PROBE_FLAGS.has(a))) {
    return { status: 'FAIL', why: `version/help probe \`${analysis.raw}\` demonstrates nothing` };
  }
  if (args.length) return { status: 'PASS', why: analysis.raw };
  if (opts.configFile) {
    return { status: 'PASS', why: `\`${analysis.raw}\` is config-driven by ${opts.configFile}` };
  }
  // A command may name a TARGET or a TASK. The operation lives in the task definition, which is
  // resolved and judged where it can be (an npm script of `true` fails exactly as a bare `true`
  // would, via the resolution in `analyseCommand`) and accepted where it cannot — indirection is
  // not a defect. Only a command naming neither is unverifiable.
  if (analysis.task) {
    return { status: 'PASS', why: `\`${analysis.raw}\` names ${analysis.task}` };
  }
  return {
    status: 'UNKNOWN',
    why: `\`${analysis.raw}\` names neither a target nor a task, so what it operates on cannot be established`,
  };
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

/** Splits a command on a top-level separator, honouring quotes. */
function splitTopLevel(command, separator) {
  const out = [];
  let current = '';
  let quote = null;
  // A separator inside a `( … )` subshell or a `{ … }` group is not top level: splitting there
  // tore `cmd || { echo failed; exit 1; }` into fragments whose `}` then read as unbalanced.
  // Depth never goes negative, so a stray `)` (as in a `case` pattern) cannot hide a separator.
  let depth = 0;
  const text = String(command ?? '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (quote === '"' && c === '\\') {
        current += c + (text[++i] ?? '');
        continue;
      }
      if (c === quote) quote = null;
      current += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      continue;
    }
    if (c === '(' || c === '{') depth++;
    else if (c === ')' || c === '}') depth = Math.max(0, depth - 1);
    if (depth === 0 && text.startsWith(separator, i)) {
      out.push(current);
      current = '';
      i += separator.length - 1;
      continue;
    }
    current += c;
  }
  out.push(current);
  return out.filter((part) => part.trim());
}

/**
 * W20 — can this command still turn a tier RED?
 *
 * A shell script's exit status is the status of its LAST statement, so that is what decides:
 * the last executable line, its last `;`-separated statement, and that statement's last `||`
 * alternative. The alternative is judged by the SAME classifier W17 uses (a second classifier
 * would drift from the first), so `|| true`, `|| :`, `|| echo skipped` and a trailing
 * `; exit 0` all read as a forced success. `|| exit 1` is not: it fails loudly on purpose.
 */

/**
 * ---------------------------------------------------------------------------------------
 * Shell propagation analysis (contract §3.3, W20)
 * ---------------------------------------------------------------------------------------
 *
 * The question is POSITIVE: is there a demonstrable path by which the invoked tool's non-zero
 * exit becomes the whole command's non-zero exit? It is NOT "does this command match a known
 * way of discarding a status" — that list was written twice and was one shape short both times.
 *
 * Two rules govern the answer, and both are the contract's:
 *
 *   Unresolvability is a FLOOR, never a ceiling. The strongest DEMONSTRATED verdict wins; a
 *   command that demonstrably discards its status does not become unresolved because it also
 *   contains a construct this reader cannot parse. Otherwise one `$( )` beside a swallow
 *   launders a FAIL and the safety valve becomes the bypass.
 *
 *   Getting it wrong in the strict direction is not "safe". It rejects a working harness and
 *   sends its owner looking for a suppression, so every idiom a real harness uses —
 *   `set -euo pipefail` then a guard block, `exit $?`, `cd dir && tool`, `cmd | xargs tool`,
 *   `time tool` — has to be READ rather than refused.
 */

/** Thrown internally when the reader will not guess; callers turn it into UNRESOLVED. */
class Unresolved extends Error {}

const BLOCK_OPENERS = new Set(['if', 'while', 'until', 'for']);
const BLOCK_KEYWORDS = new Set([
  'if',
  'elif',
  'else',
  'then',
  'fi',
  'while',
  'until',
  'for',
  'do',
  'done',
  'case',
  'esac',
  'select',
  'function',
  'coproc',
  '{',
  '}',
]);

/**
 * Constructs whose STRUCTURE this reader will not interpret. They are collapsed into one opaque
 * STATEMENT rather than making the whole command unreadable: a construct it cannot read still
 * occupies a position, and position is most of what propagation is about. Refusing the command
 * instead is what let one `case` — or one unbalanced `function` — launder a swallow three lines
 * away from it.
 */
const OPAQUE_BLOCKS = [
  { open: /^case\b/, close: /^esac\b/, why: 'a `case` statement' },
  { open: /^select\b/, close: /^done\b/, why: 'a `select` loop' },
  { open: /^coproc\b/, close: /^\}$/, why: 'a `coproc`' },
  { open: /^function\b/, close: /^\}$/, why: 'a function definition' },
  { open: /^[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\)\s*\{?/, close: /^\}$/, why: 'a function definition' },
];

/** The first word of a statement, lowercased — its keyword when it has one. */
function leadingKeyword(text) {
  const trimmed = String(text).trim();
  if (trimmed === '{' || trimmed === '}') return trimmed;
  const word = trimmed.split(/\s+/)[0] ?? '';
  return BLOCK_KEYWORDS.has(word) ? word : '';
}

/**
 * Joins backslash line continuations. A wrapped tool invocation is the commonest reason a
 * `run:` is multi-line at all, and splitting on the newline made the argument line "decide the
 * exit status" — a hard FAIL, at every profile, on a command the runner exits 1 on.
 */
function joinContinuations(text) {
  return String(text ?? '').replace(/\\\n\s*/g, ' ');
}

/**
 * Masks `$( … )` and backquoted substitutions with an opaque VALUE token. A substitution is an
 * expression inside a statement, never structure, so masking it keeps the command's shape
 * readable while admitting that the value is unknown. Treating it as unreadable STRUCTURE is
 * what made one `$(date)` launder a demonstrated swallow.
 */
function maskSubstitutions(text) {
  let out = '';
  const src = String(text ?? '');
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '`') {
      const end = src.indexOf('`', i + 1);
      out += '__SUBST__';
      i = end === -1 ? src.length : end;
      continue;
    }
    if (src[i] === '$' && src[i + 1] === '(') {
      let depth = 0;
      let j = i + 1;
      for (; j < src.length; j++) {
        if (src[j] === '(') depth++;
        else if (src[j] === ')') {
          depth--;
          if (depth === 0) break;
        }
      }
      out += '__SUBST__';
      i = j;
      continue;
    }
    out += src[i];
  }
  return out;
}

/**
 * Removes here-document BODIES, which are data rather than statements. An UNTERMINATED here-doc
 * swallows the rest of the text, so everything from it onward becomes one opaque statement
 * rather than an unreadable command.
 */
function stripHeredocs(text) {
  const lines = String(text ?? '').split('\n');
  const out = [];
  let delimiter = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (delimiter !== null) {
      if (line.trim() === delimiter) delimiter = null;
      continue;
    }
    const open = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (open) {
      delimiter = open[2];
      out.push(line.replace(/<<-?\s*(['"]?)[A-Za-z_][A-Za-z0-9_]*\1/, '').trimEnd());
      continue;
    }
    out.push(line);
  }
  if (delimiter !== null) {
    return { text: out.join('\n'), unterminated: 'an unterminated here-document' };
  }
  return { text: out.join('\n'), unterminated: null };
}

/**
 * Splits on a top-level `&` used as a STATEMENT SEPARATOR — never on `&&`, `|&`, `2>&1` or `&>`.
 */
function splitBackgrounded(text) {
  const masked = stripQuotedRegions(String(text));
  const out = [];
  let start = 0;
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== '&') continue;
    if (masked[i + 1] === '&' || masked[i - 1] === '&') {
      i++;
      continue;
    }
    if (masked[i - 1] === '>' || masked[i - 1] === '<' || masked[i + 1] === '>') continue;
    if (masked[i - 1] === '|') continue; // `|&` is a pipeline operator, not backgrounding
    out.push({ text: text.slice(start, i).trim(), backgrounded: true });
    start = i + 1;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push({ text: rest, backgrounded: false });
  return out.filter((part) => part.text);
}

/**
 * Splits a command into fragments — newline, `;` and `&` separated — and strips a leading
 * `then`/`do`/`else` off each, so `do if [ -f x ]` is recognised as the block opener it is.
 * A `{` or `}` that opens or closes a multi-line group becomes its own fragment.
 */
function fragmentsOf(text) {
  const out = [];
  const push = (raw, backgrounded) => {
    let value = raw.trim();
    if (!value) return;
    let keyword = leadingKeyword(value);
    while (keyword === 'then' || keyword === 'do' || keyword === 'else') {
      const rest = value.slice(keyword.length).trim();
      out.push({ text: keyword, keyword, backgrounded: false });
      if (!rest) return;
      value = rest;
      keyword = leadingKeyword(value);
    }
    // A group that OPENS on this fragment but does not close on it (`{ npx biome lint .`).
    if ((value.startsWith('{') || value.startsWith('(')) && !balancedWrapper(value)) {
      const bracket = value[0];
      out.push({ text: bracket, keyword: bracket === '{' ? '{' : '(', backgrounded: false });
      const rest = value.slice(1).trim();
      if (rest) push(rest, backgrounded);
      return;
    }
    if ((value === '}' || value === ')') && true) {
      out.push({ text: value, keyword: value, backgrounded: false });
      return;
    }
    out.push({ text: value, keyword: leadingKeyword(value), backgrounded });
  };
  for (const line of text.split('\n')) {
    for (const piece of splitTopLevel(line, ';')) {
      for (const part of splitBackgrounded(piece)) push(part.text, part.backgrounded);
    }
  }
  return out;
}

/** Collapses each OPAQUE construct into a single opaque statement fragment. */
function collapseOpaque(frags) {
  const out = [];
  for (let i = 0; i < frags.length; i++) {
    const frag = frags[i];
    const rule = OPAQUE_BLOCKS.find((r) => r.open.test(frag.text.trim()));
    if (!rule) {
      out.push(frag);
      continue;
    }
    let j = i;
    const balanced =
      (frag.text.match(/\{/g) ?? []).length === (frag.text.match(/\}/g) ?? []).length;
    // The `balanced` shortcut is for a definition written on ONE fragment (`f() { …; }`); a
    // `case` has no braces at all, so applying it there left `esac` stranded.
    if (rule.close && !(balanced && /\{/.test(frag.text))) {
      j++;
      while (j < frags.length && !rule.close.test(frags[j].text.trim())) j++;
      if (j >= frags.length) j = frags.length - 1; // never terminated: it swallows the rest
    } else if (!rule.close) {
      // No terminator this reader can recognise: the construct swallows the rest of the text.
      j = frags.length - 1;
    }
    out.push({
      text: frags
        .slice(i, j + 1)
        .map((f) => f.text)
        .join('; '),
      keyword: '',
      backgrounded: false,
      opaque: rule.why,
    });
    i = j;
  }
  return out;
}

/** Parses fragments into a tree of `simple`, `if`, `loop` and `group` nodes. */
function parseSequence(frags, state, stop) {
  const nodes = [];
  while (state.i < frags.length) {
    const frag = frags[state.i];
    if (stop.has(frag.keyword)) break;
    if (frag.keyword === 'if') {
      nodes.push(parseIf(frags, state));
      continue;
    }
    if (BLOCK_OPENERS.has(frag.keyword)) {
      nodes.push(parseLoop(frags, state));
      continue;
    }
    if (frag.keyword === '{' || frag.keyword === '(') {
      nodes.push(parseGroup(frags, state));
      continue;
    }
    if (frag.keyword) throw new Unresolved(`unbalanced \`${frag.keyword}\``);
    nodes.push(simpleNode(frag));
    state.i++;
  }
  return nodes;
}

/** A `{ … }` or `( … )` group spanning several fragments. */
function parseGroup(frags, state) {
  const open = frags[state.i].keyword;
  const close = open === '{' ? '}' : ')';
  state.i++;
  const body = parseSequence(frags, state, new Set([close]));
  expectKeyword(frags, state, close);
  return { type: 'group', body, text: `${open} … ${close}`, backgrounded: false };
}

/** A simple statement — unwrapped when it is wholly a subshell or brace group on one fragment. */
function simpleNode(frag) {
  const text = frag.text.trim();
  if (frag.opaque) return { type: 'simple', text, opaque: frag.opaque, backgrounded: false };
  const wrapped = /^\((.*)\)$/s.exec(text) ?? /^\{(.*)\}$/s.exec(text);
  if (wrapped && balancedWrapper(text)) {
    const inner = wrapped[1].replace(/;\s*$/, '').trim();
    if (inner) {
      const innerFrags = collapseOpaque(fragmentsOf(inner));
      const state = { i: 0 };
      const nodes = parseSequence(innerFrags, state, new Set());
      if (state.i === innerFrags.length && nodes.length) {
        return { type: 'group', body: nodes, text, backgrounded: !!frag.backgrounded };
      }
    }
  }
  return { type: 'simple', text, backgrounded: !!frag.backgrounded };
}

/** True when the outermost bracket of `text` closes exactly at its end. */
function balancedWrapper(text) {
  const masked = stripQuotedRegions(text);
  const open = masked[0];
  if (open !== '(' && open !== '{') return false;
  const close = open === '(' ? ')' : '}';
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === open) depth++;
    else if (masked[i] === close) {
      depth--;
      if (depth === 0) return i === masked.length - 1;
    }
  }
  return false;
}

function parseIf(frags, state) {
  const head = frags[state.i].text.replace(/^if\b/, '').trim();
  state.i++;
  const cond = head ? [{ type: 'simple', text: head }] : [];
  cond.push(...parseSequence(frags, state, new Set(['then'])));
  expectKeyword(frags, state, 'then');
  const branches = [
    { kind: 'then', body: parseSequence(frags, state, new Set(['elif', 'else', 'fi'])) },
  ];
  while (frags[state.i]?.keyword === 'elif') {
    const elifHead = frags[state.i].text.replace(/^elif\b/, '').trim();
    state.i++;
    const elifCond = elifHead ? [{ type: 'simple', text: elifHead }] : [];
    elifCond.push(...parseSequence(frags, state, new Set(['then'])));
    expectKeyword(frags, state, 'then');
    branches.push({
      kind: 'elif',
      cond: elifCond,
      body: parseSequence(frags, state, new Set(['elif', 'else', 'fi'])),
    });
  }
  if (frags[state.i]?.keyword === 'else') {
    state.i++;
    branches.push({ kind: 'else', body: parseSequence(frags, state, new Set(['fi'])) });
  }
  expectKeyword(frags, state, 'fi');
  return { type: 'if', cond, branches };
}

function parseLoop(frags, state) {
  const kind = frags[state.i].keyword;
  const head = frags[state.i].text.replace(/^(while|until|for)\b/, '').trim();
  state.i++;
  const cond = head ? [{ type: 'simple', text: head }] : [];
  cond.push(...parseSequence(frags, state, new Set(['do'])));
  expectKeyword(frags, state, 'do');
  const body = parseSequence(frags, state, new Set(['done']));
  expectKeyword(frags, state, 'done');
  // `for x in <non-empty literal list>` demonstrably executes its body; a `while`/`until`
  // condition does not, and this reader does not pretend otherwise.
  const list = /^\S+\s+in\s+(.+)$/.exec(head ?? '');
  const executes = kind === 'for' && !!list && !/\$|\*|\?/.test(list[1]) && !!list[1].trim();
  return { type: 'loop', kind, cond, body, executes };
}

function expectKeyword(frags, state, keyword) {
  if (frags[state.i]?.keyword !== keyword) throw new Unresolved(`expected \`${keyword}\``);
  state.i++;
}

/**
 * Parses a whole command. Substitutions are masked as values, here-doc bodies dropped as data,
 * line continuations joined, and constructs whose structure this reader will not interpret
 * collapsed into single opaque statements — so `Unresolved` is now thrown only when the command
 * cannot be given a shape at all.
 */
function parseCommand(command) {
  const heredoc = stripHeredocs(joinContinuations(executableText(command)));
  const text = maskSubstitutions(heredoc.text);
  let frags = collapseOpaque(fragmentsOf(text));
  if (heredoc.unterminated && frags.length) {
    frags = [
      ...frags.slice(0, -1),
      { ...frags[frags.length - 1], opaque: heredoc.unterminated, keyword: '' },
    ];
  }
  const state = { i: 0 };
  const nodes = parseSequence(frags, state, new Set());
  if (state.i !== frags.length) throw new Unresolved(`unbalanced \`${frags[state.i].keyword}\``);
  return nodes;
}

/**
 * The lines of a shell SCRIPT that are DEMONSTRABLY EXECUTED — an allowlist, for the same
 * reason `skip` and `exclude` are. A pin recorded anywhere else is not reconciled: enumerating
 * the constructs that do not run (`if false`, and then `while false`, `until true`, `for x in ;`,
 * a trailing `exit 0`, an uncalled function…) is a list that is always one shape short.
 *
 * Credited: a line at block depth zero, before any unconditional top-level `exit`, with
 * comments stripped, continuations joined and here-document bodies removed. Everything inside
 * any block — including a function body, which does not run where it is written — is not.
 */
function liveScriptLines(text) {
  const heredoc = stripHeredocs(joinContinuations(executableText(text)));
  const OPENERS = ['if', 'while', 'until', 'for', 'case', 'select'];
  const CLOSERS = ['fi', 'done', 'esac'];
  const out = [];
  let depth = 0;
  let stopped = false;
  for (const raw of heredoc.text.split('\n')) {
    if (stopped) break;
    const atTopLevel = depth === 0;
    let closedHere = false;
    for (const piece of splitTopLevel(raw, ';')) {
      let statement = piece.trim();
      if (!statement) continue;
      let keyword = leadingKeyword(statement);
      while (keyword === 'then' || keyword === 'do' || keyword === 'else') {
        statement = statement.slice(keyword.length).trim();
        keyword = leadingKeyword(statement);
      }
      const word = statement.split(/\s+/)[0] ?? '';
      if (OPENERS.includes(word)) depth++;
      else if (CLOSERS.includes(word)) depth = Math.max(0, depth - 1);
      // A function body is delimited by braces, so counting the braces IS counting the
      // definition — incrementing for both left the depth stuck above zero and credited
      // nothing at all.
      const braces = (statement.match(/\{/g) ?? []).length - (statement.match(/\}/g) ?? []).length;
      if (braces > 0) depth += braces;
      else if (braces < 0) {
        depth = Math.max(0, depth + braces);
        closedHere = true;
      }
      if (depth === 0 && /^exit\b/.test(statement)) stopped = true;
    }
    if (atTopLevel && depth === 0 && !closedHere) out.push(raw);
  }
  return out.join('\n');
}

/** Is a simple statement's exit status statically NON-zero — a command that always fails? */
function alwaysFails(ctx, text) {
  const analysis = analyseCommand(unwrapLast(text), ctx.pkg);
  if (analysis.tool === 'exit' || analysis.tool === 'return') {
    const code = analysis.args[0];
    return !!code && code !== '0' && !code.includes('$');
  }
  return analysis.tool === 'false';
}

/** Is a simple statement's exit status statically zero — a command that cannot fail? */
function cannotFail(ctx, text) {
  const analysis = analyseCommand(unwrapLast(text), ctx.pkg);
  if (analysis.tool === 'exit') {
    const code = analysis.args[0];
    return !code || code === '0';
  }
  return classifyWork(analysis, analysis.args, workOptionsFor(ctx, analysis)).status === 'FAIL';
}

/** Does this statement PRESERVE a preceding status rather than replacing it? (`exit $?`) */
function preservesStatus(text) {
  return /^exit\s+"?\$\{?\?\}?"?\s*$/.test(String(text).trim());
}

/**
 * The `||`/`&&` elements of a statement, in order. An operator nested inside a `( … )` or
 * `{ … }` belongs to that group, not to this list, so only depth-0 operators split.
 */
function listElements(text) {
  const value = String(text);
  const masked = stripQuotedRegions(value);
  const out = [];
  let operator = null;
  let start = 0;
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(' || c === '{') depth++;
    else if (c === ')' || c === '}') depth = Math.max(0, depth - 1);
    if (depth !== 0) continue;
    const op = masked.startsWith('||', i) ? '||' : masked.startsWith('&&', i) ? '&&' : null;
    if (!op) continue;
    out.push({ operator, text: value.slice(start, i).trim() });
    operator = op;
    i++;
    start = i + 1;
  }
  out.push({ operator, text: value.slice(start).trim() });
  return out.filter((e) => e.text);
}

/**
 * A group's exit status is its LAST statement's, so `{ echo failed; exit 1; }` is judged by
 * `exit 1`. Without this, every predicate below read a whole group as one opaque word.
 */
function unwrapLast(text) {
  let value = String(text).trim();
  for (let guard = 0; guard < 8; guard++) {
    if (!balancedWrapper(value)) return value;
    const inner = value.slice(1, -1).trim().replace(/;\s*$/, '').trim();
    const parts = inner.split('\n').flatMap((line) => splitTopLevel(line, ';'));
    const last = parts
      .map((part) => part.trim())
      .filter(Boolean)
      .pop();
    if (!last || last === value) return value;
    value = last;
  }
  return value;
}

/** The `|` elements of one list element, in order. */
function pipelineElements(text) {
  // `a |& b` is `a 2>&1 | b`: a pipeline, so only the last element's status survives without
  // `pipefail`. Reporting it as backgrounding named the wrong mechanism and quoted a truncated
  // command, which an owner cannot act on.
  return splitTopLevel(String(text).replace(/\|&/g, '|'), '|')
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Blanks out quoted spans so operator scanning never fires inside a string. */
function stripQuotedRegions(text) {
  const chars = [...String(text)];
  for (const [start, end] of quotedRanges(String(text))) {
    for (let i = start; i < end && i < chars.length; i++) chars[i] = ' ';
  }
  return chars.join('');
}

const SET_ERREXIT_ON = /^set\s+(-[a-zA-Z]*e[a-zA-Z]*(\s|$)|-o\s+errexit\b)/;
const SET_ERREXIT_OFF = /^set\s+(\+[a-zA-Z]*e[a-zA-Z]*(\s|$)|\+o\s+errexit\b)/;
const SET_PIPEFAIL_ON = /^set\s+[^\n]*-o\s+pipefail\b/;
const SET_PIPEFAIL_OFF = /^set\s+[^\n]*\+o\s+pipefail\b/;

/** Does this statement install a trap that forces the exit status? */
function trapVerdict(text) {
  const statement = String(text).trim();
  if (!/^trap\s/.test(statement) || !/\bEXIT\b/.test(statement)) return null;
  if (/exit\s+0|exit\s*['"]?\s*$/.test(statement)) {
    return { status: 'FAIL', why: `\`${statement}\` forces the exit status from an EXIT trap` };
  }
  return {
    status: 'UNRESOLVED',
    why: `\`${statement}\` installs an EXIT trap this checker cannot evaluate`,
  };
}

/**
 * Every simple statement of a tree in EXECUTION order, each with the block path that reaches
 * it. Used both to locate the tool and to compute shell state at that point — state has to be
 * global to the command, because an `if` body is a different sequence and an outer
 * `set -euo pipefail` (or an outer `set +e`) is invisible to a body-local scan. That single
 * omission produced a false FAIL on the guard-then-check idiom and a false PASS on CI at once.
 */
function flatten(nodes, path = [], out = []) {
  for (const node of nodes) {
    if (node.type === 'simple') {
      out.push({ node, path });
      continue;
    }
    if (node.type === 'group') {
      flatten(node.body, [...path, { node, role: 'body', body: node.body }], out);
      continue;
    }
    if (node.type === 'if') {
      flatten(node.cond, [...path, { node, role: 'condition' }], out);
      for (const branch of node.branches) {
        if (branch.cond) flatten(branch.cond, [...path, { node, role: 'condition' }], out);
        flatten(branch.body, [...path, { node, role: 'body', body: branch.body }], out);
      }
      continue;
    }
    if (node.type === 'loop') {
      flatten(node.cond, [...path, { node, role: 'condition' }], out);
      flatten(node.body, [...path, { node, role: 'body', body: node.body }], out);
    }
  }
  return out;
}

/** Locates the tool inside a statement: which `||`/`&&` element and which pipeline element. */
function locateInStatement(text, locate) {
  const elements = listElements(text);
  for (let e = 0; e < elements.length; e++) {
    const pipeline = pipelineElements(elements[e].text);
    for (let p = 0; p < pipeline.length; p++) {
      if (locate(pipeline[p])) return { elements, elementIndex: e, pipeline, pipeIndex: p };
      // `find … -exec <tool> {} +` runs the tool as its own argument list.
      const exec = /\s-(?:exec|execdir)\s+(.+?)(?:\s+[;+]|$)/.exec(pipeline[p]);
      if (exec && locate(exec[1])) return { elements, elementIndex: e, pipeline, pipeIndex: p };
    }
  }
  return null;
}

/**
 * W20's core. Returns PASS with the demonstrated path, FAIL with the discarding construct, or
 * UNRESOLVED with what could not be read.
 */
function propagationVerdict(ctx, command, locate, opts = {}) {
  let nodes = null;
  let unreadable = null;
  try {
    nodes = parseCommand(command);
  } catch (e) {
    if (!(e instanceof Unresolved)) throw e;
    unreadable = e.message;
  }

  // FLOOR: a demonstrable swallow is reported even when the rest of the command is unreadable.
  if (!nodes) {
    const demonstrated = degradedSwallow(ctx, command, locate, opts);
    if (demonstrated) return demonstrated;
    return {
      status: 'UNRESOLVED',
      why: `the command contains ${unreadable}, which this checker will not interpret`,
    };
  }
  if (!nodes.length) return { status: 'UNRESOLVED', why: 'no command to judge' };

  const statements = flatten(nodes);
  const found = statements
    .map((entry) => ({ ...entry, hit: locateInStatement(entry.node.text, locate) }))
    .filter((entry) => entry.hit)
    .pop();

  if (!found) {
    // The tool could not be identified — `make lint`, `scripts/lint.sh`, a workspace filter,
    // an `-exec` form. Closing that shape by shape is the same mistake as listing swallows, so
    // it is closed as a CLASS: judge the statement that DOES decide the command's status. If
    // that path is intact the command can still report a failure, whatever it runs; if it
    // cannot fail, the command cannot either.
    // An indirection whose body is IN THE REPOSITORY is followed before giving up: the
    // swallow lives in the script or the make target as often as in the command that calls it.
    if ((opts.depth ?? 0) < 2) {
      for (const entry of statements) {
        const indirect = indirectPropagation(ctx, entry.node.text, locate, opts, opts.depth ?? 0);
        if (indirect) return indirect;
      }
    }
    const last = statements[statements.length - 1];
    if (!last) return { status: 'UNRESOLVED', why: 'no command to judge' };
    if (last.node.opaque) {
      return {
        status: 'UNRESOLVED',
        why: `the command ends in ${last.node.opaque}, which this checker will not interpret`,
      };
    }
    const tail = listElements(last.node.text).at(-1)?.text ?? last.node.text;
    if (cannotFail(ctx, tail)) {
      return {
        status: 'FAIL',
        why: `the command's last statement \`${last.node.text}\` cannot fail`,
      };
    }
    const tailHit = {
      node: last.node,
      hit: {
        elements: listElements(last.node.text),
        elementIndex: listElements(last.node.text).length - 1,
        pipeline: pipelineElements(tail),
        pipeIndex: pipelineElements(tail).length - 1,
      },
    };
    const tailOwn = statementPropagation(ctx, tailHit, opts);
    if (tailOwn.status !== 'PASS') return tailOwn;
    return {
      status: 'PASS',
      why: `the tool was not identifiable, but \`${last.node.text}\` decides the command's exit status and can fail`,
    };
  }
  if (found.node.opaque) {
    return {
      status: 'UNRESOLVED',
      why: `the tool runs inside ${found.node.opaque}, which this checker will not interpret`,
    };
  }

  // Shell state at the tool, from the statements that run BEFORE it — and only those. `found`
  // is a COPY of its `statements` entry (it carries the located `hit`), so an identity test
  // against the entry never held and the walk ran past the tool: a `set -e` written BELOW the
  // check was read as if it protected it, which is a false PASS (`bash -c 'false; set -e; echo
  // done'` exits 0), and a `set +e` below it cancelled CI errexit that had already aborted at
  // the failure, which is a false FAIL. The NODE is the identity the two share.
  let errexit = !!opts.errexit;
  let pipefail = !!opts.pipefail;
  for (const entry of statements) {
    if (entry.node === found.node) break;
    const text = entry.node.text.trim();
    if (SET_ERREXIT_ON.test(text)) errexit = true;
    else if (SET_ERREXIT_OFF.test(text)) errexit = false;
    if (SET_PIPEFAIL_OFF.test(text)) pipefail = false;
    else if (SET_PIPEFAIL_ON.test(text)) pipefail = true;
  }

  // An EXIT trap is the exception: it fires wherever it is installed, so the WHOLE command is
  // swept for one. (`bash -c 'false; trap "exit 0" EXIT; echo done'` exits 0.)
  for (const entry of statements) {
    const trap = trapVerdict(entry.node.text.trim());
    if (trap) return trap;
  }

  const own = statementPropagation(ctx, found, { ...opts, pipefail });
  if (own.status !== 'PASS') return own;
  const analysis0 = analyseCommand(found.hit.pipeline[found.hit.pipeIndex], ctx.pkg);

  // The resolved body of an `npm run <script>` indirection is part of the path: the swallow
  // frequently lives in package.json, which the outer text never shows.
  const indirect = indirectPropagation(
    ctx,
    found.hit.pipeline[found.hit.pipeIndex],
    (candidate) => commandMatchesTool(analyseCommand(candidate, ctx.pkg), analysis0.tool),
    opts,
    opts.depth ?? 0,
  );
  if (indirect && indirect.status !== 'PASS') return indirect;

  let current = found.node;
  for (const step of [...found.path].reverse()) {
    if (step.role === 'condition') {
      const kind = step.node.type === 'loop' ? step.node.kind : 'if';
      return {
        status: 'FAIL',
        why: `the tool runs as the \`${kind}\` CONDITION, so its status is consumed by the test and never becomes the command's`,
      };
    }
    if (step.node.type === 'loop' && !step.node.executes) {
      return {
        status: 'UNRESOLVED',
        why: `the tool runs inside a \`${step.node.kind}\` loop, whose body this checker cannot show executes`,
      };
    }
    const seq = sequencePropagation(step.body, current, errexit);
    if (seq.status !== 'PASS') return seq;
    current = step.node;
  }
  const top = sequencePropagation(nodes, current, errexit);
  if (top.status !== 'PASS') return top;
  return { status: 'PASS', why: `\`${found.node.text}\` decides the command's exit status` };
}

/**
 * A demonstrable swallow found WITHOUT a full parse, so an unreadable construct elsewhere in
 * the command cannot launder it (the contract's floor rule).
 */
function degradedSwallow(ctx, command, locate, opts) {
  const text = maskSubstitutions(stripHeredocs(joinContinuations(executableText(command))).text);
  const statements = [];
  for (const line of text.split('\n')) {
    for (const piece of splitTopLevel(line, ';')) {
      for (const part of splitBackgrounded(piece)) statements.push(part);
    }
  }
  let errexit = !!opts.errexit;
  let index = -1;
  for (let i = 0; i < statements.length; i++) {
    const part = statements[i];
    const hit = locateInStatement(part.text, locate);
    if (hit) {
      index = i;
      const verdict = statementPropagation(
        ctx,
        { node: { text: part.text, backgrounded: part.backgrounded }, hit },
        opts,
      );
      if (verdict.status === 'FAIL') return verdict;
      break;
    }
    const trap = trapVerdict(part.text);
    if (trap && trap.status === 'FAIL') return trap;
    if (SET_ERREXIT_ON.test(part.text.trim())) errexit = true;
    else if (SET_ERREXIT_OFF.test(part.text.trim())) errexit = false;
  }
  // POSITION is demonstrable without a parse whenever the command has no block structure at
  // all: every fragment is then a top-level statement, and the last one decides the status.
  // Leaving this to the parse tree is what let one unreadable token launder the swallow class
  // the contract lists FIRST.
  const flat = statements.every((part) => !leadingKeyword(part.text));
  if (flat && index >= 0 && index < statements.length - 1 && !errexit) {
    const after = statements.slice(index + 1);
    if (!after.every((part) => preservesStatus(part.text))) {
      return {
        status: 'FAIL',
        why: `\`${statements[index].text}\` runs the check but \`${after[after.length - 1].text}\` decides the exit status, and errexit is not in effect — put the check last, add \`set -e\`, or end with \`exit $?\``,
      };
    }
  }
  return null;
}

/** Propagation WITHIN the statement that invokes the tool. */
function statementPropagation(ctx, found, opts) {
  const { elements, elementIndex, pipeline, pipeIndex } = found.hit;
  const element = pipeline[pipeIndex];

  if (found.node.backgrounded) {
    return {
      status: 'FAIL',
      why: `\`${found.node.text}\` is backgrounded with \`&\`, so its status is never the command's`,
    };
  }
  if (/^!\s/.test(elements[elementIndex].text.trim())) {
    return {
      status: 'FAIL',
      why: `\`${elements[elementIndex].text.trim()}\` is NEGATED with \`!\`, which inverts the control rather than reporting it`,
    };
  }
  if (pipeline.length > 1 && pipeIndex !== pipeline.length - 1 && !opts.pipefail) {
    return {
      status: 'FAIL',
      why: `the tool is piped into \`${pipeline[pipeline.length - 1]}\` without \`pipefail\`, so only that command's status survives`,
    };
  }
  const trap = trapVerdict(element);
  if (trap) return trap;
  for (let i = elementIndex + 1; i < elements.length; i++) {
    if (elements[i].operator !== '||') continue;
    if (cannotFail(ctx, elements[i].text)) {
      return {
        status: 'FAIL',
        why: `a failure is rescued by \`|| ${elements[i].text}\`, which cannot fail`,
      };
    }
    if (alwaysFails(ctx, elements[i].text)) continue;
    return {
      status: 'UNRESOLVED',
      why: `a failure is rescued whenever \`${elements[i].text}\` succeeds, so the tool's status cannot be shown to reach the command's`,
    };
  }
  return { status: 'PASS', why: '' };
}

/** Follows an `npm run <script>` indirection into package.json and judges the script body. */
/**
 * Does the resolved body actually INVOKE what the locator is tracking? A mention is not enough:
 * `scripts/assert-tool-versions.sh` prints its own name in a success message, and judging a body
 * that only MENTIONS the tool treats the indirection's exit status as the tool's — which read a
 * script that exits 1 on mismatch as a swallow because it ends with a success message.
 */
function bodyInvokes(body, locate) {
  let statements;
  try {
    statements = flatten(parseCommand(body)).map((entry) => entry.node.text);
  } catch (e) {
    if (!(e instanceof Unresolved)) throw e;
    statements = executableText(body)
      .split('\n')
      .flatMap((line) => splitTopLevel(line, ';'))
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return statements.some((statement) => !!locateInStatement(statement, locate));
}

function indirectPropagation(ctx, text, locate, opts, depth = 0) {
  if (depth > 2) return null;
  const analysis = analyseCommand(text, ctx.pkg);
  let source = null;
  let body = null;
  if (analysis.resolvedFrom && typeof ctx.pkg?.scripts?.[analysis.resolvedFrom] === 'string') {
    source = `the script \`${analysis.resolvedFrom}\` in package.json`;
    body = ctx.pkg.scripts[analysis.resolvedFrom];
  } else {
    const resolved = resolveIndirection(ctx, text);
    if (resolved?.commands.length) {
      source = resolved.source;
      body = resolved.commands.join('\n');
    }
  }
  if (!body?.trim()) return null;
  if (!bodyInvokes(body, locate)) return null;
  const inner = propagationVerdict(ctx, body, locate, {
    ...opts,
    errexit: false,
    pipefail: false,
    depth: depth + 1,
  });
  if (inner.status === 'PASS') return inner;
  return {
    status: inner.status,
    why: `${source} ${inner.status === 'FAIL' ? 'discards it' : 'cannot be shown to propagate it'}: ${inner.why}`,
  };
}

/** Propagation from one node to the END of the sequence that contains it. */
function sequencePropagation(sequence, node, errexit) {
  const index = sequence.indexOf(node);
  if (index < 0)
    return { status: 'UNRESOLVED', why: 'the statement could not be placed in its command' };
  if (index === sequence.length - 1) return { status: 'PASS', why: '' };
  if (errexit) return { status: 'PASS', why: '' };
  const after = sequence.slice(index + 1);
  if (after.every((n) => n.type === 'simple' && preservesStatus(n.text))) {
    return { status: 'PASS', why: '' };
  }
  const trailing = after[after.length - 1];
  const trailingText =
    trailing.type === 'simple'
      ? trailing.opaque
        ? `${trailing.opaque} (\`${firstLine(trailing.text).trim()}\`)`
        : trailing.text
      : `a ${trailing.type} block`;
  const nodeText = node.type === 'simple' ? node.text : `the ${node.type} block`;
  return {
    status: 'FAIL',
    why: `\`${nodeText}\` runs the check but \`${trailingText}\` decides the exit status, and errexit is not in effect — put the check last, add \`set -e\`, or end with \`exit $?\``,
  };
}

/**
 * W20's entry point. `opts`: `{ tools, needle, ci, shell }` — `tools`/`needle` locate the
 * tool-bearing statement (the same matchers W17 and W12 use), `ci` selects the provider's
 * default shell semantics, `shell` is a declared shell.
 */
function signalVerdict(ctx, command, opts = {}) {
  const { tools = [], needle = '' } = opts;
  const locate = (text) => {
    if (needle) return runContains(text, needle) === true;
    if (tools.length)
      return tools.some((t) => commandMatchesTool(analyseCommand(text, ctx.pkg), t));
    return false;
  };
  // GitHub Actions runs `run:` under `bash -e`, and `shell: bash` additionally adds `pipefail`.
  // A shell other than bash is a different interpreter with different flags, and this checker
  // does not guess at it.
  const errexit = !!opts.ci;
  let pipefail = false;
  if (opts.ci && opts.shell) {
    if (String(opts.shell).trim() === 'bash') pipefail = true;
    else {
      return {
        status: 'UNRESOLVED',
        why: `the step declares \`shell: ${opts.shell}\`, whose error handling this checker does not assume`,
      };
    }
  }
  return propagationVerdict(ctx, command, locate, { ...opts, errexit, pipefail });
}

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

/** Does this command invoke `tool` anywhere in an executed position? (W17's identity test.) */
function commandInvokesTool(ctx, command, tool, depth = 0) {
  const locate = (text) => commandMatchesTool(analyseCommand(text, ctx.pkg), tool);
  let statements;
  try {
    statements = liveStatements(command).map((text) => ({ text }));
  } catch (e) {
    if (!(e instanceof Unresolved)) throw e;
    statements = executableText(command)
      .split('\n')
      .flatMap((line) => splitTopLevel(line, ';'))
      .map((text) => ({ text: text.trim() }))
      .filter((s) => s.text);
  }
  for (const statement of statements) {
    const hit = locateInStatement(statement.text, locate);
    if (hit) return hit.pipeline[hit.pipeIndex];
  }
  if (depth < 2) {
    for (const statement of statements) {
      const indirect = resolveIndirection(ctx, statement.text);
      if (!indirect) continue;
      for (const inner of indirect.commands) {
        const found = commandInvokesTool(ctx, inner, tool, depth + 1);
        if (found) return found;
      }
    }
  }
  return null;
}

/** `continue-on-error` on a step or its job: true swallows, an expression is unverifiable. */
function continueOnErrorVerdict(value) {
  if (value === undefined || value === null || value === false) return null;
  const text = String(value);
  if (text.includes('${{')) return { status: 'UNKNOWN', text };
  if (value === true || /^(true|yes|on)$/i.test(text)) return { status: 'FAIL', text };
  return null;
}

/** The pinned config file this checker knows for a tool, when it exists on disk (A12's map). */
function pinnedConfigFor(ctx, tool) {
  const candidates = TOOL_CONFIGS[tool];
  if (!candidates) return null;
  return candidates.find((c) => !c.endsWith('/') && existsSync(join(ctx.root, c))) ?? null;
}

/** Work-classification options for a command: which pinned config, if any, drives it. */
function workOptionsFor(ctx, analysis, tool) {
  const configFile = pinnedConfigFor(ctx, tool ?? analysis.tool);
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
  if (typeof recorded === 'string' && KNOWN_PROFILES.includes(recorded)) {
    r.add('M2', 'PASS', `${file}: constitutionVersion "${recorded}"`, { file });
  } else {
    r.add(
      'M2',
      'UNKNOWN',
      `${file}: constitutionVersion ${JSON.stringify(recorded)} is not a profile this checker knows (${KNOWN_PROFILES.join('/')}) — profile-${CURRENT_PROFILE} checks were run instead of trusting it`,
      { file, hard: true },
    );
  }

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
    if (hasSingle && multi) {
      r.add('M4', 'FAIL', `${where}: has BOTH tool and tools[]`, { file });
    } else if (multi) {
      if (!multi.length) r.add('M4', 'FAIL', `${where}: tools[] is empty`, { file });
      for (const t of multi) {
        if (!t?.stack || !t.tool || !t.version) {
          r.add('M4', 'FAIL', `${where}: tools[] entry needs stack+tool+version`, { file });
        }
      }
      if (multi.length && multi.every((t) => t?.stack && t?.tool && t?.version)) {
        r.add('M4', 'PASS', `${where}: ${multi.length} per-stack tools`, { file });
      }
    } else if (hasSingle) {
      if (typeof entry.version === 'string' && entry.version) {
        r.add('M4', 'PASS', `${where}: ${entry.tool} ${entry.version}`, { file });
      } else {
        r.add('M4', 'FAIL', `${where}: tool without version`, { file });
      }
    } else {
      r.add('M4', 'FAIL', `${where}: neither tool+version nor tools[]`, { file });
    }

    const pairs = multi ? multi.map((t) => [t?.tool, t?.version]) : [[entry?.tool, entry?.version]];
    for (const [tool, version] of pairs) {
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
        if (!a || typeof a.tool !== 'string' || !isPinnedVersion(a.version)) {
          r.add(
            'M7',
            'FAIL',
            `${file}: ci.auditors entry ${JSON.stringify(a)} needs tool + pinned version`,
            { file },
          );
        } else {
          r.add('M7', 'PASS', `${file}: auditor ${a.tool} ${a.version}`, { file });
        }
      }
    }
  }

  if (level >= 3) {
    const hr = manifest.hookRunner;
    if (!hr || typeof hr.name !== 'string' || !hr.name || !isPinnedVersion(hr.version)) {
      r.add('M8', 'FAIL', `${file}: hookRunner must record name + pinned version`, { file });
    } else {
      r.add('M8', 'PASS', `${file}: hookRunner ${hr.name} ${hr.version}`, { file });
    }
    if (typeof manifest.agentUse !== 'boolean') {
      r.add('M8', 'FAIL', `${file}: agentUse must be a boolean`, { file });
    } else if (manifest.agentUse === false && !manifest.agentUseRationale) {
      r.add('M8', 'FAIL', `${file}: agentUse false requires agentUseRationale`, { file });
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

const TOOL_CONFIGS = {
  biome: ['biome.json', 'biome.jsonc'],
  eslint: [
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.cjs',
    'eslint.config.ts',
    '.eslintrc',
    '.eslintrc.js',
    '.eslintrc.json',
    '.eslintrc.cjs',
  ],
  prettier: [
    '.prettierrc',
    '.prettierrc.json',
    '.prettierrc.js',
    '.prettierrc.cjs',
    '.prettierrc.yaml',
    '.prettierrc.yml',
    'prettier.config.js',
    'prettier.config.mjs',
  ],
  tsc: ['tsconfig.json'],
  vitest: ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vite.config.ts'],
  jest: ['jest.config.js', 'jest.config.ts', 'jest.config.mjs', 'jest.config.json'],
  playwright: ['playwright.config.ts', 'playwright.config.js'],
  tsup: ['tsup.config.ts', 'tsup.config.js', 'tsup.config.mjs'],
  ruff: ['ruff.toml', '.ruff.toml', 'pyproject.toml'],
  mypy: ['mypy.ini', '.mypy.ini', 'pyproject.toml', 'setup.cfg'],
  pytest: ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini'],
  uv: ['pyproject.toml'],
  semgrep: ['.claudeconf/rules/'],
};
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
    const match = entries.find(
      (e) =>
        formatTools.some((t) => e.command.includes(t)) ||
        (level >= 4 && e.marker && e.marker.milestone === 'format'),
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
    else r.add('A9', 'FAIL', 'scripts/check-suppressions.* is missing', { file: 'scripts/' });
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
      const found = candidates.find(exists);
      if (found) r.add('A12', 'PASS', `${tool}: config ${found}`, { file: found });
      else r.add('A12', 'FAIL', `${tool}: no config file (looked for ${candidates.join(', ')})`);
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
    if (absent.length) parts.push(`declared by the harness but absent from the record: ${quote(absent)}`);
    if (stale.length) parts.push(`named in the record but not declared by the harness: ${quote(stale)}`);
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

function findScript(root, stem) {
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
  const pin = ctx.manifest?.hookRunner?.version;
  if (String(merged.min_version ?? '') !== String(pin ?? '')) {
    r.add(
      'A13',
      'FAIL',
      `merged configuration: min_version ${JSON.stringify(merged.min_version ?? null)} does not equal manifest hookRunner.version ${JSON.stringify(pin)}`,
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
          r.add(
            'W1',
            'FAIL',
            `${tier}: no job for the ${milestone} milestone (jobs: ${names || 'none'})`,
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
          { file: wf.path, line: b.step.line },
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
    if (missing.length) r.add('W3', 'FAIL', `gate: missing job(s) for ${missing.join(', ')}`);
    else r.add('W3', 'PASS', `gate: ${gateJobs.length} jobs cover the full battery`);
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
  else if (!e2eGate.length) r.add('W5', 'FAIL', 'gate: no e2e job');
  else {
    const inert = e2eGate
      .map((j) => ({ j, verdict: inertnessOf(ctx, j.def, { tools: toolsOf(e2eEntry) }) }))
      .find((x) => blocksWiring(x.verdict));
    if (inert) {
      r.add(
        'W5',
        inert.verdict.status,
        `gate.${inert.j.name}: e2e is inert — ${inert.verdict.why}`,
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
          { file: wf.path, line: candidates[0].line },
        );
      } else if (!ciStep) {
        r.add('W9', 'FAIL', `${wf.path}: CI auditor ${auditor.tool} is not run in a managed step`, {
          file: wf.path,
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

function checkFormatAdvisory(ctx, r, level, jobs) {
  const wf = ctx.workflow;
  const gateFormat = jobs.filter((j) => j.hook === 'gate' && jobMatchesToken(j.name, 'format'));
  if (!ctx.dump.dump) {
    r.add('W4', 'UNKNOWN', 'merged hook config unavailable');
  } else if (!gateFormat.length) {
    r.add('W4', 'FAIL', 'gate: no format job');
  } else {
    for (const job of gateFormat) {
      const run = executableText(jobText(job.def)).trim();
      if (/\|\|\s*true$/.test(run)) r.add('W4', 'PASS', `gate.${job.name}: advisory (\`|| true\`)`);
      else {
        r.add(
          'W4',
          'FAIL',
          `gate.${job.name}: \`${run}\` does not end with \`|| true\` — format must never block`,
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
          record(id, severity, `${wf.path}:${finding.line}: ${finding.message}`, {
            file: wf.path,
            line: finding.line,
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
        { file, line: Number(dup[1]) },
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
      { file, line },
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
  else if (!gateJob) r.add(id, 'FAIL', `gate: no \`${jobName}\` job`);
  else {
    const inert = inertnessOf(ctx, gateJob.def);
    if (blocksWiring(inert)) r.add(id, inert.status, `gate.${jobName}: inert — ${inert.why}`);
    else r.add(id, 'PASS', `gate.${jobName}: present`);
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
      { file: wf.path, line: candidates[0].line },
    );
  } else {
    r.add(id, 'FAIL', `${wf.path}: no managed CI step running ${scriptStem}`, { file: wf.path });
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

/**
 * Is `needle` present in an EXECUTED position of `command`? Comments and statically dead
 * constructs do not count; a command that cannot be resolved statically returns null.
 */

/** Index ranges of `text` that sit inside a single- or double-quoted shell string. */
function quotedRanges(text) {
  const ranges = [];
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    // Inside double quotes a backslash escapes the next character; single quotes have no
    // escapes in POSIX shells. Getting this wrong would let an escaped quote end a string
    // early and report a QUOTED needle as executed.
    if (quote === '"' && c === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) {
        ranges.push([start, i + 1]);
        quote = null;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
      start = i;
    }
  }
  return ranges;
}

/**
 * Is `needle` present in an EXECUTED position of `command`? A match inside a comment or a
 * statically dead construct does not count, and a match that only ever appears inside a QUOTED
 * STRING (`echo "scripts/check.sh is disabled"`, `bash -c "…"`) is not shown to execute either:
 * that returns null (UNVERIFIED), which an enforcing run fails. Returns true / false / null.
 */

/**
 * The statements a command actually EXECUTES, decided by the parsed structure rather than by
 * counting keywords. A branch under a statically false condition is dropped; the `else` branch
 * of that same conditional is kept, because it is the one that runs. Throws `Unresolved` when
 * the structure cannot be read — the caller reports UNKNOWN rather than guessing which lines
 * execute, since in a report a guess is indistinguishable from a verified answer.
 */
const STATICALLY_FALSE = /^(false|\[\s*0\s*-eq\s*1\s*\]|\[\[\s*0\s*-eq\s*1\s*\]\])\s*$/;

function liveStatements(command) {
  const out = [];
  const walk = (nodes) => {
    for (const node of nodes) {
      if (node.type === 'simple') {
        out.push(node.text);
        continue;
      }
      if (node.type === 'if') {
        walk(node.cond);
        const condText = node.cond
          .map((n) => (n.type === 'simple' ? n.text : ''))
          .join(' ')
          .trim();
        const deadThen = STATICALLY_FALSE.test(condText);
        for (const branch of node.branches) {
          if (deadThen && branch.kind === 'then') continue;
          if (branch.cond) walk(branch.cond);
          walk(branch.body);
        }
        continue;
      }
      walk(node.cond ?? []);
      walk(node.body ?? []);
    }
  };
  walk(parseCommand(command));
  return out;
}

/**
 * Is `needle` present in an EXECUTED position of `command`? A match inside a comment or a
 * statically dead branch does not count, and a match that only ever appears inside a QUOTED
 * STRING (`echo "scripts/check.sh is disabled"`, `bash -c "…"`) is not shown to execute
 * either. Returns true / false / null, where null is UNVERIFIED and an enforcing run fails it.
 */
function runContains(command, needle) {
  if (!needle) return false;
  const text = String(command ?? '');
  if (!text.trim()) return false;
  let joined;
  try {
    joined = liveStatements(text).join('\n');
  } catch (e) {
    if (e instanceof Unresolved) return null;
    throw e;
  }
  if (!joined.includes(needle)) {
    // The needle may still be present in text this reader dropped as dead; saying "absent"
    // is only honest when the whole command was readable, which it was.
    return false;
  }
  const quoted = quotedRanges(joined);
  let unquoted = false;
  for (let i = joined.indexOf(needle); i !== -1; i = joined.indexOf(needle, i + 1)) {
    const end = i + needle.length;
    if (!quoted.some(([a, b]) => i >= a && end <= b)) {
      unquoted = true;
      break;
    }
  }
  if (!unquoted) return null;
  return true;
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
      r.add('W13', 'FAIL', `${src.where}: fetches tooling at execution time — \`${at.text}\``, {
        file: src.file,
        line: at.line,
      });
    }
    for (const { rx, why } of FROZEN_RX) {
      if (rx.test(text)) {
        frozen++;
        const at = matchLineOf(text, rx, src.line, lines);
        r.add('W14', 'FAIL', `${src.where}: ${why} — \`${at.text}\``, {
          file: src.file,
          line: at.line,
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
        { file, line: onLine },
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
          { file, line: onLine },
        );
      }
    }
    if (pr.paths || pr['paths-ignore']) {
      r.add(
        'W16',
        'FAIL',
        `${file}:${onLine}: the pull_request trigger carries a paths filter — the check silently does not run for some changes`,
        { file, line: onLine },
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
      });
    }
    if (push.paths || push['paths-ignore']) {
      r.add('W16', 'FAIL', `${file}:${onLine}: the push trigger carries a paths filter`, {
        file,
        line: onLine,
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
      r.add('W17', 'UNKNOWN', `${milestone}: merged hook config unavailable — ${pair}`);
      continue;
    }
    if (!gateCommands.length || !ciCommands.length) {
      r.add('W17', 'FAIL', `${pair} — a tier has no command`);
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
          { file: wf.path },
        );
        continue;
      }
      r.add(
        'W17',
        'FAIL',
        `${pair} — gate references {${gateTools.tools.join(',')}}, CI references {${ciTools.tools.join(',')}}, manifest records {${required.join(',')}}`,
        { file: wf.path },
      );
      continue;
    }
    const verdicts = [...gateTools.work, ...ciTools.work];
    const failed = verdicts.find((v) => v.status === 'FAIL');
    if (failed) {
      r.add('W17', 'FAIL', `${pair} — ${failed.why}`, { file: wf.path });
      continue;
    }
    const unknown = verdicts.find((v) => v.status === 'UNKNOWN');
    if (unknown) {
      r.add('W17', 'UNKNOWN', `${pair} — ${unknown.why}`, { file: wf.path });
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
  const pins = manifestPins(manifest);
  const wf = ctx.workflow;
  /** tool → where its pin was reconciled, so D1 can tell "no lockfile" from "unreconciled". */
  const reconciled = new Map();

  // ---- D2: assert-tool-versions.sh literals ----
  const assertPath = findScript(root, 'assert-tool-versions') ?? 'scripts/assert-tool-versions.sh';
  const assertRead = safeRead(join(root, assertPath)).text;
  const assertText = assertRead === null ? null : liveScriptLines(assertRead);
  if (assertText === null) {
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
        { file: assertPath },
      );
    } else if (pins.size) {
      r.add(
        'D2',
        'FAIL',
        `${assertPath}: not present, and the manifest records ${pins.size} pinned tool(s) that nothing asserts at run time (contract §3.4)`,
        { file: assertPath },
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
  if (provText !== null) versionSources.push({ path: provPath, text: provText });
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
  else if (provText !== null)
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
    if (!auditor || typeof auditor.tool !== 'string' || !isPinnedVersion(auditor.version)) continue;
    for (const src of auditorText) {
      const rx = new RegExp(
        `\\b${escapeRx(auditor.tool)}\\b[^\\n]{0,80}?([0-9]+\\.[0-9]+\\.[0-9]+)`,
        'g',
      );
      for (const m of src.text.matchAll(rx)) {
        auditorHits++;
        if (m[1] !== auditor.version) {
          r.add(
            'D5',
            'FAIL',
            `${src.where}: ${auditor.tool} ${m[1]} but ci.auditors pins ${auditor.version}`,
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
  for (const [tool, version] of pins) {
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
      );
    }
  }
}

function managedText(wf) {
  return wf.regions.map((region) => region.body).join('\n');
}

function manifestPins(manifest) {
  const pins = [];
  for (const entry of Object.values(milestoneEntries(manifest))) {
    if (Array.isArray(entry?.tools)) {
      for (const t of entry.tools) if (t?.tool) pins.push([t.tool, t.version]);
    } else if (entry?.tool) {
      pins.push([entry.tool, entry.version]);
    }
  }
  for (const a of auditorsOf(manifest)) if (a?.tool) pins.push([a.tool, a.version]);
  const hr = manifest?.hookRunner;
  if (hr?.name) pins.push([hr.name, hr.version]);
  return pins;
}

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
        { file },
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
  const pin = ctx.manifest?.hookRunner?.version;
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
    r.add(
      'D8',
      'FAIL',
      `runner ${runner.path} (source: ${runner.source}) is ${version}, manifest pins ${pin}`,
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
  // Fail CLOSED: a profile this checker does not know is checked at the HIGHEST known profile,
  // so an edited field can only ever add checks, never remove them.
  const recordedLevel =
    recorded && KNOWN_PROFILES.includes(recorded) ? Number(recorded) : CURRENT_PROFILE;
  const level = Math.max(recordedLevel, opts.profile ? Number(opts.profile) : 0);
  ctx.level = level;

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
  track('A*', () => checkArtifacts(ctx, report, level));
  if (level >= 4) track('A14/A15', () => checkOwnershipSplit(ctx, report));
  track('W*', () => checkWiring(ctx, report, level));
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
      });
      continue;
    }
    for (const [id, minLevel] of owed) {
      if (level < minLevel) continue;
      const found = report.findings.get(id) ?? [];
      if (found.some((f) => f.status === 'FAIL')) continue;
      report.add(id, 'UNKNOWN', `check did not complete: internal error in the ${label} group`, {
        hard: true,
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
      { hard: true },
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
      `${JSON.stringify({ profile: recorded ?? 'unknown', results }, null, 2)}\n`,
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

/** Exclude files named by a secret-scan command, wherever that command lives. */
function collectSecretScanExcludes(ctx) {
  const out = [];
  for (const src of commandSources(ctx)) {
    for (const m of executableText(src.text).matchAll(/--exclude(?:-paths|-file)?[=\s]+(\S+)/g)) {
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
