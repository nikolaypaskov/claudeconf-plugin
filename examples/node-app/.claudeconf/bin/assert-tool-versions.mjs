#!/usr/bin/env node
// assert-tool-versions.mjs — gate-tier version enforcement (contract §3.4, §2.5). Proves the
// binaries that WILL execute are the pinned ones. Version enforcement, not provenance:
// provision-tools.mjs is what makes the bytes checksum-verified.
//
// What it asserts — read from the manifest's typed pins, never from literals in this file:
//   * every tool pinned `tools-lock` or `requirements` (provisioned, invoked by bare name):
//     `<tool> --version` on PATH must report the resolved pin;
//   * the hook RUNNER, resolved the way the INSTALLED SHIM resolves it — $LEFTHOOK_BIN → the
//     `lefthook:` path in the root then managed hook config → PATH → node_modules — because the
//     runner decides whether any hook runs at all, and a global one at another version can run
//     every hook while the manifest and the lockfile both read correctly;
//   * `runtimes.node`: the Node executing this script — the one the gate runs on.
// Tools pinned `npm-lock`/`uv-lock` are not probed: a frozen install from the lockfile is what
// puts them on disk, so their version is the lock's by construction (D1 reconciles the pin).
//
// USAGE  node .claudeconf/bin/assert-tool-versions.mjs [--root <dir>]
// EXIT   0 every probed binary matches · 1 a mismatch or an unparsable version · 2 usage or an
//        unusable manifest / pin
//
// Dependency-free: Node builtins only.

import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { reportedVersion, resolvePin } from './lib/pins.mjs';

const MANIFEST_REL = '.claudeconf/manifest.json';
const PROBED_KINDS = new Set(['tools-lock', 'requirements']);

function fatal(message) {
  process.stderr.write(`assert-tool-versions: ${message}\n`);
  process.exit(2);
}

function repoRoot(argv) {
  const i = argv.indexOf('--root');
  if (i !== -1) {
    if (!argv[i + 1]) fatal('--root needs a directory');
    return resolve(argv[i + 1]);
  }
  if (argv.length) fatal(`unknown argument ${JSON.stringify(argv[0])}`);
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (r.status !== 0) fatal('not inside a git work tree (pass --root <dir>)');
  return r.stdout.trim();
}

function probe(command, args) {
  const r = spawnSync(command, args, { encoding: 'utf8' });
  if (r.error) return { version: null, why: `${command}: ${r.error.code ?? r.error.message}` };
  return { version: reportedVersion(`${r.stdout ?? ''}\n${r.stderr ?? ''}`), why: null };
}

/** The `lefthook:` path a hook config pins, root-relative, or null. */
function configuredRunner(root) {
  for (const rel of ['lefthook.yml', 'lefthook.yaml', '.claudeconf/lefthook.yml']) {
    const path = join(root, rel);
    if (!existsSync(path)) continue;
    const m = readFileSync(path, 'utf8').match(/^lefthook:\s*["']?([^"'#\s]+)["']?\s*(?:#.*)?$/m);
    if (m) return isAbsolute(m[1]) ? m[1] : join(root, m[1]);
  }
  return null;
}

/** `name` on PATH — looked up here, never through a shell (the name comes from the manifest). */
function whichOnPath(name) {
  if (!/^[\w.-]+$/.test(name)) return null;
  for (const dir of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

function resolveRunner(root, name) {
  if (process.env.LEFTHOOK_BIN) {
    const p = process.env.LEFTHOOK_BIN;
    return { path: isAbsolute(p) ? p : join(root, p), source: '$LEFTHOOK_BIN' };
  }
  const configured = configuredRunner(root);
  if (configured) return { path: configured, source: '`lefthook:` in the hook config' };
  const onPath = whichOnPath(name);
  if (onPath) return { path: onPath, source: 'PATH' };
  const local = join(root, 'node_modules', '.bin', name);
  if (existsSync(local)) return { path: local, source: 'project-local' };
  return null;
}

function main(argv) {
  const root = repoRoot(argv);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(root, MANIFEST_REL), 'utf8'));
  } catch (e) {
    fatal(`${MANIFEST_REL}: ${e.code === 'ENOENT' ? 'missing' : e.message}`);
  }
  const runtimes = manifest?.runtimes ?? {};
  const failures = [];
  const checked = [];
  const pinOf = (holder, what) => {
    if (holder?.pin === undefined) {
      fatal(`${what} records no typed pin — this script reads profile-6 manifests (contract §2.5)`);
    }
    const r = resolvePin(root, holder.pin, { runtimes });
    if (!r.ok) fatal(`${what}: the pin does not resolve — ${r.why}`);
    return r.version;
  };
  const expect = (label, expected, actual, why) => {
    if (!actual) failures.push(`cannot parse a version for ${label}${why ? ` (${why})` : ''}`);
    else if (actual !== expected) failures.push(`${label} is ${actual}, the pin is ${expected}`);
    else checked.push(`${label} ${actual}`);
  };

  const holders = [];
  for (const [key, entry] of Object.entries(manifest?.milestones ?? {})) {
    for (const h of Array.isArray(entry?.tools) ? entry.tools : [entry]) {
      holders.push([`milestones.${key}`, h]);
    }
  }
  for (const [i, a] of (manifest?.ci?.auditors ?? []).entries())
    holders.push([`ci.auditors[${i}]`, a]);
  const seen = new Set();
  for (const [where, h] of holders) {
    // A copied literal is not skippable: skipping it would leave that tool unasserted while the
    // run reports green. This script reads profile-6 manifests only.
    if (h?.tool && h.pin === undefined) pinOf(h, `${where} ${h.tool}`);
    if (!h?.tool || !PROBED_KINDS.has(h?.pin?.kind) || seen.has(h.tool)) continue;
    seen.add(h.tool);
    const expected = pinOf(h, `${where} ${h.tool}`);
    const got = probe(h.tool, ['--version']);
    expect(h.tool, expected, got.version, got.why);
  }

  const hr = manifest?.hookRunner;
  if (hr?.name) {
    const expected = pinOf(hr, 'hookRunner');
    const runner = resolveRunner(root, hr.name);
    if (!runner) {
      failures.push(
        `no hook runner resolved ($LEFTHOOK_BIN, \`lefthook:\`, PATH, node_modules) — the ` +
          `runner decides whether any hook runs at all`,
      );
    } else {
      const got = probe(runner.path, ['--version']);
      expect(
        `${hr.name} at ${runner.path} (source: ${runner.source})`,
        expected,
        got.version,
        got.why,
      );
    }
  }

  if (runtimes.node) {
    expect(
      'node (this process)',
      pinOf({ pin: runtimes.node }, 'runtimes.node'),
      process.versions.node,
    );
  }

  for (const c of checked) process.stdout.write(`assert-tool-versions: ok  ${c}\n`);
  if (failures.length) {
    for (const f of failures) process.stderr.write(`assert-tool-versions: FAIL ${f}\n`);
    process.stderr.write(
      'assert-tool-versions: provision the pinned toolchain, or re-pin through refresh\n',
    );
    return 1;
  }
  process.stdout.write(`assert-tool-versions: ${checked.length} binaries match their pins\n`);
  return 0;
}

process.exit(main(process.argv.slice(2)));
