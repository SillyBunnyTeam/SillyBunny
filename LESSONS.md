# SillyBunny Lessons

This file lists the bugs that recur in SillyBunny, where they happen, and what guards against them. Read the section for the area you change before you fix a bug or make a non-trivial change.

The source is the fork's own fix commits from April to October 2026, checked against `staging` on 2026-10-22. `#123` is a pull request; a short hash is a commit.

## Most-fixed files

These files received the most fix commits, most first. "(upstream)" marks a file that comes from SillyTavern.

1. `public/script.js` (upstream)
2. `public/scripts/sillybunny-tabs.js`
3. `public/index.html` (upstream)
4. `public/css/sillybunny-tabs.css`
5. `public/css/sillybunny-theme.css`
6. `public/scripts/openai.js` (upstream)
7. `public/style.css` (upstream)
8. `public/css/sillybunny-mobile-shell.css`
9. `public/scripts/extensions/in-chat-agents/agent-runner.js`
10. `public/css/mobile-styles.css`
11. `public/scripts/group-chats.js`

## Recurring bugs

The sections go from the most fixes to the fewest. "No test" lists fixes that shipped without a test that guards them.

### Mobile, viewport and WebKit

This is the largest class by a wide margin.

- **Breaks:** viewport or virtual keyboard changes hide the composer or detach the shell.
- **Files:** `public/css/sillybunny-mobile-shell.css`, `public/css/sillybunny-tabs.css`, `public/style.css`, `public/scripts/sillybunny-tabs.js`.
- **Tests:** `tests/mobile-keyboard-focused-input-scroll.test.js`, `tests/mobile-shell-lifecycle-wiring.test.js`, `tests/expanded-editor-touch.e2e.js`, `tests/openrouter-picker-touch.e2e.js`, `tests/webkit-prefix-companions.test.js` (WebKit prefix parity, #562).
- **Limit:** `tests/mobile-ios26-keyboard-layout.e2e.js` simulates `visualViewport` in Chromium. It does not test real Safari.
- **Limit:** `tests/webkit-prefix-companions.test.js` checks `backdrop-filter` and `user-select` in fork `.css`, inline CSS in JavaScript and HTML, and bundled agent templates. It skips the upstream-origin files in `tests/fixtures/upstream-origin-public-files.json` and does not check camelCase style properties such as `style.backdropFilter`. It uses its own brace scanner because `@adobe/css-tools` 4.4.4 does not parse CSS nesting and drops rules in `public/style.css`.
- **Side-panel sheets:** adopted upstream panel sources can retain mobile `100dvw` sizing; constrain the source and its descendants to the panel. Size sheets from available space, not their intrinsic height: a flex child with percentage sizing can otherwise collapse the source and its nested scroller to zero. Keep same-side docked panels split across the measured chat-shell height. Tests: `tests/side-panel-adapters.e2e.js` (390×844, 360×740, 1440×900, split panels) and `tests/mobile-shell-smoke.e2e.js` (MovingUI containment).
- **Docked side-panel bounds:** side panels also carry `.sb-dialog--window`, so the Window's `max-height: 90dvh` can clip a panel below the chat shell. Remove that cap from docked panels; `tests/side-panel-adapters.e2e.js` checks the panel against `#sheld` at 1440×900. Introduced by `70801186d`.
- **Detached modal content:** moving mobile chat tools into a shared dialog without hiding the source fragment leaves its search field painted in the document. This was introduced by `aa19e952a` and affected the Characters mobile opening path as well as Toggle Panels. Keep detached dialog content hidden and inert until the frame owns it, then hide it again after disposal. Test: `tests/mobile-character-toggle-and-panels.e2e.js`.
- **Mounted list spacing:** legacy tag controls carry a top margin, and the mobile drawer can apply a more specific margin on top. Reset that margin only inside the mounted Characters/Groups filter row; keep its 40px desktop and 44px mobile target. Test: `tests/character-list.e2e.js` (`Groups filter toolbar avoids extra vertical padding`).
- **Mobile editor labels:** a select that should sit below its label needs the shared combo row's `wide: true` mode. Otherwise its intrinsic-width suffix can squeeze labels such as Group Folder into multiple lines. Test: `tests/group-editor-member-lists.e2e.js` (`group folder label stays on one line on mobile`).
- **Popup scroll:** upstream `popup.css` sets `min-height: fit-content` and hides overflow on tall desktop popups, which clips the final rows. The tier frame fixes this; `tests/popup-scroll.e2e.js` checks the last row and visible response. Characterized by `e78207e03`, framed by `5d0d2dd9b`.
- **No test:** #438 (iOS overscroll blanks the page, keyboard moves the composer).
- **Fixes:** #658 (composer stays above the iOS keyboard), #840 (touch scroll in expanded mobile editors), #914 (pickers open during scroll).

### Scroll, streaming and cancellation

- **Breaks:** rendering or resizing moves the reader's position; cancelling leaves stream state behind.
- **Files:** `public/script.js`, `public/scripts/chat-render-lifecycle/`, `public/scripts/chats.js`, `src/request-cancellation.js`.
- **Guards:** `chat-render-lifecycle/scroll-intent.js` decides when to follow the newest message, `resize-observer.js` handles content that resizes after render, and `mobile-viewport.js` handles mobile viewport changes.
- **Guards:** a page hands its chat replies to the server and stops its stream on `pagehide`, not `beforeunload` (`public/scripts/resumable-generation.js`, `public/script.js`). A leave-site prompt can cancel `beforeunload`, and the page then stays with replies the server still writes into the chat (PR #877 review). Test: `tests/resumable-generation-frontend.test.js`.
- **Tests:** `tests/chat-render-lifecycle-script-wiring.test.js`, `tests/chat-scroll-regressions.e2e.js`, `tests/request-cancellation.test.js`, `tests/in-chat-agents-companion-panel.test.js`.
- **Fixes:** #271 (stabilise chat scrolling), #314 (cancel when a stream disconnects), #771 (resize and load lock work against each other), #783 (streaming moves the screen).

### In-chat agents and companions

- **Breaks:** cancelled or stale agent turns run again or change the active response.
- **Files:** `public/scripts/extensions/in-chat-agents/agent-runner.js`, `agent-store.js`, `companion/companion-runner.js`, `companion/companion-panel.js`.
- **Tests:** `tests/in-chat-agents-runner.test.js`, `tests/guided-generations-profiles.test.js`, `tests/guided-generations-steering.test.js`.
- **No test:** `59aeea3f1` (#385, abort agent generation on cancel), `20353df60` (hotfix, swipes rerun agents).
- **Fixes:** #839 (Guided Generations cancel, swipe cleanup and profile restore).
- **Order matters:** Guided Generations calls `integrateQrBar()` before it returns for a hidden bar (`public/scripts/extensions/guided-generations/index.js`). If the order changes, Quick Replies show in the composer after a reload (`8ce1a10a5`). Test: `tests/guided-generations-settings.test.js`.
- **Dry runs:** the `GENERATION_STARTED` listener in `public/scripts/extensions/in-chat-agents/index.js` returns for a dry run, as the listeners in `agent-runner.js` and `public/scripts/sillybunny-conversation/init.js` do. A dry run does not change the generation state. Without the check, `refreshGenerationUi()` → `activateSendButtons()` → `showSwipeButtons()` → `refreshSwipeButtons()` added `.fade` to every rendered message. Prompt Manager starts dry runs from its own debounced timers after `CHAT_LOADED` (`saveServiceSettings()`, then `renderDebounced()`, in `public/scripts/PromptManager.js`), so one can land right after `redisplayChat({ fade: false })`. Holding `/api/settings/save` until after the redisplay reproduces the nightly failure in issue #920: 12 `.fade` classes in `redisplay keeps render follow-up hooks applied after batched render`. Tests: `tests/chat-scroll-regressions.e2e.js` (`a dry-run generation keeps redisplay follow-up hooks applied`), `tests/in-chat-agents-generation-ui-wiring.test.js`.

### Bundled defaults, templates and user state

- **Breaks:** a refresh, reset or update overwrites user themes or templates, or brings back deleted defaults.
- **Files:** `default/`, `public/scripts/preset-manager.js`, `public/scripts/extensions/in-chat-agents/agent-store.js`, theme endpoints and theme CSS.
- **Guards:**
  - `src/endpoints/content-manager.js` does not overwrite a seeded file that already exists.
  - `reconcileManagedBundledQuickReplies()` removes a bundled Quick Reply only when its hash matches a known stale version. It does not touch user-edited files.
  - Bundled agent template updates match by template `id` (`scripts/bump-agent-template-versions.js`). An update keeps the agent's enabled state, quick-toggle pin, order and profile overrides.
  - `✅ Run Unit Tests on PR` fails when an existing bundled agent template or `index.json` entry changes without a version bump. It runs `scripts/bump-agent-template-versions.js --check` against the PR's merge ref. After a commit, bump with `npm run agents:bump-template-versions -- --base origin/staging`; without `--base` the script compares only uncommitted changes against `HEAD`.
- **Tests:** `tests/preset-save-deleted-default.test.js`, `tests/create-only-installs.test.js`, `tests/sillybunny-theme-css.test.js`, `tests/theme-custom-css-import.test.js`, `tests/in-chat-agents-templates.test.js`, `tests/bump-agent-template-versions.test.js`.
- **No test:** `a354f263d` (#753, redundant bundled-agent updates).
- **Fixes:** #687 (saving a preset over a deleted bundled default's name), #834 (an external theme pack wipes saved themes), #919 (theme data lost on update, export or reset; Custom CSS overwritten).

### Group chats

- **Breaks:** turns are routed before the user message or its metadata is saved; stale IDs remain.
- **Files:** `public/scripts/group-chats.js`, `public/scripts/group-turn-routing.js`, `src/endpoints/groups.js`.
- **Tests:** `tests/group-turn-routing.test.js`, `tests/group-member-rename.test.js`, `tests/generation-lifecycle-wiring.test.js`.
- **No test:** `1527a1d29` (v1.2.8 hotfix: stale group IDs cause a missing `.jsonl` file).
- **Fixes:** #821 (the "typing" indicator stays on), `2e2d0fc94` (member renames propagate), `3e8c42b6c` (route turns only after the user message is saved).

### Chat writes, reloads and backups

- **Breaks:** an old queued write replaces a newer chat; backups push each other out of the backup ring.
- **Files:** `public/scripts/chat-save-guard.js`, `public/scripts/chat-reload-guard.js`, `src/endpoints/chats.js`, `src/generation-commit.js`, `public/scripts/server-generations.js`.
- **Guards:**
  - The server writes a reply over an existing message only when that message carries `extra.server_generation_placeholder` with the generation's start time. The browser removes the mark when the reply is finished, so a reply the page saved itself, and later edits to it, are not overwritten (`src/generation-commit.js`).
  - `Generate()` awaits `settleGenerationCommit()` before it saves a finished reply. If the server answers `committed`, the page reloads the chat and does not save its own copy, which would fail the integrity check. Stream readers return at `[DONE]`, which can come before the body ends and claims on its own (PR #877 review).
  - A tab keeps its server event stream (`public/scripts/server-generations.js`) only while it is visible or reads a reply of its own. Over HTTP/1.1 a browser opens about 6 connections per server for all its tabs; with a stream in every tab, a seventh tab never loads (PR #877 review). Tests: `tests/server-generations-frontend.test.js`, `tests/server-generation-commit.e2e.js`.
  - A tab that reloaded once for a server-written reply and still finds no mark for it acknowledges it. Otherwise each reload reconnects, hears of the reply again and reloads again until the server forgets it.
  - `reloadCurrentChat()` removes an open message editor but leaves `this_edit_mes_id` set. A reload for a server-written reply reopens the edit with its unsaved text through `messageEdit()`, unless the reply changed that message, and clears the id with `setEditedMessageId()` (`restoreOpenEdit()` in `public/scripts/server-generations.js`). Waiting with the reload does not help: once the server has written the chat, saving the edit fails the integrity check. Tests: `tests/server-generations-frontend.test.js`, `tests/server-generation-commit.e2e.js`.
- **Tests:** `tests/chat-cloning-lifecycle.test.js`, `tests/chat-save-guard.test.js`, `tests/chat-save-queue-runtime.test.js`, `tests/chat-integrity-rotation.test.js`, `tests/reload-chat-safeguard.test.js`, `tests/prove-368-differential.test.js`, `tests/server-generation-commit.test.js`, `tests/resumable-generation-frontend.test.js`, `tests/story-mode-request-controls.test.js`.
- **Fixes:** #819 (queued saves across swipes clone chats), #849 (staged reloads wipe chats), #373 (extra pre-write backups push older backups out), #856 (issue #706: a chat saves when opened).

### Dialog adapters and legacy DOM

- **Breaks:** moving Chat History controls into a shared Window can lose the original cleanup tree, leave dynamically created backup nodes behind, or return focus to a detached mobile sheet action.
- **Guard:** record source parents, sibling positions, child order and hidden state before adoption; restore the source before removing the page and use a connected mobile chat-chip fallback when the sheet opener is disposed. Keep backup visibility driven by the list-page parent state.
- **Tests:** `tests/unit/sillybunny-chat-dialogs.test.js`; `tests/sillybunny-overlays.e2e.js`; `tests/mobile-shell-smoke.e2e.js`; `tests/mobile-character-toggle-and-panels.e2e.js`.
- **Adopted search inputs:** restore a caller's input to its original parent and sibling on page teardown, remove only frame-added classes and attributes, and unbind frame listeners. Reuse must retain one input callback and the shared Ctrl/Cmd+F and type-to-search behavior; Escape clears before closing only when `escapeClearsFirst` is opted in. Destroying active header-slot selection must restore the real title and controls without stealing focus from a closing dialog. Tests: `tests/unit/sillybunny-dialog.test.js`; `tests/sillybunny-overlays.e2e.js`.

### Cache, boot and reload

- **Breaks:** boot continues before the cache is invalidated; a module is evaluated twice.
- **Files:** `public/index.html`, `public/sw.js`, `public/scripts/sillybunny-restart-cache-clear.js`, `src/middleware/frontend-assets.js`.
- **Guards:** unhashed assets are served with `Cache-Control: no-cache` (`src/middleware/frontend-assets.js`). Fingerprinted assets are served as `immutable` (`src/frontend-assets.js`). `scripts/check-frontend-budgets.js` checks asset budgets.
- **Tests:** `tests/frontend-asset-middleware.test.js`, `tests/restart-cache-clear.test.js`.
- **No test:** `b6d657e08` (#380, stale iOS service-worker cache), `fe3e25446` (#429, versioned module URLs evaluate `script.js` twice).
- **Fixes:** #416 (restore JavaScript revalidation), #906 (boot races the restart cache-clear reload).
- **Stylesheet keys:** a stylesheet referenced under two different `?v=` keys loads twice, which is the same cause as `fe3e25446` for modules. When you change a stylesheet, give it one new key at every call site in the same commit (`index.html` and every `loadStylesheetAsync` literal), then grep for one key per file. `820589f4d` moved the eight stylesheets changed for PR #870 to one new key each.

### Runtimes, Termux, launchers and updates

- **Breaks:** the wrong runtime or shell behaviour on one platform.
- **Files:** `Start-Node.bat`, `scripts/`, `src/npm-launcher.js`, `src/endpoints/server-admin.js`.
- **Guards:** `server.js` runs under `src/server-supervisor.js`. It loads `src/server-log-buffer.js` first and imports `src/server-main.js` last. Do not change this import order.
- **Bun and disconnects:** under Bun 1.3.12 and 1.3.14 an Express response emits no `close` when the client disconnects; the request and its socket do. Node emits all three, and emits the response's `close` from inside the socket's. The streamed routes in `src/resumable-generations.js` use `whenClientGone()`, which watches both and runs once (test: `tests/server-generation-commit.test.js`). Still on the response's `close`: `src/endpoints/backends/chat-completions.js`, `src/endpoints/server-admin.js`, `src/endpoints/chat-archive.js`, `src/server-listen.js`.
- **Bun and the listen port:** before Bun 1.4.0, sockets on Windows are inheritable (oven-sh/bun#36936, fixed by oven-sh/bun#36938). A process that the server starts, such as git during an update, can keep the port bound after the server exits. `engines.bun` still allows 1.3.14. The listen retry window in `src/server-listen.js` and `GIT_OPTIONS` in `src/endpoints/server-admin.js` (no background git maintenance during updates) guard against it. `hasBunSocketInheritBug()` limits the port-conflict hint and the dead-holder diagnostic to Bun before 1.4.0 on Windows (test: `tests/server-listen.test.js`). Before Bun 1.4.3, `closeAllConnections()` does nothing once `close()` has run (oven-sh/bun#43557), so `closeListeningServers()` also destroys the tracked sockets.
- **Tests:** `tests/server-supervisor.test.js`, `tests/base64-atomic-writes.test.js`, `tests/server-admin-update-install.test.js`, `tests/server-plugin-manager.test.js`, `tests/server-plugin-update-helper.test.js`.
- **No test:** `c1a87366c` (#522, Bun bootstrap on Termux), `cd7429421` (issue #672, unescaped parentheses in `Start-Node.bat`).
- **Fixes:** #806 (explicit Base64 decode on Bun), #912 (run npm through Node.js on Windows).

### Security and credentials

- **Breaks:** untrusted card scripts reach remote resources; secrets cross scopes.
- **Files:** `public/scripts/card-script-sandbox/`, `public/scripts/card-script-runtime.js`, `public/scripts/openai.js`, `src/endpoints/backends/chat-completions.js`.
- **Guards:**
  - The card-script sandbox CSP blocks network access (`connect-src 'none'`).
  - Sandbox frames have an opaque origin, so `event.origin` cannot be checked. `handleSandboxMessage()` checks `event.source`, the message schema, the nonce, the message ID and the rate limit, then the command allowlist. It rejects unknown commands.
  - Card scripts need user confirmation before they run (`confirmCardScriptExecution()`). This gate applies only to card scripts; other imported behaviour has no general gate.
- **Tests:** `tests/card-script-runtime.test.js`, `tests/card-script-sandbox-wrapper.test.js`, `tests/openai-prompt-logging-wiring.test.js`, `tests/openai-preset-utils.test.js`.
- **Fixes:** #110 (sandbox helpers), #144 (block remote loads from the sandbox), #348 (gate verbose prompt logging), #560 (bind custom endpoint profiles to their saved secrets).
- **Order matters:** at startup, `readSecretState()` (`public/scripts/secrets.js`) runs before `getSettings()` calls `accountStorage.init()`, and `accountStorage.getItem()` returns `null` until then. Call `checkOpenRouterAuth()` only after `getSettings()` (`public/script.js`). An earlier call does not find the PKCE code verifier and removes the OAuth query from the URL, so the OpenRouter key exchange never happens. SillyTavern moved the call out of `readSecretState()` in `97dba399e`; the SillyTavern 1.18 port (`9fe08ef34`) kept it. Test: `tests/openrouter-oauth-return.test.js`.

### CI and workflows

- **Breaks:** a workflow change merged to `staging` has no effect on pull requests, or the `staging` and `release` copies of a workflow drift apart.
- **Files:** `.github/workflows/pr-auto-manager.yml`, `.github/pr-auto-comments.yml`, `.github/pr-auto-labels-by-branch.yml`, `.github/workflows/pr-metadata.yml`, `.github/workflows/pr-checks.yml`, `.github/workflows/nightly.yml`.
- **Guards:**
  - `pull_request_target` workflows (`pr-auto-manager.yml`, which reads `pr-auto-comments.yml` and `pr-auto-labels-by-branch.yml`) and scheduled workflows (`nightly.yml`) run from `release`, the default branch. Their changes also need an `actions/*` PR into `release`; `pr-metadata.yml` limits those branches to `.github/`, `tests/`, `scripts/bump-version.js` and `scripts/update-changelog-merged-prs.js`.
  - `pull_request` workflows (`pr-checks.yml`, `pr-metadata.yml`) run from the PR's merge ref, so a PR into `release` uses the `release` copy unless the PR changes it.
  - Required check names come from rulesets; renaming a job such as `✅ Check Bun Runtime` blocks every PR.
- **Tests:** `tests/pr-auto-manager-workflow.test.js`, `tests/pr-checks-workflow.test.js`, `tests/nightly-workflow.test.js`, `tests/release-workflows.test.js`, `tests/sillybunny-launcher-smol.test.js`.
- **Fixes:** #888, #892, #895 and #903 carried workflow and test changes to `release` through `actions/*` branches. `label-by-branches` in `pr-auto-manager.yml` waited for a `synchronize` event with `changes.base`, which never arrives; a base-branch change is an `edited` event. On 2026-10-23 the `release` copy of `pr-metadata.yml` still rejected `hotfix:` titles.
- **Runner images:** GitHub moves `ubuntu-latest` to Ubuntu 26.04 between 2026-10-19 and 2026-11-19 (actions/runner-images#14748), so a job can land on either image. `@playwright/test` 1.60.0 refuses to install Chromium on Ubuntu 26.04, which broke `Install Chromium` in nightly (issue #920) and in `Run Chromium E2E suite` on #925. Playwright 1.61.0 added Ubuntu 26.04 support; `tests/package.json` pins 1.64.1. A Playwright bump needs `npx playwright install chromium` in `tests/` locally, because each version expects its own browser build.

### Playwright tests

- **Breaks:** a wait passes at once, so the test checks state too early or proves nothing.
- **Cause:** `page.waitForFunction()` takes a returned Promise as a truthy result (checked with `@playwright/test` 1.64.1), so an `async` predicate never waits. Read module values into `window` first, then wait on a synchronous predicate, as `tests/server-generation-commit.e2e.js` does.
- **Open:** `tests/nanogpt-controls.e2e.js` and `tests/pathfinder-settings.e2e.js` still wait on `async` predicates.
- **Breaks:** a startup check passes with 4 workers and times out with 8 or more. All workers share one server, so app start takes longer as the worker count goes up. The `#preloader` check in `exerciseUpgrade()` (`tests/topbar-upgrade.e2e.js`) used the 5 s `expect` default. On a 16-thread host, 17 of its 18 test runs with 8 or 12 workers (6 tests, three suite runs) failed there. All 6 tests passed with 1 and 4 workers. The check now has a 20 s timeout. `tests/mobile-shell-smoke.e2e.js` sets a 60 s test timeout for the same cause. Give startup waits an explicit timeout instead of the 5 s `expect` default.
- **Breaks:** a spec that you run alone against a fresh data root times out at startup, but passes in the full suite.
- **Cause:** a fresh data root stops startup at the first-run onboarding dialog until it is answered. `waitForAppReady()` in `tests/frontend/frontent-test-utils.js` answers it. The `app_ready` waits in `tests/character-list.e2e.js` (lines 105 and 191), `tests/character-folders.e2e.js` (line 49) and `tests/character-create-flow.e2e.js` (line 56) do not, so they pass only after an earlier spec has answered the dialog on the same server. Run alone against a fresh data root, almost every test in these three files timed out at that wait. They passed after the dialog was answered once.
- **Open:** these three specs still depend on an earlier spec to answer onboarding.
- **Breaks:** work that the app starts when a chat loads runs on its own timers and can land between a test step and its assertion. The failure is rare locally and can still fail a single nightly run (issue #920, see § In-chat agents and companions). To reproduce such a race, hold the request that starts the timer chain with `page.route()` and release it after the test step.
- **Backend-dependent fixtures:** tests that open Chat Completion prompt rows (`.sb-prompt-row`) fail when the server's saved `main_api` is another backend, because those rows do not render. `tests/in-chat-agents-list.e2e.js` and `tests/sillybunny-mobile-overlays.e2e.js` force `main_api: "openai"` through settings interception (`028a5c62e`). `tests/world-info-editor.e2e.js` (q56) still depends on the saved backend.
- **Active-character assertions:** Chat History's subtitle names the character selected in the server's saved settings, which differs between data roots. Read the selected character's name from the page context instead of hard-coding it; `tests/sillybunny-overlays.e2e.js` does this.
- **Source-text tests:** a unit test that reads module source and matches it with regular expressions fails when the module splits or the markup it names is removed, and then it says nothing about behaviour. The Chat Archive presentation tests did this and failed on the `ui.js` split into `ui/*.js`; they were replaced by model and DOM tests (`tests/unit/sillybunny-chats-archive-model.test.js`, `tests/unit/sillybunny-chats-archive-ui.test.js`). A test that must read source reads every module in the directory, as `tests/unit/native-dialog-replacements.test.js` does.
- **Route handlers after a test ends:** a handler that calls `route.fetch()` and then reads the body throws `Response has been disposed` when the test ends while the request is in flight. It showed as a load flake in `tests/preset-lorebook-dialogs.e2e.js`. Fetch through `tests/helpers/route-fetch.js` (`fetchJsonOrSkip`, `fetchBodyOrSkip`). It returns `null` only for teardown errors and rethrows any other error (`3754089e5`, `09b66af39`).
- **Saved reduced motion:** the shared data root keeps `power_user.reduced_motion`. One run saved `true`, and then 8 motion assertions in `tests/character-create-flow.e2e.js`, `tests/character-editor-rendering.e2e.js` and `tests/characters-navigation.e2e.js` failed at every commit until the value was reset. A spec that asserts motion sets `reduced_motion: false` through settings interception, as `tests/sheet-swipe.e2e.js` does.
- **Open:** those three specs still read the saved value.
- **Closing popups:** with motion on, a closing `dialog.popup` keeps `[open]` with `[closing]` until it is removed. A locator such as `dialog.popup[open]` then matches the closing popup and the next one, and fails in strict mode. Match `dialog.popup[open]:not([closing])`, use `.last()`, or wait for the old popup to be removed (`7abe38b07`; `tests/character-editor-rendering.e2e.js`, `tests/persona-editor.e2e.js`).
- **Service workers hide requests from `page.route()`:** when the service worker answers a request, Playwright does not run the route, so a test that fails a module import is not failed. Use `serviceWorkers: 'block'` in that test. Test: `tests/sillybunny-chats-archive-layout.e2e.js` (a failed archive import shows `Could not open Chat Archive.` and the next open retries).

### Dialog surfaces and layering

- **Breaks:** a broad `.sb-dialog` descendant textarea rule changes the in-chat Agents Regex editor height (159.75px instead of 160px).
- **Guard:** scope textarea sizing to the adapter rows that need it, not generic dialog descendants. `89cd805db` keeps the `8lh` minimum on the window-content adapter's scenario and YAML rows; regression: `tests/in-chat-agents-editor.e2e.js` (regex fields at least 160px).
- **Floating rows:** an empty entry row can paint its placeholder underneath the floated title. Keep the hint in `aria-description` and suppress the painted placeholder while the title floats. Fixed in `357be55f7`; regression: `tests/sillybunny-editor-rows-layout.e2e.js`.
- **Layer order:** side panels and zoomed avatars must stay below Settings and shell drawers. Keep sprite, avatar, panel, shell, settings, popover, and dialog layers in one ordered ladder. Fixed in `357be55f7`; tests: `tests/libadwaita-surface-layers-css.test.js`, `tests/side-panel-adapters.e2e.js`.
- **Shared entries:** upstream `.text_pole` rules and surface-specific selectors can silently fork dialog search fields. Keep the shared `.sb-dialog__entry` rule more specific than those inputs, remove surface copies, and compare rest/focus metrics across the manager overlays in their e2e suites.
- **Adopted rows:** moving an upstream list into shared dialog chrome must preserve the original action nodes as the handler boundary. Add adapter unit coverage for every forwarded action and keyboard route, plus an e2e that reaches the overflow actions through the production menu.
- **Touch close controls:** nested Popup close nodes can bypass direct-child coarse-pointer rules. Keep Close in the shared header layout and assert its 44×44 box on coarse-pointer Data Bank and Tag Manager surfaces.
- **Pushed-page completion:** closing an `openDialog()` frame must resolve every active page's `closed` promise with the root response, not only destroy its view. Drain the page stack during disposal so popped pages cannot settle again. Tests: `tests/unit/sillybunny-dialog.test.js` (nested Close and root `forceClose()` with a page open).
- **Selected shell controls:** persistent current-section buttons share the same neutral selected fill, including `.sb-settings-active` Characters; test the computed fill against Home at desktop and mobile sizes. Test: `tests/character-shell-performance.e2e.js` (`Characters uses the Home selected-pill fill`).
- **Header icons and custom popovers:** `.sb-header-icon-button` uses the shared control radius, matching Chat Archive rather than becoming a pill; its local `--sb-icon-control-radius` also keeps the high-specificity icon-only rule in line. Persona and World Info base button rules exclude shared header icons and status-page actions so shared hover fills and suggested-action accents remain visible. A custom `openPopover()` closes when its own trigger is activated again; native manager triggers stop Enter from reaching the document keyboard bridge, which would synthesize a second click alongside the button's native activation. Tests: `tests/header-icon-button-parity.e2e.js`, `tests/unit/sillybunny-action-menu.test.js`, `tests/tag-manager.e2e.js`, `tests/character-folders.e2e.js`.
- **Status-page actions:** generic `.menu_button` fills and mobile corner rules can override the shared neutral/suggested hierarchy, including through the paper theme's `!important` radius. Exclude `.sb-status-page__action` from legacy defaults and keep the shared component selector more specific than surface button rules. Tests: `tests/header-icon-button-parity.e2e.js`, `tests/in-chat-agents-list.e2e.js`, `tests/mobile-character-toggle-and-panels.e2e.js`.
- **Window filtering:** content-sized Windows can shrink when a live search removes rows. Keep Window surfaces fill-sized by default, opt only deliberately short Windows into content sizing, and lock a content-sized frame at its largest laid-out height. Tests: `tests/tag-manager.e2e.js`; `tests/sillybunny-overlays.e2e.js`; the Window and media dialog suites.
- **Observed extension rows:** hiding crowded extension actions changes their measured width to zero. Repeatedly writing the same hidden styles from the row observer can then loop on its own mutations and block the main thread. Cache measured widths and write row classes and inline display only when the value changes. Tests: `tests/extensions-row-actions.e2e.js`; `tests/window-tools-dialogs.e2e.js`.
- **Selection mode in a header bar:** `createSelectionMode()` reuses a real dialog header through `headerSlots` and needs no `header` element; it hides only a standalone `header`, and it exposes `cancelButton`, `selectAllButton` and `selectionTitle` on its handle instead of writing them into the slots object. The generic `.menu_button:not(...)` fill outranks the raised header-bar rule in `sillybunny-theme.css`, and the flat `[data-selection-mode='true'] button.menu_button` rule used to match the header's Cancel and Select All whenever `root` contained the header (the Chat Archive passes its dialog surface, because the full-width action bar and Escape handling need that ancestor). The flat rules now name only `.sb-selection-action`, and the raised fill, hover, active, focus ring and 44px coarse height of the header buttons sit in `public/css/sillybunny-editor-shell.css` behind a selector chain as long as the generic one. `bindHeaderLayout()` adds the inline padding of `.sb-dialog__titles` to the title width, or a short centred title such as `3 selected` ellipsizes at 390px. Tests: `tests/sillybunny-chats-archive-layout.e2e.js` (computed raised fill, border and height of both header buttons; the selection title on a phone), `tests/unit/sillybunny-dialog.test.js`, `tests/unit/sillybunny-selection-mode.test.js`.
- **Tier surfaces:** a tier rule that sets only the surface background leaves `.sb-dialog__body` on the Window layer. `openAlert` surfaces painted the Window layer, and after the surface fix their body was still darker than their response bar. Set the tier layer on the surface and on `.sb-dialog__body` (`14199fd70`). Test: `tests/sillybunny-dialog-frame.e2e.js` (`an openAlert surface paints the same Alert layer as a Popup alert, not the Window layer`).
- **Overlapping pages:** during a push or pop two pages overlap, and a `z-index` inside the covered page paints over the page that slides. The list editor divider (`z-index: 4`) drew a bar across the Chat Archive's chat page until the slide ended. `.sb-dialog__page` sets `isolation: isolate` (`4584dec17`). Test: `tests/sillybunny-dialog-frame.e2e.js` (`while pages slide`).
- **Page chains:** Close on a page in a chain of Popup and `openDialog` frames closes one level at a time, through each level's own close path, and stops at the first level that refuses.
  - Await each level fully before the next.
  - When the walk starts, take a snapshot of the closes already in flight. Otherwise a veto handler that resolves the same promise runs `onClosing` twice.
  - A page dims only when nothing beneath it dims already, so each chain shows one dim.
  - `4ef8c438b`, `public/scripts/sillybunny-editor/page-chain.js`. Tests: `tests/unit/sillybunny-page-chain.test.js`, `tests/sillybunny-dialog-frame.e2e.js` (`page chains`, `one dim is painted over the chain …`).
- **Generated hover mirror:** `public/scripts/dynamic-styles.js` copies each `:hover` rule onto `:focus-visible`, unless a focus rule with the same base selector already exists.
  - **Breaks:** the `.menu_button` hover rule sets `box-shadow: none`, so its copy erased the inset focus ring on every enabled `.menu_button`. Keyboard focus showed no ring on dialog responses, extension actions and header icon buttons.
  - **Guard:** give such a hover rule a same-base `:focus-visible` counterpart inside the same `@media (hover: hover)` block (`public/css/sillybunny-theme.css`, the `.menu_button` hover block). A `.menu_button` rule that draws its own outline then sets `box-shadow: none`, or it shows two rings.
  - **Tests:** `tests/dialogs-accessibility.e2e.js` (every Tab stop shows one focus indicator; the Presets action button shows one ring), `tests/sillybunny-chats-archive.e2e.js` (the drawer button shows one ring).
- **Focus under forced colours:** forced colours remove `box-shadow`, so a ring drawn only as a shadow disappears.
  - **Guard:** the theme's forced-colours block draws a `Highlight` outline on every `:focus-visible` element.
  - **Pitfall:** a rule with `outline: none !important` defeats that outline. Use `outline: 2px solid transparent !important` instead: forced colours repaint it, and it draws nothing in normal mode.
  - **Pitfall:** a selected control filled with `Highlight` needs a `HighlightText` focus outline, or the ring is invisible.
  - **Tests:** `tests/dialogs-accessibility.e2e.js` (forced colours).
- **Focus return:** after a dialog or side panel closes, the opener can be disabled, hidden or removed, and focus then fell to the document.
  - **Guard:** `returnFocusTo()` in `public/scripts/sillybunny-editor/page-chain.js`. It retries a disabled opener for a few frames, falls back to a recorded container or a fallback control, and never focuses behind another open modal.
  - **Tests:** `tests/unit/sillybunny-return-focus.test.js`, `tests/dialogs-accessibility.e2e.js` (Escape returns focus).
  - **WebKit:** WebKit can refuse `focus()` on a visible opener for a frame after a dialog is removed. `returnFocusTo()` retries any opener that is connected, focusable, visible and not behind a modal, and falls back at once for an opener that can never take focus.
- **Header title clipping:** `bindHeaderLayout()` in `public/scripts/sillybunny-editor/dialog.js` compares integer widths with fractional capacities.
  - **Breaks:** the old one-pixel slack kept a title that overflowed by one pixel centred, so the browser clipped it with an ellipsis (seen in WebKit on "0 selected").
  - **Guard:** a clipped title switches to the loose layout, and a loose header stays loose until the title is a full pixel inside the centred capacity, so the layout cannot flip on every resize pass.
  - **Tests:** `tests/unit/sillybunny-header-layout.test.js`, `tests/sillybunny-chats-archive-layout.e2e.js`.
- **Motion end state on a direct cancel:** `play()` in `public/scripts/sillybunny-motion.js` ran `onEnd` only on finish or through `motion.cancel()`.
  - **Breaks:** code that cancelled the animation directly, for example through `getAnimations()`, skipped `onEnd`. A pushed dialog page then never hid the page it covered, which stayed visible with its own Close.
  - **Guard:** `animation.oncancel` runs the cleanup and `onEnd` while the motion is still the active one, so no path runs them twice.
  - **Tests:** `tests/unit/sillybunny-motion.test.js`, `tests/sillybunny-dialog-frame.e2e.js` (the covered page is hidden and inert once the push settles, even when the slide is cancelled).
- **E2E during page slides:** a push or pop keeps both pages in the DOM for the slide, and each page has its own Close. A strict locator counts every match at once and fails rather than waiting.
  - **Guard:** for an `openDialog` host, get the Close through `visiblePageClose(host)` in `tests/helpers/dialog-pages.js`, which first waits for exactly one unhidden page. A Popup page is its own `dialog.popup` with no `.sb-dialog__page` wrapper, and its Back button keeps the close class, so match `.sb-dialog__close:not(.sb-dialog__back)` there.
  - **Pitfall:** looping animations outside the surface under test, such as the hidden `#connection_profile_spinner`, run for the whole session. Count only the surface's own animations, and read geometry only after its own animations finish.
  - **Tests:** `tests/tag-manager.e2e.js`, `tests/character-folders.e2e.js`, `tests/sillybunny-overlays.e2e.js`, `tests/side-panel-engine.e2e.js`, `tests/side-panel-adapters.e2e.js`.
  - **Pitfall:** a closing menu keeps its items in the DOM during its exit fade, so a strict `menuitem` locator can match two. A saved `reduced_motion: true` in the test data root hides these races, so clear it before a run.
- **Service workers bypass route stubs:** once the app's `/sw.js` controls a page, `page.route()` does not see the requests the service worker handles, so stubs are skipped and writes reach the real server.
  - **Breaks:** under WebKit, the Account settings test in `tests/misc-form-dialogs.e2e.js` posted `/api/users/reset-settings` to the test server, and every later boot showed the first-run welcome popup.
  - **Guard:** `serviceWorkers: 'block'` in `tests/playwright.webkit.config.js`. In `tests/playwright.config.js` (Chromium) service workers are not blocked by default; specs that stub writes opt in with `test.use({ serviceWorkers: 'block' })`.
  - **Tests:** `tests/playwright.webkit.config.js` runs the dialog specs with service workers blocked.

### Upstream compatibility and sync

- **Breaks:** the version map reports the wrong SillyTavern base, so extensions that need a newer SillyTavern fail.
- **Files:** `docs/upstream-sync.md`, `public/scripts/sillybunny-version-map.js`, `public/scripts/openai.js`, `src/endpoints/backends/`.
- **Guards:** the version map clamps a SillyBunny version with no mapping to the highest synced SillyTavern version for its major.
- **Tests:** `tests/sillybunny-version-map.test.js`, `tests/upstream-provider-parity.test.js`.
- **Native controls and upstream keyboard handling:** upstream `public/scripts/keyboard.js` turns Enter on any `.interactable` into a synthetic `click()`, because upstream's `.menu_button` controls are `<div>` elements. A native `<button>` with that class clicks on Enter by itself, so one press ran its handler twice: Change Password opened two popups, and the Clear cookies alert opened and cancelled at once. A marked early return now skips native buttons, links, `summary` and button-like inputs. When you turn an upstream `<div>` control into a native element, check upstream handlers that synthesise its activation. Tests: `tests/unit/sillybunny-keyboard-enter.test.js`, `tests/dialogs-accessibility.e2e.js`.
- **Fixes:** #410 (SillyBunny 1.6.4 still mapped to SillyTavern 1.16.4). The same bug came back on the next minor version; #497 fixed it with the clamp. #843 and #845 (provider parity with upstream).
- **Open:** issue #713, where the Quick Image Gen manual sync fails in Docker (no `bash`, no real `node`). No fix PR found.

## Reverts and release problems

- Performance work caused the largest rollback: `0ecfa44e3` reverted 14 optimisation commits. iOS stayed at "Initializing", and the desktop Characters panel did not open.
- A revert can cause its own regression: `f027cd460` (#595) restored mobile CSS that a June baseline revert removed.
- Release promotion failed once. #866 promoted `staging` to `release` too early for v1.8.0, `5d49b0ad1` (#891) reverted it, and #892 added a workflow guard.
- Hotfixes followed v1.2.7, v1.2.8 and v1.8.1. A cluster of fixes from 12 to 16 April led to the v1.3.6 stability release.
