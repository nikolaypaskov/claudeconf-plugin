#!/usr/bin/env node
// provision-tools.mjs — pinned-toolchain provisioning (contract §2.5, wiring-principles §8).
// Runs ONCE, before the gate; the gate then invokes only what this left behind — nothing is
// fetched at hook or CI execution time (constitution §4.2/§4.3).
//
// WHAT IT INSTALLS, AND FROM WHERE — data, not code: nothing below names a tool.
//   * every entry of `.claudeconf/tools.lock.json`: the asset for this platform, downloaded,
//     sha256-verified against the digest the lock records (copied from the release's OWN
//     checksum file), extracted, installed, and made to SAY its pinned version;
//   * every manifest tool pinned with `kind: "requirements"`: installed by the provisioned `uv`
//     into one venv on the interpreter `runtimes.python` pins, `--require-hashes`, no deps, and
//     reached through a launcher that puts the venv FIRST on PATH (a tool that locates its
//     companions through PATH otherwise picks up an ambient install — observed with semgrep).
//
// The tools directory holds ONLY what this creates; anything else in it is a refusal, before
// any download and again after (it goes FIRST on PATH for the whole gate).
//
// USAGE  node .claudeconf/bin/provision-tools.mjs [--root <dir>] [--print-path]
// EXIT   0 provisioned (or --print-path) · 2 usage · 3 unsupported platform
//        4 integrity: missing/malformed pin, checksum mismatch, wrong version installed, a
//          tools directory holding something unexpected · 5 missing prerequisite
//
// Dependency-free: Node builtins, plus `tar` for `.tar.gz` assets.

import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { gunzipSync } from 'node:zlib';
import { reportedVersion, resolvePin } from './lib/pins.mjs';

const LOCK_REL = '.claudeconf/tools.lock.json';
const MANIFEST_REL = '.claudeconf/manifest.json';
const PLATFORMS = { 'linux-x64': 1, 'linux-arm64': 1, 'darwin-x64': 1, 'darwin-arm64': 1 };

class Refusal extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const die = (code, message) => {
  throw new Refusal(code, message);
};
const log = (m) => process.stdout.write(`provision-tools: ${m}\n`);

function parseArgs(argv) {
  const opts = { root: null, printPath: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--print-path') opts.printPath = true;
    else if (argv[i] === '--root' && argv[i + 1]) opts.root = resolve(argv[++i]);
    else die(2, 'usage: provision-tools.mjs [--root <dir>] [--print-path]');
  }
  return opts;
}

function repoRoot(explicit) {
  if (explicit) return explicit;
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (r.status !== 0) die(2, 'not inside a git work tree (pass --root <dir>)');
  return r.stdout.trim();
}

const toolsDir = () =>
  join(process.env.RUNNER_TEMP || process.env.TMPDIR || tmpdir(), 'claudeconf-tools');

function platformKey() {
  const os = { linux: 'linux', darwin: 'darwin' }[process.platform];
  const arch = { x64: 'x64', arm64: 'arm64' }[process.arch];
  const key = os && arch ? `${os}-${arch}` : `${process.platform}-${process.arch}`;
  if (!PLATFORMS[key]) {
    die(
      3,
      `unsupported platform ${key} — every binary is pinned per platform and there is no ` +
        `unpinned fallback`,
    );
  }
  return key;
}

function readJson(root, rel) {
  let text;
  try {
    text = readFileSync(join(root, rel), 'utf8');
  } catch (e) {
    die(4, `${rel}: ${e.code === 'ENOENT' ? 'missing' : e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    return die(4, `${rel}: not JSON (${e.message.split('\n')[0]})`);
  }
}

/** Every manifest holder pinned with `kind: "requirements"`. */
function requirementTools(manifest) {
  const holders = [];
  for (const entry of Object.values(manifest?.milestones ?? {})) {
    for (const h of Array.isArray(entry?.tools) ? entry.tools : [entry]) holders.push(h);
  }
  for (const a of manifest?.ci?.auditors ?? []) holders.push(a);
  return holders.filter((h) => h?.pin?.kind === 'requirements' && typeof h.tool === 'string');
}

/** The ONLY names this run may leave in the tools directory. */
function allowedNames(lock, reqTools) {
  const names = new Set(Object.keys(lock));
  if (reqTools.length) {
    names.add('pyenv');
    for (const t of reqTools) names.add(t.tool);
  }
  return names;
}

function assertOnlyProvisioned(dir, allowed, when) {
  if (!existsSync(dir)) return;
  const unexpected = readdirSync(dir).filter((n) => !allowed.has(n));
  if (unexpected.length) {
    die(
      4,
      `${dir} holds ${unexpected.join(', ')} — this directory goes FIRST on PATH for the whole ` +
        `gate, and provisioning creates only: ${[...allowed].join(', ')}. Refusing (${when}). ` +
        `Remove it and re-run: rm -rf "${dir}"`,
    );
  }
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function download(url) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // `globalThis.`: lint-clean under a project linter that knows no Node globals (§1).
      const res = await globalThis.fetch(url, {
        signal: globalThis.AbortSignal.timeout(120_000),
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error('empty body');
      return buf;
    } catch (e) {
      last = e;
    }
  }
  return die(4, `download failed (${last?.message}): ${url}`);
}

function validateAsset(tool, platform, asset) {
  if (!asset)
    die(
      4,
      `${LOCK_REL}: no pinned asset for ${tool} on ${platform} — refusing to install it unpinned`,
    );
  const { url, sha256: digest, archive, member } = asset;
  if (!/^[0-9a-f]{64}$/.test(digest ?? '')) {
    die(
      4,
      `${tool} on ${platform}: sha256 ${JSON.stringify(digest)} is not 64 lowercase hex — a ` +
        `missing or malformed pin is a refusal, not a skipped check`,
    );
  }
  if (!/^https?:\/\//.test(url ?? '')) die(4, `${tool} on ${platform}: no download url`);
  if (!['tar.gz', 'gz', 'raw'].includes(archive)) {
    die(
      4,
      `${tool} on ${platform}: archive ${JSON.stringify(archive)} is not one of tar.gz, gz, raw`,
    );
  }
  if (archive === 'tar.gz' && !member) die(4, `${tool} on ${platform}: no archive member named`);
}

async function installBinary(tool, entry, platform, dir, work) {
  const asset = entry.platforms?.[platform];
  validateAsset(tool, platform, asset);
  log(`fetching ${tool} ${entry.version} for ${platform} from ${asset.url}`);
  const buf = await download(asset.url);
  const got = sha256(buf);
  if (got !== asset.sha256) {
    die(
      4,
      `checksum mismatch for ${tool} on ${platform}: expected ${asset.sha256}, got ${got}, from ` +
        `${asset.url} — refusing to install`,
    );
  }
  let binary;
  if (asset.archive === 'raw') binary = buf;
  else if (asset.archive === 'gz') binary = gunzipSync(buf);
  else {
    const archive = join(work, `${tool}.tar.gz`);
    writeFileSync(archive, buf);
    const out = join(work, tool);
    mkdirSync(out);
    const r = spawnSync('tar', ['-xzf', archive, '-C', out, asset.member], { encoding: 'utf8' });
    if (r.error) die(5, 'tar not found — release assets ship as .tar.gz');
    if (r.status !== 0)
      die(4, `${tool} archive does not contain the pinned member ${asset.member}`);
    binary = readFileSync(join(out, asset.member));
  }
  if (!binary.length) die(4, `${tool}: the installed member is empty`);
  const target = join(dir, tool);
  rmSync(target, { force: true });
  writeFileSync(target, binary);
  chmodSync(target, 0o755);
}

/** The installed binary must SAY it is the pinned version. */
function verifyVersion(path, tool, expected) {
  const r = spawnSync(path, ['--version'], { encoding: 'utf8' });
  const actual = reportedVersion(`${r.stdout ?? ''}\n${r.stderr ?? ''}`);
  if (actual !== expected) {
    die(4, `${path} reports ${actual ?? '<unparsable>'} but ${tool} is pinned at ${expected}`);
  }
}

function provisionPythonTools(root, manifest, reqTools, dir) {
  const files = new Set(reqTools.map((t) => t.pin.path));
  if (files.size !== 1) {
    die(
      4,
      `requirements-pinned tools must share ONE hash-locked file; found ${[...files].join(', ')}`,
    );
  }
  const reqRel = [...files][0];
  const python = resolvePin(root, manifest?.runtimes?.python ?? null, {});
  if (!python.ok)
    die(4, `runtimes.python must pin the interpreter the hashes were compiled for — ${python.why}`);
  const reqText = readFileSync(join(root, reqRel), 'utf8');
  if (!reqText.split('\n').some((l) => l.trim() === `# interpreter: cpython-${python.version}`)) {
    die(
      4,
      `${reqRel} does not record '# interpreter: cpython-${python.version}' — hashes compiled ` +
        `for one interpreter and installed by another is a pin in name only`,
    );
  }
  const uv = join(dir, 'uv');
  if (!existsSync(uv))
    die(4, `requirements-pinned tools need a provisioned uv: add it to ${LOCK_REL}`);
  const pyenv = join(dir, 'pyenv');
  const run = (args, what) => {
    const r = spawnSync(uv, args, { encoding: 'utf8' });
    if (r.status !== 0)
      die(4, `${what} failed — no unpinned fallback is attempted\n${r.stderr ?? ''}`);
  };
  run(
    ['venv', '--clear', '--managed-python', '--python', python.version, pyenv],
    `a venv on cpython-${python.version}`,
  );
  const actual = spawnSync(
    join(pyenv, 'bin', 'python'),
    ['-c', 'import platform; print(platform.python_version())'],
    { encoding: 'utf8' },
  ).stdout?.trim();
  if (actual !== python.version)
    die(4, `venv interpreter is ${actual}, runtimes.python pins ${python.version}`);
  run(
    [
      'pip',
      'install',
      '--python',
      join(pyenv, 'bin', 'python'),
      '--require-hashes',
      '--no-deps',
      '-r',
      join(root, reqRel),
    ],
    `the hash-locked install from ${reqRel}`,
  );
  for (const t of reqTools) {
    const inVenv = join(pyenv, 'bin', t.tool);
    if (!existsSync(inVenv)) die(4, `${reqRel} installed no ${t.tool} into ${pyenv}`);
    const launcher = join(dir, t.tool);
    rmSync(launcher, { force: true });
    writeFileSync(
      launcher,
      `#!/bin/sh\n# Generated by provision-tools.mjs — do not edit.\nexec env ` +
        `PATH="${join(pyenv, 'bin')}:$PATH" "${inVenv}" "$@"\n`,
    );
    chmodSync(launcher, 0o755);
    const pinned = resolvePin(root, t.pin, {});
    if (!pinned.ok) die(4, `${t.tool}: ${pinned.why}`);
    verifyVersion(launcher, t.tool, pinned.version);
  }
}

async function main(argv) {
  const opts = parseArgs(argv);
  const root = repoRoot(opts.root);
  const dir = toolsDir();
  const lock = readJson(root, LOCK_REL);
  const manifest = readJson(root, MANIFEST_REL);
  const reqTools = requirementTools(manifest);
  const allowed = allowedNames(lock, reqTools);

  if (opts.printPath) {
    // Checked here too: this is the mode piped into PATH, so printing a directory that holds a
    // planted binary would hand the caller exactly the compromise.
    assertOnlyProvisioned(dir, allowed, 'before printing the PATH');
    process.stdout.write(`${dir}\n`);
    return 0;
  }

  const platform = platformKey();
  assertOnlyProvisioned(dir, allowed, 'before installing anything');
  // 0700 on CREATION; an existing directory's mode is not fixable here, which is why the
  // enumeration above is the control.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const work = mkdtempSync(join(tmpdir(), 'claudeconf-provision-'));
  try {
    for (const [tool, entry] of Object.entries(lock)) {
      const pinned = resolvePin(root, { kind: 'tools-lock', key: tool }, {});
      if (!pinned.ok) die(4, `${tool}: ${pinned.why}`);
      await installBinary(tool, entry, platform, dir, work);
      verifyVersion(join(dir, tool), tool, pinned.version);
    }
    if (reqTools.length) provisionPythonTools(root, manifest, reqTools, dir);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  assertOnlyProvisioned(dir, allowed, 'after provisioning');
  if (statSync(dir).isDirectory() && process.env.GITHUB_PATH) {
    appendFileSync(process.env.GITHUB_PATH, `${dir}\n`);
  } else {
    log(`add to PATH: export PATH="${dir}:$PATH"`);
  }
  log(
    `${platform}: ${[...allowed].filter((n) => n !== 'pyenv').join(', ')} provisioned and ` +
      `version-verified`,
  );
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`provision-tools: ${e.message}\n`);
    process.exit(e instanceof Refusal ? e.code : 4);
  },
);
