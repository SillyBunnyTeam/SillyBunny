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
| Adapter shape | Keep exported compatibility functions in `public/script.js`; delegate initial-load bottom landing, bottom-scroll decisions, scheduling, scroll intent/state, anchor preservation, replacement/media anchoring, and update batching to the lifecycle module. |
| Protecting tests | `tests/chat-scroll-edges.test.js`, `tests/mobile-streaming.test.js`, `tests/chat-render-lifecycle-index.test.js`, `tests/chat-render-lifecycle-bottom-scroll.test.js`, `tests/chat-render-lifecycle-rollout-guard.test.js`, `tests/chat-render-lifecycle-anchor.test.js`, `tests/chat-render-lifecycle-scheduler.test.js`, `tests/chat-render-lifecycle-scroll-intent.test.js`, `tests/chat-render-lifecycle-scroll-state.test.js`, `tests/chat-scroll-state-machine.e2e.js`, `tests/chat-send-scroll.e2e.js`, `tests/chat-scroll-regressions.e2e.js`, future lifecycle unit tests. |
| Validation | `node --check public/script.js`, focused lifecycle Jest `chat-render-lifecycle-scroll-state.test.js chat-render-lifecycle-script-wiring.test.js`, `npm run check:frontend-budgets`, plus prior lifecycle lint/unit/e2e packs on this stack. |
| Rollback path | Disable affected lifecycle routes with the permanent device-local kill switch while correcting the routed implementation. |
| Last reviewed | 2026-06-13 initial-load scroll-state route. |
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

### `public/index.html`, `public/style.css`, `public/css/mobile-styles.css`, `public/script.js`, and `public/scripts/group-chats.js` - group chat branch creation
| Field | Value |
| --- | --- |
| Area | Chat lifecycle and mobile shell. |
| Divergence reason | SillyBunny's Start new chat menu path already flushes pending saves and clears the active chat before delegating to group chat creation, so the group branch creator must not run a second navigation-save guard that can abort and repaint the current chat. New group branches also need fresh integrity metadata and a member greeting before the first save, plus a compact group-greeting action beside Speak Now on desktop and mobile. |
| Target seam | None yet; group chat branch creation still lives in the upstream-origin chat modules. |
| Adapter shape | Keep `doNewChat()` as the stock menu adapter and pass a narrow `chatAlreadyPrepared` option; keep standalone group creation guarded, and tell `getGroupChat()` when the chat id was freshly created so validation trusts the active empty branch until its JSONL exists. Initialize empty, untainted group chats as fresh, seed one member greeting before the first save, emit first-message events after the chat-changed event, and keep the Add New Greeting button in the existing group speaker control row. |
| Protecting tests | `tests/group-chat-greetings-qol.test.js`, `tests/group-chat-info.test.js`, static validation in `tests/chat-integrity-rotation.test.js`. |
| Validation | `node --check public/scripts/group-chats.js`, `npm run test:unit --prefix tests -- group-chat-greetings-qol.test.js chat-integrity-rotation.test.js group-chat-info.test.js`, `npm run lint`, `git diff --check`. |
| Rollback path | Revert the state-based fresh-chat detection, option plumbing, and newly-created load hint to restore the previous `createNewGroupChat(groupId)` path. |
| Last reviewed | 2026-06-23 group chat greeting initialization fix. |
| Owner | Bugfix integrator. |

### `public/scripts/sillybunny-tabs.js` - shell chat controls (fork seam reference)
| Field | Value |
| --- | --- |
| Area | Mobile shell, top-bar layout, chat navigation, and preset/API sync. |
| Divergence reason | SillyBunny shell owns top/bottom navigation, chat controls, drawers, mobile actions, search shortcut focus, viewport-reset dispatches, and mirrored connection-profile controls that interact with chat and API state. Its per-device icons-only top bar adds canonical Workspace, Customize, and Characters page clusters, hides redundant shell anchors, deduplicates Quick Access targets, and keeps trailing controls fixed while the page rail pans. |
| Target seam | `public/scripts/chat-render-lifecycle/` for chat scroll requests; `public/scripts/mobile-shell-lifecycle/` for drawer/nav/viewport behavior; `public/scripts/preset-api-sync-lifecycle/` for active API and connection-profile mirror decisions. |
| Adapter shape | Shell code keeps DOM wiring and requests lifecycle decisions for drawer bounds, viewport sync order, drawer-bound scheduling, overlay exclusivity, rail quick-action normalization and visibility, inline drawer auto-close and persistence keys, nav drag, page scroll, overlay open/close, auto-close, modal inert policy, search shortcut pre-focus, viewport reset timing, active API connect-button lookup, connection-profile source binding, connection-profile source mutation rebind decisions, connection-profile mirror state, connection-profile mirror updates, connection-profile status text, and connection-strip open state. Keep icons-only behavior in the new top-bar helpers and the narrow integration points in `buildTopBar()`, `getShellProxyButton()`, `stopProxyPointerPropagation()`, `forceDrawerState()`, `syncCharacterShellTabs()`, `syncCharacterDrawerStateFromDom()`, `setActiveTab()`, `updateTopBarBrand()`, `updateShortcutButton()`, and `initAll()`. |
| Protecting tests | `tests/mobile-shell-lifecycle.test.js`, `tests/mobile-shell-lifecycle-drawer-bounds.test.js`, `tests/mobile-shell-lifecycle-viewport-sync.test.js`, `tests/mobile-shell-lifecycle-overlay-exclusion.test.js`, `tests/mobile-shell-lifecycle-rail-model.test.js`, `tests/mobile-shell-lifecycle-inline-drawers.test.js`, `tests/mobile-shell-lifecycle-wiring.test.js`, `tests/mobile-shell-smoke.e2e.js`, `tests/topbar-label-tap-cycle.test.js`, `tests/preset-api-sync-lifecycle.test.js`, `tests/preset-api-sync-lifecycle-wiring.test.js`, future shell smoke checks for drawer/tab/preset/chat-scroll behavior. |
| Validation | `node --check public/scripts/sillybunny-tabs.js`, `npm run lint`, `npm run test:unit --prefix tests -- topbar-label-tap-cycle.test.js mobile-shell-lifecycle-wiring.test.js`, `npm run check:frontend-budgets`, desktop/mobile icons-only browser smoke, plus the existing shell lifecycle unit and e2e packs. |
| Rollback path | Keep shell calls narrow so a bad adapter route can be reverted without removing shell UI. |
| Last reviewed | 2026-07-25 PR #685 icons-only top bar. |
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

### `public/scripts/mobile-streaming.js` - platform streaming policy (fork seam reference)
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

### `public/scripts/ooc-blocks.js` - prompt context retention (fork seam reference)
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

### `public/scripts/sillybunny-tabs.js` - menu layout and character drawer (fork seam reference)
| Field | Value |
| --- | --- |
| Area | Mobile shell and character menu. |
| Divergence reason | SillyBunny keeps horizontal labeled menu rails as the default, supports vertical rail mode without mixing Workspace and Customize shortcuts, and routes Character Menu controls through the canonical drawer when duplicate runtime nodes exist. In icons-only mode, complete character page controls replace the generic drawer-only interaction, and the Characters anchor explicitly opens and highlights only the base Characters page. |
| Target seam | `public/scripts/mobile-shell-lifecycle/` for drawer/nav state; no separate seam yet for Character Menu tab copy and canonical DOM targeting. |
| Adapter shape | Keep shell state updates and DOM routing in `sillybunny-tabs.js`; delegate only viewport/nav open-state decisions to lifecycle helpers where they already exist. Keep the icons-only character state isolated through the top-bar page helpers and the narrow hooks in `buildTopBar()`, `getShellProxyButton()`, `forceDrawerState()`, `syncCharacterShellTabs()`, `syncCharacterDrawerStateFromDom()`, and `setActiveTab()` so the labeled layout retains its existing drawer toggle behavior. |
| Protecting tests | `tests/mobile-shell-lifecycle.test.js`, `tests/mobile-shell-lifecycle-wiring.test.js`, `tests/topbar-label-tap-cycle.test.js`, focused browser smoke for horizontal labels, vertical rail separation, icons-only character pages, and Character Menu drawer tabs. |
| Validation | `node --check public/scripts/sillybunny-tabs.js`, `git diff --check`, `npm run test:unit --prefix tests -- topbar-label-tap-cycle.test.js mobile-shell-lifecycle-wiring.test.js`, and mobile/desktop browser smoke on both icons-only and labeled Character Menu behavior. |
| Rollback path | Revert the nav default/rail action filtering and Character panel helper calls independently from the shell lifecycle helpers. |
| Last reviewed | 2026-07-25 PR #685 icons-only top bar. |
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
| Divergence reason | SillyBunny impersonate generations on chat-completion backends need a first-person user-voice control prompt even when the editable impersonation fields are empty. Guided Generations must also let custom impersonation prompts control first-, second-, or third-person perspective without a conflicting first-person-only frame, Claude user-speaker prefill, or text-completion name prompt. |
| Target seam | Core chat-completion prompt preparation in `public/scripts/openai.js`, shared impersonation mode helpers in `public/scripts/impersonation-mode.js`, text prompt assembly in `public/script.js`, and Guided Generations' fork-side system frame. |
| Adapter shape | Keep fallback selection in tiny helpers, use the default impersonation prompt for empty system directives, use a default Claude user-speaker prefill for plain impersonate, and respect prompt-manager disabling when adding the impersonate control prompt. Keep Guided Generations' impersonate frame person-neutral and route it through neutral impersonation mode so the user-configured guide is authoritative for perspective and narration style. |
| Protecting tests | `tests/openai-impersonate-defaults.test.js`, `tests/guided-generations-steering.test.js`, `tests/impersonation-mode.test.js`. |
| Validation | `npm run test:unit --prefix tests -- openai-impersonate-defaults.test.js guided-generations-steering.test.js impersonation-mode.test.js`, `node --check public/scripts/openai.js`, `node --check public/script.js`, live chat-completion impersonate smoke when API access is available. |
| Rollback path | Restore empty-string behavior for impersonation prompt/prefill and remove the prompt-manager guard if provider behavior regresses. |
| Last reviewed | 2026-06-13 Guided Impersonate neutral core mode. |
| Owner | Refactor integrator and settings owner. |

### `public/css/sillybunny-tabs.css`, `public/css/sillybunny-mobile-shell.css`, `public/css/select2-overrides.css`, `public/css/welcome.css`, `public/style.css`, `public/script.js`, `public/sw.js`, and `public/index.html` - menu polish assets
| Field | Value |
| --- | --- |
| Area | Mobile shell, settings, cache, and frontend boot. |
| Divergence reason | SillyBunny UI polish needs responsive Character Menu rail sizing, mobile inline picker styling, Select2 z-layer fixes, welcome card text wrapping, and cache-busted asset references for the updated shell files. The icons-only top bar adds grouped page rails, mode-scoped shell-anchor hiding, mobile horizontal overflow handling, and guards that prevent mobile rules from restoring hidden Workspace controls. |
| Target seam | CSS remains declarative; frontend asset/cache references stay in the existing boot files. |
| Adapter shape | Keep CSS changes scoped to SillyBunny shell/select/menu classes and mode attributes; update only the affected stylesheet cache version strings in `public/index.html`. |
| Protecting tests | `tests/frontend-assets.test.js`, `tests/topbar-label-tap-cycle.test.js`, `tests/mobile-shell-lifecycle-wiring.test.js`, frontend asset budget check, focused browser smoke for mobile/desktop menu layout and dropdown layering. |
| Validation | `git diff --check`, `npm run test:unit --prefix tests -- topbar-label-tap-cycle.test.js mobile-shell-lifecycle-wiring.test.js`, `npm run check:frontend-budgets`, frontend asset check in CI, and browser smoke for wide, cramped, and mobile icons-only layouts. |
| Rollback path | Revert the cache-bust strings and scoped CSS blocks together if stale assets, menu layout, or dropdown layering regress. |
| Last reviewed | 2026-07-25 PR #685 icons-only top bar. |
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

### `public/script.js`, `public/scripts/openai.js`, and `public/scripts/group-chats.js` - Companion retained prompt context
| Field | Value |
| --- | --- |
| Area | Generation lifecycle, prompt context, and In-Chat Agents. |
| Divergence reason | Opted-in Companion results must remain prompt-only assistant history across text and chat-completion providers without changing stored chat text. Rewritten targets, hidden hosts, groups, tool recursion, prompt transforms, and token limits must use the same selected retained context. |
| Target seam | `public/scripts/extensions/in-chat-agents/companion/companion-shared.js` owns selection and consolidation; `public/scripts/in-chat-agent-inspection.js` owns contribution trimming. Core projection orchestration has no narrower seam yet. |
| Adapter shape | `Generate()` selects retained contributions and carries ephemeral provenance; provider assembly transports that provenance and trims oldest retained contributions first; group generation only resets the explicit rewrite target for automatic continuation. |
| Protecting tests | `tests/in-chat-agents-runner.test.js`, `tests/in-chat-agents-store.test.js`, `tests/in-chat-agents-generation-ui-wiring.test.js`, `tests/guided-generations-correction-wiring.test.js`, and retained-contribution cases in `tests/in-chat-agent-inspection.test.js`. |
| Validation | `npm run test:unit --prefix tests -- in-chat-agents-runner.test.js in-chat-agents-generation-ui-wiring.test.js in-chat-agent-inspection.test.js`, `npm run lint`, `npm run check:frontend-budgets`, and `git diff --check`. |
| Rollback path | Remove retained-context projection, provenance transport, trim loops, and rewrite-target plumbing. Stored Companion settings and results remain compatible and can be ignored without migration. |
| Last reviewed | 2026-07-25 PR #681. |
| Owner | In-Chat Agents maintainer and generation/provider owner. |

### `public/script.js`, `public/scripts/openai.js`, `public/scripts/PromptManager.js`, and `public/css/promptmanager.css` - runtime In-Chat Agent prompt inspection
| Field | Value |
| --- | --- |
| Area | Prompt Manager and generation inspection. |
| Divergence reason | Upstream Prompt Manager cannot identify exact post-macro In-Chat Agent prompts and retained notes after they merge into runtime messages. SillyBunny needs an inspection-only Agents row with roles and token counts that never enters presets or outbound API payloads. |
| Target seam | `public/scripts/in-chat-agent-inspection.js`; Prompt Manager remains the DOM adapter and `ChatCompletion` remains the detached token-counting adapter. |
| Adapter shape | Instrument In-Chat Agent extension prompts through an optional callback, attach ephemeral contribution metadata during provider assembly, publish a detached collection only after complete token counting, and render one non-editable, non-draggable inspection row. |
| Protecting tests | `tests/in-chat-agent-inspection.test.js`, `tests/prompt-display-names.test.js`, and `tests/prompt-manager-lifecycle-wiring.test.js`. |
| Validation | `npm run test:unit --prefix tests -- in-chat-agent-inspection.test.js prompt-display-names.test.js prompt-manager-lifecycle-wiring.test.js`, `npm run lint`, `npm run check:frontend-budgets`, and `git diff --check`. |
| Rollback path | Remove callback instrumentation, ephemeral annotations, detached collection, synthetic row, and scoped row styling. Normal prompt assembly and outbound serialization remain unchanged; no persisted data cleanup is required. |
| Last reviewed | 2026-07-25 PR #681. |
| Owner | In-Chat Agents maintainer and prompt manager owner. |

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

### `public/index.html` - in-chat agent message action buttons
| Field | Value |
| --- | --- |
| Area | Extension boot and chat message UI. |
| Divergence reason | SillyBunny ships in-chat-agent actions on every chat message (`mes_view_agent_changes`, `mes_fix_trackers`, and PR #446's `mes_run_companions`) in the static message template so the buttons exist before the extension boots. |
| Target seam | `public/scripts/extensions/in-chat-agents/`; visibility and behavior are owned by the extension (`companion/companion-ui.js` `updateCompanionButtonVisibility()` and `index.js` button wiring). |
| Adapter shape | Hidden static `div.mes_button` rows only (`style="display: none"`); all logic, visibility toggling, and handlers stay in the extension modules. |
| Protecting tests | `tests/in-chat-agents-runner.test.js`, `tests/in-chat-agents-companion.test.js`, `tests/in-chat-agents-generation-ui-wiring.test.js`. |
| Validation | `npm run test:unit --prefix tests -- in-chat-agents`, manual smoke: buttons hidden with the extension disabled, companion button visible on assistant messages once a companion agent is enabled. |
| Rollback path | Delete the static divs; the extension degrades gracefully because `$('.mes_run_companions')` and friends simply match nothing. |
| Last reviewed | 2026-06-12 PR #446 companion agents. |
| Owner | Extension maintainer. |

### `src/server-startup.js` and `src/endpoints/sillybunny-conversation.js` - Conversation REST API routing
| Field | Value |
| --- | --- |
| Area | API routing and Conversation Mode integration. |
| Divergence reason | SillyBunny exposes a fork-only Conversation Mode REST surface that must stay discoverable on both `/api/sillybunny-conversation` and `/api/sillybunny/conversation` without changing upstream SillyTavern chat/group/settings storage formats. |
| Target seam | `src/endpoints/sillybunny-conversation.js`. |
| Adapter shape | Keep `src/server-startup.js` limited to two `app.use(...)` registrations; keep request validation, storage normalization, and endpoint behavior inside `src/endpoints/sillybunny-conversation.js` and its companion modules. |
| Protecting tests | `tests/sillybunny-conversation-api.test.js`, `tests/conversation-mode-scoped-profile.test.js`, `tests/sillybunny-conversation-key-compatibility.test.js`, `tests/sillybunny-conversation-context-migration.test.js`. |
| Validation | `npm run test:unit --prefix tests -- sillybunny-conversation-api.test.js conversation-mode-scoped-profile.test.js sillybunny-conversation-key-compatibility.test.js sillybunny-conversation-context-migration.test.js`, `node --check src/endpoints/sillybunny-conversation.js`, `node --check src/server-startup.js`. |
| Rollback path | Remove the router mounts from `src/server-startup.js` and revert the Conversation REST endpoint module without touching persisted `settings.json` data. |
| Last reviewed | 2026-07-26 PR #638 review follow-up. |
| Owner | Feature maintainer. |

### `src/endpoints/backends/chat-completions.js` and `src/endpoints/backends/text-completions.js` - Conversation REST generation adapters
| Field | Value |
| --- | --- |
| Area | Generation lifecycle and backend adapter reuse. |
| Divergence reason | SillyBunny Conversation REST needs non-streaming access to the existing backend generation handlers without forking prompt assembly or provider-specific request code into a second implementation. |
| Target seam | `src/endpoints/conversation-generation.js`. |
| Adapter shape | Keep upstream-origin backend files limited to exported `handleChatCompletionsGenerate()` and `handleTextCompletionsGenerate()` adapters while preserving the existing `/generate` route contract. |
| Protecting tests | `tests/sillybunny-conversation-api.test.js`, `tests/sillybunny-conversation-generation-utils.test.js`, `tests/conversation-mode-scoped-profile.test.js`. |
| Validation | `npm run test:unit --prefix tests -- sillybunny-conversation-api.test.js sillybunny-conversation-generation-utils.test.js conversation-mode-scoped-profile.test.js`, `node --check src/endpoints/backends/chat-completions.js`, `node --check src/endpoints/backends/text-completions.js`, focused REST smoke against `/message/send` with chat and text backends. |
| Rollback path | Revert the exported handler seams and restore Conversation REST generation to a separate adapter only if handler reuse regresses the existing `/generate` routes. |
| Last reviewed | 2026-07-26 PR #638 review follow-up. |
| Owner | Feature maintainer. |

### `src/endpoints/speech.js`, `public/scripts/extensions/tts/index.js`, and `public/scripts/extensions/tts/pollinations.js` - Conversation TTS bridge and Pollinations audio path
| Field | Value |
| --- | --- |
| Area | Speech, extension runtime, and TTS provider integration. |
| Divergence reason | SillyBunny Conversation Mode can narrate DM messages through the existing TTS extension, and Pollinations speech must use the provider's literal audio endpoint instead of the chat-completions wrapper so generated speech matches the requested text. |
| Target seam | `public/scripts/sillybunny-conversation/tts.js` for Conversation integration; existing TTS provider modules for backend specifics. |
| Adapter shape | Keep `narrateTtsMessage()` and provider-load helpers in the extension module, keep Pollinations request-shape changes minimal, and keep `src/endpoints/speech.js` as a thin relay to the provider audio endpoint. |
| Protecting tests | `tests/conversation-mode-scoped-profile.test.js`, `tests/sillybunny-conversation-notification-routing.test.js` when Conversation narration paths evolve. |
| Validation | `npm run test:unit --prefix tests -- conversation-mode-scoped-profile.test.js`, `node --check public/scripts/extensions/tts/index.js`, `node --check public/scripts/extensions/tts/pollinations.js`, `node --check src/endpoints/speech.js`, manual Pollinations TTS smoke. |
| Rollback path | Revert the Conversation TTS bridge export and Pollinations endpoint changes independently if narration or provider compatibility regresses. |
| Last reviewed | 2026-07-26 PR #638 review follow-up. |
| Owner | Extension maintainer. |

### `public/scripts/extensions/quick-image-gen/index.js` - Conversation selfie readiness guard (fork seam reference)
| Field | Value |
| --- | --- |
| Area | Extension boot and image-generation integration. |
| Divergence reason | SillyBunny Conversation selfie actions can fire before Quick Image Gen finishes booting, so the fork needs a small readiness gate rather than duplicating QIG init state in Conversation modules. |
| Target seam | `public/scripts/sillybunny-conversation/media.js`. |
| Adapter shape | Keep QIG changes limited to exporting `ensureQuickImageGenReady()`; keep Conversation modules responsible for when to await it. |
| Protecting tests | `tests/conversation-mode-scoped-profile.test.js`, `tests/sillybunny-conversation-image-safety.test.js`. |
| Validation | `npm run test:unit --prefix tests -- conversation-mode-scoped-profile.test.js sillybunny-conversation-image-safety.test.js`, `node --check public/scripts/extensions/quick-image-gen/index.js`. |
| Rollback path | Remove the readiness helper export and revert Conversation callers to direct QIG access if boot timing changes upstream. |
| Last reviewed | 2026-07-26 PR #638 review follow-up. |
| Owner | Extension maintainer. |

### `public/scripts/extensions/in-chat-agents/companion/companion-panel.js` and `public/scripts/welcome-screen.js` - Conversation UI coexistence guards
| Field | Value |
| --- | --- |
| Area | Mobile shell, welcome flow, and extension UI coexistence. |
| Divergence reason | SillyBunny Conversation Mode uses a different workspace surface than roleplay chat, so companion handles and welcome-screen recent-chat transitions must stay hidden or visually suppressed while Conversation Mode takes over the shell. |
| Target seam | `public/scripts/sillybunny-conversation/` owns the Conversation workspace state; upstream-origin files stay as DOM adapters. |
| Adapter shape | Keep the companion panel file limited to `data-sb-conversation-mode` visibility guards and a mutation observer; keep the welcome screen file limited to temporary visibility suppression around `openConversationWorkspaceForAvatar()`. |
| Protecting tests | `tests/in-chat-agents-companion-panel.test.js`, `tests/conversation-mode-scoped-profile.test.js`. |
| Validation | `npm run test:unit --prefix tests -- in-chat-agents-companion-panel.test.js conversation-mode-scoped-profile.test.js`, `node --check public/scripts/extensions/in-chat-agents/companion/companion-panel.js`, `node --check public/scripts/welcome-screen.js`, mobile/desktop browser smoke opening recent Conversation chats. |
| Rollback path | Revert the DOM visibility guards and restore prior companion/welcome behavior if shell transitions regress, without touching Conversation store data. |
| Last reviewed | 2026-07-26 PR #638 review follow-up. |
| Owner | UI maintainer. |

### `src/endpoints/users-private.js` - account export and import compatibility
| Field | Value |
| --- | --- |
| Area | Account data and backup compatibility. |
| Divergence reason | SillyBunny preserves fork-owned account metadata, user directories, and import markers while maintaining upstream archive safety. |
| Target seam | `src/users.js`, `src/entity-date-added.js`, and the private-user endpoint helpers. |
| Adapter shape | Keep archive validation, route contracts, and account-directory resolution in this upstream-origin adapter; keep fork-specific metadata helpers isolated. |
| Protecting tests | `tests/backups-hardening.test.js`, plus manual export/import smoke with a fork account archive. |
| Validation | `node --check src/endpoints/users-private.js`, `npm run lint`, archive traversal regression smoke. |
| Rollback path | Revert the fork metadata branches while retaining upstream archive validation. |
| Last reviewed | 2026-07-28 pre-release audit. |
| Owner | Account and release integrator. |

### World Info files - shell integration and safe persistence
| Field | Value |
| --- | --- |
| File | `public/scripts/world-info.js`, `public/css/world-info.css`, `src/endpoints/worldinfo.js`. |
| Area | World Info, lorebooks, and settings UI. |
| Divergence reason | SillyBunny integrates World Info with the fork shell and auxiliary lorebook sources and bounds UTF-8 filenames before atomic writes. |
| Target seam | `public/scripts/world-info-scan-core.js`, `public/scripts/world-info-batch-helpers.js`, and the World Info endpoint filename helpers. |
| Adapter shape | Keep upstream scan and persistence entry points stable; route fork shell layout, source discovery, canonical naming, and atomic-write details through narrow helpers. |
| Protecting tests | `tests/world-info-scan-core.test.js`, `tests/world-info-scan-chat.test.js`, `tests/world-info-endpoint-utils.test.js`, `tests/world-info-character-book.test.js`, `tests/world-info-batch-helpers.test.js`. |
| Validation | `node --check public/scripts/world-info.js`, `node --check src/endpoints/worldinfo.js`, focused World Info unit tests, `npm run check:frontend-budgets`. |
| Rollback path | Revert shell/source integration and filename normalization independently; retain the upstream World Info data format. |
| Last reviewed | 2026-07-28 pre-release audit. |
| Owner | World Info and shell integrator. |

### In-Chat Agents expressions and connection profiles
| Field | Value |
| --- | --- |
| File | `public/scripts/extensions/expressions/index.js`, `public/scripts/extensions/connection-manager/index.js`, `public/scripts/extensions/shared.js`, `public/scripts/custom-request.js`. |
| Area | Extension runtime, expressions, and connection-profile secrets. |
| Divergence reason | Fork-owned agent classification, generated sprites, profile-scoped requests, and secret-aware connection state extend upstream extension surfaces. |
| Target seam | `public/scripts/extensions/in-chat-agents/`, `public/scripts/extensions/expressions/`, and `public/scripts/extensions/connection-manager/`. |
| Adapter shape | Keep extension boot and provider calls in upstream modules; delegate fork agent/profile decisions through existing narrow exports. |
| Protecting tests | `tests/expressions-agent.test.js`, `tests/connection-profile-request-fields.test.js`, `tests/connection-manager-profile-save.test.js`, `tests/in-chat-agents-runner.test.js`. |
| Validation | Focused unit tests, `npm run lint`, `npm run check:frontend-budgets`. |
| Rollback path | Disable fork classifier/profile hooks while retaining upstream expression and connection behavior. |
| Last reviewed | 2026-07-28 pre-release audit. |
| Owner | In-Chat Agents maintainer. |

### Settings, personas, presets, and prompt context
| Field | Value |
| --- | --- |
| File | `public/scripts/power-user.js`, `public/scripts/personas.js`, `public/scripts/preset-manager.js`, `public/scripts/authors-note.js`. |
| Area | Settings, persona state, presets, and prompt context. |
| Divergence reason | SillyBunny adds shell settings, scoped persona behavior, preset synchronization, and character/group Author's Notes while preserving upstream persisted formats. |
| Target seam | `public/scripts/sillybunny-tabs.js`, `public/scripts/sillybunny-conversation/`, `public/scripts/preset-api-sync-lifecycle/`, and `public/scripts/authors-note.js`. |
| Adapter shape | Keep upstream settings/preset/persona APIs authoritative; isolate fork state transitions in the named seams and preserve legacy keys. |
| Protecting tests | `tests/persona-avatar-source-sync.test.js`, `tests/sillybunny-conversation-persona-runtime.test.js`, `tests/preset-api-sync-lifecycle.test.js`, `tests/preset-save-deleted-default.test.js`, `tests/openai-preset-utils.test.js`. |
| Validation | Focused unit tests, `node --check` on each file, `npm run lint`. |
| Rollback path | Revert fork settings and scoped-state adapters without changing upstream preset, persona, or character data schemas. |
| Last reviewed | 2026-07-28 pre-release audit. |
| Owner | Settings and conversation integrator. |

### Content/default management and server initialization
| Field | Value |
| --- | --- |
| File | `src/endpoints/content-manager.js`, `src/server-init.js`, `src/server-main.js`, `src/util.js`, `src/plugin-loader.js`. |
| Area | Install, defaults, server lifecycle, and runtime utilities. |
| Divergence reason | SillyBunny synchronizes ignored default files, manages fork-owned bundled content, and adds runtime/server safeguards while preserving upstream startup contracts. |
| Target seam | `src/server-init.js`, `src/server-directory.js`, `src/runtime.js`, and the bundled-content helpers in `content-manager.js`. |
| Adapter shape | Keep startup order and upstream routes stable; isolate default synchronization and fork content reconciliation behind small helpers. |
| Protecting tests | CI `bun src/server-init.js` smoke, `tests/default-preset-deletions.test.js`, `tests/sillybunny-launcher-smol.test.js`, and root lint. |
| Validation | `npm run init`, `node --check src/server-init.js`, `node --check src/server-main.js`, `npm run lint`. |
| Rollback path | Revert default/content reconciliation while retaining upstream config initialization and server startup. |
| Last reviewed | 2026-07-28 pre-release audit. |
| Owner | Runtime and release integrator. |

### Chat backups, characters, and thumbnails
| Field | Value |
| --- | --- |
| File | `public/scripts/chat-backups.js`, `public/css/chat-backups.css`, `src/endpoints/characters.js`, `src/endpoints/thumbnails.js`, `src/endpoints/image-metadata.js`. |
| Area | Chat recovery, character assets, thumbnails, and media metadata. |
| Divergence reason | SillyBunny adds backup recovery presentation and mobile-aware character/media handling without changing upstream chat or image formats. |
| Target seam | `public/scripts/sillybunny-tabs.js`, `src/endpoints/conversation-utils.js`, and the thumbnail/image-metadata helpers. |
| Adapter shape | Keep upstream archive and image routes stable; limit fork behavior to recovery UI, mobile presets, and metadata helpers. |
| Protecting tests | `tests/backups-hardening.test.js`, `tests/character-save-guard.test.js`, `tests/thumbnails-endpoint.test.js`, `tests/mobile-thumbnail-preset.test.js`, `tests/chat-avatar-thumbnail-urls.test.js`. |
| Validation | Focused unit tests, `node --check` on endpoint/client files, `npm run lint`. |
| Rollback path | Revert backup UI and mobile/media adapters without deleting user chat or character data. |
| Last reviewed | 2026-07-28 pre-release audit. |
| Owner | Chat and media integrator. |

### Repository policy, launchers, packaging, and build infrastructure
| Field | Value |
| --- | --- |
| File | Root upstream-origin files, `.github/**`, `docker/**`, `package.json`, lockfiles, launcher scripts, `webpack.config.js`, and repository policy/setup documents. |
| Area | Release policy, packaging, launch, CI, container runtime, and project identity. |
| Divergence reason | SillyBunny carries fork branch policy, branding, Bun-first and Node-compatible launch paths, constrained installs, release automation, and container defaults. |
| Target seam | `.github/workflows/`, launcher scripts, `scripts/dependency-state.js`, `src/runtime.js`, and Docker entrypoints. |
| Adapter shape | Keep upstream-compatible commands and package contracts; isolate fork runtime selection, metadata, branding, and release gates in the named infrastructure files. |
| Protecting tests | `tests/sillybunny-launcher-smol.test.js`, `tests/server-supervisor.test.js`, `tests/frontend-assets.test.js`, root lint, frontend build, README mirror check, and workflow static validation. |
| Validation | `npm ci --dry-run`, launcher unit tests, shell/JSON/YAML syntax checks, `npm run lint`, `npm run build:frontend`, and release workflow smoke. |
| Rollback path | Revert each launcher, workflow, or packaging adapter independently while retaining user data and upstream application formats. |
| Last reviewed | 2026-07-28 pre-release audit. |
| Owner | Release integrator. |

### Bundled defaults and install-time content
| Field | Value |
| --- | --- |
| File | `default/config.yaml`, `default/content/index.json`, and `default/content/settings.json`. |
| Area | Install defaults and bundled content. |
| Divergence reason | SillyBunny ships fork defaults, agents, presets, and settings while preserving install-time migration and reset behavior. |
| Target seam | `src/server-init.js`, `src/endpoints/content-manager.js`, and bundled-template update helpers. |
| Adapter shape | Preserve upstream IDs and metadata keys; change default values and bundled indexes only through existing synchronization paths. |
| Protecting tests | `tests/default-preset-deletions.test.js`, bundled-template and agent-version tests, plus Bun initialization smoke. |
| Validation | `npm run init`, full unit suite, and fresh-data-directory smoke. |
| Rollback path | Restore individual defaults through the bundled update flow without deleting existing-user settings. |
| Last reviewed | 2026-07-28 pre-release audit. |
| Owner | Defaults and release integrator. |

### Frontend identity, localization, and static boot assets
| Field | Value |
| --- | --- |
| File | `public/locales/*.json`, `public/img/**`, `public/*.ico`, `public/login.html`, `public/manifest.json`, `public/global.d.ts`, `public/lib/polyfill.js`, and `public/webfonts/**`. |
| Area | Branding, localization, login, PWA metadata, compatibility, and static assets. |
| Divergence reason | SillyBunny replaces product identity and translated copy, adds fork provider assets, and keeps browser/PWA boot metadata aligned with the fork. |
| Target seam | Static assets and locale catalogs; no runtime seam. |
| Adapter shape | Preserve upstream locale keys, manifest structure, icon dimensions, and browser compatibility contracts. |
| Protecting tests | Frontend asset tests, manifest/browser smoke, README mirror validation, and full build. |
| Validation | `npm run build:frontend`, `npm run check:frontend-budgets`, JSON parsing, and desktop/mobile login smoke. |
| Rollback path | Restore individual assets or translations without changing persisted data. |
| Last reviewed | 2026-07-28 pre-release audit. |
| Owner | UI and localization integrator. |

### Upstream CSS surfaces and compatibility styling
| Field | Value |
| --- | --- |
| File | Modified upstream-origin files under `public/css/` not named by a narrower active entry. |
| Area | Shell integration, dialogs, tags, extensions, streaming, accessibility, and responsive styling. |
| Divergence reason | SillyBunny adapts upstream surfaces to the fork shell, theme tokens, mobile viewport, and WebKit/accessibility requirements. |
| Target seam | Fork stylesheets and scoped `sb-*`/feature selectors; upstream sheets retain only necessary compatibility overrides. |
| Adapter shape | Keep overrides selector-scoped, token-aware, prefixed for supported WebKit properties, and covered by motion/budget ratchets. |
| Protecting tests | `tests/mobile-css-budgets.test.js`, `tests/ui-motion-css-compliance.test.js`, frontend budgets, and desktop/mobile smoke. |
| Validation | `npm run check:frontend-budgets`, `npm run build:frontend`, focused CSS tests, and WebKit prefix scan. |
| Rollback path | Remove scoped fork overrides per surface while retaining upstream base styles and user CSS. |
| Last reviewed | 2026-07-28 pre-release audit. |
| Owner | UI and mobile shell integrator. |

### Core browser runtime, settings, and templates
| Field | Value |
| --- | --- |
| File | Modified upstream-origin files directly under `public/scripts/`, `public/scripts/templates/`, `public/scripts/macros/`, `public/scripts/slash-commands/`, and `public/scripts/autocomplete/` not named by a narrower active entry. |
| Area | Browser runtime, settings, prompt assembly, macros, commands, chat UI, storage, and templates. |
| Divergence reason | SillyBunny integrates fork shell, Conversation Mode, provider compatibility, accessibility, persistence safeguards, and prompt behavior through existing upstream browser APIs. |
| Target seam | Fork lifecycle modules, `public/scripts/sillybunny-conversation/`, storage utilities, and feature-specific helpers. |
| Adapter shape | Preserve upstream exports and persisted schemas; keep fork behavior behind imports, narrow hooks, templates, or compatibility helpers. |
| Protecting tests | Full browser unit suite, macro E2E suite, Conversation tests, settings/preset tests, and frontend budgets. |
| Validation | `npm run lint`, full unit suite, `npm run build:frontend`, and Chromium E2E validation. |
| Rollback path | Remove feature adapters independently while preserving upstream settings, character, chat, preset, and macro formats. |
| Last reviewed | 2026-07-28 pre-release audit. |
| Owner | Browser runtime integrator. |

### Built-in extension adapters
| Field | Value |
| --- | --- |
| File | Modified upstream-origin files under `public/scripts/extensions/` not named by a narrower active entry, including caption, connection manager, expressions, memory, Stable Diffusion, translation, TTS, and vectors. |
| Area | Extension boot, provider integration, settings UI, media, memory, speech, and vector storage. |
| Divergence reason | SillyBunny connects built-in extensions to fork agents, profiles, shell behavior, providers, and Conversation Mode without changing extension manifests or persisted settings incompatibly. |
| Target seam | Feature-local extension helpers and fork-owned integration modules. |
| Adapter shape | Preserve extension IDs, settings keys, provider request contracts, and upstream activation behavior; keep fork hooks narrow. |
| Protecting tests | Extension boot, ICA, connection-profile, TTS, vectors, translation, memory, and image-generation unit coverage plus browser smoke. |
| Validation | Full unit suite, root lint, frontend build/budgets, and release E2E. |
| Rollback path | Disable or remove each integration hook independently while retaining extension settings and manifests. |
| Last reviewed | 2026-07-28 pre-release audit. |
| Owner | Extension integrator. |

### Server endpoints and persisted-data adapters
| Field | Value |
| --- | --- |
| File | Modified upstream-origin files under `src/endpoints/` not named by a narrower active entry. |
| Area | Accounts, settings, secrets, chats, groups, characters, media, providers, extensions, presets, tokenizers, and maintenance routes. |
| Divergence reason | SillyBunny adds fork providers, shell/Conversation integrations, hardening, and compatibility behavior while retaining upstream route and storage contracts. |
| Target seam | Endpoint-local helpers, `src/endpoints/conversation-*`, request filters, and provider adapters. |
| Adapter shape | Preserve request/response shapes and upstream on-disk schemas; validate at route boundaries and delegate fork logic to side-effect-free helpers. |
| Protecting tests | Full endpoint/unit suite, request-filter and backup hardening tests, character/settings/provider tests, plus Node/Bun startup smoke. |
| Validation | Full unit suite, root lint, Node syntax checks, Node/Bun server smoke, and release E2E. |
| Rollback path | Revert endpoint adapters by area without rewriting user data or removing migration paths. |
| Last reviewed | 2026-07-28 pre-release audit. |
| Owner | Server and data compatibility integrator. |

### Server core, middleware, parsers, and vector backends
| Field | Value |
| --- | --- |
| File | Modified upstream-origin files directly under `src/`, plus `src/middleware/**`, `src/git/**`, `src/png/**`, `src/validator/**`, and `src/vectors/**`, not named by a narrower active entry. |
| Area | Server lifecycle, configuration, auth, plugins, parsing, archives, Git, images, prompt conversion, and vector providers. |
| Divergence reason | SillyBunny adds runtime parity, fork configuration, security checks, card compatibility, plugin behavior, and provider support around upstream server contracts. |
| Target seam | `src/runtime.js`, server lifecycle helpers, path containment, middleware helpers, and provider-specific modules. |
| Adapter shape | Keep startup ordering and public APIs stable; use guarded runtime detection and shared validation/security helpers. |
| Protecting tests | Server supervisor/runtime, path containment, card/parser, prompt converter, request filter, plugin, image, and vector tests. |
| Validation | Full unit suite, root lint, Node syntax checks, Node/Bun initialization and startup smoke. |
| Rollback path | Revert helpers per subsystem while preserving configuration, plugin, character-card, and vector data compatibility. |
| Last reviewed | 2026-07-28 pre-release audit. |
| Owner | Server runtime integrator. |

### Upstream test harness and dependency metadata
| Field | Value |
| --- | --- |
| File | Modified upstream-origin files under `tests/`, including frontend macro E2E fixtures, Jest/Playwright configuration, package metadata, request-filter utilities, and inherited smoke tests. |
| Area | Test infrastructure and release validation. |
| Divergence reason | SillyBunny extends inherited coverage for fork routes, direct-app/account-login startup, Node/Bun parity, frontend behavior, and release browser validation. |
| Target seam | `tests/` helpers and configuration only. |
| Adapter shape | Preserve upstream test semantics where applicable; parameterize base URLs and startup modes rather than hardcoding local state. |
| Protecting tests | The full Jest and Playwright suites themselves. |
| Validation | `npm run test:unit`, focused changed-test lint, and serial Chromium E2E. |
| Rollback path | Revert fork fixtures/config independently from production code, retaining tests that protect shipped compatibility. |
| Last reviewed | 2026-07-28 pre-release audit. |
| Owner | Test and release integrator. |

## Review Checklist
- Does the upstream-origin file contain only adapter wiring and concise comments?
- Does the target seam have a small interface and concentrated implementation?
- Does at least one test protect the divergence?
- Does the rollback path avoid user data changes?
- Does the PR keep upstream sync work separate from fork feature work?
- Did validation name the lifecycle affected: fresh install, restart after update, stale assets, mobile viewport, long chat, streaming, swipe, or settings save?
