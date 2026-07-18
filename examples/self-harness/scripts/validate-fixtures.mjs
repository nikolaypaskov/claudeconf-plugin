#!/usr/bin/env node
// Structural validation for the eval fixtures: every fixture must stay a
// contract-conformant example of the harness (harness-contract.md §2/§3),
// including the multi-stack tools[] manifest form (§2.2.1). Dependency-free;
// wired into the dev repo's CI and gate so fixture regressions fail the pipe.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixturesDir = join(root, 'evals/fixtures');
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
const TIERS = new Set(['edit', 'pre-commit', 'pre-push', 'gate', 'ci']);
// Contract §3.1: no floating ranges, wildcards, or composite strings.
const BAD_VERSION = /[\^~><=*xX+ ]/;
const REQUIRED_ARTIFACTS = [
  '.claudeconf/manifest.json',
  '.claudeconf/trufflehog-exclude.txt',
  '.claudeconf/rules',
  'lefthook.yml',
  '.github/workflows/ci.yml',
  '.github/dependabot.yml',
  '.github/CODEOWNERS',
  '.editorconfig',
  '.gitattributes',
  '.claude/settings.json',
];

const failures = [];
const fixtures = readdirSync(fixturesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

for (const fixture of fixtures) {
  const dir = join(fixturesDir, fixture);
  const fail = (msg) => failures.push(`${fixture}: ${msg}`);

  for (const rel of REQUIRED_ARTIFACTS) {
    if (!existsSync(join(dir, rel))) fail(`missing required artifact ${rel}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, '.claudeconf/manifest.json'), 'utf8'));
  } catch (err) {
    fail(`manifest unreadable: ${err.message}`);
    continue;
  }

  // Profiles are archived, not replaced (constitution §6): validate each harness
  // against its RECORDED profile. Fixtures in this repo are expected at the
  // current profile, but the per-profile split keeps older checks executable.
  const profile = manifest.constitutionVersion;
  if (!['2', '3'].includes(profile)) {
    fail(`unknown constitutionVersion ${JSON.stringify(profile)} (expected "2" or "3")`);
  }

  if (profile === '3') {
    if (typeof manifest.agentUse !== 'boolean') {
      fail('profile 3 requires a boolean agentUse (constitution §4.7)');
    } else if (manifest.agentUse === false && !manifest.agentUseRationale) {
      fail('agentUse: false requires agentUseRationale (contract §2.3)');
    }
    const hr = manifest.hookRunner;
    if (typeof hr !== 'object' || !hr?.name || !hr?.version || BAD_VERSION.test(hr.version)) {
      fail(`profile 3 requires hookRunner {name, version(pinned)}, got ${JSON.stringify(hr)}`);
    }
    try {
      const ledger = JSON.parse(readFileSync(join(dir, '.claudeconf/suppressions.json'), 'utf8'));
      if (!Array.isArray(ledger)) fail('suppressions.json must be an array');
      else {
        for (const e of ledger) {
          if (!e.fingerprint || !e.file || !e.rule || !e.rationale) {
            fail(`suppressions.json entry missing fields: ${JSON.stringify(e)}`);
          }
        }
      }
    } catch (err) {
      fail(`suppression ledger unreadable: ${err.message}`);
    }
    if (!existsSync(join(dir, 'scripts/check-suppressions.mjs'))) {
      fail('missing scripts/check-suppressions.mjs (constitution §4.7.2)');
    }
    const owners = existsSync(join(dir, '.github/CODEOWNERS'))
      ? readFileSync(join(dir, '.github/CODEOWNERS'), 'utf8')
      : '';
    for (const path of [
      '/.github/workflows/',
      '/.github/CODEOWNERS',
      '/lefthook.yml',
      '/.claudeconf/',
      '/.claude/',
    ]) {
      if (!owners.includes(path)) fail(`CODEOWNERS lacks control-plane entry ${path} (§4.7.1)`);
    }
    // The editor-hardening module is conditional on agentUse (contract §1) —
    // an opted-out harness with a rationale is valid without it.
    if (manifest.agentUse === true) {
      const settings = JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8'));
      if (!Array.isArray(settings.permissions?.deny) || settings.permissions.deny.length === 0) {
        fail('agent-hardening deny module missing from .claude/settings.json');
      }
      if (!settings.hooks?.SessionStart?.length) {
        fail('SessionStart advisory hook missing from .claude/settings.json');
      }
    }
  }

  // ci.auditors: pinned syntax + security auditors for the workflow format.
  const auditors = manifest.ci?.auditors;
  if (!Array.isArray(auditors) || auditors.length < 2) {
    fail('ci.auditors must list the pinned syntax + security workflow auditors');
  } else {
    for (const a of auditors) {
      if (!a.tool || !a.version || a.version === 'n/a' || BAD_VERSION.test(a.version)) {
        fail(`ci.auditors entry invalid: ${JSON.stringify(a)}`);
      }
    }
  }

  // SAST rules provenance (contract §2.3): required once a vendored rules dir exists.
  const rules = manifest.milestones?.sast?.rules;
  if (existsSync(join(dir, '.claudeconf/rules'))) {
    if (!rules?.source || !rules?.license) {
      fail('sast.rules provenance missing (source/license) for vendored .claudeconf/rules/');
    } else if ((rules.source === 'hand-authored') !== (rules.ref === 'n/a')) {
      fail('sast.rules: "hand-authored" and ref "n/a" must go together (contract §2.3)');
    }
  }

  // Supply-chain admission (constitution §4.6): updater cooldown + node install path.
  const dependabot = readFileSync(join(dir, '.github/dependabot.yml'), 'utf8');
  if (!dependabot.includes('cooldown:')) {
    fail('dependabot.yml lacks a cooldown block (constitution §4.6)');
  }
  if ((manifest.stacks ?? []).includes('node')) {
    if (!existsSync(join(dir, 'package-lock.json'))) {
      fail('node stack without a committed package-lock.json (frozen installs, §8)');
    }
    if (!existsSync(join(dir, '.npmrc'))) {
      fail('node stack without .npmrc release-age quarantine (constitution §4.6)');
    } else if (!readFileSync(join(dir, '.npmrc'), 'utf8').includes('engine-strict=true')) {
      fail('.npmrc lacks engine-strict=true (npm floor for min-release-age)');
    }
  }
  if ((manifest.stacks ?? []).includes('python')) {
    if (!existsSync(join(dir, 'uv.lock'))) {
      fail('python stack without a committed uv.lock (frozen installs, §8)');
    }
  }

  // Gate must carry the version-assertion + workflow-audit jobs (contract §3.3/§3.4).
  const lefthook = readFileSync(join(dir, 'lefthook.yml'), 'utf8');
  if (!lefthook.includes('assert-tool-versions')) {
    fail('lefthook gate lacks the tool-versions assertion job (contract §3.4)');
  }
  if (!lefthook.includes('zizmor') || !lefthook.includes('actionlint')) {
    fail('lefthook gate lacks the workflow-audit job (contract §3.3)');
  }
  if (profile === '3' && !lefthook.includes('check-suppressions')) {
    fail('lefthook gate lacks the suppressions job (constitution §4.7.2)');
  }
  if (!existsSync(join(dir, 'scripts/assert-tool-versions.sh'))) {
    fail('missing scripts/assert-tool-versions.sh');
  }

  for (const key of MILESTONES) {
    const entry = manifest.milestones?.[key];
    if (!entry) {
      fail(`manifest missing milestone "${key}"`);
      continue;
    }
    // §2.2.1: single entries carry tool+version, multi-stack entries tools[] — never both.
    const single = 'tool' in entry;
    const multi = 'tools' in entry;
    if (single === multi) fail(`${key}: need exactly one of tool / tools[]`);
    for (const unit of multi ? entry.tools : [entry]) {
      if (multi && !unit.stack) fail(`${key}: tools[] element missing "stack"`);
      if (!unit.tool) fail(`${key}: empty tool name`);
      const v = unit.version;
      if (!v || (v !== 'n/a' && BAD_VERSION.test(v))) {
        fail(`${key}: invalid pinned version ${JSON.stringify(v)}`);
      }
    }
    const tiers = entry.tiers ?? [];
    if (!tiers.length || !tiers.every((t) => TIERS.has(t))) {
      fail(`${key}: invalid tiers ${JSON.stringify(tiers)}`);
    }
    for (const t of ['gate', 'ci']) {
      if (!tiers.includes(t))
        fail(`${key}: tiers must include "${t}" (Gate ≡ CI, constitution §1)`);
    }
  }

  // Supply-chain checks on the managed CI block only — hand-written jobs in the
  // existing-with-ci fixture are deliberately untouched (additive mode).
  const ci = readFileSync(join(dir, '.github/workflows/ci.yml'), 'utf8');
  const managed = ci.split('>>> claudeconf managed >>>').pop() ?? '';
  // Anchor to real YAML step lines so prose mentions of `uses:` in comments don't match.
  for (const match of managed.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)) {
    const ref = match[1];
    if (ref.startsWith('docker://')) {
      // Tags are mutable; only an immutable digest pin is acceptable (§4.1/§8).
      if (!/@sha256:[0-9a-f]{64}$/.test(ref)) {
        fail(`docker action not pinned by @sha256: digest: ${ref}`);
      }
    } else if (!/@[0-9a-f]{40}\b/.test(ref)) {
      fail(`managed uses: not SHA-pinned: ${ref}`);
    }
  }
  if (!managed.includes('--exclude-paths')) fail('CI secret scan lacks --exclude-paths');
  if (!ci.includes('permissions:')) fail('CI lacks a permissions block');
  // Frozen installs only — a bare `npm install` / `pip install` re-resolves the
  // tree (§8). The pinned `npm install -g npm@x.y.z` floor step is the one allowed
  // global-install exception.
  if (/run: npm install (?!-g npm@\d)/.test(managed)) {
    fail('managed CI uses unfrozen `npm install` (use `npm ci`)');
  }
  if (/pip install/.test(managed)) {
    fail('managed CI uses fresh-resolving `pip install` (use `uv sync --locked`)');
  }
  if ((manifest.stacks ?? []).includes('python') && !managed.includes('uv sync --locked')) {
    fail('python stack CI lacks a frozen `uv sync --locked` install');
  }
  // The suppression checker must run at BOTH boundaries (contract §1): gate
  // (checked above via lefthook.yml) and CI.
  if (profile === '3' && !managed.includes('check-suppressions')) {
    fail('managed CI lacks the suppression-ledger step (constitution §4.7.2)');
  }
}

if (failures.length > 0) {
  console.error(`validate-fixtures: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`validate-fixtures: ${fixtures.length} fixtures conform`);
