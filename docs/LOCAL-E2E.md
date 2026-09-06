# Local application regression loop

Changes to the workshop must be checked at three separate boundaries: deterministic
application code, the real application in a browser, and the configured external
Copilot runtime. A fixture-backed browser pass is not a live-runtime pass.

## Before changing behavior

1. Record the goal, observable failure, affected lab, and acceptance assertions.
2. Have an independent agent plan the bounded change and a different model review
   the plan. Resolve material findings before implementation.
3. Add a regression that fails for the original behavior. Fix the owning state,
   transport, or layout rule rather than suppressing its visible symptom.
4. Run the relevant code tests and actual-browser scenarios. Request an independent
   review of the implementation, correct findings, and repeat the affected scenarios.
5. Run `npm run validate`. Commit a bounded checkpoint with its evidence and any
   explicit blockers. Push only after all required acceptance lanes pass.

Never weaken workshop validators, repair the starter practice exercise as part of
platform validation, auto-approve runtime permissions, or merge a pull request
automatically.

## Prerequisites without automatic installation

Use the project's supported Node.js version and the exact dependencies in
`package-lock.json` for full package validation. The deterministic chat tests use
an injected external runtime and do not require credentials or an installed SDK.
The source application reports an unavailable provider when the real SDK cannot
be loaded; it never silently runs a fixture.

The browser harness uses an **already installed** Playwright module and Chromium.
It does not run npm, npx, pip, browser downloads, or login commands. On restricted
machines, supply approved local paths explicitly:

```powershell
$env:LOOP_TEST_PLAYWRIGHT_MODULE = 'C:\approved\playwright\index.mjs'
$env:LOOP_TEST_BROWSER = 'C:\approved\chromium\chrome.exe'
$env:LOOP_TEST_ARTIFACTS = 'C:\local-evidence\loop-browser'
npm test
npm run test:browser
```

`npm test` runs `node scripts\test-platform.js`, which auto-discovers every root
`test\*.test.js` platform test using Node's existing test runner. Browser files,
helpers, fixtures, and the intentionally failing `practice` scenario are not
accidentally discovered by that command.
`npm run test:e2e` selects the service/coordinator/HTTP boundary checks.
`npm run test:browser` runs the renderer and lab-lifecycle browser files sequentially,
so another browser workload cannot contaminate the timing measurements.

Without `LOOP_TEST_PLAYWRIGHT_MODULE`, normal Node resolution must find an existing
`playwright` installation. Without `LOOP_TEST_BROWSER`, Playwright must already have
its matching browser. Missing prerequisites fail the command; they are not skipped
tests. Set `LOOP_TEST_HEADED=1` to watch the isolated browser.

The same commands work on a CI runner with pre-provisioned dependencies and browser
paths. No cloud services, interactive UI login, paid model calls, or platform-specific
test data are needed for fixture runs. The browser UI itself is anonymous.

## Evidence lanes

| Lane | What it proves | What it does not prove |
| --- | --- | --- |
| Node contract and HTTP tests | Real service, routes, events, permission and lifecycle invariants with controlled runtime events | External model or native SDK behavior |
| Direct browser fixture | Actual HTML, CSS, JavaScript, user input, scrolling, rendering and HTTP/SSE integration | Live Copilot or SSH behavior |
| Fault-proxy browser fixture | Resilience to the documented synthetic fragmentation and buffering profile | Reproduction of a specific SSH incident |
| Installed SDK smoke | Only the explicitly selected bundle and operations observed | Compatibility with another pinned SDK version |
| Pinned package validation | Build, packaging and existing offline package smoke with locked dependencies | Browser or live-model acceptance by itself |
| Actual SSH walkthrough | Observed behavior across the recorded authorized tunnel | Every possible network failure |

For the fault-proxy lane:

```powershell
$env:LOOP_TEST_PLAYWRIGHT_MODULE = 'C:\approved\playwright\index.mjs'
$env:LOOP_TEST_BROWSER = 'C:\approved\chromium\chrome.exe'
$env:LOOP_TEST_ARTIFACTS = 'C:\local-evidence\loop-browser-fault-proxy'
$env:LOOP_TEST_PROFILE = 'fault-proxy'
npm run test:browser
Remove-Item Env:LOOP_TEST_PROFILE
```

The loopback proxy rewrites upstream Host and Origin together so its different
test port does not bypass or accidentally fail the application's same-origin
mutation protection. This is test-only routing, not production forwarded-origin
configuration.

For the live native SDK smoke:

```powershell
$env:LOOP_TEST_PLAYWRIGHT_MODULE = 'C:\approved\playwright\index.mjs'
$env:LOOP_TEST_BROWSER = 'C:\approved\chromium\chrome.exe'
$env:LOOP_TEST_ARTIFACTS = 'C:\local-evidence\loop-live-smoke'
node scripts\smoke-live-chat.js --allow-live
```

The `--allow-live` flag is required because this lane uses the existing Copilot
authentication and requests at most three SDK turns. It exercises the actual
native SDK session history API (`session.getEvents()`), verifies native history
continuity across A-B-A navigation and process restart with a unique marker, and
requires a positive application plus native deletion receipt. The smoke must not
auto-approve protected operations; read-only fixture tool use may proceed only
when it stays inside the isolated workspace.

## Regression oracles

The browser runs the actual server and actual assets. Only the external runtime is
replaced through a constructor seam. No HTTP parameter can enable that fixture in
the shipping application.

- Page and body horizontal overflow must remain at most one CSS pixel across
  320 through 1920 pixel viewports, including both sides of layout breakpoints.
  Long ordinary text wraps; code and tables scroll inside their own containers.
  Hiding the page's horizontal overflow is not an accepted fix.
- Empty and whitespace-only assistant events never create a visible assistant
  wrapper, including intermediate mutations before tool calls.
- Message IDs and tool-call IDs survive normalization. Duplicate/replayed finals
  do not duplicate bubbles; concurrent same-named tools remain separate cards.
- A deterministic 4096-delta, 64KiB response must have the exact expected SHA-256.
  Warm-up plus three measured runs record DOM mutations, renderer flushes and
  browser long tasks. Streaming must not rebuild Markdown on every delta.
- Paced streams preserve 100 typed characters at a 100ms cadence. Input-to-paint
  p95 is at most 100ms and maximum at most 250ms. Browser long tasks must remain
  at most 200ms; long-task time is below 10% of the streaming interval.
- Readers who scroll up retain their position; following the bottom is opt-in
  again through the new-content button. Reload uses authoritative server state
  rather than inventing or automatically resending user operations.
- The browser fixture has direct and `fault-proxy` profiles. Together they cover
  fragmented and buffered transport, disconnect recovery, a missed terminal event,
  draft retention after unconfirmed delivery, exact retry idempotency, and no
  duplicate or empty messages after reload.
- The lab lifecycle browser fixture covers passive lab navigation, explicit
  connect, 13 viewport widths, command completion with Arrow/Enter/Escape/IME,
  project skill dispatch, selected native agent state, A-B-A plus draft history,
  canonical `/check` context, lost POST reply idempotency, New/Clear, stale route
  409 responses, two-tab takeover and stale permissions, process restart, more
  than 256KiB of history reload, and Forget deleting the selected application and
  native fixture session without deleting other lab history or progress.

Thresholds are fixed before a correction cycle. Functional failures are never
averaged away. Keep raw per-run results, not only a single aggregate or screenshot.

## Isolation, artifacts, and cleanup

Each browser run creates its own temporary workspace, Git metadata, runtime fixture,
ephemeral loopback ports, and fresh browser profile. It never opens the user's
existing browser profile or changes the real learner's exercise. All owned servers,
browser processes and sockets are closed, and only the named owned temporary
workspace is removed.

Evidence defaults to an ignored `.workshop\tmp\browser-<run>` directory. `results.json`
records lane, seed, browser and Node versions, expected/actual response hashes,
individual measurements and browser errors. Screenshots show synthetic fixtures.
Keep failure artifacts long enough to review them; delete only the specific run
directory when no longer needed.

Do not capture real credentials, approval grants, private reasoning, or unredacted
real transcripts in traces or Git. Agent-browser can provide an additional local
exploratory walkthrough using a unique session and the same existing Chromium.
Close only that session afterward; it does not replace the reproducible harness.

## Gates that must remain explicit

`npm run validate` includes the existing package build and offline tarball smoke.
That smoke installs a locally built tarball into a temporary prefix with an
unusable loopback registry and empty cache. It must not be used to evade a user's
installation restriction. If exact local dependencies or permission for that
offline smoke are unavailable, record the gate as blocked without changing
versions or removing the gate.

An actual SSH run requires an authorized host, tunnel configuration, and matching
before/after workload. Never disable host-key checking, alter a shared tunnel,
or claim a proxy run reproduced the original SSH freeze. The original authorized
SSH incident remains a manual acceptance residual risk unless a matching SSH
walkthrough reproduces or disproves it directly; the direct and fault-proxy
browser fixtures do not close that lane by themselves.
