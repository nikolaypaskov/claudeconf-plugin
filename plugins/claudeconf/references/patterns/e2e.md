# E2E Framework Pattern

> This is a starting point, not required. Research what the project already uses and
> what its stack supports before choosing a framework. The key invariants are
> unattended execution and no live external credentials — those come from
> `constitution.md §3` and are not negotiable.

## Pick by INTERFACE first, then by stack

"e2e" means exercising the project's PRIMARY INTERFACE end-to-end, unattended —
the browser is only one interface. First identify what the project actually
exposes, then research the current framework that drives that interface in the
project's language. The constitution mandates the e2e milestone for every
project; the *shape* adapts to the interface, it never defaults to a browser.

| Project's primary interface | What an e2e test drives | Example frameworks (research the current one for the stack) |
| --- | --- | --- |
| Web UI / browser app | the running app through a real browser | Playwright (Node/Python), Cypress, Selenium |
| HTTP service / API (no UI) | the real HTTP endpoints | supertest (Node, in-process), httpx + pytest (Python ASGI), `Phoenix.ConnTest` (Elixir), REST-assured (JVM) |
| CLI tool | the built binary as a subprocess — exit code, stdout/stderr, file side-effects | the project's test runner invoking the CLI (vitest / pytest / `swift test`); shell harnesses like `bats` |
| Library / SDK | the public API across modules (integration-level, real I/O) | the stack's test runner with a dedicated integration suite/target |
| Mobile app | the app on a device/simulator | XCUITest (iOS), Espresso (Android), Maestro |
| Desktop app | the app's UI on the target OS | the platform's UI-automation framework |

If a project exposes more than one interface (e.g. an API *and* a CLI), cover the
primary one at minimum and add the others as the project warrants. When the
project has no UI at all (a CLI, a library, a service), the e2e milestone is
satisfied by driving that interface — do not scaffold a browser suite it doesn't
need.

## Invariants for all stacks

1. **Unattended execution**: the e2e suite must start (and stop) the application
   under test without manual intervention. Wrap the server start in a setup
   fixture or a `services:` block in CI.
2. **No live external credentials**: mock or stub all third-party APIs. Use
   environment variables for any required secrets; never hardcode them. In CI,
   inject secrets from the repository's encrypted secret store.
3. **Deterministic**: seeded test data, not production data snapshots.

## Scaffold shapes

### Playwright (Node/Python browser apps)

Directory layout:

```
e2e/
  playwright.config.ts   # or playwright.config.py
  tests/
    example.spec.ts      # one spec per feature area
```

Minimal `playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e/tests',
  use: { baseURL: process.env.BASE_URL ?? 'http://localhost:3000' },
  webServer: {
    command: 'npm start',        // REPLACE with your dev server command
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
  },
});
```

Install: `npm i -D @playwright/test && npx playwright install chromium`

Run: `npx playwright test`

### supertest (Node API)

```ts
// e2e/api.test.ts
import request from 'supertest';
import { app } from '../src/app';

describe('API e2e', () => {
  it('GET /health returns 200', async () => {
    await request(app).get('/health').expect(200);
  });
});
```

No server startup needed — supertest binds the Express/Fastify app in-process.

### CLI tool (invoke the built binary)

Drive the actual command as a subprocess and assert on exit code, stdout/stderr,
and filesystem side-effects. Build first and run against the BUILT artifact (not
the source) so the test exercises what ships. CLIs commonly reuse the project's
integration-test directory rather than a web-style `e2e/`.

```ts
// test/integration/cli.test.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

it('`mycli --help` exits 0 and prints usage', async () => {
  const { stdout } = await run('node', ['dist/cli.js', '--help']);
  expect(stdout).toContain('Usage:');
});
```

Same shape in any language: invoke the built CLI and assert exit/stdout/side-
effects — e.g. `subprocess.run` (Python), `assert_cmd` (Rust), or a `bats` shell
harness. Run it in the gate + CI like any other e2e suite.

### pytest + httpx (Python ASGI API)

```python
# e2e/test_api.py
import pytest
from httpx import AsyncClient
from myapp import app   # REPLACE with your ASGI app

@pytest.mark.anyio
async def test_health():
    async with AsyncClient(app=app, base_url="http://test") as client:
        r = await client.get("/health")
    assert r.status_code == 200
```

### Phoenix / Elixir

Use ExUnit with `Phoenix.ConnTest` for API-level e2e:

```elixir
# test/e2e/health_test.exs
defmodule MyAppWeb.HealthE2ETest do
  use MyAppWeb.ConnCase

  test "GET /health returns 200", %{conn: conn} do
    conn = get(conn, "/health")
    assert json_response(conn, 200)
  end
end
```

Run separately: `mix test test/e2e/ --trace`

### Swift (Package with integration tests)

Create a separate test target in `Package.swift` named `IntegrationTests`:

```swift
.testTarget(
  name: "IntegrationTests",
  dependencies: ["MyLibrary"]
)
```

Run: `swift test --filter IntegrationTests`

### Kotlin (REST-assured + TestContainers)

```kotlin
// e2e/src/test/kotlin/HealthTest.kt
class HealthTest {
    @Test
    fun `health endpoint returns 200`() {
        given().`when`().get("/health").then().statusCode(200)
    }
}
```

Run with: `./gradlew :e2e:test`

## Wiring into the harness

Add the e2e run command to:

1. **lefthook.yml** (or equivalent) under a `gate` group — run after the full
   unit suite.
2. **`.github/workflows/ci.yml`** — see `ci-github-actions.md` for the step
   skeleton.

Record the framework and suite path in `.claudeconf/manifest.json` — the suite
path fits the interface (`e2e/` for a browser suite, or the project's existing
integration-test directory for a CLI/service, e.g. `test/integration/`):

```json
"e2e": { "framework": "playwright", "suite": "e2e/" }
```
