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

### `public/script.js` and `public/style.css` - chat render lifecycle
| Field | Value |
| --- | --- |
| Area | Chat lifecycle. |
| Divergence reason | SillyBunny adds mobile batching, bottom pinning, manual-scroll suppression, long-chat anchoring, streaming DOM throttles, issue `#167` scroll stability behavior, and issue `#911` off-screen message skipping (`content-visibility` on laid-out history in `public/style.css`, plus swipe refreshes that only touch buttons whose display changes). |
| Target seam | `public/scripts/chat-render-lifecycle/`. |
| Adapter shape | Keep exported compatibility functions in `public/script.js`; delegate initial-load bottom landing, bottom-scroll decisions, scheduling, scroll intent/state, anchor preservation, replacement/media anchoring, off-screen message tracking, and update batching to the lifecycle module. |
| Protecting tests | `tests/chat-scroll-edges.test.js`, `tests/mobile-streaming.test.js`, `tests/chat-render-lifecycle-index.test.js`, `tests/chat-render-lifecycle-bottom-scroll.test.js`, `tests/chat-render-lifecycle-rollout-guard.test.js`, `tests/chat-render-lifecycle-anchor.test.js`, `tests/chat-render-lifecycle-scheduler.test.js`, `tests/chat-render-lifecycle-scroll-intent.test.js`, `tests/chat-render-lifecycle-scroll-state.test.js`, `tests/chat-render-lifecycle-offscreen-messages.test.js`, `tests/chat-render-lifecycle-script-wiring.test.js`, `tests/chat-scroll-state-machine.e2e.js`, `tests/chat-send-scroll.e2e.js`, `tests/chat-scroll-regressions.e2e.js`, future lifecycle unit tests. |
| Validation | `node --check public/script.js`, focused lifecycle Jest `chat-render-lifecycle-scroll-state.test.js chat-render-lifecycle-script-wiring.test.js`, `npm run check:frontend-budgets`, plus prior lifecycle lint/unit/e2e packs on this stack. |
| Rollback path | Disable affected lifecycle routes with the permanent device-local kill switch while correcting the routed implementation. |
| Last reviewed | 2026-10-22 issue `#911` off-screen message skipping route. |
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

### `public/script.js`, `public/scripts/group-chats.js`, `public/scripts/reasoning.js`, and `src/endpoints/chats.js` - server-owned chat generations
| Field | Value |
| --- | --- |
| File | `public/script.js`, `public/scripts/group-chats.js`, `public/scripts/reasoning.js`, `src/endpoints/chats.js` |
| Area | Generation lifecycle and chat persistence. |
| Divergence reason | SillyBunny lets the server finish a chat reply when the page that asked for it goes away, because phones freeze and close background tabs during a generation. `Generate()` must send a commit plan with each committable request, mark its streaming message so the server replaces only an unfinished reply, and skip its own save when the server kept its copy. Upstream stops the stream on `beforeunload`, which a leave-site prompt can cancel, so the hand-off and the stop run on `pagehide`. A group reply written this way must carry the rest of its round so the round can go on, and the server must save chats with the same locking, integrity and backup handling as a browser save. |
| Target seam | `public/scripts/server-generations.js`, `public/scripts/resumable-generation.js`, `public/scripts/generation-commit-plan.js`, `src/generation-commit.js`. |
| Adapter shape | `Generate()` registers a commit plan before each committable request (`registerGenerationCommitPlan()`), then awaits `settleGenerationCommit()` before it saves the finished reply; on `committed` it unblocks and calls `reloadServerCommittedReply()` instead of saving. `StreamingProcessor.onStartStreaming()` sets `extra[GENERATION_PLACEHOLDER_KEY]` on the streaming message, and `finalizeIntermediaryMessage()` and `finalizeStoppedMessage()` delete it. The window `pagehide` handler stops the stream unless the page goes into the back/forward cache; the `beforeunload` handler no longer stops it. `generateGroupWrapper()` records the members still to speak in `groupRoundRemaining`, read by `getGroupRoundRemaining()`, and `resumeGroupRound()` runs them. `parseAutoReasoningFromString()` exposes the live reasoning parse. `updateChatRecords()` saves through `trySaveChat()`, whose `integrity` option restores a chat's earlier slug when a commit is taken back. |
| Protecting tests | `tests/story-mode-request-controls.test.js`, `tests/resumable-generation-frontend.test.js`, `tests/server-generations-frontend.test.js`, `tests/server-generation-commit.test.js`, `tests/server-generation-commit.e2e.js`, `tests/pathfinder-streaming-origin.test.js`, `tests/chat-render-lifecycle-script-wiring.test.js`. |
| Validation | `npm run test:unit --prefix tests -- story-mode-request-controls.test.js resumable-generation-frontend.test.js server-generations-frontend.test.js server-generation-commit.test.js pathfinder-streaming-origin.test.js pathfinder-generation-wiring.test.js`, `npm run test:e2e --prefix tests -- server-generation-commit.e2e.js` against Bun 1.3.14 and Node servers, `npm run lint`, `npm run check:frontend-budgets`. |
| Rollback path | Remove the `registerGenerationCommitPlan()` and `settleGenerationCommit()` calls, the `GENERATION_PLACEHOLDER_KEY` lines in `onStartStreaming()`, `finalizeIntermediaryMessage()` and `finalizeStoppedMessage()`, and the `pagehide` handler, then put `streamingProcessor.onStopStreaming()` back in the `beforeunload` handler. Requests then carry no commit plan, so the server never writes replies, and `fetchResumable()` still resumes dropped streams. `getGroupRoundRemaining()`, `resumeGroupRound()`, `parseAutoReasoningFromString()` and `updateChatRecords()` are used only by `public/scripts/server-generations.js` and `src/generation-commit.js`, so they go with those modules. |
| Last reviewed | 2026-10-23 PR #877 review fixes. |
| Owner | Generation lifecycle owner. |

### `public/script.js` - stopped streaming replies
| Field | Value |
| --- | --- |
| File | `public/script.js` |
| Area | Generation lifecycle and chat persistence. |
| Divergence reason | SillyBunny must finish and save a reply that Stop interrupts. Stop clears `streamingProcessor` before `Generate()` reaches `onFinishStreaming()`, the only path that ends the reasoning, records its duration, removes the server-generation placeholder mark and saves the chat, so a reply stopped during reasoning would stay on Thinking with no duration and a reply stopped during its text would be lost on reload. |
| Target seam | `none yet`: the steps use private `StreamingProcessor` state, so they stay in `public/script.js`; `public/scripts/generation-lifecycle/` keeps the stop decision. |
| Adapter shape | `stopGeneration()` calls `StreamingProcessor.finalizeStoppedMessage()` after `onStopStreaming()` and does not await it. The method removes `extra[GENERATION_PLACEHOLDER_KEY]`, applies the stream's pending reasoning and calls `reasoningHandler.finish()`, which persists `extra.reasoning`, `extra.reasoning_duration` and `extra.reasoning_type` and emits `STREAM_REASONING_DONE`. Then it calls `syncMesToSwipe()`, `updateMessageBlock()` and `saveChatConditional()`. It does not emit `MESSAGE_RECEIVED`. `#isOriginMessage()`, split out of `#isCurrent()`, stops it when the chat or the message changes, because Stop has already cleared `streamingProcessor` and the run. The `pagehide` handler calls only `onStopStreaming()`, so a page that goes away still hands its reply to the server. |
| Protecting tests | `tests/story-mode-request-controls.test.js` (Stop during streamed reasoning, a chat change after Stop, explicit cancellation), `tests/server-generation-commit.e2e.js` (Stop during streamed reasoning on desktop and mobile), `tests/generation-lifecycle-wiring.test.js`, `tests/pathfinder-streaming-origin.test.js`, `tests/resumable-generation-frontend.test.js`. |
| Validation | `npm run lint`, `npm run lint --prefix tests`, `npm run test:unit --prefix tests -- story-mode-request-controls.test.js pathfinder-streaming-origin.test.js pathfinder-generation-wiring.test.js generation-lifecycle resumable-generation-frontend.test.js`, full `npm run test:unit --prefix tests`, `npm run check:frontend-budgets`, `npm run test:e2e --prefix tests -- server-generation-commit.e2e.js` against a Bun 1.4.4 server at 1440x900 and at 390x844 with an iPhone user agent. |
| Rollback path | Remove the `finalizeStoppedMessage()` call from `stopGeneration()` and the method. Stop then leaves the stopped reply unsaved and its reasoning in the thinking state, with a null `extra.reasoning_duration`. `#isOriginMessage()` can stay, because `#isCurrent()` returns the same result through it. Saved chats need no change, because the method writes only existing message fields. |
| Last reviewed | 2026-10-29 Stop during streamed reasoning fix. |
| Owner | Generation lifecycle owner. |

### `public/script.js`, `src/endpoints/backends/chat-completions.js`, and `src/prompt-converters.js` - Gemini replies that end early
| Field | Value |
| --- | --- |
| File | `public/script.js`, `src/endpoints/backends/chat-completions.js`, `src/prompt-converters.js`. |
| Area | Generation lifecycle (Gemini finish reporting, fetch idle timeout and thinking levels). |
| Divergence reason | SillyBunny must tell the user when a Gemini reply stops at a token limit, because thinking counts against the output limit and each request has its own cap, so a stopped reply looks finished or is saved blank. It must also keep long thinking from hitting Bun's fetch idle timeout, and send `high` for the `xhigh` and `max` levels on Gemini 4, which documents no level above it. |
| Target seam | `public/scripts/generation-request-controls.js` owns the finish checks. The server changes are `none yet`: they sit on the Gemini request handlers and in `calculateGoogleBudgetTokens()`, and no SillyBunny module wraps those. |
| Adapter shape | `public/script.js`: `StreamingProcessor.providerLengthFinish`, set first in `#applyProseLimit()`, and one `warnsOnGenerationLengthFinish()` branch ahead of each reasoning-only toast in `Generate()`. `chat-completions.js`: `timeout: 0` on the generateContent and Interactions fetches; `finish_reason: 'length'` and a separate empty-reply error for `MAX_TOKENS` and `CONTINUATION` in `sendMakerSuiteRequest()`; `INTERACTION_CUT_OFF_STATUSES` in `transformInteractionToChatCompletion()`; a final length chunk from `finishStream()` in `forwardInteractionStream()`. `prompt-converters.js`: `xhigh` and `max` send `high` on Gemini 4 in `getGemini3ThinkingLevel()`. |
| Protecting tests | `tests/story-mode-request-controls.test.js`, `tests/google-model-request.test.js`, `tests/gemini-interactions.test.js`, `tests/prompt-converters.test.js`. |
| Validation | `npm run lint`, `npm run lint --prefix tests`, `npm run test:unit --prefix tests -- story-mode-request-controls.test.js google-model-request.test.js gemini-interactions.test.js prompt-converters.test.js pathfinder-generation-wiring.test.js`, full `npm run test:unit --prefix tests`, `npm run check:frontend-budgets`, `npm run test:e2e --prefix tests -- server-generation-commit.e2e.js`, Bun and Node.js boots, and a browser replay of each finish against a local stub of the Gemini API at desktop and mobile widths. |
| Rollback path | Remove the two `warnsOnGenerationLengthFinish()` branches, `providerLengthFinish`, the cut-off handling in `chat-completions.js`, the two `timeout: 0` options and the Gemini 4 branch in `getGemini3ThinkingLevel()`. The changes do not write persistent data, so no cleanup is needed. |
| Last reviewed | 2026-11-04 Gemini long decode reporting fix. |
| Owner | Generation lifecycle owner. |

### `src/endpoints/backends/chat-completions.js` - Gemini long decode
| Field | Value |
| --- | --- |
| File | `src/endpoints/backends/chat-completions.js`. |
| Area | Generation lifecycle (Gemini replies across several requests). |
| Divergence reason | SillyBunny must continue a Gemini reply across several requests until it finishes, because Gemini 4 can write one reply over several requests and a single request stops at its per-request cap. The client sees one reply, streamed or not. |
| Target seam | `src/gemini-long-decode.js` owns the continuation loop, the stream stitching and the request rules. |
| Adapter shape | `sendMakerSuiteRequest()`: `sendRequest()` around the fetch, `capFirstGenerateContentBody()` for the first request, `continueGenerateContentStream()` around the response that `forwardFetchResponse()` receives, `collectGenerateContentHops()`, `mergeGenerateContentHops()` and `getGenerateContentText()` on the non-streaming path, and `getVertexApiVersion()` in the Vertex URLs. `sendGeminiInteractionsRequest()`: `continueInteractionStream()` around the response that `forwardInteractionStream()` receives, and `collectInteractionHops()` with `mergeInteractionHops()` on the non-streaming path. In both handlers, `sendHop()` calls `extendLifetime()` on the resumable generation before each later request. |
| Protecting tests | `tests/gemini-long-decode.test.js`, `tests/google-model-request.test.js`, `tests/gemini-interactions.test.js`, `tests/resumable-generations.test.js`. |
| Validation | `npm run lint`, `npm run lint --prefix tests`, `npm run test:unit --prefix tests -- gemini-long-decode.test.js google-model-request.test.js gemini-interactions.test.js resumable-generations.test.js`, full `npm run test:unit --prefix tests`, `npm run check:frontend-budgets`, `npm run test:e2e --prefix tests -- server-generation-commit.e2e.js`, Bun and Node.js boots, a browser replay of multi-request replies against a local stub of the Gemini API at desktop and mobile widths, and live replies of up to 70,000 tokens through a local relay to Vertex AI. |
| Rollback path | Put the direct `fetch()` calls, `generateResponse.json()` results and the text expression back in the two handlers, put `v1` back in the Vertex URLs, delete `src/gemini-long-decode.js` and remove `extendLifetime()` from `src/resumable-generations.js`. The changes do not write persistent data, so no cleanup is needed. |
| Last reviewed | 2026-11-05 Gemini long decode. |
| Owner | Generation lifecycle owner. |

### `src/endpoints/chats.js`, `public/script.js`, `public/scripts/group-chats.js`, and `public/scripts/extensions.js` - chat save integrity
| Field | Value |
| --- | --- |
| Area | Chat persistence and data-loss prevention. |
| Divergence reason | SillyBunny must reject stale cross-device chat saves instead of allowing last-write-wins overwrites that destroy newer messages. |
| Target seam | None yet; keep the save-contract adapter minimal until chat persistence has a dedicated fork seam. |
| Adapter shape | Rotate chat metadata integrity in `trySaveChat()`, return the new token from normal and group save routes, store the returned token in the active client metadata after successful saves, and bind debounced metadata saves to the active chat generation. |
| Protecting tests | `tests/chat-integrity-rotation.test.js`; manual two-instance stale-save smoke before release. |
| Validation | `npm run test:unit --prefix tests -- chat-integrity-rotation.test.js chat-save-guard.test.js`, `node --check src/endpoints/chats.js`, `node --check public/script.js`, `node --check public/scripts/group-chats.js`, `node --check public/scripts/extensions.js`, `npm run lint`, Node/Bun server smoke. |
| Rollback path | Revert the integrity rotation response contract and client adoption to the prior per-load integrity behavior. |
| Last reviewed | 2026-08-11 PR #754 remote-save integrity fix. |
| Owner | Bugfix integrator. |

### `src/endpoints/files.js`, `src/endpoints/chats.js`, `src/endpoints/groups.js`, `src/endpoints/vectors.js`, and `src/endpoints/assets.js` - user folder paths and route errors
| Field | Value |
| --- | --- |
| File | `src/endpoints/files.js`, `src/endpoints/chats.js`, `src/endpoints/groups.js`, `src/endpoints/vectors.js`, `src/endpoints/assets.js`. |
| Area | Data Bank file delete and verify, group chat lists, chat export, chat info, group delete, vector indexes and purge, asset delete and download, and character asset lists. |
| Divergence reason | SillyBunny must keep user-supplied file, group chat, vector and asset paths inside their folders and answer bad input from the route itself. Paths there were checked with a string prefix, which also accepts sibling folders that start with the same name, or not at all, and a throw in a stream or readline event crashes the server. |
| Target seam | none yet. |
| Adapter shape | `files.js`: `/delete` and `/verify` check the joined path with `isPathUnderParent()` instead of `startsWith()`. `chats.js`: the new `getGroupChatPath()` returns the chat file path for a string or number ID whose path stays inside the group chats folder, and null otherwise; `/search` and `/recent` skip an ID that it refuses. `/export` runs its whole body inside one `try` block, answers 400 for a `file` that is not a string or that sanitizes to an empty name, and awaits a promise that its read stream and readline settle, with `error` listeners on both; its `line` listener skips a line that throws and logs one warning with the count. `getChatInfo()` reads `mes` only when it is a string. `groups.js`: `hasValidChatIds()` makes `/create` and `/edit` answer 400 for a chat list with an ID that `getGroupChatPath()` refuses, and `/delete` answers 400 for an `id` that is not a string or a number. `vectors.js`: `getIndex()` throws `InvalidVectorFolderError` for a source or collection ID that sanitizes to an empty name, `regenerateCorruptedIndexErrorHandler()` answers 400 for that error and catches errors from its own regeneration, and `/purge` answers 400 for a collection ID that sanitizes to an empty name. `assets.js`: `validateAssetFileName()` refuses a value that is not a string; `/download`, `/delete` and `/character` compare the category with `===`; `/character` answers 400 for a `name` that is not a string; `/download` writes through `pipeline()` instead of `pipe()` and `finished()`, and its catch block answers only when `response.headersSent` is false. |
| Protecting tests | `tests/route-guards-scenarios.test.js` and `tests/route-guards-rows.test.js`; the rows use the hostile file name harness in `tests/util/hostile-file-names-*.js`. `tests/base64-atomic-writes.test.js` mocks `util.js` with `isPathUnderParent`, which `files.js` imports. |
| Validation | `npm run test:unit --prefix tests -- route-guards-scenarios.test.js route-guards-rows.test.js` (each test fails with the base commit's version of the files it covers: all 31 with the first four files, and the 12 asset tests with `assets.js`), the suites that load these routers, `npm run lint`, `npm run lint --prefix tests`, one request for each guard on Bun 1.4.4 and Node 24.22.1 scratch servers, and the new suites on Linux with Node 24. |
| Rollback path | Revert the hunks in the five files, delete `tests/route-guards-scenarios.test.js` and `tests/route-guards-rows.test.js`, and remove `isPathUnderParent` from the `util.js` mock in `tests/base64-atomic-writes.test.js`. No stored data or settings change. |
| Last reviewed | 2026-11-05 user folder paths and route errors, with the asset routes. |
| Owner | Server and data compatibility integrator. |

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
| Target seam | `public/scripts/extensions/in-chat-agents/companion/companion-shared.js` owns selection and consolidation; `public/scripts/in-chat-agent-inspection.js` owns contribution trimming; `public/scripts/generation-hidden-messages.js` owns the `GENERATION_HIDE_MESSAGES` request that lets an extension keep a speaker's hidden lines out of the merge. Core projection orchestration has no narrower seam yet. |
| Adapter shape | `Generate()` awaits the hide request right after the swipe pop (skipped on dry runs), selects retained contributions from the visible lines and carries ephemeral provenance; provider assembly transports that provenance and trims oldest retained contributions first; group generation only resets the explicit rewrite target for automatic continuation. |
| Protecting tests | `tests/in-chat-agents-runner.test.js`, `tests/in-chat-agents-store.test.js`, `tests/in-chat-agents-generation-ui-wiring.test.js`, `tests/guided-generations-correction-wiring.test.js`, `tests/generation-hidden-messages.test.js`, the `Generate()` harnesses in `tests/pathfinder-generation-wiring.test.js` and `tests/story-mode-request-controls.test.js` (they stub the hide request), and retained-contribution cases in `tests/in-chat-agent-inspection.test.js`. |
| Validation | `npm run test:unit --prefix tests -- in-chat-agents-runner.test.js in-chat-agents-generation-ui-wiring.test.js in-chat-agent-inspection.test.js generation-hidden-messages.test.js pathfinder-generation-wiring.test.js story-mode-request-controls.test.js`, `npm run lint`, `npm run check:frontend-budgets`, and `git diff --check`. |
| Rollback path | Remove retained-context projection, provenance transport, trim loops, rewrite-target plumbing, and the hide request (`companionCandidateMessages` goes back to filtering `coreChat`). Stored Companion settings and results remain compatible and can be ignored without migration. |
| Last reviewed | 2026-10-10 PR #900 hide request for extension-hidden lines. |
| Owner | In-Chat Agents maintainer and generation/provider owner. |

### `public/scripts/group-chats.js`, `public/script.js`, `public/scripts/st-context.js`, and `public/scripts/events.js` - group speaker control and extension turn routing
| Field | Value |
| --- | --- |
| Area | Group chat lifecycle, generation lifecycle, and extension APIs. |
| Divergence reason | Extensions such as Group Chat Overhaul must read and set the speaker bar pick, plan who answers ordinary group messages, and keep per-chat data in step when a member is renamed. Upstream has none of these hooks; the pick is also kept through quiet generations, swipes, Continue and Impersonate, and swipes and Continue stay with the last message's author. |
| Target seam | `public/scripts/group-turn-routing.js` owns the routing lease, the turn lifecycle, plan validation, the save/load/tool-calling checks before replies, and reply status. Speaker pick and rename hooks have no narrower seam yet. |
| Adapter shape | `generateGroupWrapper()` starts a routed turn for eligible sends, computes native activation, shows and saves the user message, then calls `turn.prepare()` and replaces the native speakers with the plan; each reply calls `startReply`/`finishReply` and runs with `suppressAutoContinue` and `suppressAutoSwipe`. `Generate()` and `StreamingProcessor` only honour `suppressAutoSwipe` at the three auto-swipe checks. `renameGroupMember()` emits `CHARACTER_RENAMED_IN_PAST_CHAT` for every group chat and saves it when the host or a listener (`rename.markChanged()`) changed it. `getContext()` exposes `getSelectedGroupSpeakerAvatar`, `setSelectedGroupSpeakerAvatar`, and `groupTurnRouting`. |
| Protecting tests | `tests/group-turn-routing.test.js`, `tests/group-speaker-selection-api.test.js`, `tests/group-member-rename.test.js` (all on `tests/util/group-chats-sandbox.js`), and the `suppressAutoSwipe` cases in `tests/story-mode-request-controls.test.js`. |
| Validation | `npm run test:unit --prefix tests -- group-turn-routing.test.js group-speaker-selection-api.test.js group-member-rename.test.js story-mode-request-controls.test.js`, `node --check public/scripts/group-chats.js`, `npm run lint`, `npm run check:frontend-budgets`, and `git diff --check`. |
| Rollback path | Drop the routing branch and `prepare()` call from `generateGroupWrapper()`, the `suppressAutoSwipe` checks, the rename broadcast (emit only when the host rewrote a message), and the three `getContext()` members. The speaker pick returns to being cleared by every generation. No stored data changes. |
| Last reviewed | 2026-10-10 PR #900. |
| Owner | Group chat maintainer and generation lifecycle owner. |

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
| Target seam | `public/scripts/openai-model-capabilities.js` for the client sampler constraints. The server flags have no seam yet; they follow upstream's per-model regex pattern, so a future upstream sync can drop them. |
| Adapter shape | `isFableModel` flag OR'd into the existing gating regexes and `noSamplingModel` in `sendClaudeRequest`, next to upstream's `useNativeJsonOutput` flag for `claude-fable-5-1` and `claude-opus-5-5`; one `applyClaudeModelParameterConstraints` call in `createGenerationParameters`; dropdown options for `claude-fable-5` and `claude-fable-5-1`, one regex alternation, one vision-list entry; error passthrough kept as a separate commit. |
| Protecting tests | `tests/claude-sonnet5.test.js`, `tests/openai-static-models.test.js`, `tests/server-parity.test.js`. The PR #403 relay isolation record (minimal 200, +samplers 400, adaptive+effort 200, thinking-disabled 400, system-message 400 on non-converting relay) remains the live-request evidence. |
| Validation | `npm run lint` in the root and in `tests/`, focused Jest for the protecting test files, full `npm run test:unit`, and `node --check` on the changed JavaScript files. Earlier live evidence: direct relay curls against `https://api.linkapi.ai/v1/messages` and `/chat/completions` (2026-06-10), and a regression check that opus-4-6/sonnet-4-6/sonnet-4-5 payloads are unchanged. |
| Rollback path | Revert the fable regex alternations and remove the `applyClaudeModelParameterConstraints` call to restore stock behavior (fable then 400s again on samplers); the error passthrough commit can be reverted independently. |
| Last reviewed | 2026-11-04 SillyTavern staging sync (`ad29cbda6`). |
| Owner | Bugfix integrator. |

### `public/index.html`, `public/scripts/extensions/caption/settings.html`, `public/scripts/openai.js`, `src/endpoints/backends/chat-completions.js`, and `src/prompt-converters.js` - Google model catalog
| Field | Value |
| --- | --- |
| File | `public/index.html`, `public/scripts/extensions/caption/settings.html`, `public/scripts/openai.js`, `src/endpoints/backends/chat-completions.js`, `src/prompt-converters.js`. |
| Area | Settings and generation lifecycle (Google AI Studio and Vertex AI model pickers and Gemini request builders). |
| Divergence reason | SillyBunny must offer the newest Google models in the AI Studio, Vertex AI and caption pickers with the request parameters they accept, ahead of upstream's catalog. Models with an announced retirement date are labelled deprecated, and saved AI Studio selections of IDs that AI Studio now routes elsewhere move to the model that answers. |
| Target seam | None yet; the changes follow upstream's per-model option lists and regex patterns, so a future upstream sync can drop them once upstream covers these models. |
| Adapter shape | Static `<option>` entries and `(deprecated)` labels in both pickers and the caption list; two AI Studio entries in `migrateChatCompletionSettings`; context, vision, video and audio list entries in `openai.js`; regex alternations and list entries in `getGeminiBody`, `convertGooglePrompt` and `calculateGoogleBudgetTokens`. |
| Protecting tests | `tests/openai-static-models.test.js`, `tests/google-model-request.test.js`, `tests/prompt-converters.test.js`, `tests/story-mode-request-controls.test.js`. |
| Validation | `npm run lint` in the root and in `tests/`, focused Jest for the four protecting test files, full `npm run test:unit`, `npm run check:frontend-budgets`, and `node --check` on the changed JavaScript files. |
| Rollback path | Revert the option entries, the two AI Studio migration entries and the regex alternations. No data cleanup is needed, because a saved `gemini-3.8-flash` or `gemini-3.6-flash` selection stays valid on AI Studio. |
| Last reviewed | 2026-11-04 SillyTavern staging sync (`ad29cbda6`). |
| Owner | Bugfix integrator. |

### `public/scripts/tool-calling.js` and `public/scripts/openai.js` - GPT-6 Sol and Luna reasoning off
| Field | Value |
| --- | --- |
| File | `public/scripts/tool-calling.js`, `public/scripts/openai.js`. |
| Area | Generation lifecycle (OpenAI tool gate and reasoning effort). |
| Divergence reason | SillyBunny must open the Chat Completions tool gate for GPT-6 Sol and Luna when Reasoning Effort is None, and send `none` to them when the user picks None. Upstream's gate checks for Min, but SillyBunny sends Min as `minimal` and turns reasoning off with None, so the upstream gate would allow tools on a request that still reasons and block them on one that does not. |
| Target seam | None yet; both changes are single conditions inside upstream functions, so there is no module to move them to. |
| Adapter shape | `isToolCallingSupported` compares `settings.reasoning_effort` with `'none'` where upstream compares it with `'min'`, marked with `// SillyBunny:`. The None case of `getReasoningEffort` adds `gpt-6-(?:sol\|luna)` to its GPT-5.1 regex. |
| Protecting tests | `tests/reasoning-effort-none.test.js`, `tests/upstream-provider-parity.test.js`. |
| Validation | `npm run lint` in the root and in `tests/`, focused Jest for the protecting test files, full `npm run test:unit`, `npm run check:frontend-budgets`, and `node --check` on the changed JavaScript files. |
| Rollback path | Restore `'min'` in the tool gate and remove the Sol and Luna alternation. Min then opens Chat Completions tools while SillyBunny sends it as `'minimal'`, and None stays unsent on both models. No data cleanup is needed. |
| Last reviewed | 2026-11-04 SillyTavern staging sync (`ad29cbda6`). |
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

### `src/server-main.js` - route errors and crash exit
| Field | Value |
| --- | --- |
| File | `src/server-main.js`. |
| Area | Server lifecycle and request error handling. |
| Divergence reason | SillyBunny must answer a rejected async route with a 500, relaunch the server after a crash, and send the CSRF refusal with its message. Express 4 ignores a rejected promise, so the request gets no answer; the crash handlers exit with code 0, which the supervisor treats as a stop; and a bare `Forbidden` keeps the client from refreshing its CSRF token. |
| Target seam | `src/route-errors.js` for route errors; `src/server-supervisor.js` owns `SERVER_CRASH_EXIT_CODE` and the crash relaunch. |
| Adapter shape | `forwardAsyncRouteErrors()` runs once before `express()`. The startup chain registers `handleRouteError` with `app.use()` right after `apply404Middleware`, before the server listens. The CSRF block passes `csrfSyncProtection.invalidCsrfTokenError` to `answerWithErrorMessage()` after it sets that error's message, so the refusal answers 403 with the message as plain text. The `uncaughtException` and `unhandledRejection` handlers call `exitAfterCrash()`, which starts a `SUPERVISOR_FORCE_KILL_TIMEOUT_MS` timer that exits with `SERVER_CRASH_EXIT_CODE` and runs `exitProcess(SERVER_CRASH_EXIT_CODE)`. |
| Protecting tests | `tests/route-errors.test.js`, `tests/server-supervisor-crash-restart.test.js`, `tests/csrf-refusal-retry.test.js`. `tests/shutdown.test.js` and `tests/server-restart-monitor.test.js` read `src/server-main.js` and pass unchanged. |
| Validation | `npm run test:unit --prefix tests -- route-errors.test.js server-supervisor-crash-restart.test.js csrf-refusal-retry.test.js`, `node --check src/server-main.js`, `npm run lint`, and scratch servers under Bun 1.4.4 and Node.js 24.22.1 in production mode: a rejected async route answers 500 while the server keeps answering, an uncaught exception relaunches the server, the sixth crash within 10 minutes ends the supervisor with exit code 1, and with `FORCE_COLOR=1` a request with a stale CSRF token gets 403 `text/plain` with `Invalid CSRF token. Please refresh the page and try again.` and no escape characters, after which the Chat Backups list in headless Chromium refreshes the token once and loads. |
| Rollback path | Remove the `forwardAsyncRouteErrors()` call, the `handleRouteError` registration, the `answerWithErrorMessage()` call, `exitAfterCrash()` (the handlers call `exitProcess()` again) and the `src/route-errors.js` import, then delete `src/route-errors.js`, `tests/route-errors.test.js` and `tests/csrf-refusal-retry.test.js`. No stored data or settings change. After the rollback a rejected async route leaves its request unanswered and ends the server with exit code 0, which the supervisor does not relaunch, and the CSRF refusal says only `Forbidden` in production, so the client does not refresh its token. To drop only the CSRF answer, remove the `answerWithErrorMessage()` call. |
| Last reviewed | 2026-11-05 async route errors answered, crashes relaunched, and the CSRF refusal answered with its text. |
| Owner | Server runtime integrator. |

### `src/server-startup.js` - listen retry and port-conflict diagnostics
| Field | Value |
| --- | --- |
| File | `src/server-startup.js`. |
| Area | Server lifecycle. |
| Divergence reason | SillyBunny must wait for a busy listen port instead of exiting on the first `EADDRINUSE`, because a relaunch can start before the previous process has released its socket. If the port stays busy, it must print which application holds it and how to fix that. |
| Target seam | `src/server-listen.js`. |
| Adapter shape | `#startHTTPorHTTPS()` runs the IPv6 and IPv4 binds at the same time through `retryOnAddressInUse()` and calls `reportPortHolders()` on the first retry. Both create functions close a server that failed to bind and call `trackListeningServer()` once it listens. `#handleServerListenFail()` calls `reportPortHolders()` again and prints the `diagnosePortConflict()` result through `formatPortConflictBanner()` before it exits. `#getAddressInUseMessage()` uses `APP_NAME` and adds the Bun socket-inheritance hint only when `hasBunSocketInheritBug()` is true. |
| Protecting tests | `tests/server-listen.test.js`. |
| Validation | `npm run test:unit --prefix tests -- server-listen.test.js`, `node --check src/server-startup.js`, `npm run lint`. |
| Rollback path | In `src/server-startup.js`, bind once again: remove `retryOnAddressInUse()` and the `reportPortHolders()` calls from `#startHTTPorHTTPS()`, the close of a server that failed to bind and the `trackListeningServer()` calls in both create functions, and the `diagnosePortConflict()` banner and the Bun socket-inheritance hint from the failure messages. Remove the `closeListeningServers()` call in `src/server-main.js` before deleting `src/server-listen.js` and `tests/server-listen.test.js`. A relaunch that races the old process then dies on the first `EADDRINUSE`. No saved data changes. |
| Last reviewed | 2026-10-23 Bun socket-inheritance hint limited to Bun before 1.4.0. |
| Owner | Server runtime integrator. |

### `src/express-common.js`, `src/middleware/whitelist.js`, `src/middleware/basicAuth.js` and `src/middleware/hostWhitelist.js` - client addresses and configured credentials
| Field | Value |
| --- | --- |
| File | `src/express-common.js`, `src/middleware/whitelist.js`, `src/middleware/basicAuth.js`, `src/middleware/hostWhitelist.js`, and the comments for `rateLimiting.preferRealIpHeader`, `forwardedHeaders` and `forwardedHeaders.xForwardedFor` in `default/config.yaml`. |
| Area | Access control: IP whitelist, rate-limit keys, basic auth and host whitelist. |
| Divergence reason | SillyBunny must trust a forwarded client address only when a listed proxy set it, because a reverse proxy adds the address it saw at the right end of `X-Forwarded-For` and can pass other forwarded headers through from the client unchanged, so the whitelist and rate limits could otherwise decide on a spoofed value. Basic auth must also refuse an empty or non-string configured username or password. |
| Target seam | none yet. |
| Adapter shape | `express-common.js`: `getForwardedIps(req, trustedProxies)` replaces `getRealOrForwardedIp()`. It returns the address in each enabled forwarded header and reads `X-Forwarded-For` from the right past trusted hops. `isIpInPatterns()` matches through a strict parser (`normalizeIpAddress()`), so a value that is not an IP address matches nothing and an IPv4-mapped value matches its IPv4 entry. `getTrustedProxies()` returns the valid `whitelist` entries. `getIpAddress()` adds a forwarded address only when the socket address is a trusted hop and every enabled header names the same valid address. `whitelist.js`: blocks unless every address from `getForwardedIps()` is listed, names the first unlisted one, and matches through `isIpInPatterns()`. `basicAuth.js`: `matchesConfiguredUser()` refuses an empty or non-string configured username or password and compares with `crypto.timingSafeEqual()` over SHA-256 digests. `hostWhitelist.js`: reads `hostWhitelist.enabled` with the `'boolean'` converter. |
| Protecting tests | `tests/forwarded-client-address.test.js`, `tests/basic-auth-configured-credentials.test.js`, `tests/host-whitelist-enabled-switch.test.js`. `tests/require-https-client-address.test.js` covers `src/middleware/requireHttps.js`, a SillyBunny file that uses `getTrustedProxies()` and `isIpInPatterns()`. |
| Validation | `npm run test:unit -- tests/forwarded-client-address.test.js tests/require-https-client-address.test.js tests/basic-auth-configured-credentials.test.js tests/host-whitelist-enabled-switch.test.js` (35 of the 41 tests fail with the base commit's sources), the same files on Linux, `npm run lint` in the root and in `tests/`, and a boot with `bun server.js` and `node server.js`. |
| Rollback path | Revert the five commits that the `LESSONS.md` section "Client addresses behind proxies" lists, or the hunks of each file. `src/middleware/requireHttps.js` imports `getTrustedProxies()` and `isIpInPatterns()`, so its commit reverts with the others. Restore those three `default/config.yaml` comments to the upstream text. No stored data, settings or config keys change. |
| Last reviewed | 2026-11-05 forwarded client addresses, configured basic auth credentials and the forwarded header comments. |
| Owner | Server runtime integrator. |

### `src/transformers.js` - caption image decoding
| Field | Value |
| --- | --- |
| File | `src/transformers.js`. |
| Area | Image captioning (`POST /api/extra/caption`). |
| Divergence reason | SillyBunny must decode caption images itself and reject bytes that do not start with an image signature. `RawImage.fromBlob()` finds the format with file-type 16, which loops forever on a crafted ASF header and stops the whole server (GHSA-5v7r-6r5c-r473), and under Bun it needs a canvas that Bun does not have, so every image fails. |
| Target seam | `src/transformers-image.js`. |
| Adapter shape | `getRawImage()` decodes the base64 string into a `Buffer` and returns `decodeRawImage(buffer)`, or `null` when that throws. `decodeRawImage()` throws for bytes that do not start with a PNG, JPEG, GIF, BMP, TIFF, WebP or AVIF signature, so jimp's file-type check never sees them. It decodes the rest with the server's jimp (`src/jimp.js`) instead of calling `RawImage.fromBlob()`, and returns an RGBA `JimpRawImage`, a `RawImage` subclass whose `resize()` also uses jimp instead of `OffscreenCanvas`. `crop()` and `center_crop()` stay upstream; the default captioning model does not call them. |
| Protecting tests | `tests/transformers-image.test.js`. The test defines `self` before sillytavern-transformers loads, so the library takes the code path that it takes under Bun. |
| Validation | `npm run test:unit --prefix tests -- transformers-image.test.js` (on the base commit, the ASF test fails when its child process reaches the 30 s deadline, the PNG test gets `null`, and the preprocessing test fails with `OffscreenCanvas not supported by this browser.`), `npm run lint`. |
| Rollback path | Restore the upstream `getRawImage()` body (`RawImage.fromBlob()` on a `Blob` of the decoded bytes) and the `RawImage` import, then delete `src/transformers-image.js` and `tests/transformers-image.test.js`. No stored data or settings change. The rollback brings back the server hang on a malformed ASF header and the 400 for every image under Bun. |
| Last reviewed | 2026-11-02 caption image signature check (GHSA-5v7r-6r5c-r473). |
| Owner | Server runtime integrator. |

### `src/endpoints/characters.js` - character file names
| Field | Value |
| --- | --- |
| File | `src/endpoints/characters.js`. |
| Area | Character import, create and rename file names. |
| Divergence reason | SillyBunny must sanitise character file names on every platform and write a card only as a PNG directly inside the characters folder. A name from an import, create or rename that sanitises to nothing or loses its extension to the 255-byte cut would otherwise decide where the card is written. |
| Target seam | none yet. |
| Adapter shape | `getPngName()` sanitises the name on every platform with `sanitizeSafeCharacterReplacements` (an empty result becomes `character`), then drops a trailing `.png` in any case, because `getPngFileName()` keeps that extension; the name it returns always maps to `<name>.png`. `writeCharacterData()` fails when `resolveCharacterAvatarPath()` rejects the target name. The V2/V3 JSON branch of `importFromJson()` sanitises `data.name` and `name` before `readFromV2()`, as SillyTavern's does since `1bb2a5ea1`. `getPreservedName()` keeps `sanitiseFilenameForWindows()`. `POST /create` answers 400 when `sanitize()` turns a given `file_name` into an empty string, because the same name also names the card's chats folder. |
| Protecting tests | `tests/character-card-metadata-preservation.test.js`, `tests/entity-date-added-endpoints.test.js` and `tests/entity-last-chat-endpoints.test.js` create, edit and rename cards through `getPngName()` and `writeCharacterData()`. `tests/character-route-names.test.js` sends create requests whose `file_name` sanitizes to nothing. |
| Validation | `npm run test:unit --prefix tests -- character-route-names.test.js entity-date-added-endpoints.test.js entity-last-chat-endpoints.test.js` (on the base commit the four create rows answer 200), `npm run lint`. |
| Rollback path | Revert the `getPngName()`, `writeCharacterData()` and `importFromJson()` hunks, and the `file_name` check in `POST /create`. No stored data or settings change. |
| Last reviewed | 2026-11-05 create file names that sanitize to nothing. |
| Owner | Server and data compatibility integrator. |

### `src/endpoints/characters.js` - archive card assets and import formats
| Field | Value |
| --- | --- |
| File | `src/endpoints/characters.js`. |
| Area | CHARX and BYAF asset storage, and the format lookup of `POST /import`. |
| Divergence reason | SillyBunny must not let a CHARX or BYAF archive choose where its assets are stored or which file types are kept. Asset folders must be folders of their own inside the characters and images folders, stored images must pass a signature check, and `POST /import` must run only import functions that exist for the format. |
| Target seam | `src/image-file-type.js` for the image check; none yet for the asset folders and the format lookup. |
| Adapter shape | `getCardAssetFolder()` returns the sanitized card name, else the card's file name, or `null` when that name is not a folder directly inside the characters and user images folders. `importFromCharX()` passes it to `persistCharXAssets()` and skips the assets for `null`; `importFromByaf()` uses it for the alternate icon folder. `isArchiveImage()` passes a file to `isImageFile()` from `src/image-file-type.js`, which accepts it only when its extension is png, apng, jpg, jpeg, jfif, gif, webp, avif or bmp and its leading bytes match that type, and logs the files that fail. `importFromCharX()` filters the parser's auxiliary assets with it; `importFromByaf()` filters the chat backgrounds before it writes them and the chats, and filters the alternate icons. The stored bytes stay as they are. `POST /import` takes the import function only when `Object.hasOwn(formatImportFunctions, format)`. `src/charx.js` and `src/byaf.js` stay as in SillyTavern. |
| Protecting tests | `tests/character-archive-assets.test.js`, `tests/character-route-names.test.js`. |
| Validation | `npm run test:unit --prefix tests -- character-archive-assets.test.js character-route-names.test.js` (all 13 pass after the image check moved to `src/image-file-type.js`; when that check accepts every file, the 3 image tests fail), `npm run lint`. |
| Rollback path | Revert the `getCardAssetFolder()` and `isArchiveImage()` additions, the `isImageFile()` import, their uses in `importFromCharX()` and `importFromByaf()`, and the `Object.hasOwn()` lookup in `POST /import`. `src/image-file-type.js` stays while `src/endpoints/sprites.js` uses it. No stored data or settings change. |
| Last reviewed | 2026-11-05 image check moved to `src/image-file-type.js`. |
| Owner | Server and data compatibility integrator. |

### `src/endpoints/characters.js` - route input types and errors
| Field | Value |
| --- | --- |
| File | `src/endpoints/characters.js`. |
| Area | Request checks and error handling of `POST /rename`, `POST /edit`, `POST /delete` and `POST /import`. |
| Divergence reason | SillyBunny must answer a character route request that has a wrong-typed field, or a file the route cannot recover or remove, with its own 400 or 500 instead of letting the error escape the route. `sanitize()`, `path.parse()` and `path.join()` throw on a value that is not a string, so the request otherwise gets no answer or a generic 500. |
| Target seam | none yet. |
| Adapter shape | `POST /rename` answers 400 when `avatar_url` or `new_name` is not a string, before `sanitize()` and `path.parse()`. `POST /edit` answers 400 when `avatar_url` is not a non-empty string, before `path.join()`, and runs `charaFormatData()`, the `chat` and `create_date` assignments and `JSON.stringify()` inside a `try` block that answers 400. `POST /delete` answers 400 when `delete_chats` is an object, before `delete_chats == true`, and calls `invalidateThumbnail()` inside a `try` block that logs the error. `POST /import` calls `recoverFileWriteSync()` for `preserved_name` inside a `try` block that answers 500. `charaFormatData()` stays as in SillyTavern. |
| Protecting tests | `tests/character-route-inputs.test.js`. |
| Validation | `npm run test:unit --prefix tests -- character-route-inputs.test.js` (with the base commit's `characters.js`, all 19 tests fail: each request gets no answer, and its error reaches Jest as an unhandled rejection), `npm run lint`. |
| Rollback path | Revert the type checks in `POST /rename`, `POST /edit` and `POST /delete`, and the `try` blocks around the formatting in `POST /edit`, `invalidateThumbnail()` in `POST /delete` and `recoverFileWriteSync()` in `POST /import`. No stored data or settings change. |
| Last reviewed | 2026-11-05 route input types and errors. |
| Owner | Server and data compatibility integrator. |

### `src/endpoints/sprites.js` - sprite file types
| Field | Value |
| --- | --- |
| File | `src/endpoints/sprites.js`. |
| Area | Sprite uploads (`POST /api/sprites/upload` and `POST /api/sprites/upload-zip`). |
| Divergence reason | SillyBunny must store a sprite only when its bytes are an image of the type its extension names, because the upload and zip routes otherwise keep whatever extension the file carries. A failed upload answers 400 before it creates the sprite folder or replaces an existing sprite. |
| Target seam | `src/image-file-type.js`. |
| Adapter shape | `/upload-zip` keeps an entry of `getImageBuffers()` only when `isImageFile(path.extname(sanitize(filename)), buffer)` passes. `/upload` reads the leading bytes of the upload with `readImageSignature()`, keeps the uploaded extension when `isImageFile()` passes, else takes `getImageExtension()`, and sanitizes the name. When the sanitized name fails `isImageFile()`, the route deletes the upload and answers 400 before it creates the sprite folder or deletes an existing sprite. The stored bytes stay as they are. |
| Protecting tests | `tests/sprite-upload-images.test.js`. |
| Validation | `npm run test:unit --prefix tests -- sprite-upload-images.test.js` (with the base commit's `sprites.js`, all 8 tests fail), `npm run lint`. |
| Rollback path | Revert the `/upload-zip` filter, the `/upload` check and the import in `src/endpoints/sprites.js`. Keep `src/image-file-type.js`, which the character imports use. No stored data or settings change. |
| Last reviewed | 2026-11-05 sprite upload file types. |
| Owner | Server and data compatibility integrator. |

### `src/character-card-parser.js` - PNG chunk bounds
| Field | Value |
| --- | --- |
| File | `src/character-card-parser.js`. |
| Area | Character card PNG parsing (`read()`, `write()` and `parse()`). |
| Divergence reason | SillyBunny must reject a character card PNG whose chunk declares more data than the file holds before `png-chunks-extract` reads it. That library allocates, copies and checksums the declared length first, so a small crafted file can make the parser spend memory and time on it. |
| Target seam | `src/png/extract.js`. |
| Adapter shape | The module imports `extract` from `./png/extract.js` instead of `png-chunks-extract`. That `extract()` walks the chunk headers up to IEND and throws `PNG chunk at byte <n> runs past the end of the file` when a chunk header or the data length it declares does not fit in the file, then returns the result of `png-chunks-extract`. Data without the PNG signature goes to `png-chunks-extract` unchecked. |
| Protecting tests | `tests/png-chunk-bounds.test.js`. |
| Validation | `npm run test:unit --prefix tests -- png-chunk-bounds.test.js` (on the base commit 8 of its 12 tests fail; the other 4 pin what the check leaves unchanged), `npm run lint`. |
| Rollback path | Import `extract` from `png-chunks-extract` again, then delete `src/png/extract.js` and `tests/png-chunk-bounds.test.js`. No stored data or settings change. |
| Last reviewed | 2026-11-05 PNG chunk bounds. |
| Owner | Server runtime integrator. |

### `src/server-main.js` - session auth routes
| Field | Value |
| --- | --- |
| File | `src/server-main.js`. |
| Area | Session auth login and logout routes. |
| Divergence reason | SillyBunny must put session login and logout behind the IP whitelist and the host whitelist, with their own login rate limit. Inline routes in `src/server-main.js` answer before those checks, so a client the whitelist blocks could still try passwords without a limit. |
| Target seam | `src/middleware/sessionAuth.js`. |
| Adapter shape | When `isSessionAuthEnabled()` is true, the block above basic auth calls `registerSessionAuthRoutes(app, { whitelistMode: cliArgs.whitelistMode })`. That function registers `POST /api/auth/login` and `POST /api/auth/logout` behind the IP whitelist middleware (when `whitelistMode` is on, from its own `getWhitelistMiddleware()` call) and `hostWhitelistMiddleware`, and gives login its own rate limit. The file imports only `isSessionAuthEnabled` and `registerSessionAuthRoutes` from `./middleware/sessionAuth.js`. |
| Protecting tests | `tests/session-auth-routes.test.js`. |
| Validation | `npm run test:unit --prefix tests -- session-auth-routes.test.js` (on the `upstream/staging` sources, its route tests fail because `registerSessionAuthRoutes()` does not exist, and its `validateCredentials()` tests fail by assertion), `npm run lint`, and scratch servers with session auth, accounts and `perUserBasicAuth` on under Bun 1.4.4 and Node 24.22.1: a client that the whitelist blocks gets 403, the login after five failures gets 429, and an object password gets 400 while the server keeps running. With `perUserBasicAuth` off and an empty `basicAuthUser`, startup logs one warning. |
| Rollback path | Put the inline login and logout routes back in the block, import `createSession`, `destroySession` and `validateCredentials` again, and delete `registerSessionAuthRoutes()`, `handleLogin()`, `handleLogout()` and the login limiter from `src/middleware/sessionAuth.js`. No stored data or settings change. Session login then runs before the whitelist checks again and has no rate limit. |
| Last reviewed | 2026-11-05 session auth route guards. |
| Owner | Server runtime integrator. |

### `src/users.js`, `src/endpoints/users-public.js`, `src/endpoints/users-private.js`, and `src/endpoints/users-admin.js` - account route guards
| Field | Value |
| --- | --- |
| File | `src/users.js`, `src/endpoints/users-public.js`, `src/endpoints/users-private.js`, `src/endpoints/users-admin.js`. |
| Area | Account routes: request fields, password attempts, user folders and the user lookup for a session. |
| Divergence reason | SillyBunny must check the request fields, handles and user folders that each account route uses before it acts on them, and limit password attempts per account. `toKey()` reads an array as the handle in it and `getUserDirectories()` joins a handle into a path as it is, so a crafted request could break a route or reach a folder outside the data root. |
| Target seam | none yet. |
| Adapter shape | Each route that reads a handle checks that it is a non-empty string before `toKey()` or `getUserDirectories()`, and password, new password and avatar fields are checked for strings before `getPasswordHash()` or the data URL check; `/login` hashes a missing password as an empty one. `users-private.js` adds `passwordLimiter` (`rateLimiting.accountsLoginMaxAttempts`, 60 s, keyed by handle) and `checkAccountPassword()`, which `/change-password`, `/reset-settings` and `/reset-step2` call; their `catch` blocks answer 429 with Retry-After for a `RateLimiterRes`, and `/reset-step2` checks the reset limiter before the password. `users.js` adds `isUserRootInsideDataRoot()`, which `/delete` with `purge` and `/backup` call after a storage lookup that answers 404 for an unknown handle. `setUserDataMiddleware()` wraps its `storage.getItem()` in a `try` that answers 500. Each changed route carries a `SillyBunny:` marker. |
| Protecting tests | `tests/users-request-fields.test.js`, `tests/users-password-attempts.test.js`, `tests/users-folder-guards.test.js`, `tests/users-session-read-failure.test.js`. |
| Validation | `npm run test:unit --prefix tests -- users-request-fields.test.js users-password-attempts.test.js users-folder-guards.test.js users-session-read-failure.test.js` (every test fails on the `upstream/staging` sources), `npm run lint`, and the Bun and Node scratch servers above: an array handle gets 400, `/change-password` after five wrong passwords gets 429, a purge of a handle that is not an account gets 404 and removes nothing, and a corrupt user record gets 500 while the server keeps running. |
| Rollback path | Revert the hunks marked `SillyBunny:` in these four files, which removes `passwordLimiter`, `checkAccountPassword()` and `isUserRootInsideDataRoot()` with their calls. No stored data or settings change. |
| Last reviewed | 2026-11-05 account route guards. |
| Owner | Server and data compatibility integrator. |

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

### `public/scripts/extensions/quick-image-gen/index.js` - Conversation selfie readiness guard (fork seam reference) and unconfirmed sync id claim
| Field | Value |
| --- | --- |
| File | `public/scripts/extensions/quick-image-gen/index.js`. |
| Area | Extension boot, image-generation integration, and the settings sync cache id. |
| Divergence reason | SillyBunny Conversation selfie actions can fire before Quick Image Gen finishes booting, so the fork needs a small readiness gate rather than duplicating QIG init state in Conversation modules. It also keeps an unconfirmed claim on a new sync id for the server user who wrote it, so that its own browser caches do not look like legacy data, and ask to be imported, on every boot while the host skips settings saves, for example until the user answers the Welcome prompt. |
| Target seam | `public/scripts/sillybunny-conversation/media.js` for the readiness guard; none yet for the unconfirmed sync id claim. |
| Adapter shape | Keep the readiness guard limited to exporting `ensureQuickImageGenReady()`; keep Conversation modules responsible for when to await it. The unconfirmed sync id claim stays inside QIG. `UNCONFIRMED_SYNC_CACHE_ID_KEY` (`qig_sync_cache_id_unconfirmed` in `localStorage`) holds `{ id, user }`. `initializeQuickImageGen()` imports `getCurrentUserHandle()` from `public/scripts/user.js` before `loadSettings()`. `loadSettings()` reuses the claimed id as `_syncCacheId` only when the server has no `_syncCacheId`, `qig_sync_cache_id` is empty and the claim's user is the current user; it then skips the legacy-import question and may seed from this browser's caches. Otherwise it removes the claim. When the server has no `_syncCacheId`, it writes the claim before its cache writes, unless the legacy import was declined or local cache writes are blocked. `removeUnconfirmedClaimWhenSaved()` removes the claim after a host `SETTINGS_UPDATED` event once `confirmSyncCacheIdSaved()` confirms that the server stored the id. Each block carries a `SillyBunny divergence:` marker. |
| Protecting tests | `tests/conversation-mode-scoped-profile.test.js`, `tests/sillybunny-conversation-image-safety.test.js`, `tests/quick-image-gen-legacy-import.test.js`. |
| Validation | `npm run test:unit --prefix tests -- quick-image-gen-legacy-import.test.js conversation-mode-scoped-profile.test.js` (three legacy-import tests fail when `loadSettings()` ignores the claim), `node --check public/scripts/extensions/quick-image-gen/index.js`. Not checked in a browser. |
| Rollback path | Remove the readiness helper export and revert Conversation callers to direct QIG access if boot timing changes upstream. For the claim, revert the hunks that use `getCurrentUserHandle`, `UNCONFIRMED_SYNC_CACHE_ID_KEY`, `unconfirmedCacheId` or `removeUnconfirmedClaimWhenSaved()`; boots then ask the legacy-import question again while the host skips settings saves. Nothing reads a `qig_sync_cache_id_unconfirmed` key left in `localStorage`, and no server data changes. |
| Last reviewed | 2026-11-11 PR #918 Android APK. |
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
| Adapter shape | Keep archive validation, route contracts, and account-directory resolution in this upstream-origin adapter; keep fork-specific metadata helpers isolated. `/import-sillytavern/folder` and `/import-sillytavern/extensions` run behind `requireAdminMiddleware`, so only an admin imports from a server folder; the read check behind it (`getImportReadCheck()` and `resolveReadableImportRoot()`, also passed to `copyDirectoryTree()`) passes every path for an admin. `syncThirdPartyExtension()` keeps the existing extension at `<temp folder>-previous` until the synced copy is in place. `detectZipImportBase()` refuses a backup ZIP before anything is written when `hasPortableNames()` rejects the name of an entry that would be imported. `importZipContents()` catches a throw from `createWriteStream()`, and when an entry fails it closes the archive and removes the file that the entry opened. The ZIP route answers 500 for an error with a syscall and 400 for other errors. |
| Protecting tests | `tests/backups-hardening.test.js`, `tests/users-import-guards.test.js`, `tests/users-import-accounts-off.test.js`, `tests/users-backup-zip-failures.test.js`, `tests/users-extension-sync-swap.test.js`, plus manual export/import smoke with a fork account archive. |
| Validation | `node --check src/endpoints/users-private.js`, `npm run lint`, archive traversal regression smoke; `npm run test:unit --prefix tests -- users-import-guards.test.js users-import-accounts-off.test.js users-backup-zip-failures.test.js users-extension-sync-swap.test.js` (the tests for members fail on the sources before `8cd9ab2be`, and each backup ZIP failure test fails on the sources before its commit, `4109a0812` to `2d093e8af`). |
| Rollback path | Revert the fork metadata branches while retaining upstream archive validation. To let other users import server folders again, remove `requireAdminMiddleware` from the two folder routes, and remove `updateFolderImportVisibility()` with its call and its `SETTINGS_LOADED` listener from `public/scripts/sillybunny-tabs.js`. To undo the backup ZIP failure handling, remove `hasPortableNames()` and its check in `detectZipImportBase()`, the `try` around `createWriteStream()`, the `zipfile.close()` and the partial file removal in `importZipContents()`, and the syscall branch of the ZIP route. To undo the import read check, remove `getImportReadCheck()` and `resolveReadableImportRoot()` and their calls; to undo the extension swap, restore the `rm()` before the `rename()` in `syncThirdPartyExtension()`. No stored data or settings change. |
| Last reviewed | 2026-11-05 admin-only server folder import and backup ZIP failure handling. |
| Owner | Account and release integrator. |

### `src/electron/` - Electron launcher removal
| Field | Value |
| --- | --- |
| File | `src/electron/Start.bat`, `src/electron/package.json` and `src/electron/package-lock.json`, removed. SillyTavern also ships `src/electron/index.js` and `src/electron/start.sh`, which SillyBunny never adopted. |
| Area | Packaging and launchers. |
| Divergence reason | SillyBunny must not ship an Electron launcher package that cannot start: `package.json` names an `index.js` that SillyBunny never adopted, and `Start.bat` installs with `--ignore-scripts`, which skips the Electron binary download. The package's lockfile also carries npm audit advisories that no script, test or workflow covers. |
| Target seam | None. The root launchers start `server.js`, and SillyBunny ships no Electron entry point. |
| Adapter shape | None. A SillyTavern sync that changes `src/electron/**` leaves those changes out. |
| Protecting tests | None. |
| Validation | `git grep -n -i "src/electron"` finds no code, test or workflow reference. `.github/pr-auto-labels-by-files.yml` parses as YAML. |
| Rollback path | Revert the commit that removed the package (`git log --diff-filter=D -- src/electron/package.json`), which restores the three files at electron 41.1.1. The launcher still does not start until `src/electron/index.js` comes from SillyTavern, because `package.json` names it as `main`, and until the Electron binary is installed, because `Start.bat` installs with `--ignore-scripts` and the electron package downloads its binary only in its `postinstall` script. |
| Last reviewed | 2026-11-02, package removal. |
| Owner | Release integrator. |

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

### `public/scripts/world-info.js` - scan target for Conversation lorebooks
| Field | Value |
| --- | --- |
| File | `public/scripts/world-info.js` |
| Area | World Info scanning and Conversation mode. |
| Divergence reason | SillyBunny must scan the lorebooks of a Conversation character that is not the open chat, with that thread's lorebook override and persona. Upstream scans only the active chat, so the same scan would read and change its extension prompts, forced activations, sticky and cooldown state and Author's Note, and emit scan events. |
| Target seam | `public/scripts/sillybunny-conversation/world-info.js`. |
| Adapter shape | `checkWorldInfo()` and `getSortedEntries()` take an optional `scanTarget` (`WIScanTarget`), and `WorldInfoBuffer` takes the substitution function for keys. With a target, the scan reads the target character's linked books and the global books, reads `chatWorld` and `personaWorld` in place of the chat and persona lorebooks, and applies character filters, `{{char}}`, `{{user}}` and the regex `{{char}}` to the target. It skips the active chat's extension prompts, forced activations, sticky and cooldown writes, Author's Note write, `WORLDINFO_ENTRIES_LOADED` and `WORLDINFO_SCAN_DONE`. Without a target the scan does not change. |
| Protecting tests | `tests/world-info-scan-target.test.js` (characterization of the active-chat scan, plus target scans), `tests/frontend/ConversationLorebooks.e2e.js`. |
| Validation | `npm run test:unit -- world-info-scan-target.test.js` in `tests/`, `npx eslint public/scripts/world-info.js`, `npm run test:e2e -- frontend/ConversationLorebooks.e2e.js` against a running server in Chromium and WebKit. |
| Rollback path | Remove the optional `scanTarget` parameter and its branches from `getCharacterLore()`, `getChatLore()`, `getPersonaLore()`, `getSortedEntries()` and `checkWorldInfo()`, and the key substitution argument of `WorldInfoBuffer`, in `public/scripts/world-info.js`. The Conversation scan in `public/scripts/sillybunny-conversation/world-info.js` would then read the active chat's lorebooks instead of the thread character's, so revert `getConversationWorldInfo()` as well. No saved data changes, because a target scan writes no sticky, cooldown or Author's Note state. |
| Last reviewed | 2026-10-23 Conversation lorebooks. |
| Owner | World Info and shell integrator. |

### `public/scripts/macros/engine/MacroEngine.js`, `public/scripts/macros/engine/MacroCstWalker.js`, `public/scripts/macros/engine/MacroRegistry.js`, and `public/scripts/macros/definitions/core-macros.js` - macro whitespace markers
| Field | Value |
| --- | --- |
| File | `public/scripts/macros/engine/MacroEngine.js`, `public/scripts/macros/engine/MacroCstWalker.js`, `public/scripts/macros/engine/MacroRegistry.js`, `public/scripts/macros/definitions/core-macros.js` |
| Area | Macros 2.0 whitespace trimming. |
| Divergence reason | SillyBunny must keep the whitespace that `{{newline}}`, `{{space}}` and `{{noop}}` produce when the engine trims. The engine trims text after it resolves macros, so `{{if}}` branches, scoped content and variable shorthand values lose that whitespace, and `{{noop}}` no longer stops the legacy `{{trim}}`. |
| Target seam | `public/scripts/macros/sillybunny-whitespace-markers.js`. |
| Adapter shape | `MacroCstWalker` marks `{{newline}}`, `{{space}}` and `{{noop}}` output, and removes the markers from arguments, from scoped content after its trim, and from variable shorthand values after their trim. `MacroEngine.evaluate()` gives marked text to the `core:` post-processors that run before all others, runs the legacy `{{trim}}` through `applyLegacyTrim()`, and gives the other post-processors text without markers. `resolve()` passes `keepWhitespaceMarkers` to `MacroEngine.evaluate()`. Only the `{{if}}` handler sets it, for its branch, so that its trim keeps the marked output. |
| Protecting tests | `tests/sillybunny-macro-whitespace.test.js`, `tests/frontend/sillybunny-macro-whitespace.e2e.js`, `tests/frontend/MacroEngine.e2e.js`. |
| Validation | `npm run lint` in the root and in `tests/`, `npm run test:unit -- sillybunny-macro-whitespace.test.js` and the full `npm run test:unit` in `tests/`, `npm run check:frontend-budgets`, and `npm run test:e2e -- frontend/sillybunny-macro-whitespace.e2e.js frontend/MacroEngine.e2e.js` against a running server in Chromium. |
| Rollback path | Remove the `SillyBunny:` lines in the four files and delete the marker module; the engine then trims as upstream does, and the specs that test the markers fail until they are removed. If upstream merges its own fix for SillyTavern/SillyTavern#5673 and SillyTavern/SillyTavern#5674 (open as SillyTavern/SillyTavern#6040), take the upstream code in the sync, drop this adapter, and keep the whitespace cases in `tests/frontend/sillybunny-macro-whitespace.e2e.js` that still apply. |
| Last reviewed | 2026-11-02 macro whitespace markers. |
| Owner | Browser runtime integrator. |

### `public/scripts/slash-commands/SlashCommandParser.js` and `public/scripts/slash-commands/SlashCommandParserError.js` - STscript parser fixes
| Field | Value |
| --- | --- |
| File | `public/scripts/slash-commands/SlashCommandParser.js`, `public/scripts/slash-commands/SlashCommandParserError.js`. |
| Area | STscript parsing, parser errors and autocomplete positions. |
| Divergence reason | SillyBunny must parse STscript as written and report malformed input as a parser error at the right position. Upstream's parser skips a character after a nested block comment closes, mis-reads quoted values, escaped characters and closures in split-count commands, and throws a TypeError for an empty `/parser-flag` or `/let key=`. |
| Target seam | none yet: each change is inside a parser method, and the methods share one index through the text. |
| Adapter shape | `parseBlockComment()` takes a character only when no nested comment starts at it. `parseParserFlag()` throws `Unexpected end of unnamed argument`, with the text and the index, when no flag name follows. `parseCommand()` reports an unknown command at `start`, the first character of its name, and lists the name from a `/let` `key=` only when that argument has a value. `parseUnnamedArgument()` leaves an escaped first character to the split branches when it splits, tests for the end of the argument again after the quoted rest of a split-count command, adds a quote flag for each closure, gives its `Unexpected end of unnamed argument` error the text and the index, and joins a closure in the rest as its source text. `parseQuotedValue()` counts macro positions back from the closing quote and discards the closing character only when it is a quote. `SlashCommandParserError.hint` slices the source up to the newline that ends the error line. |
| Protecting tests | `tests/frontend/StscriptParserFixes.e2e.js` (one test or more for each change, through `tests/frontend/stscript-parser-harness.js`; every test fails on the upstream parser), `tests/frontend/MacroSlashCommands.e2e.js`. |
| Validation | `npm run lint` in the root and in `tests/`, `npm run check:frontend-budgets`, `npm run test:unit -- input-history-account-storage.test.js openrouter-oauth-return.test.js pathfinder-search.test.js quick-reply-config.test.js quick-reply-settings-ui.test.js webkit-prefix-companions.test.js` in `tests/`, and `npm run test:e2e -- frontend/StscriptParserFixes.e2e.js frontend/MacroSlashCommands.e2e.js frontend/ReasoningHiddenBlocks.e2e.js frontend/AddSwipeNoReload.e2e.js frontend/DeleteToolCalls.e2e.js card-script-sandbox.e2e.js` against a Bun 1.4.4 server in Chromium. |
| Rollback path | Revert the `SillyBunny:` hunks in the two files. The hunks are independent, except that a closure in a joined rest reads the quote flag that each closure adds. No stored data, settings or saved scripts change. Scripts then parse as they do upstream, and `tests/frontend/StscriptParserFixes.e2e.js` fails until it is removed. |
| Last reviewed | 2026-11-05 STscript parser fixes. |
| Owner | Browser runtime integrator. |

### `tests/playwright.config.js` - test servers, worker count and request headers
| Field | Value |
| --- | --- |
| File | `tests/playwright.config.js`. |
| Area | Test infrastructure: Playwright worker count, test servers and the `Accept-Encoding` request header. |
| Divergence reason | Upstream's `workers: '50%'` sends more workers to one server than it can serve on a large machine, and the extra workers only add timeouts. SillyBunny caps the default and can start several isolated servers, so that one Playwright process spreads its workers over them. |
| Target seam | `tests/e2e-servers.js`, with `tests/e2e-servers-launch.js` (starts the servers at once) and `tests/e2e-servers-prime.js` (boots the app once on each server). |
| Adapter shape | One `await getServerConfig()` call. Its `use` is spread last into `use`, its `workers` replaces `'50%'`, and its `config` (`webServer`, `globalSetup`, `projects`) is spread last into the config. When the config starts the servers, `use` adds `extraHTTPHeaders` with `Accept-Encoding: identity`. With a base URL variable set, or without `SILLYBUNNY_TEST_SERVERS`, `use` and `config` are empty and only the worker count differs from upstream. `SILLYBUNNY_TEST_COMPRESSION=1` or `0` sets the header for any run. |
| Protecting tests | `tests/e2e-servers.test.js` (server count, worker count, routing, request headers, server commands, sequential spec files, projects) and `tests/e2e-servers.e2e.js` (each worker uses the server of its parallel index; it runs only with `SILLYBUNNY_TEST_SERVERS`). |
| Validation | `npm run lint` and `npm run test:unit` in `tests/`. `SILLYBUNNY_TEST_SERVERS=8 npx playwright test` (full suite on 8 Bun servers and 64 workers), `SILLYBUNNY_TEST_SERVERS=3 npx playwright test e2e-servers.e2e.js --repeat-each=12`, and against one Bun server with `SILLYBUNNY_TEST_BASE_URL`: `frontend/MacroLexer.e2e.js` with the default workers (16 on a 128-thread machine) and `frontend/MacroParser.e2e.js --workers=1`. Cleanup checked after a normal end, an interrupt, a server that cannot start (`bun` not on `PATH`), a port that another process holds while another server runs already, and a server that stops after the others are ready. One app boot with the identity header got no compressed response (674 same-origin responses), and 529 Brotli responses without it. Chromium, Playwright 1.64.1. |
| Rollback path | Revert the `SillyBunny:` hunks in `tests/playwright.config.js`, and delete `tests/e2e-servers.js`, `tests/e2e-servers-launch.js`, `tests/e2e-servers-prime.js`, `tests/e2e-servers.e2e.js` and `tests/e2e-servers.test.js`. Runs then use `'50%'` workers against one running server, as upstream does. No app code, stored data or settings change. |
| Last reviewed | 2026-11-10 `perf/e2e-throughput`. |
| Owner | Test and release integrator. |

### `tests/frontend/MacroEngine.e2e.js`, `MacroLexer.e2e.js`, `MacroParser.e2e.js`, `MacroRegistry.e2e.js`, `MacroSlashCommands.e2e.js` and `MacroStoryString.e2e.js` - one booted page per worker
| Field | Value |
| --- | --- |
| File | `tests/frontend/MacroEngine.e2e.js`, `tests/frontend/MacroLexer.e2e.js`, `tests/frontend/MacroParser.e2e.js`, `tests/frontend/MacroRegistry.e2e.js`, `tests/frontend/MacroSlashCommands.e2e.js`, `tests/frontend/MacroStoryString.e2e.js`. |
| Area | Test infrastructure: app boots in the macro and STscript browser tests. |
| Divergence reason | These tests run the macro engine, its parser and registry, and slash commands inside the page, and need the booted app only as the place to run. Upstream boots the whole app for each test, so the boot was most of their run time. |
| Target seam | `tests/frontend/shared-page.js`. Its `test` gives a `page` that boots once per worker, restores the chat metadata (which holds the local variables) and the global variables of the boot before each test, fails a test when the page has navigated since its boot, and answers `/api/settings/save` itself after the boot. Its `testSetup.awaitST` and `testSetup.goST` do nothing, because the page has booted. |
| Adapter shape | In each file, the `@playwright/test` and `./frontent-test-utils.js` imports become one import of `test`, `expect` and `testSetup` from `./shared-page.js`, under a `SillyBunny:` comment. The test bodies and their `beforeEach(testSetup.awaitST)` or `beforeEach(testSetup.goST)` lines are unchanged. `tests/frontend/sillybunny-macro-whitespace.e2e.js` is a SillyBunny file and uses the same import. A file may join only when it leaves no other state behind; MessageFormatter, MacroEnvBuilder and StscriptParserFixes leave state that breaks other files, and the remaining files write chats, lorebooks or settings. |
| Protecting tests | The six files and `tests/frontend/sillybunny-macro-whitespace.e2e.js` themselves. Among them, at least 14 MacroEngine tests expect empty variables (for example the scoped `getvar::x` test and the `.myvar ??` tests), so a missing restore fails them. |
| Validation | `npm run lint` in `tests/`. The seven files with one worker (520 tests, one boot, 507 passed and 13 skipped), with the `e2e` runner's 8 servers × 8 workers and `--repeat-each=3` (1,521 passed, 39 skipped), and `tests/frontend/` with one worker (582 passed, 13 skipped; 252 s, against 1,501 s before). A failed test on the shared page still attaches its screenshot and error context; it has no video. Chromium, Playwright 1.64.1. |
| Rollback path | Restore the two upstream import lines in each file, and delete `tests/frontend/shared-page.js` when no file imports it. The tests then boot the app for each test, as upstream does. No app code, stored data or settings change. |
| Last reviewed | 2026-11-10 `perf/e2e-throughput`. |
| Owner | Test and release integrator. |

### `src/endpoints/settings.js` and `public/script.js` - settings saves without a change
| Field | Value |
| --- | --- |
| File | `src/endpoints/settings.js`, `public/script.js`. |
| Area | Settings: the version check that keeps a stale tab or device from overwriting newer settings. |
| Divergence reason | SillyBunny refuses a settings save from a page that loaded before another page saved, so that a stale tab or device cannot overwrite newer settings. Upstream has no such check, and every boot saves the settings without a change, so the check refused saves and showed the conflict prompt without a real conflict. |
| Target seam | `isUnchangedSettingsSave()` in `src/settings-version.js` (server) and `createSettingsSync()` in `public/scripts/sillybunny-settings-sync.js` (page). |
| Adapter shape | `POST /api/settings/save` answers a save whose content equals the stored settings, apart from `_version`, with `{ result: 'ok', version: <stored>, unchanged: true }` before the version check: no write, no autosave backup, no new version. `saveSettingsInner()` accepts such an answer when its version is not lower than the one it sent; every other answer still needs a higher version. `prepareSettingsSave()`, which the Conversation REST API shares, is unchanged. `public/script.js` also remembers the key-sorted settings text that `getSettings()` loaded and that each confirmed save sent, without `_version`, and `saveSettingsInner()` sends no request when the payload equals it; it still sets `settings` and emits `SETTINGS_UPDATED`. Adapter lines: the import, `const settingsSync = createSettingsSync()`, one `remember()` after the load, the check before the request, and one `remember()` after a confirmed save. |
| Protecting tests | `tests/settings-version-guard.test.js` (equal and changed content), `tests/settings-save-unchanged.test.js` (route: no write and the same version, a stale page with the stored settings, a stale page with a change still refused), `tests/openai-custom-endpoint-credentials.test.js` (client: same version, newer version, older version refused; no request when nothing changed; a request after each change; nothing remembered from a failed or refused save), `tests/sillybunny-settings-sync.test.js` (key order, nested values, array order, one state per page). |
| Validation | `npm run lint` in the root and in `tests/`, the protecting tests, `tests/sillybunny-conversation-api.test.js` and `tests/chat-integrity-rotation.test.js`. In Chromium against a Bun server: a second and third boot posted exactly the stored settings (0 differing paths); 8 pages booting at once got 8 `unchanged` answers and no prompt with the server change alone, and sent no save at all with the page change (`staging`: 7 of 8 got 409 and the prompt); a real change in one tab still gave an older tab 409 and the prompt; a page that booted just before another tab saved a real change sent no save and got no prompt. `npm run check:frontend-budgets`; boots with `bun server.js` and `node server.js`. |
| Rollback path | Revert the `SillyBunny:` hunks in `src/endpoints/settings.js` and `public/script.js`, and delete `public/scripts/sillybunny-settings-sync.js` and `isUnchangedSettingsSave()`. Every boot then saves and raises the settings version again, and other open tabs and devices show the conflict prompt at their next save. No stored data or settings format changes. |
| Last reviewed | 2026-11-10 `perf/e2e-throughput`. |
| Owner | Server and data compatibility integrator. |

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
| Area | Install, defaults, server lifecycle, runtime utilities, and Android app runtime. |
| Divergence reason | SillyBunny synchronizes ignored default files, manages fork-owned bundled content, and adds runtime/server safeguards while preserving upstream startup contracts. When the Android app starts the server with `SILLYBUNNY_LAUNCH_TOKEN`, the server must refuse requests that do not carry that token, so other apps on the device cannot use it. |
| Target seam | `src/server-init.js`, `src/server-directory.js`, `src/runtime.js`, the bundled-content helpers in `content-manager.js`, and `src/middleware/launchToken.js` for launch authentication, health probes, and browser handoff. |
| Adapter shape | Keep startup order and upstream routes stable; isolate default synchronization and fork content reconciliation behind small helpers. In `src/server-main.js`, mount `createLaunchTokenMiddleware()` immediately after helmet and exempt `LAUNCH_COOKIE_NAME` from `/api/cookies/clear` only while enabled. Both hooks are inert unless `SILLYBUNNY_LAUNCH_TOKEN` is non-empty. |
| Protecting tests | CI `bun src/server-init.js` smoke, `tests/default-preset-deletions.test.js`, `tests/sillybunny-launcher-smol.test.js`, `tests/launch-token.test.js`, `tests/launch-token-server-wiring.test.js`, and root lint. |
| Validation | Android hooks: `node --check src/server-main.js`, `npm run test:unit --prefix tests -- launch-token.test.js launch-token-server-wiring.test.js`. Existing initialization checks: `npm run init`, `node --check src/server-init.js`, `npm run lint`. |
| Rollback path | Revert default/content reconciliation while retaining upstream config initialization and server startup. For the Android hooks, remove the `createLaunchTokenMiddleware()` mount after `helmet()` and the `LAUNCH_COOKIE_NAME` exemption in `/api/cookies/clear` in `src/server-main.js`, then delete `src/middleware/launchToken.js` and its tests. The server then accepts requests without a launch token and stops serving `/__sillybunny/health` and `/__sillybunny/handoff`, which the Android app uses for its health probe and browser handoff. The Android hooks write no saved data. |
| Last reviewed | 2026-10-21, PR SillyBunnyTeam/SillyBunny#918 (Android hooks; prior initialization review 2026-07-28). |
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

### `start.sh` - Android app runtime
| Field | Value |
| --- | --- |
| File | `start.sh` |
| Area | Android app runtime. |
| Divergence reason | The Android app bundles Node.js, git and npm but not Bun. SillyBunny must make `start.sh` skip Termux detection and the prerequisite installer and default to Node.js when `SILLYBUNNY_ANDROID_APP=1`, because the app ships its own tools and the installer relies on download tools that may not exist on Android. |
| Target seam | `scripts/install-prerequisites.sh`, `scripts/self-update.sh`, and `scripts/dependency-state.js` own setup, updates, and dependencies; no separate seam yet for APK runtime selection. |
| Adapter shape | Keep `is_android_app()` guards around Termux detection, runtime fallback, and the prerequisite call. Honor Node/Bun overrides, otherwise default APK launches to Node; keep existing update/dependency helper calls. APK branches are inert unless `SILLYBUNNY_ANDROID_APP=1`. |
| Protecting tests | `tests/android-app-mode-scripts.test.js`, `tests/sillybunny-launcher-smol.test.js`. |
| Validation | `bash -n start.sh`, `npm run test:unit --prefix tests -- android-app-mode-scripts.test.js sillybunny-launcher-smol.test.js` (shell cases require a POSIX host). |
| Rollback path | Remove `is_android_app()` and its guards in `start.sh`: the early return in `is_termux()`, the Node.js default in `prefer_node_runtime()` and the skip of `scripts/install-prerequisites.sh`. The Android app then runs the prerequisite installer, whose download tools may not exist on Android. No saved data changes. |
| Last reviewed | 2026-10-21, PR SillyBunnyTeam/SillyBunny#918. |
| Owner | Runtime and release integrator. |

### Repository policy, launchers, packaging, and build infrastructure
| Field | Value |
| --- | --- |
| File | Root upstream-origin files, `.github/**`, `docker/**`, `package.json`, lockfiles, launcher scripts, `webpack.config.js`, and repository policy/setup documents not named by a narrower active entry. |
| Area | Release policy, packaging, launch, CI, container runtime, and project identity. |
| Divergence reason | SillyBunny carries fork branch policy, branding, Bun-first and Node-compatible launch paths, constrained installs, release automation, and container defaults. |
| Target seam | `.github/workflows/`, launcher scripts, `scripts/dependency-state.js`, `src/runtime.js`, and Docker entrypoints. |
| Adapter shape | Keep upstream-compatible commands and package contracts; isolate fork runtime selection, metadata, branding, and release gates in the named infrastructure files. |
| Protecting tests | `tests/sillybunny-launcher-smol.test.js`, `tests/server-supervisor.test.js`, `tests/frontend-assets.test.js`, root lint, frontend build, README mirror check, and workflow static validation. |
| Validation | `npm ci --dry-run`, launcher unit tests, shell/JSON/YAML syntax checks, `npm run lint`, `npm run build:frontend`, and release workflow smoke. |
| Rollback path | Revert each launcher, workflow, or packaging adapter independently while retaining user data and upstream application formats. |
| Last reviewed | 2026-11-04 SillyTavern staging sync (`ad29cbda6`). |
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

### simple-git named imports
| Field | Value |
| --- | --- |
| File | `plugins.js`, `src/plugin-loader.js`, `src/util.js`, `src/endpoints/extensions.js`, `src/git/client.js`. |
| Area | Git integration for server plugins, extensions, the git backend client and version info. |
| Divergence reason | SillyBunny must import simple-git by its named `simpleGit` export, because simple-git 4 removes the default export. The named export exists since 3.10, so the change also works on 3.x. |
| Target seam | None; the import statement is the whole divergence. |
| Adapter shape | Each file imports the named `simpleGit` export instead of the default export and keeps its local name: `git` in `plugins.js` and `src/plugin-loader.js`, `simpleGit` in the others. |
| Protecting tests | `tests/plugin-loader.test.js` mocks the named export. `tests/extensions-discover.test.js` loads `src/endpoints/extensions.js` and `src/git/client.js` without mocks, and most server suites load `src/util.js`, so these suites fail at import if the export is missing. No test loads `plugins.js`. |
| Validation | `npm run lint`, `npm run test:unit --prefix tests -- plugin-loader.test.js connection-state-checker.test.js`, the full `npm run test:unit`. Manual checks on Windows with Bun and Node: extension install with and without a branch, per user and global, then version, branches, switch, update and delete; `plugins.js install` and `update`; server plugin auto-update at startup; server update, auto-stash update and branch switch in a disposable checkout; version info with `GIT_DIR` set in the server environment; an extension install with the `builtin` backend. |
| Rollback path | Restore the default import in each file: `import { default as git, CheckRepoActions } from 'simple-git'` in `plugins.js` and `src/plugin-loader.js`, `import { default as simpleGit } from 'simple-git'` in `src/util.js`, `import { CheckRepoActions, default as simpleGit } from 'simple-git'` in `src/endpoints/extensions.js`, and `import simpleGit from 'simple-git'` in `src/git/client.js`. simple-git 4 removes the default export, so do this only on simple-git 3. No saved data changes. |
| Last reviewed | 2026-10-24 simple-git 4 upgrade. |
| Owner | Server runtime integrator. |

### simple-git environment in the Android app
| Field | Value |
| --- | --- |
| File | `src/util.js`, `src/plugin-loader.js`, `src/endpoints/extensions.js`, `src/git/client.js`. |
| Area | Git integration for version info, server plugin updates, extensions and the git backend client in the Android app. |
| Divergence reason | The Android app gives git its paths, CA bundle and identity only through `GIT_*` environment variables, and simple-git 4 removes every inherited `GIT_*` variable that `allowEnvironment` does not name. Without them, git in the app cannot find its helpers or verify https, and commits and stashes have no identity, so Server Tools, extension and server plugin updates fail. |
| Target seam | `getAndroidAppGitOptions()` in `src/android-app-gate.js`. |
| Adapter shape | Each file imports `getAndroidAppGitOptions()` and passes its result to simple-git: spread into the options of `simpleGit()` in `getVersion()` in `src/util.js` and into `OPTIONS` in `src/endpoints/extensions.js`, as the second argument of `git()` in `updatePlugins()` in `src/plugin-loader.js`, and as the argument of `simpleGit()` in the `SimpleGitClient` constructor in `src/git/client.js`. Outside the Android app it returns an empty object, so these calls keep simple-git's environment guard as upstream does. |
| Protecting tests | `tests/android-app-git-environment.test.js` checks the `allowEnvironment` option at each simple-git call site in these files and in `src/endpoints/server-admin.js`, in and outside app mode. `tests/android-app-gate.test.js` checks with the real simple-git and git that the inherited git variables reach git only in app mode. |
| Validation | `npm run test:unit --prefix tests -- android-app-gate.test.js android-app-git-environment.test.js plugin-loader.test.js extensions-discover.test.js extensions-bundled-third-party.test.js server-admin-android-gate.test.js util.test.js`, `npx eslint` on the changed files. Not run in the Android app. |
| Rollback path | Remove the `getAndroidAppGitOptions` import and its use in each file: `simpleGit({ baseDir: serverDirectory })` in `src/util.js`, `git(pluginPath)` in `src/plugin-loader.js`, `Object.freeze({ timeout: { block: 5 * 60 * 1000 } })` in `src/endpoints/extensions.js` and `simpleGit()` in `src/git/client.js`. In the Android app, git then loses its exec path, CA bundle and identity again, so its fetches, clones and pulls over https fail there. No saved data changes. |
| Last reviewed | 2026-11-11 PR #918 Android APK. |
| Owner | Runtime and release integrator. |

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
