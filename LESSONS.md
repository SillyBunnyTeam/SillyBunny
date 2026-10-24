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
- **Detached modal content:** moving mobile chat tools into a shared dialog without hiding the source fragment leaves its search field painted in the document. This was introduced by `aa19e952a` and affected the Characters mobile opening path as well as Toggle Panels. Keep detached dialog content hidden and inert until the frame owns it, then hide it again after disposal. Test: `tests/mobile-character-toggle-and-panels.e2e.js`.
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

### Cache, boot and reload

- **Breaks:** boot continues before the cache is invalidated; a module is evaluated twice.
- **Files:** `public/index.html`, `public/sw.js`, `public/scripts/sillybunny-restart-cache-clear.js`, `src/middleware/frontend-assets.js`.
- **Guards:** unhashed assets are served with `Cache-Control: no-cache` (`src/middleware/frontend-assets.js`). Fingerprinted assets are served as `immutable` (`src/frontend-assets.js`). `scripts/check-frontend-budgets.js` checks asset budgets.
- **Tests:** `tests/frontend-asset-middleware.test.js`, `tests/restart-cache-clear.test.js`.
- **No test:** `b6d657e08` (#380, stale iOS service-worker cache), `fe3e25446` (#429, versioned module URLs evaluate `script.js` twice).
- **Fixes:** #416 (restore JavaScript revalidation), #906 (boot races the restart cache-clear reload).

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

### Dialog surfaces and layering

- **Breaks:** a broad `.sb-dialog` descendant textarea rule changes the in-chat Agents Regex editor height (159.75px instead of 160px).
- **Guard:** scope textarea sizing to the adapter rows that need it, not generic dialog descendants. `89cd805db` keeps the `8lh` minimum on the window-content adapter's scenario and YAML rows; regression: `tests/in-chat-agents-editor.e2e.js` (regex fields at least 160px).
- **Floating rows:** an empty entry row can paint its placeholder underneath the floated title. Keep the hint in `aria-description` and suppress the painted placeholder while the title floats. Fixed in `357be55f7`; regression: `tests/sillybunny-editor-rows-layout.e2e.js`.
- **Layer order:** side panels and zoomed avatars must stay below Settings and shell drawers. Keep sprite, avatar, panel, shell, settings, popover, and dialog layers in one ordered ladder. Fixed in `357be55f7`; tests: `tests/libadwaita-surface-layers-css.test.js`, `tests/side-panel-adapters.e2e.js`.
- **Shared entries:** upstream `.text_pole` rules and surface-specific selectors can silently fork dialog search fields. Keep the shared `.sb-dialog__entry` rule more specific than those inputs, remove surface copies, and compare rest/focus metrics across the manager overlays in their e2e suites.
- **Adopted rows:** moving an upstream list into shared dialog chrome must preserve the original action nodes as the handler boundary. Add adapter unit coverage for every forwarded action and keyboard route, plus an e2e that reaches the overflow actions through the production menu.
- **Touch close controls:** nested Popup close nodes can bypass direct-child coarse-pointer rules. Keep Close in the shared header layout and assert its 44×44 box on coarse-pointer Data Bank and Tag Manager surfaces.
- **Window filtering:** content-sized Windows can shrink when a live search removes rows. Keep Window surfaces fill-sized by default, opt only deliberately short Windows into content sizing, and lock a content-sized frame at its largest laid-out height. Tests: `tests/tag-manager.e2e.js`; `tests/sillybunny-overlays.e2e.js`; the Window and media dialog suites.

### Upstream compatibility and sync

- **Breaks:** the version map reports the wrong SillyTavern base, so extensions that need a newer SillyTavern fail.
- **Files:** `docs/upstream-sync.md`, `public/scripts/sillybunny-version-map.js`, `public/scripts/openai.js`, `src/endpoints/backends/`.
- **Guards:** the version map clamps a SillyBunny version with no mapping to the highest synced SillyTavern version for its major.
- **Tests:** `tests/sillybunny-version-map.test.js`, `tests/upstream-provider-parity.test.js`.
- **Fixes:** #410 (SillyBunny 1.6.4 still mapped to SillyTavern 1.16.4). The same bug came back on the next minor version; #497 fixed it with the clamp. #843 and #845 (provider parity with upstream).
- **Open:** issue #713, where the Quick Image Gen manual sync fails in Docker (no `bash`, no real `node`). No fix PR found.

## Reverts and release problems

- Performance work caused the largest rollback: `0ecfa44e3` reverted 14 optimisation commits. iOS stayed at "Initializing", and the desktop Characters panel did not open.
- A revert can cause its own regression: `f027cd460` (#595) restored mobile CSS that a June baseline revert removed.
- Release promotion failed once. #866 promoted `staging` to `release` too early for v1.8.0, `5d49b0ad1` (#891) reverted it, and #892 added a workflow guard.
- Hotfixes followed v1.2.7, v1.2.8 and v1.8.1. A cluster of fixes from 12 to 16 April led to the v1.3.6 stability release.
