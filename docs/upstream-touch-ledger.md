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

### Extension row action overflow adapter
| Field | Value |
| --- | --- |
| File | `public/css/extensions-panel.css` |
| Area | Extensions manager row layout and action overflow. |
| Divergence reason | Upstream renders every extension action as an inline button, so rows with many actions crowd out the title on narrow screens. SillyBunny keeps the actions at the row end and moves the ones that do not fit into one overflow menu. |
| Target seam | `public/scripts/sillybunny-extension-actions.js`. |
| Adapter shape | Keep upstream action buttons and delegated handlers in the row; the owned adapter measures the row, hides crowded inline controls, and exposes their existing clicks through one shared action menu. |
| Protecting tests | `tests/extensions-row-actions.e2e.js`; `tests/extensions-discover.test.js`; `tests/extensions-disable.test.js`; `tests/extensions-bundled-third-party.test.js`. |
| Validation | 2026-10-24: root/tests lint, extension unit specs, `git diff --check`, and Chromium E2E at 1440×900 and 390×844. |
| Rollback path | Delete the marked rules in `public/css/extensions-panel.css` that keep actions trailing, limit title width and hide the transport buttons. Remove the `import './sillybunny-extension-actions.js'` line from `public/scripts/sillybunny-tabs.js`. The upstream buttons and handlers stay in each row, so no data changes. Then drop `tests/extensions-row-actions.e2e.js`. |
| Last reviewed | 2026-10-27, PR #870 (paths, markers and unit tests re-checked). |
| Owner | UI overhaul integrator. |

### Extensions manager Window adapter
| Field | Value |
| --- | --- |
| File | `public/scripts/extensions.js`; `public/css/extensions-panel.css` |
| Area | Extensions manager Window header, preference groups and extension rows. |
| Divergence reason | Upstream shows the Extensions manager as a full-screen popup with a sticky toolbar of loose buttons. SillyBunny shows it in the shared Window, with the toolbar actions in header menus and each extension as a preference row, so it scrolls and fits phones like every other pop-out. |
| Target seam | `public/scripts/sillybunny-editor/adapters/extensions-manager-dialog.js` and `public/css/sillybunny-extensions-manager.css`; shared Window frame, action menus and preference rows. |
| Adapter shape | Preserve the upstream update, sort, bulk-toggle, restore, extension-row and status handlers; move their existing controls into shared header menus and group suffixes without replacing source nodes. Load manager-only layout rules after the user opens the Window, and release row observers when the Window closes. |
| Protecting tests | `tests/window-tools-dialogs.e2e.js`; `tests/extensions-row-actions.e2e.js`; `tests/extensions-discover.test.js`; `tests/extensions-disable.test.js`; `tests/extensions-bundled-third-party.test.js`; `tests/utility-dialog-first-paint.e2e.js`. |
| Validation | Root/tests lint, frontend budget check, diff check, and Chromium E2E at 1440×900 and 390×844. |
| Rollback path | In `public/scripts/extensions.js`, remove the dynamic import of `extensions-manager-dialog.js`, the `adaptExtensionsManager()` call and the `tier: 'window'` and `size: 'fill'` options. Restore the `extensions_toolbar` block and the `sb-popup-fullscreen` class from `git show db00f583e:public/scripts/extensions.js`. Delete `sillybunny-extensions-manager.css`, the marked manager rules in `extensions-panel.css` and `extensions-manager-dialog.js`. Then drop the Extensions manager cases in `tests/window-tools-dialogs.e2e.js`. |
| Last reviewed | 2026-11-05, PR #870 (adapters reshape in `onBeforePaint`). |
| Owner | UI overhaul integrator. |

### Shared header icon-button markup
| Field | Value |
| --- | --- |
| File | `public/index.html` |
| Area | Character and group editor header controls. |
| Divergence reason | Upstream editor header controls carry their own hover and pressed styling, so they differ from the list and settings headers. SillyBunny adds one shared class so every visible header icon button looks and responds the same. |
| Target seam | `public/css/sillybunny-editor-shell.css`; shared header-icon-button class. |
| Adapter shape | Preserve existing IDs, handlers, transport nodes and icon geometry; add the shared state class to visible editor header controls. |
| Protecting tests | `tests/header-icon-button-parity.e2e.js`; `tests/character-list.e2e.js`; `tests/world-info-editor.e2e.js`. |
| Validation | 2026-10-24: root/tests lint, header parity E2E in both bundled themes, and `git diff --check`. |
| Rollback path | Remove the `sb-header-icon-button` class from the character and group editor header controls in `public/index.html`. Leave its rules in `public/css/sillybunny-editor-shell.css`, because list and settings headers use them too. IDs, handlers and icons do not change. Then drop `tests/header-icon-button-parity.e2e.js`. |
| Last reviewed | 2026-10-27, PR #870 (paths and markers re-checked). |
| Owner | UI overhaul integrator. |

### Dialog frame surface and layer adjustments
| Field | Value |
| --- | --- |
| File | `public/scripts/chats.js`; `public/scripts/extensions/regex/index.js`; `public/scripts/extensions/stable-diffusion/index.js`; `public/scripts/extensions/expressions/index.js`. |
| Area | View-surface document windows and Visual Novel sprite layering. |
| Divergence reason | A maximized text editor, the expanded Regex output and the ComfyUI workflow are documents, so their Window body needs the View surface instead of the form surface. Upstream gives Visual Novel sprites a bare layer index as z-index, which hides them behind the chat once the shared layer ladder exists. |
| Target seam | The `sb-document` surface check in `public/scripts/sillybunny-editor/popup-frame.js` and the `--sb-z-sprites` layer token in `public/css/sillybunny-theme.css`. |
| Adapter shape | Mark the maximized editor, the expanded Regex output and the ComfyUI workflow editor with `sb-document`; retain source controls and handlers. Put expression sprites on the sprite layer so they stay above chat and below zoomed avatars. |
| Protecting tests | `tests/sillybunny-dialog-tiers.e2e.js`; `tests/popup-scroll.e2e.js`; `tests/window-media-dialogs.e2e.js`; `tests/window-dialogs.e2e.js`; `tests/libadwaita-surface-layers-css.test.js`. |
| Validation | 2026-10-24: root and tests lint; full unit suite; dialog-tier, popup-scroll, side-panel-adapters, tag-manager, and swipe-picker Chromium E2E on port 4457. |
| Rollback path | Remove the `sb-document` class additions in `chats.js`, `regex/index.js` and `stable-diffusion/index.js`, so those windows use the default form surface. In `visualNovelUpdateLayers()` in `expressions/index.js`, put back `element.css('z-index', layerIndex)`. The layer token can stay in the theme. |
| Last reviewed | 2026-10-27, PR #870 (paths, markers and unit tests re-checked). |
| Owner | UI overhaul integrator. |

### Account windows and profile presentation
| Field | Value |
| --- | --- |
| File | `public/scripts/user.js`; `public/scripts/templates/userProfile.html`; `public/scripts/templates/admin.html`; `public/scripts/templates/snapshotsView.html`; `public/css/accounts.css`. |
| Area | Account profile, administrator user list and settings snapshots. |
| Divergence reason | Upstream shows the account profile, administrator panel and settings snapshots as loose popup markup with buttons in a row. SillyBunny shows the profile in a content-sized Dialog and the user and snapshot lists as shared Window rows, so the actions fit on phones and match the other windows. |
| Target seam | `public/scripts/sillybunny-editor/adapters/window-content-dialogs.js`; shared dialog frame, rows and action menu. |
| Adapter shape | Preserve source nodes, IDs, classes, request handlers and confirmation results; present profile properties in a content-sized Dialog, user and snapshot collections in shared Window rows, and expose existing administrator actions through the row overflow menu. |
| Protecting tests | `tests/unit/window-content-dialogs.test.js`; `tests/window-content-dialogs.e2e.js`; `tests/sillybunny-dialog-tiers.e2e.js`; `tests/popup-scroll.e2e.js`; `tests/window-dialogs.e2e.js`; `tests/utility-dialog-first-paint.e2e.js`. |
| Validation | 2026-10-25: focused unit and Chromium account-window E2E at 1440×900, 390×844 and 844×390. |
| Rollback path | In `public/scripts/user.js`, remove the `accountProfileOptions()`, `adminPanelOptions()` and `snapshotsOptions()` spreads and the `tier: 'window'` option that goes with them. Revert the marked hunks in `admin.html`, `snapshotsView.html` and `accounts.css`. In `userProfile.html`, revert only the layout changes and keep the removal of the two popup buttons that the Data & Security Export entry needs. Then drop the account cases in `tests/unit/window-content-dialogs.test.js` and `tests/window-content-dialogs.e2e.js`. |
| Last reviewed | 2026-11-05, PR #870 (adapters reshape in `onBeforePaint`). |
| Owner | UI overhaul integrator. |

### Swipe Selection Window
| Field | Value |
| --- | --- |
| File | `public/scripts/swipe-picker.js`. |
| Area | Swipe selection and swipe actions. |
| Divergence reason | Upstream builds its own header and restyles the close button inside the popup, which does not resize or scroll well on phones. SillyBunny hands the title, Close and mobile sheet to the shared Window, and confirms swipe deletion with the shared Cancel-first Alert. |
| Target seam | `public/scripts/sillybunny-editor/popup-frame.js`; shared destructive Alert in `public/scripts/sillybunny-editor/dialog.js`. |
| Adapter shape | Keep swipe data, IDs, selection, branch/copy/delete handlers, preview expansion, input bounds, and swipe result semantics; request the shared Window tier and use the shared Alert for the existing preference-gated delete confirmation. Give the cloned div controls and rows button roles and keyboard activation that run the same click paths. The footer, and the focus and selection of the index field, are set in `onBeforePaint`; `scrollToSelectedSwipe` stays in `onOpen`, because it reads rects that the opening animation scales. |
| Protecting tests | `tests/swipe-picker.e2e.js`; `tests/libadwaita-swipe-styling.test.js`; `tests/sillybunny-dialog-tiers.e2e.js`; `tests/popup-scroll.e2e.js`; `tests/sillybunny-overlays.e2e.js`; `tests/utility-dialog-first-paint.e2e.js`. |
| Validation | 2026-10-24: root/tests lint; full Jest (437 suites, 6,634 passed, 2 skipped); frontend budgets; diff check; Swipe Picker E2E at 1440×900 and 390×844 (2/2, including 52-row scrolling, current marker, copy, branch save interception, destructive Alert safety, Go navigation and Escape); AddSwipeNoReload + dialog tiers + Popup scroll + conversation message actions Chromium (27/27). |
| Rollback path | In `public/scripts/swipe-picker.js`, restore the in-body `Swipe Selection` header and the restyled close button, restore the original `okButton` value that shows Go only when `canJumpToSwipe` is true, and drop `tier`, `title` and `customButtons` from the `Popup` options. Put the `callGenericPopup()` delete confirmation back in place of `openAlert()` and remove the `openAlert` import. Remove the button roles and key handlers if keyboard support is dropped too. Then update `tests/swipe-picker.e2e.js` and `tests/libadwaita-swipe-styling.test.js`. |
| Last reviewed | 2026-11-05, PR #870 (adapters reshape in `onBeforePaint`). |
| Owner | UI overhaul integrator. |

### Confirm response labels
| Field | Value |
| --- | --- |
| File | `public/script.js`; `public/scripts/popup.js`; `public/scripts/PromptManager.js`; `public/scripts/backgrounds.js`; `public/scripts/chat-backups.js`; `public/scripts/chats.js`; `public/scripts/data-maid-dialog.js`; `public/scripts/extensions/regex/index.js`; `public/scripts/group-chats.js`; `public/scripts/preset-manager.js`; `public/scripts/reasoning.js`; `public/scripts/secrets.js`; `public/scripts/world-info.js`. |
| Area | Confirmation response labels and destructive confirmation defaults. |
| Divergence reason | Upstream confirmations use the generic OK button, and the default result is the affirmative one. SillyBunny names the affirmative response with the action's own verb and labels the default negative response Cancel, so each confirmation reads clearly and a destructive one does not default to the affirmative. |
| Target seam | `public/scripts/sillybunny-editor/popup-frame.js`. |
| Adapter shape | Keep upstream confirmation handlers and result values, name affirmative responses with existing action strings, and map the default negative response to Cancel in the shared frame. Destructive confirmations add `is-destructive` to `popup.okButton` in `onBeforePaint`, so OK is red from the first frame. |
| Protecting tests | `tests/unit/popup-contract.test.js`; `tests/unit/sillybunny-popup-frame.test.js`; `tests/world-info-editor.e2e.js`; `tests/sillybunny-dialog-tiers.e2e.js`; `tests/popup-scroll.e2e.js`; `tests/native-dialog-replacements.e2e.js`; `tests/character-list.e2e.js`; `tests/tag-manager.e2e.js`; `tests/destructive-first-paint.e2e.js`. |
| Validation | Root lint; tests lint; focused and full unit suites; frontend budgets; Chromium confirmation and dialog regressions. |
| Rollback path | In each listed file, remove the `okButton` verb strings and `defaultResult: POPUP_RESULT.NEGATIVE` options that sit under a `SillyBunny:` marker. In `public/scripts/popup.js`, remove the `cancelButtonProvided` argument passed to `framePopup()`. In `public/scripts/sillybunny-editor/popup-frame.js`, remove `replaceDefaultNegativeLabel()`. Then update `tests/unit/popup-contract.test.js` and `tests/unit/sillybunny-popup-frame.test.js`. |
| Last reviewed | 2026-11-05, PR #870 (destructive OK set in `onBeforePaint`). |
| Owner | UI overhaul integrator. |

### Native browser dialog replacements
| Field | Value |
| --- | --- |
| File | `public/scripts/openai.js`; `public/scripts/extensions/vectors/index.js`; `public/scripts/extensions/tts/speecht5.js`. |
| Area | Server config reload, vector index purge and SpeechT5 speaker deletion confirmations. |
| Divergence reason | Upstream calls the browser's native confirm box for these destructive actions. That box cannot be themed or focus Cancel, and Return can confirm it. SillyBunny awaits the shared Alert instead, which puts Cancel first and focuses it. |
| Target seam | `public/scripts/sillybunny-editor/dialog.js`. |
| Adapter shape | Keep the existing action handlers and messages; await `openAlert()` for confirmations, focus Cancel and avoid Return confirmation for destructive actions. |
| Protecting tests | `tests/unit/native-dialog-replacements.test.js`; `tests/unit/sillybunny-dialog.test.js`; `tests/unit/tts-voices-dialog.test.js`; `tests/native-dialog-replacements.e2e.js`; `tests/sillybunny-backend-settings.e2e.js`. |
| Validation | 2026-10-23: root lint, ESLint for changed test files, and `git diff --check` pass; the broader tests-package lint command remains blocked by existing errors in unrelated test files. Frontend budgets pass (16 blocking stylesheets / 1005.0 KiB; 24 startup scripts / 2025.0 KiB). Full Jest: 426 suites passed; 6,442 tests passed, 2 skipped; 1 snapshot passed. Chromium on port 4455: native-dialog replacements 4/4, Chat Archive 15/15, dialog tiers 18/18, Popup scroll 2/2, startup-on-demand 8/8, and backend settings 21/22. The remaining backend-settings failure is the existing unsaved-template discard assertion at line 729. Visually reviewed four desktop/mobile Alert captures in `/tmp/opencode/phase7-dialog-shots/`; message wrapping and action visibility are clear. |
| Rollback path | Replace each `await openAlert(...)` call under a `SillyBunny:` marker with the original native call: `confirm('Are you sure you want to delete this speaker?')` in `speecht5.js`, `confirm('Are you sure?')` in `vectors/index.js`, and `window.confirm(...)` for the server config reload in `openai.js`. Remove the `openAlert` imports. Then drop the matching cases in `tests/unit/native-dialog-replacements.test.js`, `tests/unit/tts-voices-dialog.test.js` and `tests/native-dialog-replacements.e2e.js`. |
| Last reviewed | 2026-10-27, PR #870 (paths, markers and unit tests re-checked). |
| Owner | UI overhaul integrator. |

### Chat History Window and saved-chat deletion
| Field | Value |
| --- | --- |
| File | `public/script.js`; `public/style.css`; `public/css/mobile-styles.css`; `public/css/popup-safari-fix.css`; `public/css/chat-backups.css`. |
| Area | Chat History and saved-chat deletion. |
| Divergence reason | Upstream shows Chat History as a legacy popup with a fixed mobile size and its own cleanup tray. SillyBunny moves the same nodes into the shared Window, so the list scrolls and the cleanup tools sit on their own page. Deleting a saved chat uses a Cancel-first destructive Alert. |
| Target seam | `public/scripts/sillybunny-chat-dialogs.js`; `public/scripts/sillybunny-editor/dialog.js`. |
| Adapter shape | Move existing Chat History nodes into the shared Window, adopt the existing cleanup controls as preference rows, proxy frame-search changes through the existing input handler, and restore every source node on close. Keep the wrapper's legacy display state observable while the frame owns the visible surface. Remove upstream mobile sizing that conflicts with the Window frame. Use a Cancel-first destructive Alert for `.PastChat_cross`. |
| Protecting tests | `tests/unit/sillybunny-chat-dialogs.test.js`; `tests/sillybunny-overlays.e2e.js`; `tests/mobile-shell-smoke.e2e.js`; `tests/mobile-character-toggle-and-panels.e2e.js`; `tests/sillybunny-dialog-tiers.e2e.js`; `tests/popup-scroll.e2e.js`; `tests/chat-backups.test.js`; `tests/chat-backup-sequence.test.js`; `tests/backups-hardening.test.js`. |
| Validation | Chat History cleanup and backup-page regression coverage, focused/full overlay E2E, mobile shell checks, chat-dialog unit tests, root/tests lint, `git diff --check`, and frontend budget validation. |
| Rollback path | In `public/script.js`, remove the `openChatHistoryDialog` import and call, and restore the upstream Chat History popup flow. In the `.PastChat_cross` handler, put the upstream `Popup` confirmation back in place of `openAlert()`. Restore the removed `#select_chat_popup` sizing in `public/css/mobile-styles.css` and `public/css/popup-safari-fix.css`. Delete the `#shadow_select_chat_popup.sb-chat-history-compat-open` rule in `public/style.css` and the marker comment in `public/css/chat-backups.css`. Then drop `tests/unit/sillybunny-chat-dialogs.test.js` and update `tests/sillybunny-overlays.e2e.js`. |
| Last reviewed | 2026-10-27, PR #870 (paths, markers and unit tests re-checked). |
| Owner | UI overhaul integrator. |

### Bulk Tag Editor Dialog
| Field | Value |
| --- | --- |
| File | `public/scripts/BulkEditOverlay.js`; `public/css/character-group-overlay.css`. |
| Area | Bulk character and group tag editing. |
| Divergence reason | Upstream appends the bulk tag editor to the page as a custom overlay with its own heading and close control. SillyBunny moves the same markup into the shared Dialog, so it gets the standard title, Close action and phone sheet, and the tag search input matches the other framed searches. |
| Target seam | `public/scripts/sillybunny-editor/dialog.js`. |
| Adapter shape | Parse the existing bulk-tag markup into a fragment, move its wrapper into a Dialog, use the frame title and Close action, and keep existing action controls and IDs in the content. Add the shared `sb-dialog__entry` class to the tag search input without changing its handlers. |
| Protecting tests | `tests/unit/bulk-edit-overlay.test.js`; `tests/sillybunny-overlays.e2e.js`; `tests/character-list.e2e.js`. |
| Validation | 2026-10-23: root lint, `git diff --check`, and frontend budgets pass (16 blocking stylesheets / 1005.4 KiB). Full Jest: 425 suites passed; 6,425 tests passed, 2 skipped; 1 snapshot passed. Chromium on port 4455: overlays, character-list, mobile-shell smoke, dialog tiers, and Popup scroll 103/103. Bulk tag add/remove persisted through intercepted settings saves; the surface screenshot pair was reviewed in `/tmp/opencode/dialogs-phase6-shots/`. |
| Rollback path | In `public/scripts/BulkEditOverlay.js`, restore `document.body.insertAdjacentHTML('beforeend', this.#getHtml())` in `show()` and the `document.body.removeChild()` call in `hide()`. Remove the `openDialog` import, the `#dialog` field and the `sb-dialog__entry` class. Revert the marked rules in `public/css/character-group-overlay.css`. Then update the bulk-tag cases in `tests/unit/bulk-edit-overlay.test.js`, `tests/sillybunny-overlays.e2e.js` and `tests/character-list.e2e.js`. |
| Last reviewed | 2026-10-27, PR #870 (paths, markers and unit tests re-checked). |
| Owner | UI overhaul integrator. |

### Side-panel engine and MovingUI seam
| Field | Value |
| --- | --- |
| File | `public/scripts/RossAscends-mods.js`; `public/scripts/power-user.js`. |
| Area | MovingUI and side-panel layout. |
| Divergence reason | Upstream MovingUI lets any floating panel be dragged anywhere, including over the chat. SillyBunny docks registered panels in the gaps beside the chat, so MovingUI must skip them and save only the side each panel sits on. |
| Target seam | `public/scripts/sillybunny-editor/side-panel.js`. |
| Adapter shape | Keep MovingUI calls compatible while guarding registered panel descendants; route their existing state entries through the side controller and persist only `{ left, right }`. Reset and MovingUI off restore declared defaults. |
| Protecting tests | `tests/unit/side-panel.test.js`; `tests/side-panel-engine.e2e.js`; `tests/mobile-shell-smoke.e2e.js`; `tests/sillybunny-dialog-tiers.e2e.js`; `tests/popup-scroll.e2e.js`. |
| Validation | 2026-10-23: root lint and `git diff --check` pass; frontend budgets pass at 16 blocking stylesheets / 1005.3 KiB and 24 startup scripts / 2030.3 KiB. Full Jest: 424 suites passed; 6,420 tests passed, 2 skipped; 1 snapshot passed. Chromium on port 4455: side-panel engine 9/9, MovingUI shell smoke 17/17, dialog tiers 18/18, and Popup scroll 2/2 passed (46/46). Desktop 1440×900 and phone 390×844 screenshots were visually reviewed in `/tmp/opencode/side-panel-engine-shots/`. |
| Rollback path | In `public/scripts/RossAscends-mods.js`, remove the three `.sb-side-panel` early returns in `dragElement()` and the `closeTopmostSidePanelOnEscape` call in the Escape handler. In `public/scripts/power-user.js`, remove the `side-panel.js` import, the `configureMovingUIState()` call, the `resetSidePanelSides()` call and the `applyMovingUIState()` guards. Panels then fall back to free dragging. Then drop `tests/unit/side-panel.test.js` and `tests/side-panel-engine.e2e.js`. |
| Last reviewed | 2026-10-27, PR #870 (paths, markers and unit tests re-checked). |
| Owner | UI overhaul integrator. |

### Side-panel adapters
| Field | Value |
| --- | --- |
| File | `public/scripts/authors-note.js`; `public/scripts/cfg-scale.js`; `public/scripts/logprobs.js`; `public/scripts/extensions/expressions/index.js`. |
| Area | Author's Note, CFG, and Token Probabilities presentation. |
| Divergence reason | Upstream shows Author's Note, CFG and Token Probabilities as free-floating panels that can cover the chat. SillyBunny docks them beside the chat, or in a bottom sheet on phones, so they stay usable while the chat stays readable. Visual Novel sprites follow the docked canvas width. |
| Target seam | `public/scripts/sillybunny-editor/adapters/side-panels.js`; `public/scripts/sillybunny-editor/side-panel.js`. |
| Adapter shape | Keep source inputs, IDs, names, values, events, and save handlers; adopt controls into preference rows, route existing triggers and Escape close targets through the dock controller, and keep the logprob token DOM and keyboard handlers intact. Recent Chats uses the same controller from `sillybunny-tabs.js`; Visual Novel sprites follow docked canvas geometry. |
| Protecting tests | `tests/unit/side-panel-adapters.test.js`; `tests/side-panel-adapters.e2e.js`; `tests/side-panel-engine.e2e.js`; `tests/mobile-shell-smoke.e2e.js`; `tests/authors-note-chat-metadata.test.js`. No other suite covers the docked CFG or Token Probabilities panels. |
| Validation | 2026-10-23: root lint, touched-test ESLint, and `git diff --check` pass. Frontend budgets pass at 16 blocking stylesheets / 1005.3 KiB and 24 startup scripts / 2030.3 KiB. Full Jest: 424 suites passed; 6,420 tests passed, 2 skipped; 1 snapshot passed. Chromium on port 4455: side-panel adapters 11/11; side-panel engine 9/9, MovingUI shell smoke 17/17, dialog tiers 18/18, and Popup scroll 2/2 (57/57 requested cases total). Refreshed and visually reviewed Author's Note and Recent Chats at 1440×900 and 390×844 in `/tmp/opencode/side-panel-shots-final/`; Recent Chats shows populated previews and its actual scroll list reaches the final fixture entry. |
| Rollback path | In `authors-note.js`, `cfg-scale.js` and `logprobs.js`, remove the `side-panels.js` imports and the `register...Panel()`, `toggle...Panel()` and `close...Panel()` calls, and restore the upstream show and hide code. In `expressions/index.js`, remove the `sb:side-panel-layout` listener. Then drop `tests/unit/side-panel-adapters.test.js` and `tests/side-panel-adapters.e2e.js`. |
| Last reviewed | 2026-10-27, PR #870 (paths, markers and unit tests re-checked). |
| Owner | UI overhaul integrator. |

### Window-tier tools
| Field | Value |
| --- | --- |
| File | `public/scripts/extensions/token-counter/index.js`; `public/scripts/extensions/token-counter/style.css`; `public/scripts/samplerSelect.js`; `public/scripts/power-user.js`; `public/scripts/data-maid-dialog.js`; `public/scripts/templates/dataMaidCategory.html`; `public/scripts/templates/dataMaidDialog.html`; `public/css/data-maid.css`. |
| Area | Token Counter, sampler visibility, Data Maid and viewer, Debug Menu. |
| Divergence reason | Upstream opens these tools as popups with loose checkboxes and buttons. SillyBunny presents them as Windows with shared rows, so long lists scroll, switches sit at the row end and destructive Data Maid actions default to Cancel. `data-maid-dialog.js` holds the Data Maid dialog code that was split out of upstream's `data-maid.js`, so upstream changes to that dialog must be ported there. |
| Target seam | `public/scripts/sillybunny-editor/adapters/window-tools-dialogs.js`; shared Popup frame and row factories. |
| Adapter shape | Keep Token Counter, sampler visibility, debug actions and Data Maid results on their existing sources of truth; adopt sampler checkboxes and delegated debug action nodes, set explicit Window tiers, and let the Popup frame push nested Window/Dialog pages. Data Maid retains its upstream drawer classes, IDs, action nodes and toggle event path while using shared boxed rows; its category toggle is named `Show or Hide Files` through `data-i18n` on `aria-label` and `title`; delete confirmations default to Cancel. The Extensions manager keeps its existing Window tier and row identities; its shared frame body owns scrolling. |
| Protecting tests | `tests/unit/window-tools-dialogs.test.js`; `tests/window-tools-dialogs.e2e.js` at 1440×900 and 390×844; `tests/sillybunny-dialog-tiers.e2e.js`; `tests/popup-scroll.e2e.js`; existing `tests/sillybunny-backend-settings.e2e.js` and `tests/startup-on-demand.e2e.js`. Destructive Data Maid and debug actions are intercepted and never executed. |
| Validation | 2026-10-22: `npm run lint`, test-file ESLint, and `git diff --check` pass. `npm run check:frontend-budgets` passes (16 blocking stylesheets / 1003.9 KiB; 24 startup scripts / 2029.3 KiB). From `tests/`, full Jest: 421 suites passed; 6,404 tests passed, 2 skipped; 1 snapshot passed. Chromium: new surface E2E + `sillybunny-dialog-tiers` + `popup-scroll` 30/30; the temporary screenshot suite 3/3; misc-form-dialogs + startup-on-demand + dialog tiers + Popup scroll 50/50; Data Maid and all remaining Chat Archive cases 14/14 when excluding its pre-existing close-target failure at line 246. Backend settings: 21/22 pass; its pre-existing unsaved-template discard alert failure at line 729 remains. Original archive run: the line 246 close target is 24px (expected ≥44px), 1 passed and 13 did not run; excluding that test yields 14/14. All destructive routes/actions are intercepted. Visually reviewed 29 desktop, phone, and landscape screenshots. |
| Rollback path | Remove the `tokenCounterOptions()` spread in `extensions/token-counter/index.js`, the `adaptSamplerSelectList()` call in `samplerSelect.js` and the `adaptDebugMenu()` call in `power-user.js`. In `data-maid-dialog.js`, the two Data Maid templates and `data-maid.css`, revert the marked hunks. Delete the Token Counter rules in `token-counter/style.css`. Then drop `tests/unit/window-tools-dialogs.test.js` and `tests/window-tools-dialogs.e2e.js`. |
| Last reviewed | 2026-10-27, PR #870 (paths, markers and unit tests re-checked). |
| Owner | UI overhaul integrator. |

### Window-tier account, override, editor and prompt adapters
| Field | Value |
| --- | --- |
| File | `public/scripts/user.js`; `public/script.js`; `public/scripts/chats.js`; `public/scripts/itemized-prompts.js`; `public/scripts/openai.js`; `public/scripts/secrets.js`. |
| Area | Settings Snapshots, Account Profile, Admin, character settings overrides, maximized editor and Creator's Notes, Prompt Itemization/raw prompt, Custom Endpoint parameters, exposed secrets viewer. |
| Divergence reason | Upstream shows these editors and viewers as plain popups that do not fit small screens. SillyBunny presents them in the shared Window with shared rows, so they scroll, fit phones and keep the on-screen keyboard clear of the text. |
| Target seam | `public/scripts/sillybunny-editor/adapters/window-content-dialogs.js`; shared Popup frame, rows and `bindKeyboardInset()`. |
| Adapter shape | Adopt existing profile/admin/snapshot/scenario/YAML controls into explicit Window content while preserving IDs and native attributes; pass Window tiers to expanded text and itemization surfaces; use the visual viewport inset already bound by the frame. Never execute snapshot restore or account writes in tests, and keep exposed secret fixtures out of logs, storage, screenshots and video. |
| Protecting tests | `tests/unit/window-content-dialogs.test.js`; `tests/window-content-dialogs.e2e.js` at 1440×900 and 390×844; `tests/expanded-editor-touch.e2e.js`; `tests/sillybunny-dialog-tiers.e2e.js`; `tests/popup-scroll.e2e.js`; existing `tests/misc-form-dialogs.e2e.js`, `tests/character-editor-rendering.e2e.js`, `tests/world-info-editor.e2e.js`, `tests/prompt-manager-characterization.e2e.js`, `tests/mobile-shell-smoke.e2e.js`, `tests/sillybunny-backend-settings.e2e.js`, `tests/sillybunny-connections-layout.e2e.js`, and `tests/window-dialogs.e2e.js`. |
| Validation | 2026-10-22: `npm run lint`, `git diff --check`, and `npm run check:frontend-budgets` pass (16 blocking stylesheets / 1005.3 KiB; 24 startup scripts / 2029.8 KiB). From `tests/`, full Jest: 422 suites passed; 6,409 tests passed, 2 skipped; 1 snapshot passed. Chromium on port 4455: `in-chat-agents-editor.e2e.js` 50/51 (only the known missing saved tracker fixture at line 204); `window-content-dialogs.e2e.js` 24/24; `expanded-editor-touch.e2e.js` 3/3; `sillybunny-dialog-tiers.e2e.js` 18/18; `popup-scroll.e2e.js` 2/2. Combined, 97 passed and 1 known failure. The four 159.75px regex textarea failures were caused by this phase's unscoped stacked-textarea rule; `8lh` is now limited to adapter-owned scenario/YAML rows, with the focused four-viewport regression passing 4/4. Earlier shell/Connections/Window regression batch: 78/78; focused in-chat editor checks: 2/2. Existing backend settings: 21/22, with the known unsaved-template alert assertion at line 729; Quick Edit fade check passes on isolated retry after restarting port 4455. Account, snapshot, settings and secret requests are intercepted; restore and user mutations are not confirmed. Secret suite screenshots and video are disabled. Seven non-secret screenshots were reviewed in `/tmp/opencode/window-content-shots/`. |
| Rollback path | Remove the `scenarioOverrideOptions()` spread in `script.js`, the `customEndpointParametersOptions()` spread in `openai.js`, and the `accountProfileOptions()`, `adminPanelOptions()` and `snapshotsOptions()` spreads in `user.js`. Remove the `tier: 'window'` options and titles under a `SillyBunny:` marker in `itemized-prompts.js`, `chats.js` and `secrets.js`. Then drop `tests/unit/window-content-dialogs.test.js` and `tests/window-content-dialogs.e2e.js`. |
| Last reviewed | 2026-10-27, PR #870 (paths, markers and unit tests re-checked). |
| Owner | UI overhaul integrator. |

### Window-tier media adapters
| Field | Value |
| --- | --- |
| File | `public/scripts/extensions/assets/index.js`; `public/scripts/extensions/assets/style.css`; `public/scripts/extensions/stable-diffusion/index.js`; `public/scripts/extensions/stable-diffusion/style.css`. |
| Area | Assets character browser and ComfyUI workflow editor. |
| Divergence reason | Upstream opens the asset browser and the ComfyUI workflow editor as popups sized for desktop. SillyBunny gives them explicit Window tiers, so their long content scrolls in the shared frame and fits phones. |
| Target seam | Shared Popup frame plus feature-local editor styles. |
| Adapter shape | Set explicit Window tiers without replacing source content or changing results; reuse the existing Characters title; constrain asset card titles within their cards; keep ComfyUI workflow saves on the existing route and retain the JSON textarea as the editor scroller. |
| Protecting tests | `tests/window-media-dialogs.e2e.js` at 1440×900, 390×844 and 844×390; `tests/sillybunny-dialog-tiers.e2e.js`; `tests/popup-scroll.e2e.js`; existing `tests/character-import.e2e.js`, `tests/utility-dialogs.e2e.js`, and `tests/mobile-shell-smoke.e2e.js`. Asset downloads and ComfyUI workflow reads/saves are intercepted. |
| Validation | 2026-10-22: `npm run lint`, test-file ESLint, `git diff --check`, and `npm run check:frontend-budgets` pass (16 blocking stylesheets / 1005.3 KiB; 24 startup scripts / 2029.8 KiB). Full Jest: 422 suites passed; 6,409 tests passed, 2 skipped; 1 snapshot passed. Chromium E2E: window media + Chat Archive + dialog tiers + Popup scroll 38/38; previously validated character import + utility dialogs 41/41 and mobile shell smoke 17/17. Assets install success and failure responses are intercepted and their UI states are checked; ComfyUI workflow routes are intercepted; Prompt Inspector response styling and save, discard and cancel-generation results are checked. Chat Archive's framed coarse-pointer close target is measured at 44px or larger in both media and archive suites. Screenshots at desktop, phone, and landscape sizes were visually reviewed in `/tmp/opencode/window-media-shots/`. |
| Rollback path | Remove the `tier: 'window'` and `title` options from the `callGenericPopup()` call in `assets/index.js` and the `Popup` call for the ComfyUI workflow editor in `stable-diffusion/index.js`. Delete the marked rules in `assets/style.css` and `stable-diffusion/style.css`. Then drop `tests/window-media-dialogs.e2e.js`. |
| Last reviewed | 2026-10-27, PR #870 (paths and markers re-checked). |
| Owner | UI overhaul integrator. |

### Quick Reply editor window
| Field | Value |
| --- | --- |
| File | `public/scripts/extensions/quick-reply/src/QuickReply.js`; `public/scripts/extensions/quick-reply/src/QuickReplySetLink.js`; `public/scripts/extensions/quick-reply/style.css`. |
| Area | Quick Reply editor, context-set rows, execution debugger and minimized debugger. |
| Divergence reason | Upstream lays the Quick Reply editor out for desktop only. SillyBunny shows it in the shared Window with shared rows, so it scrolls and fits phones, and the execution debugger stacks on narrow screens. |
| Target seam | `public/scripts/extensions/quick-reply/src/sillybunny-editor.js`; shared rows and `public/scripts/sillybunny-editor/popup-frame.js`. |
| Adapter shape | Keep the existing template, control identities, IDs, input/change/click listeners, live mutation/persistence, parser, debug controller, Popup callbacks and results. Pass Window/Quick Reply title options, use the shared select/switch/entry/spin rows for adopted controls, and let the existing Popup frame stack the icon picker. Feature CSS is loaded by Quick Reply's manifest, so QR-only layout and minimized-debugger rules stay in `style.css`; the earlier QR container-query workaround is gone from the global theme. |
| Protecting tests | `tests/unit/quick-reply-editor.test.js`; `tests/quick-reply-editor.e2e.js` at 1440×900, 390×844 and 844×390; `tests/utility-dialogs.e2e.js`; `tests/quick-reply-bar-layout.e2e.js`; `tests/mobile-shell-smoke.e2e.js`; `tests/sillybunny-dialog-tiers.e2e.js`; `tests/popup-scroll.e2e.js`. The editor suite verifies live/persisted fields, options, context selection, icon page, execute/error/debugger controls, Ctrl+Enter, F9, Ctrl+Backslash, scrolling, split/stack debugger widths and minimization. |
| Validation | 2026-10-22: HEAD characterization `tests/quick-reply-editor.e2e.js` 6/6 at 1440×900 and 390×844. Full Jest: 420 suites, 6,400 passed, 2 skipped, 1 snapshot passed. Root lint, test-file ESLint, and `git diff --check` pass; frontend budget passes at 16 blocking stylesheets / 1,002.9 KiB. Chromium: editor 16/16; requested editor + dialog tiers + Popup scroll + utility dialogs 62/62. Narrow debugger result width is asserted ≥90% of body at 390×844 and 844×390; desktop retains the side-by-side debugger split. Generation calls are intercepted; test slash commands use local fixtures. Refreshed 390/844 debug screenshots and 1440 desktop split were visually reviewed in `/tmp/opencode/quick-reply-layout-review/`. |
| Rollback path | Remove the `adaptQuickReplyEditor()` call and the Window and title options in `QuickReply.js`, and revert the marked hunks in `QuickReplySetLink.js`. Delete the marked rules in `quick-reply/style.css`. Then drop `tests/unit/quick-reply-editor.test.js` and `tests/quick-reply-editor.e2e.js`. |
| Last reviewed | 2026-10-27, PR #870 (paths, markers and unit tests re-checked). |
| Owner | UI overhaul integrator. |

### Window-tier Data Bank, Regex and API Keys adapters
| Field | Value |
| --- | --- |
| File | `public/scripts/chats.js`; `public/scripts/scrapers.js`; `public/scripts/secrets.js`; `public/scripts/extensions/regex/index.js`; `public/scripts/extensions/regex/debugger.css`; `public/scripts/extensions/regex/debugger.html`. |
| Area | Data Bank manager, attachment viewer/notepad, scraper notepad, Regex editor/debugger/expanded views and API Keys manager. |
| Divergence reason | Upstream opens the Data Bank, attachment and scraper notepads, the Regex editor and debugger, and the API Keys manager as desktop-sized popups. SillyBunny gives them explicit Window tiers and titles and lets nested pages stack in one frame, so each one scrolls, fits phones and keeps one Back path. |
| Target seam | `public/scripts/sillybunny-editor/popup-frame.js`; `public/scripts/sillybunny-editor/dialog.js`; feature-local shared frame CSS. |
| Adapter shape | Keep Popup content, IDs, listeners, drop target, result values and persistence unchanged; pass explicit Window tiers and titles, let nested Dialog/Window Popups use the existing page presentation, route expanded Regex navigation to the frame body, and preserve the debugger's internal result lists. Scope headings remain shared group headings outside each boxed sortable list, while every rule keeps its upstream identity and handlers. |
| Protecting tests | `tests/window-dialogs.e2e.js` with `tests/helpers/window-dialogs.js` exercises production Data Bank/viewer/notepad/scraper, Regex editor/debugger/expanded views, and API Keys manager/Add/Rename surfaces at 1440×900 and 390×844. Regression suites: `tests/sillybunny-dialog-tiers.e2e.js`, `tests/popup-scroll.e2e.js`, `tests/utility-dialogs.e2e.js`; unit contracts: `tests/unit/popup-contract.test.js`, `tests/unit/sillybunny-popup-frame.test.js`, `tests/secrets.test.js`, `tests/secret-inputs.test.js`. |
| Validation | 2026-10-22: `npm run lint` and `git diff --check` pass. `npm run check:frontend-budgets` passes (16 blocking stylesheets, 1003.8 KiB; 24 startup scripts, 2029.3 KiB). From `tests/`, `npm run test:unit -- --runInBand`: 419 suites pass; 6,392 tests pass, 2 skipped; 1 snapshot passes. Chromium `npx playwright test <suite>.e2e.js --browser=chromium --workers=2`: `window-dialogs` 12 pass; `sillybunny-dialog-tiers` 18 pass; `popup-scroll` 2 pass; `utility-dialogs` 26 pass. File uploads/deletes, settings saves and every secrets endpoint are intercepted in the Window suite; assertions cover decoded upload payloads, actual scraper File returns, saved Regex settings, transient DOM/console secret leaks, parent identity, result equality and the shared frame scroller. `PHASE4_SCREENSHOTS=/tmp/opencode/phase4a-shots` captures 22 screenshots (11 desktop/phone pairs), visually reviewed. |
| Related validation | With `SILLYBUNNY_TEST_BASE_URL=http://127.0.0.1:4455`, `npx playwright test <suite>.e2e.js --browser=chromium --workers=2 --grep-invert 'in firefox\|in webkit'`: `tests/sillybunny-connections-layout.e2e.js` 49 pass; `tests/sillybunny-editor-rows-layout.e2e.js` 11 pass; `tests/sillybunny-debugger.e2e.js` 11 pass; `tests/in-chat-agents-editor.e2e.js` 50 pass, 1 fails its explicit saved-tracker prerequisite at line 204 (the isolated server has no saved tracker). A single-test rerun with `--workers=1 --grep 'real saved long tracker'` reproduces that prerequisite failure; no saved agents or unrelated tests are changed to mask it. |
| Coverage notes | Transactional attachment/scraper notepads keep the existing Cancel/Save header; Cancel and Escape return without saving. Viewer and expanded Regex pages exercise literal Back and Escape. The expanded Steps last-link test exposed a jQuery/DOM mismatch; unwrap `.closest('.popup-content')` with `.get(0)` before native `scrollTo`. Mobile screenshots retain the existing narrow Data Bank name wrapping and expanded Steps metric clipping; no layout redesign is claimed. |
| Rollback path | Remove the `tier: 'window'` and `title` options at the marked `callGenericPopup()` and `Popup` calls in `chats.js`, `scrapers.js`, `secrets.js` and `regex/index.js`. Revert the marked hunks in `regex/debugger.css` and `regex/debugger.html`. Then drop `tests/window-dialogs.e2e.js` and `tests/helpers/window-dialogs.js`. |
| Last reviewed | 2026-10-27, PR #870 (paths, markers and unit tests re-checked). |
| Owner | UI overhaul integrator. |

### Dialog action rows
| Field | Value |
| --- | --- |
| File | `public/scripts/personas.js`; `public/scripts/tags.js`; `public/scripts/slash-commands.js`; `public/scripts/extensions/tts/index.js`. |
| Area | Persona and tag actions, slash-command buttons and TTS voice previews. |
| Divergence reason | Upstream shows persona choices, tag actions, `/buttons` results and TTS voice previews as Alerts full of loose buttons. SillyBunny puts them in the Dialog tier as shared action rows, so long lists scroll and the actions line up. |
| Target seam | Shared Popup frame and `public/scripts/sillybunny-editor/rows.js`. |
| Adapter shape | Keep persona/tag data, slash-command result mapping and TTS preview IDs/audio unchanged; adopt only the presentation, give the voice list an explicit `Available voices` Dialog title, and pass explicit Dialog/destructive options. |
| Protecting tests | `tests/tag-manager.e2e.js`; `tests/persona-editor.e2e.js`; `tests/sillybunny-dialog-tiers.e2e.js`; `tests/unit/tts-voices-dialog.test.js`; `tests/unit/sillybunny-editor-rows.test.js`. No test covers the `/buttons` slash command Dialog. |
| Validation | Root lint; focused and full Jest; diff check; frontend budgets; Chromium desktop/phone dialog screenshots. |
| Rollback path | Remove the `tier`, `title` and destructive options under a `SillyBunny:` marker in `personas.js`, `tags.js`, `slash-commands.js` and `tts/index.js`. These popups then return to their default Alert presentation. Then drop `tests/unit/tts-voices-dialog.test.js`. |
| Last reviewed | 2026-10-27, PR #870 (paths, markers and unit tests re-checked). |
| Owner | UI overhaul integrator. |

### Tag Manager deletion alert and member callbacks
| Field | Value |
| --- | --- |
| File | `public/scripts/tags.js` |
| Area | Tag Manager destructive deletion confirmation and member page data. |
| Divergence reason | Upstream confirms tag deletion with a generic Popup where Return can confirm. SillyBunny uses the shared destructive Alert with Cancel focused and keeps the merge-target control inside it. The Tag Manager also needs avatar and member callbacks from this file for its member pages. |
| Target seam | `public/scripts/sillybunny-editor/dialog.js` (`openAlert`); `public/scripts/sillybunny-tag-manager.js`. |
| Adapter shape | Preserve the existing tag reference merge control and deletion persistence; replace only the confirmation surface and response IDs. Pass avatar getters and add/remove member callbacks to `openTagManager()`, which call the existing tag functions. |
| Protecting tests | `tests/tag-manager.e2e.js`; `tests/unit/sillybunny-dialog.test.js`. |
| Validation | Root lint; tests lint; focused and full unit tests; tag-manager Chromium E2E at desktop and phone widths. |
| Rollback path | In `public/scripts/tags.js`, replace the `openAlert()` call in the tag-deletion handler with `callGenericPopup(popupContent, POPUP_TYPE.CONFIRM)` and the `POPUP_RESULT.AFFIRMATIVE` check, and remove the `openAlert` import. Remove `getAvatar`, `getGroupAvatar`, `addMember` and `removeMember` from the `openTagManager()` call, and the two imports they need. The merge control and deletion code stay as they are. Then update the delete case in `tests/tag-manager.e2e.js`. |
| Last reviewed | 2026-10-27, PR #870 (paths, markers and unit tests re-checked). |
| Owner | UI overhaul integrator. |

### Utility dialogs - shared content rows
| Field | Value |
| --- | --- |
| File | `public/scripts/welcome-screen.js`; `public/scripts/personas.js`; `public/scripts/secrets.js`; `public/scripts/scrapers.js`; `public/scripts/utils.js`; `public/scripts/extensions/regex/index.js`; `public/scripts/extensions/quick-reply/src/QuickReplySet.js`; `public/scripts/extensions/quick-reply/style.css`; `public/scripts/extensions/stable-diffusion/index.js`. Templates remain unchanged. |
| Area | Recent Chats settings, persona creation, Add Secret, regex import target, Quick Reply transfer/copy, image prompt review, web/wiki/transcript scrapers, icon picker. |
| Divergence reason | Upstream builds these small forms as popups with loose labels, checkboxes and numeric inputs that overflow on phones. SillyBunny adopts the same inputs into shared rows, so each form scrolls in one body and keeps its IDs, values and validation. |
| Target seam | `public/scripts/sillybunny-editor/adapters/utility-dialogs.js`; shared rows, toggle-row, select-row and Popup frame. |
| Adapter shape | Keep source control identities, IDs/names/values, native handlers, Popup mainInput/inputResults and upstream validation. Adopt numeric inputs without adding normalization. Copy uses an existing custom response appended after the main response so Transfer remains the default; forward select-trigger shortcuts. Load the transfer adapter lazily to keep the set model free of UI-only imports. Icon search stays in the body because Popup has no search option; icon buttons gain keyboard activation and share the body scroller. Add Secret retains Popup's source textarea (upstream has neither a password input nor autocomplete-off). Preserve YouTube's existing post-close language-listener timing. The adapters reshape the Popup in `onBeforePaint`, so the first frame already shows the rows. |
| Protecting tests | `tests/unit/utility-dialogs.test.js`; `tests/utility-dialogs.e2e.js`; full Jest; dialog-tier, popup-scroll, misc-form-dialogs, persona-editor, character-list, welcome-starter-pack-actions and quick-reply-bar-layout E2E; `tests/utility-dialog-first-paint.e2e.js`. |
| Validation | Root lint; full Jest; diff check; frontend budgets; Chromium desktop/mobile E2E with intercepted settings, secret, avatar, Quick Reply, scraper and image routes. Utility E2E blocks service workers so request interception also covers extension modules. |
| Rollback path | Remove the `utilityFormOptions()`, `regexImportOptions()`, `quickReplyTransferOptions()`, `scraperDialogOptions()` and `iconPickerOptions()` spreads and their `onClose` calls in the listed files. Delete the marked rules in `quick-reply/style.css`. Then drop `tests/unit/utility-dialogs.test.js` and `tests/utility-dialogs.e2e.js`. |
| Last reviewed | 2026-11-05, PR #870 (adapters reshape in `onBeforePaint`). |
| Owner | UI overhaul integrator. |

### Miscellaneous form dialogs - shared content rows
| Field | Value |
| --- | --- |
| File | `public/scripts/chats.js`; `public/scripts/power-user.js`; `public/script.js`; `public/scripts/extensions.js`; `public/scripts/user.js`. Templates remain unchanged. |
| Area | Creator Notes CSS scope, external media, AI Custom CSS, message screenshot range, extension install/branch selection, account forms. |
| Divergence reason | Upstream builds the Creator Notes CSS choice, external media, AI Custom CSS, message screenshot, extension install and account forms as popups with raw radios and inputs. SillyBunny adopts the same controls into shared rows, so they fit phones and scroll in one body while keeping their IDs, values and native events. |
| Target seam | `public/scripts/sillybunny-editor/adapters/misc-dialogs.js`; shared rows, toggle-row, select-row and Popup frame. |
| Adapter shape | Preserve source inputs, native events, IDs/names/values, password types and autocomplete. Adopt radio inputs rather than mirror them. Move Popup-owned URL/branch and screenshot inputs into the scrolling body; retain mainInput and inputResults. Screenshot rows retain text input/parseInt semantics without new clamping. Dispose select observers while retaining source selects for post-close reads. Reset and delete affirmatives default to Cancel. The screenshot caller in `script.js` composes the adapter's `onBeforePaint` with its own focus and selection of the start field. |
| Protecting tests | `tests/unit/misc-dialogs.test.js`; `tests/misc-form-dialogs.e2e.js`; existing row/Popup contract, message-screenshot, dialog-tier, popup-scroll, preset/lorebook and Connection Manager suites; `tests/utility-dialog-first-paint.e2e.js`. |
| Validation | Root lint; full Jest; frontend budgets; Chromium E2E at 1440×900 and 390×844 with intercepted settings, extension and account writes. |
| Rollback path | Remove the `creatorStylesPreferenceOptions()`, `externalMediaOptions()`, `customCssAiOptions()`, `messageScreenshotOptions()`, `installExtensionOptions()`, `switchBranchOptions()` and `accountFormOptions()` spreads in `chats.js`, `power-user.js`, `script.js`, `extensions.js` and `user.js`. Remove the Cancel defaults on the reset and delete confirmations. Then drop `tests/unit/misc-dialogs.test.js` and `tests/misc-form-dialogs.e2e.js`. |
| Last reviewed | 2026-11-05, PR #870 (adapters reshape in `onBeforePaint`). |
| Owner | UI overhaul integrator. |

### Preset and lorebook dialogs - shared content rows
| Field | Value |
| --- | --- |
| File | `public/scripts/preset-manager.js`; `public/scripts/world-info.js`; `public/scripts/personas.js`; `public/script.js`. Templates and `index.html` remain unchanged. |
| Area | Master settings import/export, preset deletion, embedded lorebook batch import, sorting, character/persona/chat lorebook assignment. |
| Divergence reason | Upstream shows preset import, export and deletion choices, lorebook sorting and lorebook assignment as popups with raw checkboxes and selects. SillyBunny builds shared rows from the same controls, with Select All only for long lists, so they fit phones while writes and persistence stay upstream. |
| Target seam | `public/scripts/sillybunny-editor/adapters/preset-lorebook-dialogs.js`; shared row, select-row and Popup-frame modules. |
| Adapter shape | Prepare native choices before Popup construction; show Select All only above five candidates and exclude it from preset results. Move custom sorting inputs into the content in `onBeforePaint` without changing inputResults; nullable spin rows preserve empty values while retaining default numeric clamping. Mirror existing lorebook selects, reuse the auxiliary Select2 placeholder and hide only its picker sentinel, retain desktop Select2 initialization, release observers/IDs onClose. Keep section writes, sorting, imports and assignment persistence upstream. Final preset deletion also defaults to Cancel. The character lorebook dialog in `script.js` still sets up Select2 in `onOpen`: the shared select row hides the Select2 container, so the late setup changes nothing visible. |
| Protecting tests | `tests/unit/preset-lorebook-dialogs.test.js`; `tests/unit/sillybunny-editor-rows.test.js`; `tests/unit/popup-contract.test.js`; `tests/preset-lorebook-dialogs.e2e.js`; WorldInfoSorting, world-info-editor, persona-editor, sillybunny-preset-autosave, character-list, sillybunny-dialog-tiers and popup-scroll E2E; `tests/utility-dialog-first-paint.e2e.js`. |
| Validation | Root lint; full Jest; frontend budgets; Chromium E2E at 1440×900 and 390×844 with intercepted writes. |
| Rollback path | Remove the `presetChoicesOptions()` spread in `preset-manager.js`, the `embeddedLorebookOptions()` and `lorebookSortingOptions()` calls in `world-info.js`, and the `lorebookSelectOptions()` calls in `script.js`, `personas.js` and `world-info.js`. Remove the Cancel default on the final preset deletion. Then drop `tests/unit/preset-lorebook-dialogs.test.js` and `tests/preset-lorebook-dialogs.e2e.js`. |
| Last reviewed | 2026-11-05, PR #870 (adapters reshape in `onBeforePaint`). |
| Owner | UI overhaul integrator. |

### `public/scripts/extensions/connection-manager/index.js` and `style.css` - profile dialog rows
| Field | Value |
| --- | --- |
| File | `public/scripts/extensions/connection-manager/index.js`; `public/scripts/extensions/connection-manager/style.css`. Templates remain unchanged. |
| Area | Connection profile forms, deletion selection, folders, and details. |
| Divergence reason | Upstream shows Connection Profile creation, deletion, folder and detail popups with raw checkboxes and lists that overflow on phones. SillyBunny builds shared rows from the same template nodes, so they scroll and fit phones, and final deletions default to Cancel. |
| Target seam | `public/scripts/extensions/connection-manager/sillybunny-dialogs.js`; shared row and Popup-frame modules. |
| Adapter shape | Prepare template rows before Popup construction; forward tier/title/defaultResult and lifecycle options. Final destructive confirmations default to Cancel and mark the affirmative destructive in `onBeforePaint`. Save and Update keeps its result/action as a neutral footer response. Keep exclusion events, folder-item ancestry, profile saving, and results upstream. Release row IDs on refresh/close. Extension CSS only scopes adapter content. |
| Protecting tests | `tests/unit/connection-manager-dialogs.test.js`; `tests/unit/sillybunny-editor-rows.test.js`; `tests/connection-manager-dialogs.e2e.js`; connection-profile-change-notice, sillybunny-connections-layout, popup-scroll, and sillybunny-dialog-tiers E2E; `tests/utility-dialog-first-paint.e2e.js`; `tests/destructive-first-paint.e2e.js`. |
| Validation | Root lint; full Jest; frontend budgets; Chromium E2E at desktop, portrait, and landscape sizes. |
| Rollback path | In `index.js`, remove the imports and calls of `profileDialogOptions()`, `adaptProfileDeletion()`, `adaptProfileFolders()` and `adaptProfileDetails()`, and the tier, title and `defaultResult` options that go with them. Delete the marked rules in `style.css`. Saved profiles are not touched. Then drop `tests/unit/connection-manager-dialogs.test.js` and `tests/connection-manager-dialogs.e2e.js`. |
| Last reviewed | 2026-11-05, PR #870 (adapters reshape in `onBeforePaint`). |
| Owner | UI overhaul integrator. |

### `public/scripts/popup.js` and `public/css/popup.css` - shared dialog frame hook
| Field | Value |
| --- | --- |
| File | `public/scripts/popup.js`; `public/css/popup.css` (cascade overrides only; this work leaves it unchanged); `public/css/popup-safari-fix.css` (only the Chat History height rules; see the Chat History entry). |
| Area | Popup lifecycle and dialog presentation. |
| Divergence reason | Upstream Popup clips its content with fixed heights and hidden overflow, so long dialogs cannot scroll, and every popup has the same size and look. SillyBunny frames each Popup as an Alert, Dialog or Window through one small hook, with a single scrolling body and a sheet on phones, while the Popup API and results stay the same. |
| Target seam | `public/scripts/sillybunny-editor/popup-frame.js`; `public/scripts/sillybunny-editor/dialog.js`; tier CSS in `public/css/sillybunny-theme.css`. |
| Adapter shape | `popup.js` imports `framePopup`, forwards optional `tier`/`title`/`size`, calls `opened()` after `showModal()`, `closing()` when hiding, and `dispose()` after removal. All response buttons remain descendants of `buttonControls`; custom responses use a measured footer wrapper inside it and do not grow to fill it. Cascade overrides correct upstream sizing and hidden overflow, including Safari. Window framing locks content-sized height after first layout and uses one fill opt-in for list-heavy and editor surfaces. A framed Dialog or Window opened over another framed surface becomes a page with Back and Close. `framePopup` registers each frame as a level in `public/scripts/sillybunny-editor/page-chain.js`, so Close walks the chain one level at a time. It wraps `complete` on the Popup instance, not in `popup.js`, so a chain Close can wait for a completion that is already running. `popup.js` also forwards `onBeforePaint`. `opened()` calls it last, in the same task as `showModal()`, through `runBeforePaint()`, which logs a throw so the dialog still opens and finishes the CSS transitions the handler started. `onOpen` keeps its upstream timing, after the opening animation. |
| Protecting tests | `tests/unit/popup-contract.test.js`, `tests/unit/sillybunny-popup-frame.test.js`, `tests/unit/sillybunny-dialog.test.js`, `tests/unit/sillybunny-page-chain.test.js`, `tests/popup-scroll.e2e.js`, `tests/sillybunny-dialog-frame.e2e.js` (including `page chains`), `tests/window-dialogs.e2e.js`, and the popup-touching dialog suites; `tests/utility-dialog-first-paint.e2e.js` (every frame from the first, motion on, 1440×900 and 390×844, also in the WebKit config). |
| Validation | `npm run lint`; focused Jest suites for Popup contract/frame/dialog/rows and Tag/Folder Managers; `popup-scroll`, dialog-frame, Tag Manager and Folder Manager Chromium E2E; frontend budget check. WebKit is unavailable on this host because Playwright's system dependencies are missing. 2026-10-27 (`4ef8c438b`, page chains): the full Jest suite had 448 suites and 6,807 tests passed; 239/239 Chromium E2E passed across the dialog, Window, tier, scroll, overlay, Tag Manager, Folder Manager and Chat Archive suites. `popup.js` is unchanged. 2026-11-05 (`onBeforePaint`): two review rounds; the first-paint spec failed on the old sources (21 of 21, then 16 of 16 with only the newer adapters reverted) and passes 39 of 39 in Chromium and in the WebKit container; the affected dialog specs pass in Chromium on two shards; full unit, lint and frontend budgets pass. |
| Rollback path | In `public/scripts/popup.js`, remove the `framePopup` import, the `tier`, `title` and `size` options with their typedef lines, the `this.sbFrame = framePopup(...)` call, and the `opened()`, `closing()` and `dispose()` calls. Popups then use the upstream layout, and callers that still pass `tier` or `title` have those options ignored. Delete `popup-frame.js` and `page-chain.js` only after every adapter that uses them is removed. Then drop `tests/unit/sillybunny-popup-frame.test.js` and `tests/sillybunny-dialog-frame.e2e.js`, and update `tests/unit/popup-contract.test.js`. |
| Last reviewed | 2026-11-05, PR #870 (adapters reshape in `onBeforePaint`). |
| Owner | UI overhaul integrator. |

### `public/script.js` and `public/scripts/user.js` - destructive Popup defaults
| Field | Value |
| --- | --- |
| File | `public/script.js`; `public/scripts/user.js`. |
| Area | Character and user deletion confirmations. |
| Divergence reason | Upstream confirms character and user deletion with the affirmative response as the default. SillyBunny makes Cancel the default result and marks the delete button as destructive, so a stray Return cannot delete. |
| Target seam | `public/scripts/sillybunny-editor/popup-frame.js`. |
| Adapter shape | Pass the negative defaultResult and add `is-destructive` to `okButton` in `onBeforePaint`. |
| Protecting tests | `tests/unit/popup-contract.test.js`; `tests/unit/sillybunny-popup-frame.test.js`; `tests/sillybunny-dialog-tiers.e2e.js`; `tests/destructive-first-paint.e2e.js`. |
| Validation | Root lint; full Jest suite; Chromium dialog-tier and mobile template checks. |
| Rollback path | Remove the `defaultResult: POPUP_RESULT.NEGATIVE` option and the `onBeforePaint` callback that adds `is-destructive` from the marked confirmations in `public/script.js` and `public/scripts/user.js`. Then update the destructive-default cases in `tests/sillybunny-dialog-tiers.e2e.js` and `tests/unit/popup-contract.test.js`. |
| Last reviewed | 2026-11-05, PR #870 (destructive OK set in `onBeforePaint`). |
| Owner | UI overhaul integrator. |

### `public/script.js`, `public/scripts/RossAscends-mods.js` and `public/style.css` - chat render lifecycle
| Field | Value |
| --- | --- |
| Area | Chat lifecycle. |
| Divergence reason | SillyBunny adds mobile batching, bottom pinning, manual-scroll suppression, long-chat anchoring, streaming DOM throttles, issue `#167` scroll stability behavior, and issue `#911` off-screen message skipping (`content-visibility` on laid-out history in `public/style.css`, plus swipe refreshes that only touch buttons whose display changes). |
| Target seam | `public/scripts/chat-render-lifecycle/`.; `public/scripts/sillybunny-home/greeting-art-opening.js` (`shouldHoldChatAtTop`) for the greeting picture's opening hold |
| Adapter shape | Keep exported compatibility functions in `public/script.js`; delegate initial-load bottom landing, bottom-scroll decisions, scheduling, scroll intent/state, anchor preservation, replacement/media anchoring, off-screen message tracking, and update batching to the lifecycle module. `scrollChatElementToBottom` returns early while `shouldHoldChatAtTop()` holds a freshly opened, greeting-only Reisen or Tewi chat at its top, so the greeting picture and name row are in view on open; the hold is not skipped for `force`, because a chat load's own pins are forced. The resize compensation in `RossAscends-mods.js` skips while held, so a banner that shrinks the chat cannot push it off the top. The hold ends on a second message, user scroll input, a native scroll away from the top, or 3 s (longer than the load lock at `script.js` 2400 + 250 ms). |
| Protecting tests | `tests/chat-scroll-edges.test.js`, `tests/mobile-streaming.test.js`, `tests/chat-render-lifecycle-index.test.js`, `tests/chat-render-lifecycle-bottom-scroll.test.js`, `tests/chat-render-lifecycle-rollout-guard.test.js`, `tests/chat-render-lifecycle-anchor.test.js`, `tests/chat-render-lifecycle-scheduler.test.js`, `tests/chat-render-lifecycle-scroll-intent.test.js`, `tests/chat-render-lifecycle-scroll-state.test.js`, `tests/chat-render-lifecycle-offscreen-messages.test.js`, `tests/chat-render-lifecycle-script-wiring.test.js`, `tests/chat-scroll-state-machine.e2e.js`, `tests/chat-send-scroll.e2e.js`, `tests/chat-scroll-regressions.e2e.js`, future lifecycle unit tests.; `tests/unit/sillybunny-greeting-art-opening.test.js` (the predicate, every release path, the per-opening refusal, wiring checks that the sink and the resize compensation are guarded and not skipped for `force`, and the hold outlasting the load lock), `tests/greeting-art.e2e.js` (Start New Chat and Temporary Chat open at the top with no frame painted elsewhere; sending, Go to bottom by mouse and keyboard, wheel and PageDown end the hold) |
| Validation | 2026-11-03 (greeting picture opening hold): unit 87 greeting-picture tests, full unit 8,799 (one environment-only failure); e2e `--workers=1` `greeting-art` 47, `chat-scroll-regressions` 14, `chat-send-scroll` 1, `chat-scroll-state-machine` 1, `temporary-chat` 76, `home-assistants` 130, `home-mode-memory` 36; `check:frontend-budgets`. Earlier: `node --check public/script.js`, focused lifecycle Jest `chat-render-lifecycle-scroll-state.test.js chat-render-lifecycle-script-wiring.test.js`, `npm run check:frontend-budgets`, plus prior lifecycle lint/unit/e2e packs on this stack. |
| Rollback path | Disable affected lifecycle routes with the permanent device-local kill switch while correcting the routed implementation. |
| Last reviewed | 2026-11-03, PR #870 greeting picture opening hold. |
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

### `public/script.js`, `public/scripts/openai.js`, `public/scripts/textgen-settings.js`, `public/scripts/kai-settings.js`, `public/scripts/nai-settings.js`, `public/scripts/horde.js`, `public/scripts/custom-request.js`, `src/util.js`, and `src/endpoints/backends/chat-completions.js` - provider request errors
| Field | Value |
| --- | --- |
| File | `public/script.js`, `public/scripts/openai.js`, `public/scripts/textgen-settings.js`, `public/scripts/kai-settings.js`, `public/scripts/nai-settings.js`, `public/scripts/horde.js`, `public/scripts/custom-request.js`, `src/util.js`, `src/endpoints/backends/chat-completions.js`. |
| Area | Generation lifecycle: failed provider requests. |
| Divergence reason | TODO(copy) |
| Target seam | `public/scripts/sillybunny-request-errors.js` (the error toast: the provider's own message, plus a hint for 401/403, 404, 429 and 5xx) and `public/scripts/sillybunny-provider-message.js` (finds the provider's sentence in a response body; the server imports it too). |
| Adapter shape | Browser: one import and a `showRequestError(...)` or `createFailedResponseError(...)` call at each failed-response site (`onError` and the error branch of `Generate` in `public/script.js`; the failure paths of `openai.js`, `textgen-settings.js`, `kai-settings.js`, `nai-settings.js`, `horde.js` and `custom-request.js`); `tryParseStreamingError` in `openai.js` returns a boolean. Server: `forwardFetchResponse` in `src/util.js` sends the provider's status in `X-Upstream-Status` when it maps a 401 to 400; `chat-completions.js` puts the provider's message, at most 300 characters, in non-streaming error bodies. |
| Protecting tests | `tests/sillybunny-request-errors.test.js`, `tests/sillybunny-request-error-sites.test.js`, `tests/util.test.js`, `tests/nai-settings.test.js`, `tests/sillybunny-conversation-core-generation-regressions.test.js`, `tests/request-errors.e2e.js`. |
| Validation | `npm run lint`; the focused unit tests and the full unit suite with `--maxWorkers=3`; `npm run check:frontend-budgets`; `request-errors.e2e.js` 10/10 on a Bun server; code review 2026-11-04. |
| Rollback path | TODO(copy) |
| Last reviewed | 2026-11-04, `feat/home-mascot-overhaul` (#870). |
| Owner | TODO(copy) |

### `public/script.js` and `public/scripts/openai.js` - Send and Connect feedback without a connection
| Field | Value |
| --- | --- |
| File | `public/script.js`, `public/scripts/openai.js`. |
| Area | Generation lifecycle and API connection: Send with no connection, Connect with an empty key. |
| Divergence reason | TODO(copy) |
| Target seam | `public/scripts/sillybunny-connection-notices.js` (`notifyNotConnected`, `flagMissingKey`). |
| Adapter shape | `public/script.js`: one import; `sendTextareaMessage` returns before any chat change when `online_status` is `no_connection` or not yet known and the draft is not a slash command, and calls `notifyNotConnected()`; the Send button handler calls it where it already refused offline activation. Upstream behaviour change: Enter with no connection no longer posts the user's message without a reply. `public/scripts/openai.js`: `onConnectButtonClick` calls `flagMissingKey(...)` for a user's press (`e.originalEvent` present) when the key field is empty. |
| Protecting tests | `tests/sillybunny-connection-notices.test.js`, `tests/connection-notices.e2e.js`, `tests/roleplay-composer-visibility.e2e.js`, `tests/conversation-composer-connection.e2e.js`, `tests/sillybunny-conversation-core-roleplay-queue.test.js`. |
| Validation | `npm run lint`; the focused unit tests; `npm run check:frontend-budgets`; the four e2e specs on a Bun server; code review 2026-11-04. |
| Rollback path | TODO(copy) |
| Last reviewed | 2026-11-04, `feat/home-mascot-overhaul` (#870). |
| Owner | TODO(copy) |

### `public/script.js`, `public/scripts/group-chats.js`, `public/scripts/reasoning.js`, and `src/endpoints/chats.js` - server-owned chat generations
| Field | Value |
| --- | --- |
| File | `public/script.js`, `public/scripts/group-chats.js`, `public/scripts/reasoning.js`, `src/endpoints/chats.js` |
| Area | Generation lifecycle and chat persistence. |
| Divergence reason | SillyBunny lets the server finish a chat reply when the page that asked for it goes away, because phones freeze and close background tabs during a generation. `Generate()` must send a commit plan with each committable request, mark its streaming message so the server replaces only an unfinished reply, and skip its own save when the server kept its copy. Upstream stops the stream on `beforeunload`, which a leave-site prompt can cancel, so the hand-off and the stop run on `pagehide`. A group reply written this way must carry the rest of its round so the round can go on, and the server must save chats with the same locking, integrity and backup handling as a browser save. |
| Target seam | `public/scripts/server-generations.js`, `public/scripts/resumable-generation.js`, `public/scripts/generation-commit-plan.js`, `src/generation-commit.js`. |
| Adapter shape | `Generate()` registers a commit plan before each committable request (`registerGenerationCommitPlan()`), then awaits `settleGenerationCommit()` before it saves the finished reply; on `committed` it unblocks and calls `reloadServerCommittedReply()` instead of saving. `StreamingProcessor.onStartStreaming()` sets `extra[GENERATION_PLACEHOLDER_KEY]` on the streaming message, and `finalizeIntermediaryMessage()` deletes it. The window `pagehide` handler stops the stream unless the page goes into the back/forward cache; the `beforeunload` handler no longer stops it. `generateGroupWrapper()` records the members still to speak in `groupRoundRemaining`, read by `getGroupRoundRemaining()`, and `resumeGroupRound()` runs them. `parseAutoReasoningFromString()` exposes the live reasoning parse. `updateChatRecords()` saves through `trySaveChat()`, whose `integrity` option restores a chat's earlier slug when a commit is taken back. |
| Protecting tests | `tests/story-mode-request-controls.test.js`, `tests/resumable-generation-frontend.test.js`, `tests/server-generations-frontend.test.js`, `tests/server-generation-commit.test.js`, `tests/server-generation-commit.e2e.js`, `tests/pathfinder-streaming-origin.test.js`, `tests/chat-render-lifecycle-script-wiring.test.js`. |
| Validation | `npm run test:unit --prefix tests -- story-mode-request-controls.test.js resumable-generation-frontend.test.js server-generations-frontend.test.js server-generation-commit.test.js pathfinder-streaming-origin.test.js pathfinder-generation-wiring.test.js`, `npm run test:e2e --prefix tests -- server-generation-commit.e2e.js` against Bun 1.3.14 and Node servers, `npm run lint`, `npm run check:frontend-budgets`. |
| Rollback path | Remove the `registerGenerationCommitPlan()` and `settleGenerationCommit()` calls, the `GENERATION_PLACEHOLDER_KEY` lines in `onStartStreaming()` and `finalizeIntermediaryMessage()`, and the `pagehide` handler, then put `streamingProcessor.onStopStreaming()` back in the `beforeunload` handler. Requests then carry no commit plan, so the server never writes replies, and `fetchResumable()` still resumes dropped streams. `getGroupRoundRemaining()`, `resumeGroupRound()`, `parseAutoReasoningFromString()` and `updateChatRecords()` are used only by `public/scripts/server-generations.js` and `src/generation-commit.js`, so they go with those modules. |
| Last reviewed | 2026-10-23 PR #877 review fixes. |
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

### `public/index.html` and `public/script.js` - message actions
| Field | Value |
| --- | --- |
| Area | Chat message actions. |
| Divergence reason | DESIGN.md "Chat Transcript": a labelled message menu replaces upstream's inline `.extraMesButtons` expansion, and deleting a message always confirms with Cancel focused. |
| Target seam | `public/scripts/sillybunny-message-actions.js`, `public/scripts/sillybunny-action-menu.js`, `public/scripts/sillybunny-delete-confirm.js`. |
| Adapter shape | `#message_template`: `.extraMesButtons` reordered into menu sections with Checkpoint and Delete + Add Swipe moved in; Delete, Copy, Edit, and `.extraMesButtonsHint` (`fa-ellipsis-vertical`) follow in the row; edit row starts Cancel, Confirm. `script.js`: `deleteMessage()` calls `confirmMessageDeletion()`; `.mes_edit_delete` confirms unless `fromSlashCommand`. Upstream's `.extraMesButtonsHint` click handler is left in place and pre-empted in the capture phase. |
| Protecting tests | `tests/foundation/message-actions.e2e.js`. |
| Validation | `npm run lint`, `npm run build:frontend`, `npm run check:frontend-budgets`, foundation Playwright (chromium, all sizes). |
| Rollback path | Restore the upstream template block and `deleteMessage()` popup call; the SillyBunny modules then only add the menu on top. |
| Last reviewed | 2026-10-02, PR #870. |
| Owner | UI overhaul integrator. |

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
| File | `public/index.html` |
| Area | Settings and frontend boot. |
| Divergence reason | SillyBunny keeps `script.js` loaded through its canonical URL, keeps OOC/HTML retention settings copy synchronized with active-turn depth behavior, and exposes core background transparency sliders without requiring Moonlit Echoes. `script.js` must NEVER carry a `?v=` query: every module imports `../script.js` bare, and a versioned tag URL splits ES-module identity so `script.js` evaluates twice and registers every delegated handler twice (all inline-drawer toggles break). Stale-cache protection comes from `src/middleware/frontend-assets.js` serving JS with `Cache-Control: no-cache`, not from URL versioning. |
| Target seam | `public/scripts/ooc-blocks.js` for retention behavior; `public/css/sillybunny-chat-styles.css` and `public/scripts/power-user.js` for core transparency behavior. |
| Adapter shape | Keep HTML changes limited to static boot references and settings labels/tooltips. v1.9.0 swaps the Figtree preload/stylesheet links for Adwaita Sans/Mono, drops the Figtree Google Font preset (saved `Figtree` values still load as a custom Google Font), bumps fork stylesheet cache versions, and points the theme reset tooltip at `Libadwaita`. Keep each changed cache key aligned with its fork stylesheet and deferred runtime loader; `css/sillybunny-theme.css?v=` changes with that sheet (the art panels added the `--sb-dialog-aside` width to the Dialog and Window tiers). |
| Protecting tests | `tests/script-module-identity.test.js`, `tests/frontend-assets.test.js`, `tests/ooc-blocks.test.js`, `tests/core-message-transparency.test.js`, `tests/mobile-css-budgets.test.js`, `tests/header-icon-button-parity.e2e.js`, `tests/in-chat-agents-list.e2e.js`, `tests/mobile-character-toggle-and-panels.e2e.js`. |
| Validation | Unit tests for script identity and frontend assets, the focused status-page and mobile Characters E2E cases, `npm run check:frontend-budgets`, and browser smoke at desktop and mobile widths. |
| Rollback path | Restore versioned `script.js` references, previous settings copy, and remove core transparency slider markup if cache behavior or settings semantics regress. Chat transparency CSS loading rolls back through `public/scripts/power-user.js`. |
| Last reviewed | 2026-11-05, PR #870 (the `sillybunny-theme.css` key, `20261105a`; the `style.css` key, `20261105c`, at both call sites). |
| Owner | Refactor integrator. |

### `public/index.html` - Characters/Groups deferred stylesheet cache key
| Field | Value |
| --- | --- |
| File | `public/index.html` |
| Area | Characters and Groups list stylesheet boot. |
| Divergence reason | SillyBunny loads the Characters and Groups list stylesheet after startup, which upstream's static links do not do. The preload and both loader URLs must carry the same cache key, or the browser keeps a stale stylesheet. |
| Target seam | `public/scripts/dynamic-styles.js`, `public/scripts/sillybunny-character-list.js`, and `public/scripts/sillybunny-tabs.js`. |
| Adapter shape | Keep the preload and both deferred loader URLs on the same cache version because `loadStylesheetAsync` adopts the preloaded link by ID. |
| Protecting tests | `tests/character-list.e2e.js` (`Groups filter toolbar avoids extra vertical padding` at desktop and mobile widths). |
| Validation | Focused Characters/Groups E2E and `npm run check:frontend-budgets`. 2026-10-27 (`820589f4d`): the preload and both loaders moved to `?v=20261027a` together, and a repo-wide grep shows one key for the file. |
| Rollback path | Remove the preload `<link>` for `sillybunny-character-list.css` and its `SillyBunny:` comments from `public/index.html`. The stylesheet then loads only through the loader entries in `sillybunny-character-list.js` and `sillybunny-tabs.js`. Keep those two keys equal when you bump them. |
| Last reviewed | 2026-10-27, PR #870 (paths and markers re-checked). |
| Owner | UI overhaul integrator. |

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

### `public/index.html` - Data & Security Usage Stats row
| Field | Value |
| --- | --- |
| File | `public/index.html` |
| Area | Settings. |
| Divergence reason | TODO(copy) |
| Target seam | `public/scripts/sillybunny-settings-content.js` (`SB_DATA_SECURITY_SECTIONS` and the Data & Security `general` category). |
| Adapter shape | Keep one static `#user_stats_controls` row after `#account_controls`. Its button keeps the upstream `user_stats_button` class and `Usage Stats` i18n key, so the upstream binding in `public/script.js` opens `userStatsHandler()`. The row's subtitle is written and carries a `data-i18n` key of its own. |
| Protecting tests | `tests/unit/sillybunny-settings-content.test.js`, `tests/startup-on-demand.e2e.js` (`Data & Security opens Usage Stats`). |
| Validation | `npm run test:unit --prefix tests -- unit/sillybunny-settings-content.test.js`, `npm run test:e2e --prefix tests -- startup-on-demand.e2e.js -g "Data & Security"`, `npm run lint`, `npm run check:frontend-budgets`, browser check at 1440px and 390px. |
| Rollback path | TODO(copy) |
| Last reviewed | 2026-11-04, PR #870 (Usage Stats subtitle written). |
| Owner | TODO(copy) |

### `public/index.html`, `public/scripts/user.js`, and `public/scripts/templates/userProfile.html` - Data & Security Export category
| Field | Value |
| --- | --- |
| File | `public/index.html`, `public/scripts/user.js`, `public/scripts/templates/userProfile.html` |
| Area | Settings and accounts. |
| Divergence reason | TODO(copy) |
| Target seam | `public/scripts/sillybunny-settings-content.js` (`SB_DATA_SECURITY_SECTIONS` and the Data & Security `export` category). |
| Adapter shape | Keep two static rows, `#user_backup_controls` and `#settings_snapshots_controls`, after `#user_stats_controls`; the section order moves them into the `export` category after Import & Restore. Their buttons reuse the upstream `Download Backup` and `Settings Snapshots` i18n keys. The `user.js` ready block binds `#user_backup_button` to `backupUserData()` and `#settings_snapshots_button` to `viewSettingsSnapshots()`, and `openUserProfile()` binds neither popup button. `userProfile.html` drops both popup buttons and puts `data-require-accounts` on Account Actions, so the section hides with Change Password when accounts are off. |
| Protecting tests | `tests/unit/sillybunny-settings-content.test.js`, `tests/startup-on-demand.e2e.js` (`Data & Security downloads a backup from Export`, `Download Backup is enabled again after a failed backup`, `Data & Security opens Settings Snapshots from Export`, `Account popup opens without Settings Snapshots and Download Backup`). |
| Validation | `npm run test:unit --prefix tests -- unit/sillybunny-settings-content.test.js`, `npm run test:e2e --prefix tests -- startup-on-demand.e2e.js -g "Data & Security\|Download Backup\|Account popup"`, `npm run lint`, `npm run check:frontend-budgets`, browser check at 1440px and 390px. |
| Rollback path | TODO(copy) |
| Last reviewed | 2026-10-23 PR `#870` Data & Security Export category. |
| Owner | TODO(copy) |

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

### `src/server-startup.js` - listen retry and port-conflict diagnostics
| Field | Value |
| --- | --- |
| File | `src/server-startup.js`. |
| Area | Server lifecycle. |
| Divergence reason | TODO(copy) |
| Target seam | `src/server-listen.js`. |
| Adapter shape | `#startHTTPorHTTPS()` runs the IPv6 and IPv4 binds at the same time through `retryOnAddressInUse()` and calls `reportPortHolders()` on the first retry. Both create functions close a server that failed to bind and call `trackListeningServer()` once it listens. `#handleServerListenFail()` calls `reportPortHolders()` again and prints the `diagnosePortConflict()` result through `formatPortConflictBanner()` before it exits. `#getAddressInUseMessage()` uses `APP_NAME` and adds the Bun socket-inheritance hint only when `hasBunSocketInheritBug()` is true. |
| Protecting tests | `tests/server-listen.test.js`. |
| Validation | `npm run test:unit --prefix tests -- server-listen.test.js`, `node --check src/server-startup.js`, `npm run lint`. |
| Rollback path | TODO(copy) |
| Last reviewed | 2026-10-23 Bun socket-inheritance hint limited to Bun before 1.4.0. |
| Owner | TODO(copy) |

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

### `public/scripts/world-info.js` - scan target for Conversation lorebooks
| Field | Value |
| --- | --- |
| File | `public/scripts/world-info.js` |
| Area | World Info scanning and Conversation mode. |
| Divergence reason | TODO(copy) |
| Target seam | `public/scripts/sillybunny-conversation/world-info.js`. |
| Adapter shape | `checkWorldInfo()` and `getSortedEntries()` take an optional `scanTarget` (`WIScanTarget`), and `WorldInfoBuffer` takes the substitution function for keys. With a target, the scan reads the target character's linked books and the global books, reads `chatWorld` and `personaWorld` in place of the chat and persona lorebooks, and applies character filters, `{{char}}`, `{{user}}` and the regex `{{char}}` to the target. It skips the active chat's extension prompts, forced activations, sticky and cooldown writes, Author's Note write, `WORLDINFO_ENTRIES_LOADED` and `WORLDINFO_SCAN_DONE`. Without a target the scan does not change. |
| Protecting tests | `tests/world-info-scan-target.test.js` (characterization of the active-chat scan, plus target scans), `tests/frontend/ConversationLorebooks.e2e.js`. |
| Validation | `npm run test:unit -- world-info-scan-target.test.js` in `tests/`, `npx eslint public/scripts/world-info.js`, `npm run test:e2e -- frontend/ConversationLorebooks.e2e.js` against a running server in Chromium and WebKit. |
| Rollback path | TODO(copy) |
| Last reviewed | 2026-10-23 Conversation lorebooks. |
| Owner | TODO(copy) |

### In-Chat Agents expressions and connection profiles
| Field | Value |
| --- | --- |
| File | `public/scripts/extensions/expressions/index.js`, `public/scripts/extensions/connection-manager/index.js`, `public/scripts/extensions/connection-manager/{settings,view,profile,edit}.html`, `public/scripts/extensions/connection-manager/style.css`, `public/scripts/extensions/shared.js`, `public/scripts/custom-request.js`. |
| Area | Extension runtime, expressions, and connection-profile secrets. |
| Divergence reason | Fork-owned agent classification, generated sprites, profile-scoped requests, and secret-aware connection state extend upstream extension surfaces. |
| Target seam | `public/scripts/extensions/in-chat-agents/`, `public/scripts/extensions/expressions/`, `public/scripts/extensions/connection-manager/`, `public/scripts/extensions/connection-manager/profile-change-model.js`, and `public/scripts/extensions/connection-manager/profile-change-notice.js`. |
| Adapter shape | Keep extension boot and provider calls in upstream modules; delegate fork agent/profile decisions through existing narrow exports. |
| Protecting tests | `tests/expressions-agent.test.js`, `tests/connection-profile-request-fields.test.js`, `tests/connection-manager-profile-save.test.js`, `tests/in-chat-agents-runner.test.js`, `tests/unit/connection-profile-change-notice.test.js`, `tests/unit/connection-profile-change-notice-wiring.test.js`, `tests/connection-profile-change-notice.e2e.js`. |
| Validation | Focused unit tests, `npm run lint`, `npm run check:frontend-budgets`. |
| Rollback path | Disable fork classifier/profile hooks while retaining upstream expression and connection behavior. |
| Last reviewed | 2026-10-14 profile change notice. |
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
| Target seam | `src/server-init.js`, `src/server-directory.js`, `src/runtime.js`, and the bundled-content helpers in `content-manager.js`, including `MANAGED_BUNDLED_THEMES`, `CONTRAST_REVISED_THEME_HASHES` and `reconcileManagedBundledThemes()`. |
| Adapter shape | Keep startup order and upstream routes stable; isolate default synchronization and fork content reconciliation behind small helpers. Each bundled theme revision lists the SHA-256 of the previous bundled file, so reconciliation replaces only an unmodified copy; edited copies stay, and deleted ones are not recreated. Seeding is unchanged. |
| Protecting tests | CI `bun src/server-init.js` smoke, `tests/default-preset-deletions.test.js`, `tests/sillybunny-launcher-smol.test.js`, `tests/bundled-theme-reconcile.test.js`, and root lint. |
| Validation | `npm run init`, `node --check src/server-init.js`, `node --check src/server-main.js`, `npm run lint`. 2026-10-31 (theme text contrast): boots under `bun server.js` and `node server.js` on data roots seeded from the previous theme files replaced the 51 unmodified copies, kept an edited copy, did not recreate a deleted one, and left the unrevised themes byte-identical. |
| Rollback path | Revert default/content reconciliation while retaining upstream config initialization and server startup. |
| Last reviewed | 2026-10-31, PR #870 theme text contrast. |
| Owner | Runtime and release integrator. |

### Chat backups, characters, and thumbnails
| Field | Value |
| --- | --- |
| File | `public/scripts/chat-backups.js`, `public/css/chat-backups.css`, `src/endpoints/characters.js`, `src/endpoints/thumbnails.js`, `src/endpoints/image-metadata.js`. |
| Area | Chat recovery, character assets, thumbnails, and media metadata. |
| Divergence reason | SillyBunny adds backup recovery presentation and mobile-aware character/media handling without changing upstream chat or image formats. |
| Target seam | `public/scripts/sillybunny-tabs.js`, `src/endpoints/conversation-utils.js`, and the thumbnail/image-metadata helpers. |
| Adapter shape | Keep upstream archive and image routes stable; limit fork behavior to recovery UI, mobile presets, and metadata helpers. Treat disconnected backup controls as stale so the browser can recreate them after Chat History restores its legacy tree. |
| Protecting tests | `tests/backups-hardening.test.js`, `tests/character-save-guard.test.js`, `tests/thumbnails-endpoint.test.js`, `tests/mobile-thumbnail-preset.test.js`, `tests/chat-avatar-thumbnail-urls.test.js`, `tests/sillybunny-overlays.e2e.js`. |
| Validation | Focused unit tests, Chat History overlay E2E, `node --check` on endpoint/client files, `npm run lint`. |
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
| File | `default/config.yaml`, `default/content/index.json`, `default/content/settings.json`, and `default/content/themes/*.json`. |
| Area | Install defaults and bundled content. |
| Divergence reason | SillyBunny ships fork defaults, agents, presets, and settings while preserving install-time migration and reset behavior. v1.9.0 registers the `Libadwaita` and `Libadwaita Light` themes in `index.json`, makes `Libadwaita` the default theme with matching colors in `settings.json`, and defaults `reduced_motion` to `false`. |
| Target seam | `src/server-init.js`, `src/endpoints/content-manager.js`, the managed-content reconcile (`src/sillybunny-managed-content.js`) with its manifest `default/content/sillybunny-managed.json`, bundled-template update helpers, and `public/scripts/sillybunny-theme-revisions.js` for applied theme colours. |
| Adapter shape | Preserve upstream IDs and metadata keys; change default values and bundled indexes only through existing synchronization paths. Bundled theme text colours are revised in place (`main_text_color`, `italics_text_color`, `underline_text_color`, `quote_text_color`, and the text rules in `custom_css` through `--customThemeColor-text` and `--customThemeColor-hover-text`); `settings.json` carries the default theme's revised palette and `sb_theme_text_revision`. `index.json` lists `SillyBunny Lexicon.json` as a `world` after `Eldoria.json`; the managed manifest fingerprints it, so an edited copy is never overwritten and shows as modified. `index.json` lists `default_AssistantReisen.png` and `default_AssistantTewi.png` as `character` entries before `default_Seraphina.png`, and the managed manifest fingerprints both cards, so an edited or deleted copy is never overwritten or re-seeded. |
| Protecting tests | `tests/default-preset-deletions.test.js`, bundled-template and agent-version tests, `tests/bundled-theme-text-contrast.test.js` (every bundled theme's text roles reach 4.5:1), `tests/libadwaita-theme-migration.test.js` (`settings.json` matches the bundled Libadwaita theme), plus Bun initialization smoke.; `tests/unit/sillybunny-lexicon-coverage.test.js`, `tests/unit/sillybunny-shipped-managed-content.test.js` (the manifest matches what the build script writes, and every item is indexed), `tests/world-info-scan-target.test.js` (the lexicon reaches the scan through a character that links it), `tests/managed-content-fixtures.test.js`.; `tests/bundled-assistant-cards.e2e.js` (the seeded cards on Home at desktop and phone widths, the pointer migration, Getting Started not counting them, the lexicon link with no embedded book). |
| Validation | 2026-11-02 (Assistant Reisen and Assistant Tewi): Node and Bun seeded both cards on a fresh data root, on a copy of an existing one and on a root made by `f6c1b217b`; an edited Reisen stayed byte-identical with status modified; a deleted Reisen was not re-seeded, and Restore returned it to current; the pointer migrated to Reisen with no dialog or lorebook import prompt; unit 8,712 tests (one environment-only failure), `bundled-assistant-cards` 7, `getting-started` 57, `bundled-assistants` 19, `managed-updates` 82, `home-assistants` 130. 2026-11-02 (SillyBunny Lexicon): Bun and Node seeded it on a fresh data root and on a copy of an existing one, left an edited copy untouched with status modified, did not re-seed a deleted copy, and Restore returned it to current with a backup; `sb_topic` survived a save in the World Info editor; unit 8,708 tests (one environment-only failure), `bundled-assistants` 19, `world-info-cross-links` 8, `preset-lorebook-dialogs` 28, `managed-updates` 82. `npm run init`, full unit suite, and fresh-data-directory smoke. 2026-10-31: a browser measurement of every text role on five surfaces in all 56 themes (3,304 rows) leaves only Libadwaita Light's quote and links on the bare page tone at 4.41:1 (libadwaita's standalone blue `#0461be`, kept by choice); fresh-data boot seeded all 56 themes and the revised palette. |
| Rollback path | Restore individual defaults through the bundled update flow without deleting existing-user settings. Existing users keep their saved theme and motion setting. |
| Last reviewed | 2026-11-02, PR #870 SillyBunny Lexicon. |
| Owner | Defaults and release integrator. |

### `public/scripts/power-user.js` - bundled theme text repair
| Field | Value |
| --- | --- |
| File | `public/scripts/power-user.js`; `public/scripts/sillybunny-theme-revisions.js`. |
| Area | Startup migration of saved theme text colours after the bundled themes' text colours were revised. |
| Divergence reason | TODO(copy) |
| Target seam | `planThemeTextRepair()` and the per-theme revision data in `public/scripts/sillybunny-theme-revisions.js`. |
| Adapter shape | Under `// SillyBunny:` markers: the `SB_THEME_TEXT_REVISION` constant; one block in `loadPowerUserSettings()` after the Libadwaita palette repair that, while `power_user.sb_theme_text_revision` is below it, imports the revisions module dynamically, applies the planned text colours (and the CSS only when it is the previous bundled CSS and the loaded theme carries the revised CSS), records the marker and saves; a failed import leaves the marker unset so the next start retries; the Dark V 1.0 migration writes the current Libadwaita quote colour; the default `settings.json` seeds `sb_theme_text_revision`, so fresh installs never load the module. A user's state changes only when the saved theme name and all ten saved colour keys equal a previous bundled version. |
| Protecting tests | `tests/sillybunny-theme-revisions.test.js`, `tests/sillybunny-theme-text-repair.e2e.js`, `tests/libadwaita-theme-migration.test.js`. |
| Validation | 2026-10-31: root and tests lint; full unit suite; `npm run check:frontend-budgets` (startup scripts 25 of 26; the revisions module is a dynamic import, requested only while the marker is unset); repair e2e; a 4460 boot under Bun and Node with a seeded `settings.json` holding the previous Everforest Dark palette and CSS applied the revised colours and CSS, saved the marker, and switched themes without the CSS prompt. |
| Rollback path | TODO(copy) |
| Last reviewed | 2026-10-31, PR #870 theme text contrast. |
| Owner | TODO(copy) |

### `public/style.css` - libadwaita shell foundation
| Field | Value |
| --- | --- |
| Area | Shell typography, status colors, controls, and chat disclosures. |
| Divergence reason | The v1.9.0 libadwaita shell needs root-level defaults that load before fork sheets: Adwaita Sans/Mono font stacks, libadwaita dark status colors, the 1.81 display step, libadwaita check buttons, and short reasoning/OOC disclosure reveals. |
| Target seam | `public/css/sillybunny-theme.css` owns layer, radius, motion, and light-tone tokens; `style.css` keeps only root defaults and base control styling. |
| Adapter shape | Variable value swaps in `:root`, the checkbox rule block, and one `sb-chat-disclosure-in` keyframe with its two selectors. The status-colour and checkbox blocks carry `SillyBunny` inline comments. |
| Protecting tests | `tests/ui-motion-css-compliance.test.js`, `tests/mobile-css-budgets.test.js`, `tests/frontend-assets.test.js`. |
| Validation | `npm run lint`, `npm run check:frontend-contracts`, `npm run build:frontend`, `npm run check:frontend-budgets`, full unit suite, desktop/mobile screenshots in both tones. |
| Rollback path | Revert the variable values, checkbox block, and disclosure keyframe; persisted themes and user CSS are unaffected. |
| Last reviewed | 2026-10-01 PR #870 libadwaita shell. |
| Owner | UI and shell integrator. |

### Frontend identity, localization, and static boot assets
| Field | Value |
| --- | --- |
| File | `public/locales/*.json`, `public/img/**`, `public/*.ico`, `public/login.html`, `public/manifest.json`, `public/global.d.ts`, `public/lib/polyfill.js`, and `public/webfonts/**`. |
| Area | Branding, localization, login, PWA metadata, compatibility, and static assets. |
| Divergence reason | SillyBunny replaces product identity and translated copy, adds fork provider assets, and keeps browser/PWA boot metadata aligned with the fork. v1.9.0 replaces bundled Figtree with Adwaita Sans and adds Adwaita Mono (both OFL, licenses shipped alongside). |
| Target seam | Static assets and locale catalogs; no runtime seam. |
| Adapter shape | Preserve upstream locale keys, manifest structure, icon dimensions, and browser compatibility contracts. Keep font preload/rewrite paths in `public/index.html` and `src/frontend-assets.js` in sync with `public/webfonts/`. The Adwaita Mono files are real WOFF2 subsets of GNOME `adwaita-fonts-50.0` (`https://download.gnome.org/sources/adwaita-fonts/50/adwaita-fonts-50.0.tar.xz`, SHA-256 `4c927fbfeec1c503801ba510c2c94e0054c82c522cf7ba0d3be5d4d41fcf5c86`, `mono/AdwaitaMono-{Regular,Bold,Italic,BoldItalic}.ttf`), made with fontTools 4.67.0 `pyftsubset --unicodes=<the face's unicode-range in stylesheet.css> --layout-features='*' --name-IDs='*' --name-languages='*' --notdef-outline --flavor=woff2`. When font bytes change, change the `?v=` key on every URL in that family's `stylesheet.css` and at its `public/index.html` and `public/login.html` links together. |
| Protecting tests | `tests/frontend-assets.test.js`, `tests/unit/webfonts-format.test.js` (every `.woff2` is WOFF2, every stylesheet URL resolves, Adwaita URLs carry a key), `tests/webfonts-load.e2e.js` (every Adwaita face loads through `FontFace` with no OTS or decode error), manifest/browser smoke, README mirror validation, and full build. |
| Validation | `npm run build:frontend`, `npm run check:frontend-budgets`, JSON parsing, and desktop/mobile login smoke. 2026-10-30 (Adwaita Mono rebuild): cmap, outlines, advances, hinting, metrics and names compared old against new with fontTools, default shaping compared with `hb-shape`; Chromium loads all faces through the e2e above; the coder also loaded them in Firefox 157 and WebKit 27.2 in the Playwright container. |
| Rollback path | Restore individual assets or translations without changing persisted data. |
| Last reviewed | 2026-10-30, PR #870 Adwaita Mono rebuild. |
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

### Data Bank Window redesign
| Field | Value |
| --- | --- |
| File | `public/scripts/chats.js`; `public/scripts/extensions/attachments/manager.html`; `public/scripts/extensions/attachments/style.css`. |
| Area | Data Bank attachment manager presentation and row actions. |
| Divergence reason | Upstream shows the Data Bank as a popup with its own toolbar and fixed layout. SillyBunny frames the same manager as a Window with shared search, sort and row menus, while the original controls, IDs and drop target stay in place. |
| Target seam | `public/scripts/sillybunny-editor/adapters/data-bank-dialog.js`. |
| Adapter shape | Keep source inputs, attachment IDs, scopes, render functions, existing action nodes and callbacks; frame the manager as a Window, forward shared menu actions to the original controls, and retain the `.popup` drop target. `chats.js` calls `frameDataBankManager()` in `onBeforePaint`. |
| Protecting tests | `tests/window-dialogs.e2e.js` covers search, sort, coarse-pointer Close, keyboard/bulk behavior, `.popup` drop, and every row overflow action; `tests/unit/data-bank-dialog-adapter.test.js` covers source validation, sort forwarding, action forwarding, and keyboard activation; regression suites: `tests/tag-manager.e2e.js`, `tests/character-folders.e2e.js`, `tests/sillybunny-overlays.e2e.js`, `tests/sillybunny-dialog-frame.e2e.js`, `tests/sillybunny-dialog-tiers.e2e.js`, `tests/popup-scroll.e2e.js`; `tests/utility-dialog-first-paint.e2e.js`. |
| Validation | 2026-10-25: Chromium verification on port 4460 passed the requested 180-test E2E matrix twice, 442 unit suites (6682 passed, 2 skipped), root/tests lint with no errors, `git diff --check`, and the frontend budget at 1017.7 KiB blocking CSS. Final screenshots inspected for Data Bank main/bulk at 1440×900 and 390×844 plus Tag Manager search-open at both sizes. Attachment stylesheet reduced from 418 to 255 lines. |
| Rollback path | In `public/scripts/chats.js`, remove the `frameDataBankManager()` and `decorateDataBankRow()` calls and their import. Revert the marked hunks in `public/scripts/extensions/attachments/manager.html` and `style.css`. Then drop `tests/unit/data-bank-dialog-adapter.test.js` and the Data Bank cases in `tests/window-dialogs.e2e.js`. |
| Last reviewed | 2026-11-05, PR #870 (adapters reshape in `onBeforePaint`). |
| Owner | UI overhaul integrator. |

### `public/scripts/keyboard.js` - Enter on native controls

| Field | Value |
| --- | --- |
| File | `public/scripts/keyboard.js` |
| Area | Keyboard activation of `.interactable` controls. |
| Divergence reason | Upstream turns Enter on any `.interactable` into a synthetic `click()`. Upstream's `.menu_button` controls are `<div>` elements, so that is their only activation. SillyBunny renders many of them as real `<button>` elements, which already click on Enter, so one press ran the handler twice and the second click landed on whatever took focus after the first. |
| Target seam | `handleGlobalKeyDown()` in `public/scripts/keyboard.js`. |
| Adapter shape | One early return, under one `// SillyBunny:` marker, skips the synthetic click when the focused element is a native `button`, `summary`, `a[href]`, or a button, submit, reset or image `input`. Every other `.interactable` element, including checkboxes and radios, keeps the upstream synthetic click. |
| Protecting tests | `tests/unit/sillybunny-keyboard-enter.test.js`; `tests/dialogs-accessibility.e2e.js` (Enter on a real button activates once, Change Password opens one popup, the Clear cookies alert stays open, and `#options_button` still activates once); `tests/native-dialog-replacements.e2e.js`. |
| Validation | 2026-10-28: full Jest suite 454 suites, 6,902 tests passed, 2 skipped; `dialogs-accessibility` 112/112 on Chromium; root and tests lint pass. |
| Rollback path | Delete the marked early return in `handleGlobalKeyDown()`. Then a native button that also carries `.interactable` activates twice on Enter again, so first remove `.interactable` from the SillyBunny `<button>` controls that have it, or keep the return. Drop `tests/unit/sillybunny-keyboard-enter.test.js` and the Enter tests in `tests/dialogs-accessibility.e2e.js`. |
| Last reviewed | 2026-10-28, PR #870 (marker and unit tests checked). |
| Owner | UI overhaul integrator. |

### `public/style.css` - Home stylesheet import
| Field | Value |
| --- | --- |
| File | `public/style.css` |
| Area | Home state, Home layout and shell width. |
| Divergence reason | TODO(copy) |
| Target seam | `public/css/sillybunny-home.css` (all Home rules: the Home state, the Home shell width (`min(max(1120px, var(--sheldWidth)), 100dvw - 32px)`; the top bar keeps its chat width while Home is shown, so its controls do not move between Home and a chat), the bottom gap matching the Roleplay composer, the one-column layout, Recent Chats, two rules carried from `welcome.css`: `#chat .mes[type="assistant_message"] .mes_button` and `.welcomeForkNotice*`, the art panels: `.sbArtPanel` with its `--sb-art-backdrop` lavender, the banner fade and `[data-sb-art-fit='smooth']`, and the hero, `.sbHomeHeroArt`, an `.sbArtPanel` around the picture that its script sizes to the band less the panel's padding at a whole step and draws smooth only when shrunk; the panel pads 8px at a container of 390px or narrower, and the band keeps its 4px side padding up to a 414px container, derived from the day art width (332 + 2×12 panel + 2×16 band + 2×12 layout + 2 border)); `public/scripts/sillybunny-home-state.js` (`#sheld[data-sb-home='on']`, derived from a `.welcomePanel` in `#chat` while Conversation mode is off). |
| Adapter shape | The `welcome.css` import is replaced by one `@import url(css/sillybunny-home.css?v=…)` line under one `/* SillyBunny: */` marker; `public/css/welcome.css` stays on disk, unreferenced. A change to `style.css` needs a new `style.css?v=` key at both `public/index.html` call sites (the preload and the stylesheet link), as the `index.html` boot-assets entry describes. |
| Protecting tests | `tests/unit/sillybunny-home-state.test.js`; `tests/home-state.e2e.js` (composer hidden and `#chat` filling the shell on Home at 1440×900 and 390×844, composer back in a chat, Conversation over Home, Ctrl+O, mobile chat bar and side-panel sheet on Home); `tests/home-state.e2e.js` (every top-bar control has the same box on Home and in a chat at 1440×900, 1744×1000 and 390×844, also on every frame of the transition back); `tests/home-layout.e2e.js` (Home shell width with Page Width and the panel fill, one column at every width, header alignment, tile row, assistant card footers, display modes, bottom gap); `tests/unit/sillybunny-home-stylesheet-guard.test.js`; `tests/unit/side-panel.test.js`; `tests/side-panel-engine.e2e.js`; `tests/art-panels.e2e.js`, `tests/art-pixel-evenness.e2e.js`, `tests/unit/sillybunny-home-art-layout.test.js`, `tests/unit/sillybunny-home-pixel-art.test.js` (the art panels); `tests/home-hero-art.e2e.js` (the hero's step at each band width and screen scale, day and night, a resize and a Compact round trip); `tests/home-layout.e2e.js` (tile lines shown in full, one tile height); `tests/unit/sillybunny-home-hero-band.test.js` (the 414px limit against the art width); `tests/art-panels.e2e.js` (the hero's backdrop and forced colours). |
| Validation | 2026-11-05 (hero panel): reviews `ses_e5a2400ecffeKGWLNkLTFigm0L` and `ses_e59a09e16ffeFoVHJm9hifB3LH`; `style.css?v=20261105b` at both `index.html` call sites and `sillybunny-home.css?v=20261105b`; lint, unit and budgets pass; `home-hero-art`, `art-panels`, `art-pixel-evenness` and `home-layout` pass at the full matrix in Chromium. 2026-11-04 (written copy): `style.css?v=20261104h` at both `index.html` call sites and `sillybunny-home.css?v=20261104h`; the Home tile line clamp and the dead `[data-sb-copy-placeholder]` rule removed; unit, lint and budgets pass; e2e `home-layout`, `getting-started`, `bundled-extras`, `welcome-startup`, `help-shortcuts`, `home-assistants` 862 passed. 2026-11-04 (pixel-art hero): `style.css?v=20261104g` at both `index.html` call sites and `sillybunny-home.css?v=20261104g`; `home-hero-art`, `art-pixel-evenness` and `home-layout` pass in the sharded e2e run with the checks below. 2026-11-04 (art panels): reviews `ses_e5d4d2648ffexdnEL68oSOIfWb` and `ses_e5b75f68bffeKDcn6rw22524wF`; `style.css?v=20261104e` at both `index.html` call sites and `sillybunny-home.css?v=20261104e`; root and tests lint pass; unit 9,033 passed (one failure that needs a checkout inside the server directory); `npm run check:frontend-budgets` passes; sharded e2e of `art-panels`, `art-pixel-evenness`, `welcome-transitions`, `welcome-slide-restyles`, `home-windows`, `home-layout`, `dialogs-accessibility` and `home-assistants`, 1,565 passed; of the 3 failures, two were the Update Available alert surface still expecting `TODO(copy)` after its wording landed (its expectation is fixed in the next commit), and one, `home-assistants` "a second New Chat is a second fresh branch", passed 6 of 6 on fresh data roots with and without these changes. 2026-11-01 (top bar keeps its chat width): `home-state` 23, `topbar-upgrade` 6, `side-panel-adapters` 23, `home-layout` Home shell width group 32; `style.css?v=` moved to `20261101a` at both `index.html` call sites, which the two commits before it had missed. 2026-10-29: root and tests lint pass; unit 462 suites, 7,041 passed, 2 skipped; Chromium e2e of the Home, side-panel, splash and utility-dialog specs (248 passed; the one failure was a test race, fixed and then 30 of 30 under load); foundation Chromium 71 passed, 33 skipped; `npm run check:frontend-budgets` passes (blocking stylesheets 1,048,492 of 1,048,576 bytes). |
| Rollback path | TODO(copy) |
| Last reviewed | 2026-11-05, PR #870 (hero panel). |
| Owner | TODO(copy) |

### `public/scripts/welcome-screen.js` - Home skeleton adapter and mode switcher resume
| Field | Value |
| --- | --- |
| File | `public/scripts/welcome-screen.js` |
| Area | Home (template, Recent Chats, display modes) and the top-bar mode switcher. |
| Divergence reason | TODO(copy) |
| Target seam | `public/scripts/sillybunny-home/` (`mount.js` mounts the header row, the art-led band, the tile row (`tiles-view.js`), the assistant cards (`assistants-view.js`, with `footer-fit.js` deciding whether the footer labels fit), the header row (`header-fit.js` moves the version below the centred title when it would touch the main menu button), the main menu and the Recent Chats status pages; `menu.js` builds the main, Recent Chats row and Assistant menus; `modes.js` decides the regions per display mode; `focus.js` restores focus after a re-render; `recent-chat.js` resolves a row's chat identity; `windows.js` opens the Help, About, Shortcuts, Welcome, Getting Started (`getting-started-window.js`) and Bundled Extras (`bundled-extras-window.js`) windows on first use; `step-rows.js` builds the Getting Started step rows shared with the welcome dialog; `getting-started-boot.js` registers the Getting Started listeners once per app session, `getting-started-signals.js` decides when a step is done, `getting-started-storage.js` reads and writes the accountStorage key `WelcomePage_GettingStarted`, `getting-started-toast.js` shows the completion toast and `bundled-cards.js` lists the cards that ship with SillyBunny; `assistant-registry.js` lists the bundled assistants, their account keys and how each one is brought in, `default-assistant-resolver.js` remembers which card is the default assistant until the character list changes, and `assistant-pointer-migration.js` moves the Welcome Page Assistant pointer to Reisen once her card exists; `assistant-cards.js` decides which assistant cards Home shows and in which state, `assistant-actions.js` which chat a card control opens, and `assistant-chat.js` opens it through the app; `assistant-picker.js` opens the Choose Assistant window for the third card, listing the library's characters other than Reisen and Tewi and building its rows in growing chunks; `managed-content.js` reads the managed-content status and lists the Restore and Update offers (`describeOffers`), `managed-status.js` keeps the last status and drops answers older than the newest request, `assistant-managed-actions.js` and `assistant-managed-app.js` run Restore, Update and Keep Mine through the managed-content routes, `assistants-refresh.js` re-mounts the cards when the offers change and no menu or dialog is open, and `managed-update-alert.js` asks Update or Keep Mine); the fork-owned template `public/scripts/templates/sillybunnyHome.html`; `public/scripts/sillybunny-chat-mode-memory.js` and the switcher in `public/scripts/sillybunny-tabs.js` for the resume. |
| Adapter shape | Under `// SillyBunny:` markers: the import of `sillybunny-home/`; the template path and its `?v=` key; `getWelcomePanelMode()` / `setWelcomePanelMode()` and the slimmed `buildWelcomeTemplateData()`; one `mountHome()` call after the template renders; a re-check after the template `await` that no chat opened meanwhile; in-place re-render (`openWelcomeScreen({ force: true })` removes only non-panel children); the row's pin plus a Chat Menu (Rename, Delete) through `resolveRecentChatTarget()`; focus capture and restore around `refreshWelcomeScreen()`; and `resumeLatestRoleplayChat({ canOpen })` for the switcher. The SillyBunny tour, handbook, Launchpad deck, starter pack, hero action grid and Temporary Chat button were removed, which shrank the file from about 2,700 to about 1,700 lines. Upstream Recent Chats behaviour stays. The bundled-assistant plumbing stays, with its per-assistant configuration read from the registry: `getBundledAssistantConfig()` and `getDefaultAssistantConfig()` resolve through it (an unknown id means the default assistant, Reisen once her card exists and the Bunny Guide until then); the fingerprint check matches by avatar alone for an assistant the server seeds (it has no creation method); the browser never creates Reisen or Tewi, and no startup check or listener reads or writes the account keys of an assistant that is not in the registry, so a Nahida card and keys from an earlier version stay as they were; after the startup checks, `migrateAssistantPointer()` runs; the default-assistant cache is cleared on `CHARACTER_PAGE_LOADED`, `CHARACTER_EDITED`, `CHARACTER_DUPLICATED`, `CHARACTER_RENAMED` and `CHARACTER_DELETED`, after the handlers that change the identity and deletion marks. Home's assistant cards: `getAssistantLibrary()` answers the cards model from the loaded characters and the account's deletion marks, and lists the library's characters (`listCharacters`); one `createAppAssistantActions()` set is shared by every render, so a double click is dropped across a re-render; `sendWelcomePanel()` reads the managed-content status in parallel with the template, waits for a first answer only for a short cap and otherwise reuses the last status, passes `assistants: { getCards, getPickerEntries, setPointer, actions, getThumbnailUrl }` with the Restore and Update offers and actions to `mountHome()`, and keeps the cards current through the `{ remountAssistants }` handle that `mountHome()` returns (`keepCardsCurrent`); `showManagedChange()` clears a card's deleted mark after a Restore and renders Home again; `managedAssistants` holds the status client; the exported `setAssistantPointer()` writes or clears the Welcome Page Assistant pointer, refusing an avatar that is not in the library, and renders Home again; `chooseHomeAssistant()` calls it for the third card, the picker and the character list's Set as assistant (`assignCharacterAsAssistant()`), and reports a failure with the written toast (`reportAssistantFailure()` from `sillybunny-home/assistant-chat.js`) instead of leaving it unhandled; `openRecentConversationChat()` takes `{ enable }` so a card can open a fresh Conversation for a character without Conversation Mode. |
| Protecting tests | `tests/unit/sillybunny-home-modes.test.js`; `tests/unit/sillybunny-home-menu.test.js`; `tests/unit/sillybunny-home-focus.test.js`; `tests/unit/sillybunny-home-recent-chat.test.js`; `tests/unit/sillybunny-home-tiles.test.js`; `tests/unit/sillybunny-home-footer-fit.test.js`; `tests/unit/sillybunny-home-header-fit.test.js`; `tests/unit/sillybunny-home-stylesheet-guard.test.js` (nothing loads `welcome.css`); `tests/unit/sillybunny-home-step-rows.test.js`; `tests/unit/sillybunny-home-windows.test.js`; `tests/home-windows.e2e.js` (Getting Started and Bundled Extras windows, focus return after a re-render); `tests/unit/sillybunny-home-getting-started.test.js`; `tests/unit/sillybunny-getting-started.test.js` (storage, signals, hidden rules, toast plan); `tests/getting-started.e2e.js` (signals from real events, persistence across a reload, fresh install and existing account, toast and Show Me); `tests/unit/sillybunny-home-shell-targets.test.js`; `tests/unit/sillybunny-assistant-registry.test.js`; `tests/unit/sillybunny-default-assistant-resolver.test.js`; `tests/unit/sillybunny-assistant-pointer-migration.test.js`; `tests/bundled-assistants.e2e.js` (registry resolution, fingerprint, startup without Reisen, pointer migration and invalidation; a fresh install without Nahida, and an earlier Nahida card and its three keys left untouched by startup, renames and deletions); `tests/unit/sillybunny-assistant-cards.test.js`; `tests/unit/sillybunny-assistant-actions.test.js`; `tests/unit/sillybunny-assistant-chat.test.js`; `tests/unit/sillybunny-assistants-view.test.js`; `tests/unit/sillybunny-assistant-picker.test.js` (entries, sort and tiebreak, first activation wins, chunked rows, late rows filtered); `tests/home-assistants.e2e.js` (card states and art size after a window opens, New Chat, Temporary Chat, New Chat in a mode, Conversation branch, failure toast, double activation, the third card's Choose Assistant, Choose Another Assistant… and Remove Assistant, the character list re-rendered and the failure toast after Set as assistant, equal card heights in full and Compact); `tests/unit/sillybunny-home-managed-content.test.js`; `tests/unit/sillybunny-home-managed-status.test.js`; `tests/unit/sillybunny-assistant-managed-actions.test.js`; `tests/unit/sillybunny-assistants-refresh.test.js`; `tests/unit/sillybunny-managed-update-alert.test.js`; `tests/managed-updates.e2e.js` (Restore button on a deleted or missing card, Update Available and its alert, Keep Mine, the update toast, a slow, hung or failing status, re-mounts held while a menu or dialog is open, focus kept); `tests/dialogs-accessibility.e2e.js` (the update alert surface and the Restore block); `tests/unit/sillybunny-bundled-extras.test.js`; `tests/home-layout.e2e.js`; `tests/unit/sillybunny-chat-mode-memory.test.js`; `tests/home-mode-memory.e2e.js`; `tests/conversation-mode-scoped-profile.test.js` (Conversation suppression strings); `tests/utility-dialogs.e2e.js` (Recent Chats Settings); `tests/unit/character-import-operation.test.js`. |
| Validation | 2026-11-05 (written wording from the live review): the template key is `20261105b`; lint, the welcome, help and art-intro unit suites, and the full matrix of `home-layout` (554), `home-windows` and `welcome-startup` (301) pass. 2026-11-02 (Update Available and Restore): reviews `ses_e69c3be20ffeQT0p45RNq9jHnp` (two rounds, mutation checks: unit and e2e mutants killed, the stale-status guard covered after round 1); first paint with a hung status route about 4.4 s against 9.0 s before, steady re-renders never wait; on a scratch checkout, unit 8,685 tests (one environment-only failure), `managed-updates` 82, `home-assistants` 130, `dialogs-accessibility` filtered 68; on the agents' server after the last round, `bundled-assistants`, `home-press` and `managed-updates` 114 passed; root and tests lint pass. 2026-11-02 (Nahida removed): review `ses_e69c3be20ffeQT0p45RNq9jHnp` with mutation checks (registry, Bundled Extras, slot and startup-key mutants killed); on a scratch checkout of HEAD plus the change, `bundled-assistants` 19, `home-assistants` 130, `bundled-extras` 35, `getting-started` 57, `home-windows` 269, `home-layout` 548, `home-press` 13, `home-contrast` 41, `dialogs-accessibility` Bundled Extras and picker 62; unit 813 passed; root and tests lint, `check:frontend-budgets` pass. 2026-11-02 (third assistant card and Choose Assistant): review `ses_e69c3be20ffeQT0p45RNq9jHnp` with mutation checks (unit 10 of 10, e2e 7 of 8 killed; the survivor, the late-rows filter, is killed by the unit test); on a scratch checkout of the commit, `home-assistants` 130, `home-layout` 548, `home-windows` 269 (2 Welcome name failures from an unnamed default persona in the fresh data root), `home-press` 13, `home-contrast` 41, `dialogs-accessibility` picker and menu sheet 44; unit 623 passed; root and tests lint, `check:frontend-budgets` pass. 2026-11-01 (Home assistant cards): review `ses_e6bdd0f01ffeY4maAD47mMHxoC`; on a scratch checkout of the commit, `home-assistants` 52, `bundled-extras` 45, `home-windows` Bundled Extras 38, `home-press` 13, `home-layout` (Compact, Getting Started, Page Width, menu, shell width, assistants) 178, `action-menu-viewport` 17 of 18 (a short-landscape test passed 3 of 3 on rerun); unit 32 suites, 568 passed; lint clean. 2026-11-01 (assistant registry): review `ses_e6bdd0f01ffeY4maAD47mMHxoC` with mutation checks; unit 30 suites, 539 passed; `bundled-assistants` 18; root lint and budgets pass. Earlier (Getting Started signals and persistence; `welcome-screen.js` itself unchanged): root and tests lint pass; unit 486 suites, 7,681 passed, 2 skipped; `npm run check:frontend-budgets` passes; e2e `getting-started` 50, `home-windows` 267, `home-layout --grep "1440\|390x844"` 184, `home-state` 15, `welcome-transitions` 28, `home-contrast` 41, `home-mode-memory` 36, `home-press` 13, `action-menu-viewport` 18. |
| Rollback path | TODO(copy) |
| Last reviewed | 2026-11-05, PR #870 (template key `20261105b`). |
| Owner | TODO(copy) |

### `public/index.html`, `public/css/loader.css`, `public/style.css` and `public/script.js` - mascot boot splash
| Field | Value |
| --- | --- |
| File | `public/index.html` (`#preloader`, the splash and boot-guard script keys); `public/css/loader.css`; `public/style.css` (the `loader.css` import); `public/script.js` (one boot timing mark in `firstLoadInit()`) |
| Area | Frontend boot and startup splash. |
| Divergence reason | TODO(copy) |
| Target seam | `public/scripts/sillybunny-splash.js` (`window.SillyBunnySplash`: variant from localStorage `sb-splash-character`, one `SPLASH_LINES` pool of four lines for every character with one picked per load, the `ART` table of the three pictures with their sizes in art pixels and `ART_VERSION`, `chooseFit()` sizing all three by the tallest picture at the largest whole step within 42% of the viewport height (step 1 up to 60%, a smooth fraction beyond), a resize and screen-scale watch that stops once the preloader has gone, `.sb-boot-reduced` from localStorage `sb-reduced-motion`, the `sb-boot-inline` mark); `public/scripts/sillybunny-splash-preferences.js` (keeps those two localStorage keys current: the Splash Character choice, mirrored to accountStorage `WelcomePage_SplashCharacter` and copied back after settings load, and the Reduced Motion setting on every settings save); `public/scripts/sillybunny-splash-setting.js` (the Splash Character combo row in Customize → Interface, beside Frontend Icon, which still drives the favicon and `system_avatar`); `public/scripts/sillybunny-boot-marks.js` (the four mark names, `sb-app-ready` at `APP_READY`, `readBootMarks()` for About → Troubleshooting and `scripts/measure-frontend-performance.js`); `sillybunny-boot-guard.js` makes `sb-boot-dismiss` on the first dismissal; the pictures `public/img/sillybunny/splash-{reisen,tewi,both}@native.webp`. |
| Adapter shape | `#preloader > .sb-boot-splash` holds `img.sb-boot-mascot[alt=""]` (sized and given its source by the script before the first paint) and a `p.sb-boot-line[role=status]` (a visually hidden "Loading SillyBunny" label, a visually hidden `.sb-boot-line-reader` that holds the whole line, the line typed out in `aria-hidden` per-letter spans inside `.sb-boot-flavour` between four `aria-hidden` pixel sparkles, and `aria-hidden` dots), followed by one classic `<script src="scripts/sillybunny-splash.js?v=…">`, under `<!-- SillyBunny: -->` markers (the splash and boot-guard script keys change with those files); the inline script keeps only the boot-surface pinning. `loader.css` replaces the throbber, logo and message rules with the mascot, line and dots rules under one `/* SillyBunny: */` marker (the mascot is a still drawn `pixelated`, and `.sb-boot-mascot[data-fit='smooth']` draws a fractional fit with `image-rendering: auto`); The finished line is the base style: the letter and sparkle animations only hold them hidden until their turn (a `backwards` fill with `steps(1, end)`), so a rule that removes animations leaves the whole line. `#load-spinner` and the action-loader rules are unchanged. The `loader.css` import carries a `?v=` key (unmarked, like the sibling keyed imports) because the service worker caches `/css/` by URL; `style.css?v=` changes at both `index.html` call sites with it. |
| Protecting tests | `tests/unit/sillybunny-splash.test.js` (variant, random reaching all three, the fit: the largest whole step within the share, step 1 up to 60%, the smooth fallback, every variant at the step of the tallest picture; the size and scale watches and their end once the preloader has gone; each picture against the `ART` table; line pool, reduced-motion class, copy attributes, the inline mark); `tests/unit/sillybunny-splash-preferences.test.js`; `tests/unit/sillybunny-splash-setting.test.js`; `tests/unit/sillybunny-boot-marks.test.js`; `tests/unit/sillybunny-about.test.js` (marks in the debug text); `tests/measure-frontend-performance.test.js`; `tests/splash.e2e.js` (boot held open: chosen variant, the picture's size across a table of viewports and screen scales, `pixelated` at a whole step and `auto` when shrunk, animated dots, the loading label, reduced motion without the theme's global rule, boot completes; the reveal hidden before its turn and the whole line and every sparkle after `body.reduced-motion` arrives mid-reveal; one accessible string for the line); `tests/sillybunny-boot-guard.test.js` (recovery panel; `sb-boot-dismiss` once); `tests/topbar-upgrade.e2e.js` (`#preloader` removal); `tests/art-pixel-evenness.e2e.js` (even art pixels on the splash at real screen scales); `tests/splash.e2e.js` also covers the Splash Character row (choice stored, copied back from the account, subtitle marked), the Reduced Motion mirror and the marks in About → Troubleshooting. |
| Validation | 2026-11-05 (one line pool, typed reveal and sparkles): reviews `ses_e5a2400ecffeKGWLNkLTFigm0L` and `ses_e59a09e16ffeFoVHJm9hifB3LH`; `sillybunny-splash.js?v=20261105b`, `loader.css?v=20261105b` and `style.css?v=20261105c` at both `index.html` call sites; lint, unit and budgets pass; `splash` passes at the full matrix in Chromium, and `splash` and `art-motion` pass in the WebKit container except one boot-marks case that also fails without this change. 2026-11-04 (pixel-art mascot): reviews `ses_e5d4d2648ffexdnEL68oSOIfWb` and `ses_e5b75f68bffeKDcn6rw22524wF`; `sillybunny-splash.js?v=20261104f`, `loader.css?v=20261104f` and `style.css?v=20261104f` at both `index.html` call sites; root and tests lint pass; unit 9,033 passed (one failure that needs a checkout inside the server directory); `npm run check:frontend-budgets` passes; `splash` and `art-pixel-evenness` pass in the sharded e2e run. 2026-11-01 (setting, mirror and marks): root and tests lint pass; 133 unit suites that read these files, 2,396 passed; `splash` 24, `topbar-upgrade` 6, About Troubleshooting 6; budgets unchanged (blocking CSS 1,048,556 B, startup scripts 25 of 26). 2026-10-29: root and tests lint pass; Chromium `splash`, `home-state` and `topbar-upgrade` 35 passed; WebKit `splash.e2e.js` 12 of 12 in the Playwright 1.64.1 container (temporary config, because `playwright.webkit.config.js` covers the dialog specs only); `npm run check:frontend-budgets` passes (blocking stylesheets 1,048,556 of 1,048,576 bytes; 25 of 26 startup scripts). |
| Rollback path | TODO(copy) |
| Last reviewed | 2026-11-05, PR #870 (splash line). |
| Owner | TODO(copy) |

### `public/scripts/backgrounds.js` - Backgrounds tabs with a query string
| Field | Value |
| --- | --- |
| File | `public/scripts/backgrounds.js` |
| Area | Backgrounds panel tabs (Global, Chat) and app boot. |
| Divergence reason | TODO(copy) |
| Target seam | `initBackgrounds()`: the jQuery UI `$('#bg_tabs').tabs()` call. `public/index.html:6` (`<base href="/">`) and the tab markup (`#bg_tabs`, anchors `href="#bg_global_tab"` and `href="#bg_chat_tab"`) stay unchanged. |
| Adapter shape | Three marked lines before and after the upstream `tabs()` call: set each tab `<li>`'s `aria-controls` from its anchor's hash, pass `beforeLoad: event => event.preventDefault()`, and remove the `aria-live` jQuery UI adds to panels it treats as remote. Without them, any query string in the page URL makes jQuery UI fetch `/` into a new tab panel, duplicating the app's DOM. |
| Protecting tests | `tests/backgrounds-tabs-query.e2e.js` (query at init, query lost, query gained after init, no query: one `#sheld` and `#chat`, panels `bg_global_tab` and `bg_chat_tab`, no `aria-live`, no request for `/`). |
| Validation | 2026-10-30: the spec fails on the old code (two `#sheld`), and a reviewer's mutation runs fail it without each of the three changes; `--repeat-each=2` 8 of 8; `sillybunny-settings-consistency` and `home-state` 38 of 38; root and tests lint clean; unit suite green. |
| Rollback path | TODO(copy) |
| Last reviewed | 2026-10-30, PR #870. |
| Owner | TODO(copy) |

### `public/script.js`, `public/scripts/stats.js`, `public/scripts/slash-commands.js`, `public/scripts/power-user.js`, `public/scripts/welcome-screen.js`, `public/scripts/bookmarks.js` and `public/scripts/extensions/vectors/index.js` - Temporary Chat write seams
| Field | Value |
| --- | --- |
| File | `public/script.js`; `public/scripts/stats.js`; `public/scripts/slash-commands.js`; `public/scripts/power-user.js`; `public/scripts/welcome-screen.js`; `public/scripts/bookmarks.js`; `public/scripts/extensions/vectors/index.js` |
| Area | Chat lifecycle: a Roleplay chat with a character that is never written to disk (Temporary Chat), and every way out of a chat. |
| Divergence reason | TODO(copy) |
| Target seam | `public/scripts/sillybunny-temporary-chat-state.js` (the flag, a random reserved chat name per temporary chat, `isTemporaryChatWith`, `isReservedChatName`, `reassertReservedChatName`, `assertChatFileWritable`; no imports, so any module can ask without an import cycle) and `public/scripts/sillybunny-temporary-chat.js` (`startTemporaryChat`, `saveTemporaryChatAsNew`, `leaveTemporaryChat` with one shared leave alert and a Discard remembered against a snapshot of the messages, the banner, `beforeunload`, and the page mark and injected style that hide actions needing a chat file). The SillyBunny-owned `public/scripts/server-generations.js` (`getOpenChatTarget`) and `public/scripts/sillybunny-conversation/auto-engine.js` (`captureRoleplayDMRequest`) carry their own guards, and `public/scripts/sillybunny-tabs.js` shows the label "Temporary Chat" in the chat bar. |
| Adapter shape | One-line `// SillyBunny:` markers only. `script.js`: the state imports; `selectCharacterById({ temporary })` starts fresh and calls `getTemporaryChat()` instead of `getChat()` (which calls `showTemporaryChatError()` with no arguments on failure), and reselecting the open card passes `staying: true`; `getOneCharacter()` and `getCharacters()` put the reserved name back; `clearChat()` skips the itemized-prompt save; the save after an aborted generation is skipped; `reloadCurrentChatUnsafe()` redraws from memory for the temporary card, and ends the temporary chat and clears its itemized prompts when another card is selected; `saveChatDebounced()`, `saveChatImmediately()`, `updateRemoteChatName()` and `flushPendingChatSaves()` refuse or report success without writing; `flushPendingChatSavesForNavigation({ staying })` calls `leaveTemporaryChat()`; `renameCharacter()` leaves first; the settings payload sends `active_character: null`; `select_selected_character` writes the real chat name to `#selected_chat_pole`; `doNewChat()` never deletes the real chat after a temporary one. `stats.js`: `statMesProcess()` returns early. `slash-commands.js`: `openChat()` (`/go`, `/char`) passes the navigation seam before `setCharacterId()` and stops when it returns false; for a normal chat this also flushes a pending save first, which before was sent to the new character's file. `power-user.js`: `doRandomChat()` picks the character, then passes the navigation seam, then resets the selected group (with no match it no longer resets the group). `welcome-screen.js`: `openRecentCharacterChat()` asks before it selects, so Cancel shows no failure toast. `bookmarks.js`: `/branch-create` and `/checkpoint-create` call `assertChatFileWritable()`, whose message is plain English with no `<` or `&`, because it reaches a slash-command toast as HTML and `sillybunny-temporary-chat-state.js` has no imports. `vectors/index.js`: a module-local `getCurrentChatId` returns `''` while the chat is temporary, so the chat collection is never listed, filled, queried or purged. |
| Protecting tests | `tests/temporary-chat.e2e.js` (1440×900 and 390×844: no write outside an allowlist of read-only requests across send, swipe, edit and delete; banner and Save as New Chat; every leave path including `/go`, `/random`, group select, Recent Chats and rename; `beforeunload`; reload; vectors; actions needing a chat file hidden; Clear cache); `tests/temporary-chat-seams.test.js`; `tests/temporary-chat-navigation.test.js`; `tests/stats-temporary-chat.test.js`; `tests/unit/sillybunny-temporary-chat.test.js`; `tests/unit/sillybunny-temporary-chat-state.test.js`; `tests/chat-save-queue-runtime.test.js` (the normal save path, characterised first); `tests/server-generations-frontend.test.js`; `tests/script-export-surface.test.js` (snapshot unchanged). |
| Validation | 2026-11-04 (written copy): `tests/unit/sillybunny-temporary-chat*.test.js`, `tests/temporary-chat-seams.test.js` and `temporary-chat` e2e pass. 2026-11-01: root and tests lint pass; unit 486 suites, 7,681 passed, 2 skipped; `npm run check:frontend-budgets` passes; e2e `temporary-chat` 76 (38 at 1440×900 and 38 at 390×844), `server-generation-commit` 3, `home-mode-memory` 36, `conversation-message-actions` 4. Two review rounds ran mutations of the guards: removing `saveChatImmediately`'s, `getOpenChatTarget`'s, the stats guard, the `active_character` null, the re-asserts, the `/go` seam, the vectors wrapper, the rename leave or the Clear cache guard fails `tests/temporary-chat.e2e.js`; the `doNewChat`, `updateRemoteChatName`, `/random` and reload-mismatch guards fail unit tests. |
| Rollback path | TODO(copy) |
| Last reviewed | 2026-10-31, PR #870. |
| Owner | TODO(copy) |

### `public/script.js` - Quick Image Gen first-run seed and Welcome at first run
| Field | Value |
| --- | --- |
| File | `public/script.js` |
| Area | Settings load at boot and the first-run flow. |
| Divergence reason | TODO(copy) |
| Target seam | `public/scripts/sillybunny-first-run-defaults.js` (`showFirstRunWelcome(avatarId)`: records the boot's Welcome decision as a first run, loads `public/scripts/sillybunny-welcome.js` and runs the first-run Welcome, which resolves once the persona is named with the same writes as `doOnboarding` (`sillybunny-welcome-persona.js`; the name is trimmed); returns false only when the Welcome modules fail to load, so the upstream popup stays as the fallback; `public/scripts/sillybunny-welcome-startup.js` decides the other boots (Show at Startup, an account that never saw Welcome, the import marker `sb-welcome-import-pending`) and `sillybunny-home/welcome-boot.js` opens it at `APP_READY`; `seedQuickImageGenFirstRun()`: an absent, `null` or empty `extension_settings['quick-image-gen']` becomes `{ setupWizardSeen: true, starterPresetsSeeded: false }`; anything else is returned unchanged). The vendored `public/scripts/extensions/quick-image-gen/` files are unchanged, and the wizard still opens from its own button (`.qig-wizard-btn`). |
| Adapter shape | Three marked one-liners: the import of both helpers; `settings.extension_settings = seedQuickImageGenFirstRun(settings.extension_settings);` directly before `loadExtensionSettings(settings, …)` in `getSettings()`; and `if (await showFirstRunWelcome(avatarId)) return;` at the top of `doOnboarding()`, which keeps the upstream popup below it as the fallback. `#onboarding_template` stays in `index.html`. |
| Protecting tests | `tests/unit/sillybunny-first-run-defaults.test.js`; `tests/unit/sillybunny-welcome.test.js` (trigger matrix, persona writes, import marker); `tests/welcome-startup.e2e.js` (first run required persona, boot released once named, reload on pages 2 and 3, Escape per page, Import page, Show at Startup, an account that never saw Welcome, the import marker, the fallback popup when the Welcome module fails to load); `tests/quick-image-gen-first-run.e2e.js` (one dialog at first run: Welcome; no wizard; the three starter presets; the wizard from its button; reset and existing accounts). |
| Validation | 2026-11-01 (Welcome): root and tests lint pass; unit 502 suites, 7,993 passed; e2e `welcome-startup` 25, `quick-image-gen-first-run` 6, `home-layout` 530, `temporary-chat` 76, `home-windows`/`home-contrast`/`home-mode-memory` 342, the 19 migrated specs 237 (failures only the pre-existing ones), foundation chromium 70; a fresh data root on its own port ran 12 specs, 119 passed (the one failure pre-existing); reviewer `ses_e6d7d2e6fffeqhXP8l8ODLDSYD` killed 12 of 12 mutants. 2026-11-01: root and tests lint pass; unit 10 passed; e2e `quick-image-gen-first-run` 5, `sillybunny-preset-autosave` 14, foundation `shared-ui` and `shell-navigation` 6 passed, 4 skipped; with the seam disabled, the no-wizard and reset tests fail. |
| Rollback path | TODO(copy) |
| Last reviewed | 2026-11-01, PR #870. |
| Owner | TODO(copy) |

### `src/server-startup.js`, `src/endpoints/themes.js`, `public/scripts/extensions.js` and `public/scripts/power-user.js` - Bundled Extras
| Field | Value |
| --- | --- |
| File | `src/server-startup.js`; `src/endpoints/themes.js`; `public/scripts/extensions.js`; `public/scripts/power-user.js` |
| Area | Bundled Extras window: extension, preset and theme actions; theme creation on the server. |
| Divergence reason | TODO(copy) |
| Target seam | `src/endpoints/sillybunny-bundled-themes.js` (`POST /api/sillybunny/themes/install-bundled` with `{ id }`: allowlist lookup, `node-fetch` with `redirect: 'error'`, a deadline over headers and body that aborts the request, a 512 KiB streaming cap, the sha256 checked before parsing, flat-object theme validation, sanitised name, 409 for an existing theme, 10 installs per 60 s per user); `src/sillybunny-bundled-themes.js` (the pinned allowlist and its start-up check); `src/sillybunny-publish-file.js` (exclusive publish through a hard link, with an exclusive copy where the file system has none); `public/scripts/sillybunny-bundled-extras.js` and `public/scripts/sillybunny-home/bundled-extras-{window,actions,adapters,presets}.js` on the client. |
| Adapter shape | One-line `// SillyBunny:` markers. `server-startup.js`: the router import and one `app.use('/api/sillybunny/themes', …)` beside the other `/api/sillybunny/*` routers. `themes.js`: `/create` (a fork route) publishes through the shared helper. `extensions.js`: `isOfficialExtension` treats `github.com/SillyBunnyTeam/` as first party (anchored regex); `confirmAndDeleteExtension(name)` is the old `onDeleteClick` body, exported, and the panel's handler calls it. `power-user.js`: `switchUiTheme` is exported, and `registerUiTheme(theme)` adds a theme saved by another route to the theme list and select. |
| Protecting tests | `tests/unit/sillybunny-bundled-themes.test.js` (70, including a real local server for redirects, an endless body and stalls); `tests/unit/sillybunny-publish-file.test.js`; `tests/unit/sillybunny-official-extension.test.js` (official check, escaped delete confirm); `tests/unit/sillybunny-bundled-extras*.test.js`; `tests/bundled-extras.e2e.js` (1440×900 and 390×844: row states and actions, the panel's delete confirm with its clean-up option, per-preset Restore without selecting, the theme route on 201 and 409). |
| Validation | 2026-11-01: root and tests lint pass; unit 27 suites, 451 passed; e2e `bundled-extras` 30; `npm run check:frontend-budgets` passes; reviewer mutation runs killed 13 of 14 server mutants (the survivor is an equivalent early exit); Bun 1.3.12 and Node 26.10 both boot and give the same answers for redirects, an endless body, stalls and `/api/themes/create`. |
| Rollback path | TODO(copy) |
| Last reviewed | 2026-11-01, PR #870. |
| Owner | TODO(copy) |

### `src/endpoints/content-manager.js` and `src/endpoints/presets.js` - Restore default presets
| Field | Value |
| --- | --- |
| File | `src/endpoints/content-manager.js` (`restoreDefaultPresetFiles`); `src/endpoints/presets.js` (`POST /api/presets/restore-defaults`) |
| Area | Bundled default presets: the Presets panel's "Restore default presets" button. |
| Divergence reason | TODO(copy) |
| Target seam | none yet: `restoreDefaultPresetFiles` and the `restore-defaults` route are SillyBunny additions inside upstream-origin files (added in `98affc781`). |
| Adapter shape | The route passes the user's directories and the preset types to `restoreDefaultPresetFiles`, which brings back every bundled preset whose file is missing, deleted or never seeded, with an exclusive copy (`COPYFILE_EXCL`, one-line marker): a file that is there, edited or not, is never written over and is not reported as restored. A written preset gets its permissions set and its deletion record cleared. |
| Protecting tests | `tests/default-preset-deletions.test.js` (an empty folder gets every bundled preset; a deleted preset comes back with its record cleared; an edited bundled preset and a custom preset keep their content; a file that appears during the restore is kept; only written presets are listed). |
| Validation | 2026-11-01: root and tests lint pass; unit `default-preset`, `content-manager` and `preset` 10 suites, 139 passed; mutants with the forced copy (5 fail), a check-then-copy (1 fails) and kept files listed (4 fail); the real route on Bun and Node restored only the deleted preset and kept an edited `Default` and a custom preset. |
| Rollback path | TODO(copy) |
| Last reviewed | 2026-11-01, PR #870. |
| Owner | TODO(copy) |

### `src/endpoints/content-manager.js` - managed bundled content reconcile
| Field | Value |
| --- | --- |
| File | `src/endpoints/content-manager.js` (`seedContentForUser`) |
| Area | Bundled default content per user at start-up: managed cards, sprite folders and worlds. |
| Divergence reason | TODO(copy) |
| Target seam | `src/sillybunny-managed-content.js` (`createManagedContent` → `status`, `reconcile`, `apply`, `restore`, `stateSignature`; fingerprints of a card's authored fields and image, of each sprite file, and of a world's entries and root `extensions`; classification `current`, `updated`, `modified`, `deleted`; backups in `<user>/backups/managed/`, the newest 5 per item); `scripts/build-managed-manifest.js` writes `default/content/sillybunny-managed.json`. With no manifest, nothing is managed. |
| Adapter shape | Three marked edits: the import of `reconcileManagedContent`; `seedContentForUser` exported with an optional fourth argument (`managedDirectory`) so tests can point it at fixtures; and one `reconcileManagedContent(...)` call after `reconcileManagedBundledThemes`, before seeding, so a newly seeded item is never classified on its first start. |
| Protecting tests | `tests/unit/sillybunny-managed-content.test.js` (fingerprints, pinned literal hashes, classification, merge keeps personal fields, sprites, worlds, backups and retention, path guards); `tests/managed-content-app-roundtrip.test.js` (the real characters router: favourite, tags, editor save with CRLF multipart, world link and unlink, rename); `tests/managed-content-seeding.test.js`; `tests/managed-content-fixtures.test.js` (committed fixtures equal the generator); `tests/managed-manifest-script.test.js`; `tests/unit/sillybunny-managed-content-signature.test.js`. |
| Validation | 2026-11-01: root and tests lint pass; managed suites 304 passed, 19 related suites 565 passed; reviewer `ses_e6c1bf662ffec7EodqYE0Blhuv` mutants all killed after fixes (personal-field merge, deleted detection, containment, `lstat`, backup order, normalisations); fixture generator, manifest CLI and a seed/reconcile/apply/restore probe byte-identical under Node v26.10.0 and Bun 1.3.12; both runtimes boot. |
| Rollback path | TODO(copy) |
| Last reviewed | 2026-11-01, PR #870. |
| Owner | TODO(copy) |

### `src/server-startup.js` - managed content routes
| Field | Value |
| --- | --- |
| File | `src/server-startup.js` |
| Area | Private REST routes: status, update and restore of managed bundled content. |
| Divergence reason | TODO(copy) |
| Target seam | `src/endpoints/sillybunny-managed-content.js` (`createManagedContentRouter({ bundledDirectory, createService, rateLimit })`: `GET /status` memoised per user on `stateSignature()`; `POST /apply` and `POST /restore` take exactly `{ filename }`, looked up by equality in the manifest; 20 changes per 60 s per user; error codes only in responses, logged with a constant format string). |
| Adapter shape | Two marked lines in `setupPrivateEndpoints`: the router import, and `app.use('/api/sillybunny/managed-content', …)` after the themes mount, so CSRF, login and the per-user directories apply. |
| Protecting tests | `tests/unit/sillybunny-managed-content-router.test.js` (bad bodies, unknown and path-like names against a real temp tree, per-user isolation, generic errors, log format, rate limit including unknown names, backup before write); `tests/unit/sillybunny-managed-content-signature.test.js`. |
| Validation | 2026-11-01: root and tests lint pass; router and signature suites 87 passed; reviewer `ses_e6c15c276ffekMopI2GmmU22vg` APPROVE (live on Node v26.10.0 and Bun 1.3.12: 403 without a CSRF token, 404, 400 and 429 with `Retry-After`); the log-format, signature and rate-limit gaps it found are fixed and red-tested. |
| Rollback path | TODO(copy) |
| Last reviewed | 2026-11-01, PR #870. |
| Owner | TODO(copy) |

## Review Checklist
- Does the upstream-origin file contain only adapter wiring and concise comments?
- Does the target seam have a small interface and concentrated implementation?
- Does at least one test protect the divergence?
- Does the rollback path avoid user data changes?
- Does the PR keep upstream sync work separate from fork feature work?
- Did validation name the lifecycle affected: fresh install, restart after update, stale assets, mobile viewport, long chat, streaming, swipe, or settings save?
