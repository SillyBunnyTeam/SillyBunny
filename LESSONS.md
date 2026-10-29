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
- **No test:** #438 (iOS overscroll blanks the page, keyboard moves the composer).
- **Fixes:** #658 (composer stays above the iOS keyboard), #840 (touch scroll in expanded mobile editors), #914 (pickers open during scroll).

### Scroll, streaming and cancellation

- **Breaks:** rendering or resizing moves the reader's position; cancelling leaves stream state behind.
- **Files:** `public/script.js`, `public/scripts/chat-render-lifecycle/`, `public/scripts/chats.js`, `src/request-cancellation.js`.
- **Guards:** `chat-render-lifecycle/scroll-intent.js` decides when to follow the newest message, `resize-observer.js` handles content that resizes after render, and `mobile-viewport.js` handles mobile viewport changes.
- **Guards:** a page hands its chat replies to the server and stops its stream on `pagehide`, not `beforeunload` (`public/scripts/resumable-generation.js`, `public/script.js`). A leave-site prompt can cancel `beforeunload`, and the page then stays with replies the server still writes into the chat (PR #877 review). Test: `tests/resumable-generation-frontend.test.js`.
- **Guards:** Stop cancels the run, so `Generate()` never reaches its finish path for the stopped reply. `stopGeneration()` calls `StreamingProcessor.finalizeStoppedMessage()`, which ends the reasoning with all reasoning that arrived, records `extra.reasoning_duration`, removes `extra.server_generation_placeholder` and saves the chat. Without it, a reply stopped during reasoning kept "Thinking..." and a null duration, and no save followed Stop, so a chat reload right after Stop dropped the reply (10f2b91e4 set `isStopped` in `onStopStreaming()`; 0167ddc2a made Stop a cancellation that clears the streaming processor). Tests: `tests/story-mode-request-controls.test.js`, `tests/server-generation-commit.e2e.js`.
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
  - The server writes a reply over an existing message only when that message carries `extra.server_generation_placeholder` with the generation's start time. The browser removes the mark when the reply is finished or stopped, so a reply the page saved itself, and later edits to it, are not overwritten (`src/generation-commit.js`).
  - `Generate()` awaits `settleGenerationCommit()` before it saves a finished reply. If the server answers `committed`, the page reloads the chat and does not save its own copy, which would fail the integrity check. Stream readers return at `[DONE]`, which can come before the body ends and claims on its own (PR #877 review).
  - A tab keeps its server event stream (`public/scripts/server-generations.js`) only while it is visible or reads a reply of its own. Over HTTP/1.1 a browser opens about 6 connections per server for all its tabs; with a stream in every tab, a seventh tab never loads (PR #877 review). Tests: `tests/server-generations-frontend.test.js`, `tests/server-generation-commit.e2e.js`.
  - A tab that reloaded once for a server-written reply and still finds no mark for it acknowledges it. Otherwise each reload reconnects, hears of the reply again and reloads again until the server forgets it.
  - `reloadCurrentChat()` removes an open message editor but leaves `this_edit_mes_id` set. A reload for a server-written reply reopens the edit with its unsaved text through `messageEdit()`, unless the reply changed that message, and clears the id with `setEditedMessageId()` (`restoreOpenEdit()` in `public/scripts/server-generations.js`). Waiting with the reload does not help: once the server has written the chat, saving the edit fails the integrity check. Tests: `tests/server-generations-frontend.test.js`, `tests/server-generation-commit.e2e.js`.
- **Tests:** `tests/chat-cloning-lifecycle.test.js`, `tests/chat-save-guard.test.js`, `tests/chat-save-queue-runtime.test.js`, `tests/chat-integrity-rotation.test.js`, `tests/reload-chat-safeguard.test.js`, `tests/prove-368-differential.test.js`, `tests/server-generation-commit.test.js`, `tests/resumable-generation-frontend.test.js`, `tests/story-mode-request-controls.test.js`.
- **Fixes:** #819 (queued saves across swipes clone chats), #849 (staged reloads wipe chats), #373 (extra pre-write backups push older backups out), #856 (issue #706: a chat saves when opened).

### Cache, boot and reload

- **Breaks:** boot continues before the cache is invalidated; a module is evaluated twice.
- **Files:** `public/index.html`, `public/sw.js`, `public/scripts/sillybunny-restart-cache-clear.js`, `src/middleware/frontend-assets.js`.
- **Guards:** unhashed assets are served with `Cache-Control: no-cache` (`src/middleware/frontend-assets.js`). Fingerprinted assets are served as `immutable` (`src/frontend-assets.js`). `scripts/check-frontend-budgets.js` checks asset budgets.
- **Tests:** `tests/frontend-asset-middleware.test.js`, `tests/restart-cache-clear.test.js`.
- **No test:** `b6d657e08` (#380, stale iOS service-worker cache), `fe3e25446` (#429, versioned module URLs evaluate `script.js` twice).
- **Fixes:** #416 (restore JavaScript revalidation), #906 (boot races the restart cache-clear reload).

### Runtimes, Termux, launchers and updates

- **Breaks:** the wrong runtime or shell behaviour on one platform.
- **Files:** `Start-Node.bat`, `start.sh`, `scripts/`, `src/npm-launcher.js`, `src/endpoints/server-admin.js`, `src/android-app-gate.js`.
- **Guards:**
  - `server.js` runs under `src/server-supervisor.js`. It loads `src/server-log-buffer.js` first and imports `src/server-main.js` last. Do not change this import order.
  - The Android app sets `SILLYBUNNY_ANDROID_APP=1` (`ProcessEnvironment.kt`). `start.sh` then skips the Termux, prerequisite and runtime detection paths (`is_android_app()`) and picks Node.js, because the APK bundles git, Node.js and npm but not Bun. Each of these divergences has a `# SillyBunny:` comment.
  - A checkout update that needs a newer Android app stops before it changes `HEAD`. `scripts/self-update.sh` and the `/update` and `/switch-branch` routes in `src/endpoints/server-admin.js` (through `src/android-app-gate.js`) read `android/min-app-version` at the fetched commit, and then update to that commit only. Both write `update-blocked.json`, from which the app shows its update prompt; the routes also refuse with `android_app_update_required`.
- **Bun and disconnects:** under Bun 1.3.12 and 1.3.14 an Express response emits no `close` when the client disconnects; the request and its socket do. Node emits all three, and emits the response's `close` from inside the socket's. The streamed routes in `src/resumable-generations.js` use `whenClientGone()`, which watches both and runs once (test: `tests/server-generation-commit.test.js`). Still on the response's `close`: `src/endpoints/backends/chat-completions.js`, `src/endpoints/server-admin.js`, `src/endpoints/chat-archive.js`, `src/server-listen.js`.
- **Bun and the listen port:** before Bun 1.4.0, sockets on Windows are inheritable (oven-sh/bun#36936, fixed by oven-sh/bun#36938). A process that the server starts, such as git during an update, can keep the port bound after the server exits. `engines.bun` still allows 1.3.14. The listen retry window in `src/server-listen.js` and `GIT_OPTIONS` in `src/endpoints/server-admin.js` (no background git maintenance during updates) guard against it. `hasBunSocketInheritBug()` limits the port-conflict hint and the dead-holder diagnostic to Bun before 1.4.0 on Windows (test: `tests/server-listen.test.js`). Before Bun 1.4.3, `closeAllConnections()` does nothing once `close()` has run (oven-sh/bun#43557), so `closeListeningServers()` also destroys the tracked sockets.
- **Termux pins:** `android/runtime.lock` pins exact Termux debs, and the Termux repository keeps only the newest version of each package. A pin returns 404 as soon as Termux updates that package; `ca-certificates` updates itself since termux-packages `d3dde8b08c`. Builds read a pin set that is in the input mirror (next bullet) from the mirror first, so the 404 reaches only builds of a set that is not in the mirror yet. Refresh both locks with `bash android/runtime/fetch-termux.sh --update-lock`, then `bash android/runtime/build-sources.sh --refresh-lock`. `android/runtime/sources.py` drops a recipe's `termux_pkg_auto_update()` function before it looks for downloads, because only Termux's update bot runs it (`f514ac58e`). A function body with an unindented line stays in, and its `curl` still fails the refresh with `unsupported-recipe-download` (tests: `android/runtime/test-sources.py`).
- **Input mirror:** release builds read every pinned input only from the input mirror, the `inputs-<12 hex>` versions of the Node runtime's GHCR package (`android/runtime/runtime-mirror.py`; `--mirror-only` in `android/release/build-release-apks.sh`), so a release still builds after Termux or another host removes a pinned file. The `mirror` job in `.github/workflows/android-runtime.yml` publishes a new pin set only on a `staging` push or a manual run with `publish: true`. Until it does, the builds of a branch that changes the pins, such as a pin refresh, read the origins, and the release workflow's `decide` job fails with `mirror-missing`. A newer push cancels a mirror run that waits in the workflow's concurrency group; re-run the cancelled run to publish its set. Never delete an `inputs-*` version, because it is the only copy of an old set and it holds the corresponding source of the GPL debs. The release recipe runs `build-sources.sh` before `build-npm.py --offline`, so the Node source files also come from the mirror (`46788240f` to `b2f7555a9`; tests: `android/runtime/test-runtime-mirror.py`, `tests/android-runtime-workflow.test.js`, `tests/release-workflows.test.js`).
- **Mirror token:** `android/runtime/sources.py` asks GHCR for an anonymous pull token once per process and keeps the answer: a 401 or 403 (a missing or private package) as no token, and a failed request as its error, so an unreachable token endpoint costs one curl retry cycle instead of one for each pin. The token answer goes to an `--output` file, not to stdout: when curl retries a 429 or 503, it writes the new answer after the failed answer's body on stdout, and the token does not parse, but it empties the `--output` file before each retry (tests: `android/runtime/test-sources.py`).
- **Tests:** `tests/server-supervisor.test.js`, `tests/base64-atomic-writes.test.js`, `tests/server-admin-update-install.test.js`, `tests/server-plugin-manager.test.js`, `tests/server-plugin-update-helper.test.js`, `tests/android-app-mode-scripts.test.js`, `tests/android-bootstrap-scripts.test.js`, `tests/android-self-update-scripts.test.js`, `tests/server-admin-android-gate.test.js`.
- **No test:** `c1a87366c` (#522, Bun bootstrap on Termux), `cd7429421` (issue #672, unescaped parentheses in `Start-Node.bat`).
- **Fixes:** #806 (explicit Base64 decode on Bun), #912 (run npm through Node.js on Windows).

### Security and credentials

- **Breaks:** untrusted card scripts reach remote resources; secrets cross scopes.
- **Files:** `public/scripts/card-script-sandbox/`, `public/scripts/card-script-runtime.js`, `public/scripts/openai.js`, `src/endpoints/backends/chat-completions.js`, `src/middleware/launchToken.js`.
- **Guards:**
  - The card-script sandbox CSP blocks network access (`connect-src 'none'`).
  - Sandbox frames have an opaque origin, so `event.origin` cannot be checked. `handleSandboxMessage()` checks `event.source`, the message schema, the nonce, the message ID and the rate limit, then the command allowlist. It rejects unknown commands.
  - Card scripts need user confirmation before they run (`confirmCardScriptExecution()`). This gate applies only to card scripts; other imported behaviour has no general gate.
  - In the Android app, `src/middleware/launchToken.js` runs right after helmet and before body parsing, logging, authentication and static files (`src/server-main.js`), so other apps on the device cannot use the local server.
  - The cookie-clearing route keeps the `sillybunny_launch` cookie while the gate is on; clearing it would lock the Android browser out of the server.
  - The browser handoff answers with a page that moves to `/`, not a `302` (`c008eb38f`): Chrome does not send a `SameSite=Strict` cookie on the redirect of a navigation that another app started.
- **Tests:** `tests/card-script-runtime.test.js`, `tests/card-script-sandbox-wrapper.test.js`, `tests/openai-prompt-logging-wiring.test.js`, `tests/openai-preset-utils.test.js`, `tests/launch-token.test.js`, `tests/launch-token-server-wiring.test.js`.
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
- **Gradle heap:** packaging the Android APK splits needs more than Gradle's default 512 MiB daemon heap, because zipflinger compresses each entry in memory and the splits package in parallel. With the default, packaging throws `OutOfMemoryError: Java heap space` or stalls. `android/gradle.properties` sets `org.gradle.jvmargs` (`dd4863546`). A `gradle.properties` in the Gradle home overrides it, so a local file with a bigger heap hides the failure; test heap changes with `-Dorg.gradle.jvmargs=...` or without the home file.
- **Emulator KVM:** without `--settle`, `udevadm trigger` returns before udev applies the new rule, so a `/dev/kvm` check right after it can fail on a usable device; one of three smoke jobs on the same runner image failed that way. The Enable KVM step in `.github/workflows/android-smoke.yml` passes `--settle` (`1bd685d99`, test: `tests/android-smoke-workflow.test.js`).
- **Emulator version:** on Linux, `emulator -version` runs the windowed QEMU, which needs `libpulse.so.0` and `libxkbfile.so.1`; without them it exits 127 and prints no version, while the smoke's emulator boots on the headless QEMU (`-no-window`). On CI's runner the smoke preflight read no build until it asked `emulator -no-window -version` (`readEmulatorVersion()` in `tests/android-smoke/adb.js`, `3bd096eff`, test: `tests/android-smoke-runner.test.js`).

### Playwright tests

- **Breaks:** a wait passes at once, so the test checks state too early or proves nothing.
- **Cause:** `page.waitForFunction()` takes a returned Promise as a truthy result (checked with `@playwright/test` 1.64.1), so an `async` predicate never waits. Read module values into `window` first, then wait on a synchronous predicate, as `tests/server-generation-commit.e2e.js` does.
- **Open:** `tests/nanogpt-controls.e2e.js` and `tests/pathfinder-settings.e2e.js` still wait on `async` predicates.
- **Breaks:** work that the app starts when a chat loads runs on its own timers and can land between a test step and its assertion. The failure is rare locally and can still fail a single nightly run (issue #920, see § In-chat agents and companions). To reproduce such a race, hold the request that starts the timer chain with `page.route()` and release it after the test step.

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
