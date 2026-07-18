#!/usr/bin/env node
// Suppression approval gate (constitution §4.7.2 / contract §1): any ADDED or
// CHANGED suppression — inline tokens, widened scanner exclusions, or
// weakening edits to generated control configs — must have an entry in
// .claudeconf/suppressions.json. The ledger is control-plane material, so the
// code-owner review of the ledger change IS the human sign-off; this check
// never turns green by re-running.
//
// Fingerprints are bound to the OCCURRENCE (file + rule + new-file line number
// + content): moving or duplicating an approved suppression requires a fresh
// approval; unrelated edits that shift the line also re-require approval —
// churn is accepted because it fails safe.
//
// Base resolution: $SUPPRESSION_BASE, else merge-base with origin/main, else
// FAIL CLOSED with remediation (shallow clones need fetch-depth: 0).
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const LEDGER = join(root, '.claudeconf/suppressions.json');

// Inline tokens that silence a control.
const TOKENS =
  /(biome-ignore|eslint-disable|nosemgrep|(?<![\w-])noqa\b|type:\s*ignore|trufflehog:ignore|zizmor:\s*ignore)/;
// Files where ANY added line widens an exclusion (rule = exclusion-widening).
const WATCHED = [/\.claudeconf\/trufflehog-exclude\.txt$/, /(^|\/)zizmor\.yml$/];
// Generated control configs: added lines matching weakening PATTERNS are
// flagged (rule = config-weakening). A best-effort net — CODEOWNERS review of
// these control-plane files is the backstop for what the patterns miss.
const CONTROL_CONFIGS = [
  /(^|\/)biome\.json$/,
  /(^|\/)eslint\.config\.(js|mjs|cjs)$/,
  /(^|\/)\.eslintrc(\.\w+)?$/,
  /(^|\/)\.prettierignore$/,
  /(^|\/)ruff\.toml$/,
  /(^|\/)mypy\.ini$/,
  /(^|\/)pyproject\.toml$/,
  /(^|\/)tsconfig(\..+)?\.json$/,
];
const WEAKENING = /(ignore|exclude|disable|skip|"off"|'off'|=\s*off\b|allowlist|nofail)/i;
// The ledger itself and this script are reviewed as control-plane changes, not
// re-flagged as suppressions. Markdown is excluded because suppression tokens
// are INERT there — no scanner honors them in prose — and documentation must
// be able to name them.
const IGNORED = [/\.claudeconf\/suppressions\.json$/, /scripts\/check-suppressions\.mjs$/, /\.md$/];

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

let base = process.env.SUPPRESSION_BASE ?? '';
if (!base) {
  try {
    base = git('merge-base', 'HEAD', 'origin/main').trim();
  } catch {
    try {
      base = git('merge-base', 'HEAD', 'main').trim();
    } catch {
      console.error(
        'check-suppressions: cannot resolve a merge base (shallow clone?). ' +
          'Set SUPPRESSION_BASE or check out with fetch-depth: 0. Failing closed.',
      );
      process.exit(1);
    }
  }
}

let ledger;
try {
  ledger = JSON.parse(readFileSync(LEDGER, 'utf8'));
} catch (err) {
  console.error(`check-suppressions: ledger unreadable: ${err.message}`);
  process.exit(1);
}
const approved = new Set(ledger.map((e) => e.fingerprint));

const fingerprint = (file, rule, lineNo, line) =>
  createHash('sha256')
    .update(`${file}\n${rule}\n${lineNo}\n${line.trim()}`)
    .digest('hex')
    .slice(0, 16);

// Diff base -> working tree so the gate catches uncommitted changes too.
const diff = git('diff', '--unified=0', '--no-color', base, '--');
const violations = [];
let file = null;
let lineNo = 0;
for (const raw of diff.split('\n')) {
  if (raw.startsWith('+++ b/')) {
    file = raw.slice(6);
    continue;
  }
  const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
  if (hunk) {
    lineNo = Number(hunk[1]) - 1;
    continue;
  }
  if (file === null || !raw.startsWith('+') || raw.startsWith('+++')) continue;
  lineNo += 1;
  if (IGNORED.some((re) => re.test(file))) continue;
  const line = raw.slice(1);
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) continue;
  const watched = WATCHED.some((re) => re.test(file));
  const config = CONTROL_CONFIGS.some((re) => re.test(file)) && WEAKENING.test(line);
  const token = line.match(TOKENS);
  if (!watched && !config && !token) continue;
  const rule = token ? token[1] : watched ? 'exclusion-widening' : 'config-weakening';
  const fp = fingerprint(file, rule, lineNo, line);
  if (!approved.has(fp)) violations.push({ file, rule, fp, lineNo, line: trimmed });
}

if (violations.length > 0) {
  console.error(`check-suppressions: ${violations.length} unapproved suppression(s):`);
  for (const v of violations) {
    console.error(`  - ${v.file}:${v.lineNo} [${v.rule}] fingerprint=${v.fp}\n      ${v.line}`);
  }
  console.error(
    'Approval path: add {fingerprint, file, rule, rationale} to ' +
      '.claudeconf/suppressions.json in this change — the code-owner review of the ' +
      'ledger edit is the human sign-off (constitution §4.7.2).',
  );
  process.exit(1);
}
console.log('check-suppressions: no unapproved suppressions');
