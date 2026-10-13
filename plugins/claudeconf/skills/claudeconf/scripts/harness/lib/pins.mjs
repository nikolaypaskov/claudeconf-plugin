// pins.mjs — the ONE resolver for typed pins (contract §2.5, PLAN.md AD5). The checker and every
// vendored support script import it, so every consumer of a version reads the same answer from
// the same file; there is no second implementation to disagree with.
//
// A pin is `{ kind, path?, key }` — a reference into the file that actually pins a tool, never
// a copied literal. Resolution FAILS CLOSED: a source that is missing, unreadable, malformed,
// ambiguous, outside the repository root (including through a symlink) or not an exact version
// yields `{ ok: false, error, why }`, and a caller must treat that as a failure, never as a
// comparison it can skip.
//
// Dependency-free: Node builtins only.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** kind → default path (null: the pin must name one). */
export const PIN_KINDS = {
  'npm-lock': 'package-lock.json',
  'uv-lock': 'uv.lock',
  'tools-lock': '.claudeconf/tools.lock.json',
  requirements: null,
  'version-file': null,
  runtime: null,
};

/**
 * An EXACT version: digits and dots, optionally a pre-release/build suffix — never a range,
 * a wildcard, an alias (`lts/*`), or a bare major.
 */
export function isExactVersion(v) {
  return typeof v === 'string' && /^\d+\.\d+(\.\d+)*([-+][0-9A-Za-z.-]+)?$/.test(v);
}

/**
 * The version a tool REPORTS: the first version token in its output, taken WHOLE — every
 * character up to the token's end, a leading `v` dropped and trailing punctuation trimmed — so
 * `1.2.3rc1` reads as `1.2.3rc1` and can never equal a `1.2.3` pin, while `1.2.3-beta.1` can
 * equal the pre-release pin the resolver accepts. Null when there is none.
 */
export function reportedVersion(text) {
  const m = String(text ?? '').match(/(?<![0-9A-Za-z.])v?(\d+\.\d+[0-9A-Za-z.+-]*)/);
  return m ? m[1].replace(/[.+-]+$/, '') : null;
}

/**
 * Orders two exact versions by SemVer precedence: numeric components first, then a version
 * WITH a pre-release below the same version without one, pre-release identifiers compared
 * numerically or lexically; build metadata does not order. Returns -1, 0 or 1.
 */
export function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^([^-]*)(?:-(.*))?$/.exec(String(v).split('+')[0]) ?? [];
    return {
      core: String(m[1] ?? '')
        .split('.')
        .map(Number),
      pre: m[2] ?? null,
    };
  };
  const sign = (d) => (d < 0 ? -1 : d > 0 ? 1 : 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i++) {
    const d = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (d) return sign(d);
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  const ia = pa.pre.split('.');
  const ib = pb.pre.split('.');
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    if (ia[i] === undefined) return -1;
    if (ib[i] === undefined) return 1;
    const na = /^\d+$/.test(ia[i]);
    const nb = /^\d+$/.test(ib[i]);
    if (na && nb && Number(ia[i]) !== Number(ib[i])) return sign(Number(ia[i]) - Number(ib[i]));
    if (na !== nb) return na ? -1 : 1;
    if (!na && ia[i] !== ib[i]) return ia[i] < ib[i] ? -1 : 1;
  }
  return 0;
}

const fail = (error, why) => ({ ok: false, error, why });

/** Reads `rel` inside `root`; refuses anything that resolves outside it. */
function readInside(root, rel) {
  if (typeof rel !== 'string' || !rel) return { error: fail('malformed', 'no path') };
  if (isAbsolute(rel)) return { error: fail('outside-root', `${rel} is absolute`) };
  const base = realpathSync(resolve(root));
  const target = resolve(base, rel);
  const inside = (p) => p === base || p.startsWith(base + sep);
  if (!inside(target)) return { error: fail('outside-root', `${rel} leaves the repository`) };
  if (!existsSync(target)) return { error: fail('missing', `${rel} does not exist`) };
  let real;
  try {
    real = realpathSync(target);
  } catch (e) {
    return { error: fail('unreadable', `${rel}: ${e.message}`) };
  }
  if (!inside(real)) {
    return { error: fail('outside-root', `${rel} resolves outside the repository (symlink)`) };
  }
  try {
    return { text: readFileSync(real, 'utf8'), rel: relative(base, target) || rel };
  } catch (e) {
    return { error: fail('unreadable', `${rel}: ${e.message}`) };
  }
}

function parseJson(read) {
  try {
    return { doc: JSON.parse(read.text) };
  } catch (e) {
    return { error: fail('malformed', `${read.rel}: not JSON (${e.message.split('\n')[0]})`) };
  }
}

const exact = (version, rel, key) =>
  isExactVersion(version)
    ? { ok: true, version, provenance: `${rel}#${key}` }
    : fail('not-exact', `${rel}#${key}: ${JSON.stringify(version)} is not an exact version`);

function npmLock(root, rel, key) {
  const read = readInside(root, rel);
  if (read.error) return read.error;
  const lock = parseJson(read);
  if (lock.error) return lock.error;
  const entry = lock.doc?.packages?.[`node_modules/${key}`];
  if (!entry || typeof entry.version !== 'string') {
    return fail('not-found', `${read.rel}: no top-level entry for ${key}`);
  }
  // The lock records what was resolved; the package manifest records what was ASKED for. A
  // range there means the next fresh resolution may pick something else — not a pin.
  const manifestRel = join(dirname(read.rel), 'package.json');
  const pkgRead = readInside(root, manifestRel);
  if (pkgRead.error) return pkgRead.error;
  const pkg = parseJson(pkgRead);
  if (pkg.error) return pkg.error;
  const declared = ['dependencies', 'devDependencies', 'optionalDependencies']
    .map((field) => pkg.doc?.[field]?.[key])
    .find((v) => typeof v === 'string');
  if (declared === undefined) {
    return fail('not-declared', `${pkgRead.rel}: ${key} is not a direct dependency`);
  }
  if (declared !== entry.version) {
    return fail(
      'range',
      `${pkgRead.rel}: ${key} is declared as ${JSON.stringify(declared)}, the lock holds ` +
        `${entry.version} — declare the exact version`,
    );
  }
  return exact(entry.version, read.rel, key);
}

/** uv / PEP 503 name normalisation: case-insensitive, `-`/`_`/`.` equivalent. */
const pyName = (n) =>
  String(n)
    .toLowerCase()
    .replace(/[-_.]+/g, '-');

function uvLock(root, rel, key) {
  const read = readInside(root, rel);
  if (read.error) return read.error;
  const versions = [];
  for (const block of read.text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = block.match(/^name\s*=\s*"([^"]+)"/m);
    if (!name || pyName(name[1]) !== pyName(key)) continue;
    const version = block.match(/^version\s*=\s*"([^"]+)"/m);
    if (!version) return fail('malformed', `${read.rel}: ${key} has no version`);
    versions.push(version[1]);
  }
  if (!versions.length) return fail('not-found', `${read.rel}: no package named ${key}`);
  if (versions.length > 1) {
    return fail(
      'ambiguous',
      `${read.rel}: ${key} is locked ${versions.length} times (${versions.join(', ')})`,
    );
  }
  return exact(versions[0], read.rel, key);
}

function toolsLock(root, rel, key) {
  const read = readInside(root, rel);
  if (read.error) return read.error;
  const lock = parseJson(read);
  if (lock.error) return lock.error;
  const entry = lock.doc?.[key];
  if (!entry || typeof entry !== 'object') return fail('not-found', `${read.rel}: no entry ${key}`);
  return exact(entry.version, read.rel, key);
}

function requirements(root, rel, key) {
  const read = readInside(root, rel);
  if (read.error) return read.error;
  // Join `\`-continued lines so a requirement and its hashes read as one logical line.
  const logical = read.text.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  const hits = [];
  for (const line of logical) {
    const m = line.trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*==\s*([^\s;]+)/);
    if (m && pyName(m[1]) === pyName(key))
      hits.push({ version: m[2], hashed: /--hash=/.test(line) });
  }
  if (!hits.length) return fail('not-found', `${read.rel}: no \`${key}==\` line`);
  if (hits.length > 1)
    return fail('ambiguous', `${read.rel}: ${key} is pinned ${hits.length} times`);
  if (!hits[0].hashed) return fail('unhashed', `${read.rel}: ${key} carries no --hash`);
  return exact(hits[0].version, read.rel, key);
}

function versionFile(root, rel, key) {
  const read = readInside(root, rel);
  if (read.error) return read.error;
  const lines = read.text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length !== 1)
    return fail('malformed', `${read.rel}: expected exactly one version line`);
  return exact(lines[0].replace(/^v/, ''), read.rel, key);
}

/**
 * Resolves one typed pin.
 *
 * @param {string} root repository root
 * @param {unknown} pin `{ kind, path?, key }`
 * @param {{ runtimes?: Record<string, unknown> }} [opts] the manifest's `runtimes`, for `runtime`
 * @returns {{ok: true, version: string, provenance: string} | {ok: false, error: string, why:
 * string}}
 */
export function resolvePin(root, pin, opts = {}) {
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)) {
    return fail('malformed', `a pin is an object { kind, path?, key }, not ${JSON.stringify(pin)}`);
  }
  const { kind, key } = pin;
  if (!Object.hasOwn(PIN_KINDS, kind)) {
    return fail(
      'unknown-kind',
      `pin kind ${JSON.stringify(kind)} is not one of ${Object.keys(PIN_KINDS).join('/')}`,
    );
  }
  if (typeof key !== 'string' || !key) return fail('malformed', `a ${kind} pin needs a key`);
  if (kind === 'runtime') {
    const target = opts.runtimes?.[key];
    if (!target) return fail('not-found', `no runtimes.${key} pin to resolve through`);
    if (target.kind === 'runtime') {
      return fail('malformed', `runtimes.${key} is itself a runtime pin — it must name a source`);
    }
    return resolvePin(root, target, {});
  }
  const rel = pin.path ?? PIN_KINDS[kind];
  if (!rel) return fail('malformed', `a ${kind} pin needs a path`);
  switch (kind) {
    case 'npm-lock':
      return npmLock(root, rel, key);
    case 'uv-lock':
      return uvLock(root, rel, key);
    case 'tools-lock':
      return toolsLock(root, rel, key);
    case 'requirements':
      return requirements(root, rel, key);
    default:
      return versionFile(root, rel, key);
  }
}
