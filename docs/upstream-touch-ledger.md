# Upstream Touch Ledger

This ledger tracks intentional SillyBunny divergence in upstream-origin files. Its purpose is to keep fork behavior mechanically protected during upstream syncs.

## Rules
- Add or update an entry whenever an upstream-origin file is modified for SillyBunny behavior.
- Keep entries concise and test-backed.
- Do not use the ledger to justify broad inline fork logic. Prefer moving behavior behind a SillyBunny module and keeping upstream-origin files as thin adapters.
- If a seam absorbs the divergence later, update the entry rather than leaving stale notes.

## Entry Template
| Field | Value |
| --- | --- |
| File | `path/to/file.js` |
| Area | Chat lifecycle, mobile shell, preset/API sync, generation lifecycle, extension boot, settings, cache, or other named area. |
| Divergence reason | Why SillyBunny must differ from upstream here. |
| Target seam | The SillyBunny module that should own this behavior, or `none yet` if the seam still needs to be created. |
| Adapter shape | The smallest call or hook that should remain in the upstream-origin file. |
| Protecting tests | Unit/e2e/budget checks that fail if this divergence regresses. |
| Validation | Commands or manual checks used for the latest change. |
| Rollback path | How to revert safely if the divergence breaks upstream compatibility. |
| Last reviewed | Date, issue, PR, or upstream sync reference. |
| Owner | Person or role responsible for keeping the entry current. |

## Active Entries

### `public/script.js` - chat render lifecycle
| Field | Value |
| --- | --- |
| Area | Chat lifecycle. |
| Divergence reason | SillyBunny adds mobile batching, bottom pinning, manual-scroll suppression, long-chat anchoring, streaming DOM throttles, and issue `#167` scroll stability behavior. |
| Target seam | `public/scripts/chat-render-lifecycle/`. |
| Adapter shape | Keep exported compatibility functions in `public/script.js`; delegate bottom-scroll decisions, scheduling, scroll intent, anchor preservation, and update batching to the lifecycle module. |
| Protecting tests | `tests/chat-scroll-edges.test.js`, `tests/mobile-streaming.test.js`, `tests/chat-render-lifecycle-index.test.js`, `tests/chat-render-lifecycle-bottom-scroll.test.js`, `tests/chat-render-lifecycle-rollout-guard.test.js`, `tests/chat-render-lifecycle-anchor.test.js`, `tests/chat-render-lifecycle-scheduler.test.js`, `tests/chat-render-lifecycle-scroll-intent.test.js`, `tests/chat-send-scroll.e2e.js`, `tests/chat-scroll-regressions.e2e.js`, future lifecycle unit tests. |
| Validation | `npm run lint`, `npm run lint --prefix tests -- chat-render-lifecycle-bottom-scroll.test.js chat-render-lifecycle-index.test.js chat-render-lifecycle-rollout-guard.test.js chat-render-lifecycle-scroll-intent.test.js`, `npm run lint --prefix tests -- chat-render-lifecycle-rollout-guard.test.js chat-render-lifecycle-index.test.js`, `npm run lint --prefix tests -- chat-render-lifecycle-index.test.js chat-render-lifecycle-scroll-intent.test.js chat-render-lifecycle-scheduler.test.js chat-render-lifecycle-anchor.test.js`, `npm run test:unit --prefix tests -- chat-render-lifecycle-bottom-scroll.test.js chat-render-lifecycle-index.test.js chat-render-lifecycle-rollout-guard.test.js chat-render-lifecycle-scroll-intent.test.js`, `npm run test:unit --prefix tests -- chat-render-lifecycle-rollout-guard.test.js chat-render-lifecycle-index.test.js`, `npm run test:unit --prefix tests -- chat-render-lifecycle-index.test.js chat-render-lifecycle-scroll-intent.test.js chat-render-lifecycle-scheduler.test.js chat-render-lifecycle-anchor.test.js chat-scroll-edges.test.js mobile-streaming.test.js`, `npm run check:frontend-budgets`, prior focused e2e pack on this stack: `SILLYBUNNY_TEST_BASE_URL=http://127.0.0.1:4567 npm run test:e2e --prefix tests -- chat-scroll-regressions.e2e.js chat-send-scroll.e2e.js`. |
| Rollback path | Keep legacy behavior behind temporary rollout guard until lifecycle fixtures pass. |
| Last reviewed | 2026-05-27 scroll function seam. |
| Owner | Refactor integrator. |

### `public/script.js` - generation lifecycle
| Field | Value |
| --- | --- |
| Area | Generation lifecycle. |
| Divergence reason | SillyBunny generation flow needs explicit UI lock, stop, agent-generation, and unblock decisions while preserving provider calls, prompt assembly, token accounting, and persistence in the existing generation path. |
| Target seam | `public/scripts/generation-lifecycle/`. |
| Adapter shape | Keep exported generation functions in `public/script.js`; delegate send-button lock state, stop-generation request state, and unblock cleanup decisions to the lifecycle module. |
| Protecting tests | `tests/generation-lifecycle.test.js`, `tests/generation-lifecycle-wiring.test.js`, `tests/in-chat-agents-generation-ui-wiring.test.js`, existing export-surface coverage. |
| Validation | `npm run test:unit --prefix tests -- generation-lifecycle.test.js generation-lifecycle-wiring.test.js in-chat-agents-generation-ui-wiring.test.js`, `npm run lint --prefix tests -- generation-lifecycle.test.js generation-lifecycle-wiring.test.js in-chat-agents-generation-ui-wiring.test.js`, `npm run lint`, `npm run check:frontend-budgets`. |
| Rollback path | Revert lifecycle calls in `public/script.js` while keeping existing provider and prompt paths intact. |
| Last reviewed | 2026-06-06 in-chat agent stop-button wiring. |
| Owner | Refactor integrator. |

### `src/endpoints/chats.js`, `public/script.js`, and `public/scripts/group-chats.js` - chat save integrity
| Field | Value |
| --- | --- |
| Area | Chat persistence and data-loss prevention. |
| Divergence reason | SillyBunny must reject stale cross-device chat saves instead of allowing last-write-wins overwrites that destroy newer messages. |
| Target seam | None yet; keep the save-contract adapter minimal until chat persistence has a dedicated fork seam. |
| Adapter shape | Rotate chat metadata integrity in `trySaveChat()`, return the new token from normal and group save routes, and store the returned token in the active client metadata after successful saves. |
| Protecting tests | `tests/chat-integrity-rotation.test.js`; manual two-instance stale-save smoke before release. |
| Validation | `npm run test:unit --prefix tests -- chat-integrity-rotation.test.js`, `node --check src/endpoints/chats.js`, `node --check public/script.js`, `node --check public/scripts/group-chats.js`, `npm run lint`, Node/Bun server smoke. |
| Rollback path | Revert the integrity rotation response contract and client adoption to the prior per-load integrity behavior. |
| Last reviewed | 2026-06-06 chat integrity rotation fix. |
| Owner | Bugfix integrator. |

### `public/script.js` and `public/scripts/group-chats.js` - group chat branch creation
| Field | Value |
| --- | --- |
| Area | Chat lifecycle. |
| Divergence reason | SillyBunny's Start new chat menu path already flushes pending saves and clears the active chat before delegating to group chat creation, so the group branch creator must not run a second navigation-save guard that can abort and repaint the current chat. |
| Target seam | None yet; group chat branch creation still lives in the upstream-origin chat modules. |
| Adapter shape | Keep `doNewChat()` as the stock menu adapter and pass a narrow `chatAlreadyPrepared` option; keep standalone group creation guarded, and tell `getGroupChat()` when the chat id was freshly created so validation trusts the active empty branch until its JSONL exists. |
| Protecting tests | Future focused group-chat new-branch coverage; current protection is static validation. |
| Validation | `node --check public/script.js`, `node --check public/scripts/group-chats.js`, `npm run lint`, `git diff --check`. |
| Rollback path | Revert the option plumbing and newly-created load hint to restore the previous `createNewGroupChat(groupId)` path. |
| Last reviewed | 2026-06-10 group chat Start new chat validation fix. |
| Owner | Bugfix integrator. |

### `public/style.css` - message containment and scroll anchoring
| Field | Value |
| --- | --- |
| Area | Chat lifecycle and CSS containment. |
| Divergence reason | SillyBunny may need targeted containment or visibility handling to stabilize long-chat and macOS/mobile scroll behavior. |
| Target seam | `public/scripts/chat-render-lifecycle/` controls transition classes; CSS remains declarative. |
| Adapter shape | Prefer lifecycle state classes over permanent global `.mes` behavior changes. |
| Protecting tests | Future issue `#167` long-chat, swipe, media resize, and mobile stream fixtures. |
| Validation | No CSS behavior change until repro coverage exists. |
| Rollback path | Revert CSS class or containment rule independently from lifecycle module. |
| Last reviewed | 2026-05-26 refactor plan. |
| Owner | Refactor integrator and test lead. |

### `public/scripts/sillybunny-tabs.js` - shell chat controls
| Field | Value |
| --- | --- |
| Area | Mobile shell, chat navigation, and preset/API sync. |
| Divergence reason | SillyBunny shell owns top/bottom navigation, chat controls, drawers, mobile actions, search shortcut focus, viewport-reset dispatches, and mirrored connection-profile controls that interact with chat and API state. |
| Target seam | `public/scripts/chat-render-lifecycle/` for chat scroll requests; `public/scripts/mobile-shell-lifecycle/` for drawer/nav/viewport behavior; `public/scripts/preset-api-sync-lifecycle/` for active API and connection-profile mirror decisions. |
| Adapter shape | Shell code keeps DOM wiring and requests lifecycle decisions for drawer bounds, viewport sync order, drawer-bound scheduling, overlay exclusivity, rail quick-action normalization and visibility, inline drawer auto-close and persistence keys, nav drag, page scroll, overlay open/close, auto-close, modal inert policy, search shortcut pre-focus, viewport reset timing, active API connect-button lookup, and connection-profile mirror state. |
| Protecting tests | `tests/mobile-shell-lifecycle.test.js`, `tests/mobile-shell-lifecycle-drawer-bounds.test.js`, `tests/mobile-shell-lifecycle-viewport-sync.test.js`, `tests/mobile-shell-lifecycle-overlay-exclusion.test.js`, `tests/mobile-shell-lifecycle-rail-model.test.js`, `tests/mobile-shell-lifecycle-inline-drawers.test.js`, `tests/mobile-shell-lifecycle-wiring.test.js`, `tests/mobile-shell-smoke.e2e.js`, `tests/preset-api-sync-lifecycle.test.js`, `tests/preset-api-sync-lifecycle-wiring.test.js`, future shell smoke checks for drawer/tab/preset/chat-scroll behavior. |
| Validation | `node --check public/scripts/sillybunny-tabs.js`, `npm run lint`, `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json mobile-shell-lifecycle-drawer-bounds.test.js mobile-shell-lifecycle-viewport-sync.test.js mobile-shell-lifecycle-overlay-exclusion.test.js mobile-shell-lifecycle-rail-model.test.js mobile-shell-lifecycle-inline-drawers.test.js mobile-shell-lifecycle-wiring.test.js mobile-shell-lifecycle.test.js` from `tests/`, full `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json` from `tests/`, `npm run check:frontend-budgets`, `SILLYBUNNY_TEST_BASE_URL=http://127.0.0.1:4567 npm run test:e2e -- mobile-shell-smoke.e2e.js` from `tests/`. |
| Rollback path | Keep shell calls narrow so a bad adapter route can be reverted without removing shell UI. |
| Last reviewed | 2026-06-10 inline drawer lifecycle seam. |
| Owner | Refactor integrator and mobile shell owner. |

### `public/scripts/browser-fixes.js` - mobile viewport reset guard
| Field | Value |
| --- | --- |
| Area | Mobile shell. |
| Divergence reason | SillyBunny must restore scroll and avoid re-pinning the root while mobile keyboard close/reset events are still settling. |
| Target seam | No separate seam yet; this file owns browser-specific viewport patches. |
| Adapter shape | Keep reset scheduling, transient fixed-position cleanup, scroll restoration, and reapply suppression in the mobile browser fix helper. |
| Protecting tests | `tests/mobile-shell-lifecycle-wiring.test.js`. |
| Validation | `npm run test:unit --prefix tests -- mobile-shell-lifecycle-wiring.test.js`, `node --check public/scripts/browser-fixes.js`, `node --check public/scripts/sillybunny-tabs.js`, mobile smoke for search close/focus. |
| Rollback path | Restore the prior reset timeout and remove scroll restoration/reapply suppression if mobile viewport behavior regresses. |
| Last reviewed | 2026-06-06 Bug 2 mobile search viewport reset. |
| Owner | Refactor integrator and mobile shell owner. |

### `public/scripts/openai.js` and `public/index.html` - tool recursion limit setting
| Field | Value |
| --- | --- |
| Area | Settings and tool calling. |
| Divergence reason | SillyBunny exposes a tool-call recursion limit control that must persist and drive the actual runtime cap instead of showing the browser range midpoint. |
| Target seam | `public/scripts/tool-call-recurse-limit.js`. |
| Adapter shape | Keep `openai.js` limited to settings map/default wiring, load/change synchronization, and assigning `ToolManager.RECURSE_LIMIT`; keep `index.html` default values aligned with the runtime default. |
| Protecting tests | `tests/tool-call-recurse-limit.test.js`, `tests/tool-call-recurse-limit-wiring.test.js`. |
| Validation | `npm run test:unit --prefix tests -- tool-call-recurse-limit.test.js tool-call-recurse-limit-wiring.test.js`, `node --check public/scripts/openai.js`, `node --check public/scripts/tool-call-recurse-limit.js`, `npm run lint`, `npm run check:frontend-budgets`. |
| Rollback path | Remove the setting map/default and input handler, leaving `ToolManager.RECURSE_LIMIT` at its static default. |
| Last reviewed | 2026-06-06 tool recursion limit fix. |
| Owner | Bugfix integrator. |

### `public/scripts/mobile-streaming.js` - platform streaming policy
| Field | Value |
| --- | --- |
| Area | Mobile streaming. |
| Divergence reason | SillyBunny needs iOS WebKit conservative streaming and optional smooth-streaming bypass behavior. |
| Target seam | Keep this as platform policy consumed by `chat-render-lifecycle`; do not let it own DOM orchestration. |
| Adapter shape | Export pure policy helpers for effective smooth streaming, reduced DOM work, and update intervals. |
| Protecting tests | `tests/mobile-streaming.test.js`, future lifecycle streaming tests. |
| Validation | Existing unit tests plus future lifecycle checks. |
| Rollback path | Disable conservative policy flags while preserving base streaming path. |
| Last reviewed | 2026-05-26 refactor plan. |
| Owner | Refactor integrator. |

### `public/scripts/extensions.js` - extension boot lifecycle
| Field | Value |
| --- | --- |
| Area | Extension boot. |
| Divergence reason | SillyBunny extension boot needs duplicate manifest protection, deterministic activation ordering, dependency/module gating, disabled dependency handling, and client-version checks while preserving the existing extension runtime loading hooks. |
| Target seam | `public/scripts/extension-boot-lifecycle/`. |
| Adapter shape | Extension runtime keeps fetch/script/style/hook behavior and delegates manifest registration, dedupe keys, activation ordering, and activation eligibility decisions to the lifecycle module. |
| Protecting tests | `tests/extension-boot-lifecycle.test.js`, `tests/extension-boot-lifecycle-wiring.test.js`, `tests/extensions-disable.test.js`. |
| Validation | `npm run test:unit --prefix tests -- extension-boot-lifecycle.test.js extension-boot-lifecycle-wiring.test.js extensions-disable.test.js`, `npm run lint --prefix tests -- extension-boot-lifecycle.test.js extension-boot-lifecycle-wiring.test.js`, `npm run lint`, `npm run check:frontend-budgets`. |
| Rollback path | Revert helper calls in `extensions.js` while leaving extension settings and runtime load paths unchanged. |
| Last reviewed | 2026-05-28 extension boot lifecycle wiring. |
| Owner | Refactor integrator and extension runtime owner. |

### `public/scripts/extensions/quick-reply/` - active set canonicalization
| Field | Value |
| --- | --- |
| Area | Extension quick replies, settings, and automation. |
| Divergence reason | SillyBunny needs duplicate Quick Reply set names from saved/imported data to resolve to one canonical active set so buttons, auto-execute, API lookup, settings selectors, and persisted chat/character links do not duplicate or disappear. |
| Target seam | `public/scripts/extensions/quick-reply/src/quick-reply-set-list.js`. |
| Adapter shape | Keep call sites using normalized set/link helpers for load, render, API, auto-execute, and settings traversal. |
| Protecting tests | `tests/quick-reply-set-list.test.js`, `tests/quick-reply-config.test.js`, `tests/quick-reply-button-ui.test.js`, `tests/quick-reply-auto-execute.test.js`, `tests/quick-reply-api.test.js`. |
| Validation | `npm run test:unit --prefix tests -- quick-reply-set-list.test.js quick-reply-config.test.js quick-reply-button-ui.test.js quick-reply-auto-execute.test.js quick-reply-api.test.js`, `npm run lint`, `npm run check:frontend-budgets`. |
| Rollback path | Remove helper calls and revert to exact-name set/link traversal if canonicalization regresses saved Quick Reply data. |
| Last reviewed | 2026-06-02 Quick Replies duplicate fix. |
| Owner | Refactor integrator and extension runtime owner. |

### `public/scripts/ooc-blocks.js` - prompt context retention
| Field | Value |
| --- | --- |
| Area | Prompt context and settings. |
| Divergence reason | SillyBunny exposes OOC and raw HTML retention depth where `0` must keep the active turn while stripping older context messages. |
| Target seam | `public/scripts/ooc-blocks.js`. |
| Adapter shape | Keep retention-depth normalization and message-depth checks in this module; keep settings copy in `public/index.html` aligned with behavior. |
| Protecting tests | `tests/ooc-blocks.test.js`. |
| Validation | `npm run test:unit --prefix tests -- ooc-blocks.test.js`, `npm run lint`, `npm run check:frontend-budgets`. |
| Rollback path | Revert the comparison and settings copy to previous strip-at-zero behavior. |
| Last reviewed | 2026-06-02 active-turn retention fix. |
| Owner | Refactor integrator. |

### `public/scripts/samplerSelect.js` - selected sampler storage
| Field | Value |
| --- | --- |
| Area | Preset/API sync and sampler settings. |
| Divergence reason | SillyBunny persists text-generation sampler visibility and manual priority while guarding startup from slow IndexedDB reads that could otherwise overwrite saved selections with fallback state. |
| Target seam | `public/scripts/sampler-storage.js`. |
| Adapter shape | Keep `samplerSelect.js` as the DOM/settings adapter and delegate timeout-backed storage loading to `sampler-storage.js`. |
| Protecting tests | `tests/sampler-storage.test.js`. |
| Validation | `npm run test:unit --prefix tests -- sampler-storage.test.js`, `npm run lint`, `npm run check:frontend-budgets`. |
| Rollback path | Revert the storage helper import and save guard, returning to direct `localforage.getItem('selectedSamplers')` loading. |
| Last reviewed | 2026-06-02 sampler storage timeout guard. |
| Owner | Refactor integrator and preset/API sync owner. |

### `public/index.html` - boot assets and settings copy
| Field | Value |
| --- | --- |
| Area | Settings and frontend boot. |
| Divergence reason | SillyBunny keeps `script.js` loaded through its canonical URL, keeps OOC/HTML retention settings copy synchronized with active-turn depth behavior, and exposes core background transparency sliders without requiring Moonlit Echoes. `script.js` must NEVER carry a `?v=` query: every module imports `../script.js` bare, and a versioned tag URL splits ES-module identity so `script.js` evaluates twice and registers every delegated handler twice (all inline-drawer toggles break). Stale-cache protection comes from `src/middleware/frontend-assets.js` serving JS with `Cache-Control: no-cache`, not from URL versioning. |
| Target seam | `public/scripts/ooc-blocks.js` for retention behavior; `public/css/sillybunny-chat-styles.css` and `public/scripts/power-user.js` for core transparency behavior. |
| Adapter shape | Keep HTML changes limited to static boot references and settings labels/tooltips. |
| Protecting tests | `tests/script-module-identity.test.js`, `tests/frontend-assets.test.js`, `tests/ooc-blocks.test.js`, `tests/core-message-transparency.test.js`. |
| Validation | `npm run test:unit --prefix tests -- script-module-identity.test.js frontend-assets.test.js ooc-blocks.test.js`, `npm run test:unit --prefix tests -- core-message-transparency.test.js`, `npm run build:frontend`, browser smoke check. |
| Rollback path | Restore versioned `script.js` references, previous settings copy, and remove core transparency slider markup if cache behavior or settings semantics regress. Chat transparency CSS loading rolls back through `public/scripts/power-user.js`. |
| Last reviewed | 2026-06-11 script.js module-identity regression fix (double-evaluated frontend after #413 re-versioned the tag; inline drawers dead). |
| Owner | Refactor integrator. |

### `public/index.html` - mobile stylesheet media gates
| Field | Value |
| --- | --- |
| Area | Mobile shell and frontend boot. |
| Divergence reason | SillyBunny keeps upstream `mobile-styles.css` and the fork mobile shell stylesheet gated to `max-width: 768px` so compact desktop widths use desktop chrome while still receiving upstream 1000px layout rules. |
| Target seam | None; this is static boot markup. |
| Adapter shape | Keep the `css/mobile-styles.css` and `css/sillybunny-mobile-shell.css` stylesheet links on `media="(max-width: 768px)"`, loaded after upstream `style.css` and before `css/user.css`. |
| Protecting tests | `tests/mobile-css-budgets.test.js` (`mobile sheets keep their (max-width: 768px) media gates`, `fork sheets load after upstream styles and before user.css`) and the 820x1180 compact desktop smoke checkpoint in `tests/mobile-shell-smoke.e2e.js`. |
| Validation | `npm run test:unit --prefix tests -- mobile-css-budgets.test.js`, mobile smoke pack before CSS consolidation PRs. |
| Rollback path | Restore prior stylesheet link gates and load order if compact desktop or mobile shell boot behavior regresses. |
| Last reviewed | 2026-06-11 PR 2.1 mobile breakpoint ledger. |
| Owner | Refactor integrator and mobile shell owner. |

### `public/css/backgrounds.css` - background image transparency
| Field | Value |
| --- | --- |
| Area | Settings and frontend boot. |
| Divergence reason | SillyBunny background-image opacity and blur must work without the Moonlit Echoes extension enabled. |
| Target seam | `public/scripts/power-user.js` owns the persisted theme effect values; CSS remains declarative. |
| Adapter shape | Consume `--customCSS-bg-opacity` and `--customCSS-bg-blur` on the background image elements. |
| Protecting tests | `tests/core-message-transparency.test.js`. |
| Validation | `npm run test:unit --prefix tests -- core-message-transparency.test.js`, `node --check public/scripts/power-user.js`, `npm run check:frontend-budgets`. |
| Rollback path | Remove the two CSS variable consumers and leave existing background image selection untouched. |
| Last reviewed | 2026-06-06 Bug 1 transparency migration. |
| Owner | Refactor integrator. |

### `public/scripts/sillybunny-tabs.js` - menu layout and character drawer
| Field | Value |
| --- | --- |
| Area | Mobile shell and character menu. |
| Divergence reason | SillyBunny keeps horizontal labeled menu rails as the default, supports vertical rail mode without mixing Workspace and Customize shortcuts, and routes Character Menu controls through the canonical drawer when duplicate runtime nodes exist. |
| Target seam | `public/scripts/mobile-shell-lifecycle/` for drawer/nav state; no separate seam yet for Character Menu tab copy and canonical DOM targeting. |
| Adapter shape | Keep shell state updates and DOM routing in `sillybunny-tabs.js`; delegate only viewport/nav open-state decisions to lifecycle helpers where they already exist. |
| Protecting tests | `tests/mobile-shell-lifecycle.test.js`, `tests/mobile-shell-lifecycle-wiring.test.js`, focused browser smoke for horizontal labels, vertical rail separation, and Character Menu drawer tabs. |
| Validation | `node --check public/scripts/sillybunny-tabs.js`, `git diff --check`, mobile/desktop browser smoke on Character Menu horizontal labels, vertical rail behavior, and canonical drawer targeting. |
| Rollback path | Revert the nav default/rail action filtering and Character panel helper calls independently from the shell lifecycle helpers. |
| Last reviewed | 2026-06-02 PR #315 menu layout polish. |
| Owner | Refactor integrator and mobile shell owner. |

### `public/scripts/openai.js` and `public/scripts/textgen-models.js` - mobile OpenRouter selects
| Field | Value |
| --- | --- |
| Area | Settings and mobile shell. |
| Divergence reason | SillyBunny must avoid Select2 keyboard-only behavior on touch/mobile OpenRouter/API model and provider selects while preserving the underlying native select values and existing change handlers. |
| Target seam | No separate seam yet; future API settings UI helpers can own reusable inline select rendering. |
| Adapter shape | Keep the inline picker as a thin DOM adapter around existing `<select>` elements; dispatch native `change`/`input` events so current settings logic remains authoritative. |
| Protecting tests | Existing OpenAI/textgen settings unit coverage where applicable, plus focused browser smoke for OpenRouter model, provider, and quantization menus on mobile and desktop Select2 parity. |
| Validation | `node --check public/scripts/openai.js`, `node --check public/scripts/textgen-models.js`, `git diff --check`, mobile browser smoke opening OpenRouter model/provider/quantization menus and selecting through native-backed lists. |
| Rollback path | Remove the inline picker binding and restore Select2/native select initialization to the previous mobile branch if dropdown behavior regresses. |
| Last reviewed | 2026-06-02 PR #315 mobile dropdown fix. |
| Owner | Refactor integrator and settings owner. |

### `public/scripts/openai.js` - impersonate first-person defaults
| Field | Value |
| --- | --- |
| Area | Generation lifecycle and settings. |
| Divergence reason | SillyBunny impersonate generations on chat-completion backends need a first-person user-voice control prompt even when the editable impersonation fields are empty. Guided Generations must also let custom impersonation prompts control first-, second-, or third-person perspective without a conflicting first-person-only frame. |
| Target seam | Core chat-completion prompt preparation in `public/scripts/openai.js`; Guided Generations adds its own fork-side system frame. |
| Adapter shape | Keep fallback selection in tiny helpers, use the default impersonation prompt for empty system directives, use a default Claude user-speaker prefill, and respect prompt-manager disabling when adding the impersonate control prompt. Keep Guided Generations' impersonate frame person-neutral and make the user-configured guide authoritative for perspective and narration style. |
| Protecting tests | `tests/openai-impersonate-defaults.test.js`, `tests/guided-generations-steering.test.js`. |
| Validation | `npm run test:unit --prefix tests -- openai-impersonate-defaults.test.js guided-generations-steering.test.js`, `node --check public/scripts/openai.js`, live chat-completion impersonate smoke when API access is available. |
| Rollback path | Restore empty-string behavior for impersonation prompt/prefill and remove the prompt-manager guard if provider behavior regresses. |
| Last reviewed | 2026-06-13 Guided Impersonate person-neutral steering. |
| Owner | Refactor integrator and settings owner. |

### `public/css/sillybunny-tabs.css`, `public/css/sillybunny-mobile-shell.css`, `public/css/select2-overrides.css`, `public/css/welcome.css`, `public/style.css`, `public/script.js`, `public/sw.js`, and `public/index.html` - menu polish assets
| Field | Value |
| --- | --- |
| Area | Mobile shell, settings, cache, and frontend boot. |
| Divergence reason | SillyBunny UI polish needs responsive Character Menu rail sizing, mobile inline picker styling, Select2 z-layer fixes, welcome card text wrapping, and cache-busted asset references for the updated shell files. |
| Target seam | CSS remains declarative; frontend asset/cache references stay in the existing boot files. |
| Adapter shape | Keep CSS changes scoped to SillyBunny shell/select/menu classes and update only the affected boot/cache version strings. |
| Protecting tests | `tests/frontend-assets.test.js`, frontend asset budget check, focused browser smoke for mobile/desktop menu layout and dropdown layering. |
| Validation | `git diff --check`, frontend asset check in CI, browser smoke for mobile Character Menu, desktop Character Menu, and OpenRouter dropdown layering. |
| Rollback path | Revert the cache-bust strings and scoped CSS blocks together if stale assets, menu layout, or dropdown layering regress. |
| Last reviewed | 2026-06-02 PR #315 menu/layout polish. |
| Owner | Refactor integrator and mobile shell owner. |

### `public/scripts/PromptManager.js` - prompt manager lifecycle
| Field | Value |
| --- | --- |
| Area | Prompt manager lifecycle. |
| Divergence reason | SillyBunny Prompt Manager needs explicit render gating, generation-active waiting, dry-run/live render selection, and scroll restoration while keeping prompt assembly, token counting, and DOM rendering in the existing class. |
| Target seam | `public/scripts/prompt-manager-lifecycle/`. |
| Adapter shape | PromptManager keeps prompt/render implementation and delegates render gating, render mode, and scroll-restore decisions to the lifecycle module. |
| Protecting tests | `tests/prompt-manager-lifecycle.test.js`, `tests/prompt-manager-lifecycle-wiring.test.js`. |
| Validation | `npm run test:unit --prefix tests -- prompt-manager-lifecycle.test.js prompt-manager-lifecycle-wiring.test.js`, `npm run lint --prefix tests -- prompt-manager-lifecycle.test.js prompt-manager-lifecycle-wiring.test.js`, `npm run lint`, `npm run check:frontend-budgets`. |
| Rollback path | Revert lifecycle calls in `PromptManager.js` while leaving prompt data and service settings untouched. |
| Last reviewed | 2026-05-28 prompt manager lifecycle wiring. |
| Owner | Refactor integrator and prompt manager owner. |

### `src/endpoints/backends/chat-completions.js`, `public/scripts/openai.js`, and `public/index.html` - claude-fable-5 request compatibility
| Field | Value |
| --- | --- |
| Area | Generation lifecycle and settings (Claude chat-completion request builders). |
| Divergence reason | `claude-fable-5` rejects `temperature`/`top_p`/`top_k`, explicit `thinking:{type:'disabled'}`, and assistant prefill with HTTP 400, and upstream's Claude model gating, dropdown, 1M-context regex, and vision list do not know the model. SillyBunny gates fable into the existing per-model flags, strips the removed samplers on both the native and OpenAI-compatible paths, and forwards real upstream error bodies on non-streaming failures instead of a generic 500. |
| Target seam | None yet; the core fix follows upstream's existing per-model regex/delete-block patterns so it can be contributed to SillyTavern and dropped here on a future upstream sync. |
| Adapter shape | `isFableModel` flag OR'd into existing gating regexes plus a sampler delete-block in `sendClaudeRequest`; a source-aware delete-block in `createGenerationParameters`; one dropdown option, one regex alternation, one vision-list entry; error passthrough kept as a separate commit. |
| Protecting tests | None yet; current protection is static validation and the PR #403 relay isolation test record (minimal 200, +samplers 400, adaptive+effort 200, thinking-disabled 400, system-message 400 on non-converting relay). Add focused unit coverage if fable gating grows beyond regex alternations. |
| Validation | `npm run lint`, `node --check src/endpoints/backends/chat-completions.js`, `node --check public/scripts/openai.js`, direct relay curls against `https://api.linkapi.ai/v1/messages` and `/chat/completions` (2026-06-10), regression check that opus-4-6/sonnet-4-6/sonnet-4-5 payloads are unchanged. |
| Rollback path | Revert the fable regex alternations and delete-blocks to restore stock behavior (fable then 400s again on samplers); the error passthrough commit can be reverted independently. |
| Last reviewed | 2026-06-10 PR #403 claude-fable-5 400 fix. |
| Owner | Bugfix integrator. |

## Candidate Entries To Add Later
| File or area | Add entry when |
| --- | --- |
| Core settings modules | Preset/API sync refactor starts. |
| Screenshot/image-gen UI code | Lazy loading of non-active tooling begins. |

## Review Checklist
- Does the upstream-origin file contain only adapter wiring and concise comments?
- Does the target seam have a small interface and concentrated implementation?
- Does at least one test protect the divergence?
- Does the rollback path avoid user data changes?
- Does the PR keep upstream sync work separate from fork feature work?
- Did validation name the lifecycle affected: fresh install, restart after update, stale assets, mobile viewport, long chat, streaming, swipe, or settings save?
