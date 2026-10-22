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
- **Tests:** `tests/chat-render-lifecycle-script-wiring.test.js`, `tests/chat-scroll-regressions.e2e.js`, `tests/request-cancellation.test.js`, `tests/in-chat-agents-companion-panel.test.js`.
- **Fixes:** #271 (stabilise chat scrolling), #314 (cancel when a stream disconnects), #771 (resize and load lock work against each other), #783 (streaming moves the screen).

### In-chat agents and companions

- **Breaks:** cancelled or stale agent turns run again or change the active response.
- **Files:** `public/scripts/extensions/in-chat-agents/agent-runner.js`, `agent-store.js`, `companion/companion-runner.js`, `companion/companion-panel.js`.
- **Tests:** `tests/in-chat-agents-runner.test.js`, `tests/guided-generations-profiles.test.js`, `tests/guided-generations-steering.test.js`.
- **No test:** `59aeea3f1` (#385, abort agent generation on cancel), `20353df60` (hotfix, swipes rerun agents).
- **Fixes:** #839 (Guided Generations cancel, swipe cleanup and profile restore).
- **Order matters:** Guided Generations calls `integrateQrBar()` before it returns for a hidden bar (`public/scripts/extensions/guided-generations/index.js`). If the order changes, Quick Replies show in the composer after a reload (`8ce1a10a5`). Test: `tests/guided-generations-settings.test.js`.

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
