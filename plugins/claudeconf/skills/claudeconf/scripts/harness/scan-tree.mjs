#!/usr/bin/env node
// scan-tree.mjs — run a whole-tree scanner over the CANDIDATE tree (contract §2.5 / AD10).
//
// The gate's whole-tree scanners must scan what CI scans: the tracked content of the commit,
// not whatever lies in the working directory. Scanning `.` locally reads ignored build output,
// local `.env` files and untracked scratch — the source of every false positive the field
// reported — while CI's checkout contains none of it. So this materialises the INDEX into a
// temporary directory and runs the scanner there:
//   * staged additions and modifications are IN — the index is exactly what the next commit
//     carries, and on a clean tree it IS HEAD, which is what CI checks out;
//   * staged deletions, untracked files and ignored files are OUT, by construction;
//   * unstaged edits to tracked files are NOT part of the candidate — they are reported, and
//     the pre-commit tier scans them when they are staged.
// No file list is passed to the scanner, so there is no argument-length chunking and no
// filename escaping to get wrong. The scanner runs WITHOUT a shell and its exit status is this
// script's exit status; the temporary tree is removed whatever happens.
//
// USAGE  node .claudeconf/bin/scan-tree.mjs [--root <dir>] -- <scanner> <args… with ONE {tree}>
// EXIT   the scanner's own status · 2 usage, or an index with nothing in it · 127 the scanner
//        could not be started
//
// Dependency-free: Node builtins and git.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

const USAGE = 'usage: scan-tree.mjs [--root <dir>] -- <scanner> <args… with exactly one {tree}>';
const TOKEN = '{tree}';

function usage(message) {
  process.stderr.write(`scan-tree: ${message}\n${USAGE}\n`);
  process.exit(2);
}

function parse(argv) {
  const sep = argv.indexOf('--');
  if (sep === -1) usage('missing `--` before the scanner command');
  const own = argv.slice(0, sep);
  const scanner = argv.slice(sep + 1);
  let root = null;
  for (let i = 0; i < own.length; i++) {
    if (own[i] === '--root' && own[i + 1]) root = resolve(own[++i]);
    else usage(`unknown argument ${JSON.stringify(own[i])}`);
  }
  if (!scanner.length) usage('no scanner command after `--`');
  const occurrences = scanner.reduce((n, a) => n + a.split(TOKEN).length - 1, 0);
  if (occurrences !== 1)
    usage(`the scanner command must contain ${TOKEN} exactly once (found ${occurrences})`);
  return { root, scanner };
}

function git(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function main(argv) {
  const opts = parse(argv);
  let root = opts.root;
  if (!root) {
    const top = git(process.cwd(), ['rev-parse', '--show-toplevel']);
    if (top.status !== 0) usage('not inside a git work tree (pass --root <dir>)');
    root = top.stdout.trim();
  }
  const tracked = git(root, ['ls-files', '-z']);
  if (tracked.status !== 0) usage(`git ls-files failed: ${tracked.stderr.trim()}`);
  if (!tracked.stdout) usage('the index is empty — there is no candidate tree to scan');

  const unstaged = git(root, ['diff', '--name-only', '-z']).stdout.split('\0').filter(Boolean);
  if (unstaged.length) {
    process.stderr.write(
      `scan-tree: ${unstaged.length} tracked file(s) have UNSTAGED edits, which are not part of ` +
        `the candidate scanned here (pre-commit scans them once staged): ` +
        `${unstaged.slice(0, 5).join(', ')}${unstaged.length > 5 ? ', …' : ''}\n`,
    );
  }

  const tree = mkdtempSync(join(tmpdir(), 'claudeconf-scan-tree-'));
  try {
    const out = git(root, ['checkout-index', '--all', '--force', `--prefix=${tree}/`]);
    if (out.status !== 0) {
      process.stderr.write(`scan-tree: git checkout-index failed: ${out.stderr.trim()}\n`);
      return 2;
    }
    const [command, ...args] = opts.scanner.map((a) => a.split(TOKEN).join(tree));
    const r = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
    if (r.error) {
      process.stderr.write(
        `scan-tree: could not start ${command}: ${r.error.code ?? r.error.message}\n`,
      );
      return 127;
    }
    // A scanner killed by a signal did not pass.
    return r.status ?? 1;
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

process.exit(main(process.argv.slice(2)));
