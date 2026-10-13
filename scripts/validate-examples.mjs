// Validates every vendored example harness in examples/<name>/ with the plugin's OWN bundled
// conformance checker (plugins/claudeconf/skills/claudeconf/scripts/claudeconf-check.mjs) — the
// arbiter the skill and the doctor use — rather than a second, weaker reading of the manifest.
//
// The checker runs in advisory mode with a PATH holding only `node` and `git`, so whatever hook
// runner a machine happens to have installed cannot decide the result: the machine-state checks
// (the installed runner, the installed hooks, an uninstalled dependency tree) come back UNKNOWN
// everywhere, and any FAIL is a defect in the example's committed content.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHECKER = 'plugins/claudeconf/skills/claudeconf/scripts/claudeconf-check.mjs';

function onPath(name) {
  for (const dir of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`${name} is not on PATH`);
}

const bin = mkdtempSync(join(tmpdir(), 'claudeconf-validate-'));
symlinkSync(process.execPath, join(bin, 'node'));
symlinkSync(onPath('git'), join(bin, 'git'));

let checked = 0;
try {
  for (const dir of readdirSync('examples', { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const root = join('examples', dir.name);
    if (!existsSync(join(root, '.claudeconf', 'manifest.json'))) continue;

    const r = spawnSync(
      process.execPath,
      [CHECKER, '--root', root, '--format', 'json', '--advisory'],
      { encoding: 'utf8', env: { ...process.env, PATH: bin } },
    );
    if (r.status !== 0) throw new Error(`${root}: the checker exited ${r.status}\n${r.stderr}`);
    const report = JSON.parse(r.stdout);
    const count = (s) => report.results.filter((x) => x.status === s).length;
    const fails = report.results.filter((x) => x.status === 'FAIL');
    for (const f of fails) console.error(`FAIL ${f.id} — ${f.evidence}`);
    if (fails.length) throw new Error(`${root}: ${fails.length} check(s) FAIL`);
    console.log(
      `ok: ${root} — profile ${report.profile}, judged at ${report.judgedAt}: ` +
        `${count('PASS')} PASS, 0 FAIL, ${count('UNKNOWN')} UNKNOWN (machine state), ${count('INFO')} INFO`,
    );
    checked++;
  }
} finally {
  rmSync(bin, { recursive: true, force: true });
}

if (checked === 0) throw new Error('no example manifests found under examples/');
console.log(`validated ${checked} example harness(es)`);
