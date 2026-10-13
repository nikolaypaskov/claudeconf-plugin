import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const builtEntry = resolve(root, 'dist/index.js');

/**
 * End-to-end: consume the package the way a downstream user does — build it, then
 * import the *built* artifact (not the TS source) and exercise the public API.
 * No server, no browser, no network, no credentials.
 */
test('built package exposes a working public API', async () => {
  if (!existsSync(builtEntry)) {
    // Build unattended so the suite is self-contained (mirrors `npm run build`).
    execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
  }
  expect(existsSync(builtEntry)).toBe(true);

  const mod = (await import(pathToFileURL(builtEntry).href)) as {
    add: (a: number, b: number) => number;
  };

  expect(typeof mod.add).toBe('function');
  expect(mod.add(2, 3)).toBe(5);
  expect(mod.add(-4, 1)).toBe(-3);
});
