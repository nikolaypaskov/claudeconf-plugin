import { defineConfig } from 'vitest/config';

/**
 * E2E config for the node-app fixture.
 *
 * This fixture is a pure Node/TS *library* (no HTTP server, no browser UI), so per
 * `references/patterns/e2e.md` (Library / SDK row) the e2e suite uses the project's
 * OWN test runner — vitest — with a dedicated config instead of pulling in an
 * e2e-only framework. The suite drives the package's public entrypoint exactly as a
 * downstream consumer would (build → import the built artifact → assert), which is
 * the genuine end-to-end path for a library.
 *
 * Invariants (constitution §3): runs unattended, needs no live external credentials,
 * makes no network calls, and is deterministic.
 */
export default defineConfig({
  test: {
    include: ['e2e/**/*.test.ts'],
    environment: 'node',
    env: { TZ: 'UTC' },
  },
});
