# Dialogs Reference

SillyBunny shows overlays through one frame with three tiers: Alert, Dialog and Window. This page is
for contributors and agents who build or change those surfaces. It describes the code as built.
Visual rules are in [DESIGN.md](../DESIGN.md#dialogs) and are not repeated here.

Code lives under `public/scripts/`: `sillybunny-editor/dialog.js` (`openDialog`, `openAlert`),
`popup-frame.js` (`framePopup`, the hook `popup.js` calls), `overlay-host.js`, `breakpoints.js`, the
row, selection, list and side panel modules, and `adapters/`. Menus are in
`sillybunny-action-menu.js`. Dialog CSS is in `public/css/sillybunny-theme.css`.

## Choosing a Tier

- **Alert**: a message, a confirmation, a one-field prompt, or at most one boolean option. Use `openAlert`.
- **Dialog**: a form or an action dialog. Use `openDialog`.
- **Window**: a list, an editor or a viewer. Use `openDialog({ tier: 'window' })`.

For `Popup`, pass `tier: 'alert'`, `'dialog'` or `'window'`. Sizes and header rules are in
[Dialogs](../DESIGN.md#dialogs). Promotion in the code:

- A `Popup` that maps to Alert becomes a Dialog (`shouldPromoteAlert`) when `.popup-content` holds
  more than one checkbox, a `select`, `textarea`, `button` or non-checkbox `input`, when it is an
  INPUT with more than three rows, or when the content is taller than half the viewport. The main
  input and `customInputs` do not count.
- A Dialog never becomes a Window by itself. Window comes only from an explicit `tier: 'window'` or
  the upstream `large` flag. `wide` and `wider` give a Dialog.
- An explicit `tier` skips promotion. DISPLAY is the exception: it has no responses, so
  `tier: 'alert'` becomes a Dialog to show Close.

## openDialog and openAlert

Examples import from a file in `public/scripts/`. `openDialog(options)` returns a handle.

| Option | Default | Notes |
|---|---|---|
| `tier` | `'dialog'` | `'window'` selects Window. Any other value gives a Dialog. |
| `title`, `subtitle` | none, `''` | Header title (required) and a dimmed line under it. |
| `content` | `null` | An element, a fragment, or `(body) => void` that fills the scrolling body. |
| `size` | `'fill'` | Window only. `'content'` follows the content; the height only grows while open. |
| `className` | `''` | Added to the surface, or to the page when pushed. |
| `responses` | `null` | `null` is immediate apply, with Close at the header end. |

`responses` is an object; any non-null value shows Cancel, even `{}`:

- `cancel: { label }` at the header start. The label defaults to "Cancel"; the id is `'cancel'`.
- `affirmative: { id, label, appearance, enabled }` at the header end. Defaults: id `'affirmative'`,
  appearance `'suggested'`, enabled `true`. Use `'destructive'` for destructive actions.
- `extra: [{ id, label, appearance, enabled }]` in a bottom bar, aligned to the end.

`canClose(reason)` returns a boolean or a promise; `false` keeps the frame open. Reasons: `'close'`,
`'cancel'`, `'back'`, `'affirmative'` (any affirmative id), an extra response id, `'escape'`,
`'scrim'`, `'swipe'` and `'programmatic'`. While an async check is pending, other close attempts are ignored.
`initialFocus` is `() => HTMLElement`. Without it, focus goes to the search field or toggle, the
first focusable body control, Cancel, and finally Close.

`search` takes `onChange(query)`, `placeholder` and `label` (default "Search"), `debounce` (`0`),
`collapsed` (hide the field until the toggle is used), `input` (adopt an existing input, returned on
close), `escapeClearsFirst` and `onEscape(event)` (return `true` to take the key). `menu(trigger)`
returns `openActionMenu` sections on every click. The ⋮ button is named `menuLabel`, or "Menu"; the
menu title is `menuLabel`, or the page title.

The handle has:

- Elements: `root` (the `<dialog>`), `surface`, `page`, `header`, `headerStart`, `headerEnd`, `titles`,
  `titleNode` and `body`. `menuButton`, `closeButton`, `search` (a `createListSearch` control),
  `searchInput` and `searchToggle` are `null` when absent. `closeButton` is `null` with `responses`.
- `setTitle(text)`, `setSubtitle(text)` and `setResponseEnabled(id, enabled)`.
- `closed`, a promise of `{ response }`. Dismissal resolves `'cancel'` with responses and `'close'`
  without. A response button resolves its id.
- `close(response, reason = 'programmatic')` goes through `canClose` and returns a boolean or a
  promise. `forceClose()` skips it. `push(spec)` opens a page. `isOpen` tells whether it is still open.

```js
import { t } from './i18n.js';
import { openDialog } from './sillybunny-editor/dialog.js';
import { createEntryRow, createPrefGroup } from './sillybunny-editor/rows.js';

const name = createEntryRow({ label: t`Name`, field: 'profile-name' });
const dialog = openDialog({
    title: t`Create Profile`,
    content: createPrefGroup({ field: 'profile', rows: [name] }).section,
    responses: { affirmative: { id: 'create', label: t`Create` } },
});
const { response } = await dialog.closed;
if (response === 'create') saveProfile(name.getValue());
```

`openAlert(options)` resolves with the id of the activated response. `heading` and `responses`
(`[{ id, label, appearance, enabled }]`, in display order) are required. Optional: `body`, `bodyNode`
(used instead of `body`), `extra` (a node below the body, for example one switch row), `defaultResponse`
(`null`), `closeResponse` (`'cancel'`) and `preferWide` (`false`, allows up to 600px). Escape, a scrim
click (floating only), a swipe or a native close resolve `closeResponse`. An Alert has no `canClose`.

List Cancel first and the affirmative response last. `appearance` is `'suggested'` or `'destructive'`.
For destructive defaults, leave `defaultResponse` as `null` and give Cancel the id in `closeResponse`:
focus starts on Cancel and Return confirms nothing. Return activates `defaultResponse` only when focus
is not on a button, textarea, select or link.

```js
const response = await openAlert({
    heading: t`Delete Tag?`,
    responses: [
        { id: 'cancel', label: t`Cancel` },
        { id: 'delete', label: t`Delete`, appearance: 'destructive' },
    ],
});
if (response === 'delete') deleteTag();
```

## The Popup Options tier and title

`Popup` takes three extra options: `tier` (`'alert'`, `'dialog'` or `'window'`, default `null`), `title`
(default `null`) and `size` (`'fill'` or `'content'`, Window only). The constructor calls
`framePopup`. `show()` calls `opened()` after `showModal()`, and the hide path calls `closing()` and
`dispose()`. `onOpen` runs after the frame is built. `resolvePopupTier` decides in this order:

1. An explicit `tier`.
2. CROP, `transparent` and image-zoom content keep their own frame.
3. `large` gives Window. `wide`, `wider` and DISPLAY give Dialog.
4. Otherwise Alert, or Dialog after promotion.

A given `title` becomes the heading and does not remove a heading still in the content, so adapters
remove it. Without `title`, the leading `h2`, `h3` or `.popup-header` of the content moves into the
header (the element itself, so `data-i18n` stays). An Alert keeps it in place.

For third-party extensions the guarantee is functional, not visual
(`tests/unit/popup-contract.test.js`): the constructor signature, `POPUP_TYPE`, `POPUP_RESULT`, return
values, `inputResults` keyed by id, `onOpen`, `onClosing` and `onClose` timing, the public element
properties, and the classes `.popup`, `.popup-body`, `.popup-content`, `.popup-controls`,
`.popup-input`, `.popup-inputs` and the OK, Cancel and Close classes. OK stays before Cancel in DOM
order, `dlg` stays the native modal, and caller content stays directly inside `.popup-content`.
Not guaranteed: where controls sit. Dialog and Window move `.popup-controls` into the header, so
`.popup-body > .popup-controls` no longer matches; Alert moves it after the body. Leading headings
leave `.popup-content`. The default CONFIRM negative button is relabelled "Cancel" unless the caller
passes `cancelButton`. `customInputs` checkboxes become switch rows around the same input and id.

## Moving a Popup Caller to the Frame

An adapter takes the upstream markup and returns `Popup` options, as `utilityFormOptions` and
`accountFormOptions` do. Callers spread the result: `new Popup(html, type, '', { okButton, ...options })`.

1. Keep the upstream template as the markup source. Put the adapter in `sillybunny-editor/adapters/`
   and return an explicit `tier`, and a `title` when the content has no leading heading.
2. Adopt controls, never clone them. Pass `input`, `select` or `inputs` to the factory so `id`, `name`,
   `value`, `data-*` and listeners survive. `field` is only a `data-sb-editor-field` marker. Move
   caption nodes into `.ds-row-label` with `moveCaption(target, source, options)` from `rows.js`. It
   copies `data-i18n` and removes the emptied source. `copyId`, `keepSource` and `stripColon`
   cover the adapters that need more.
3. Reshape Popup-built controls in `onOpen(popup)`: move `popup.mainInput` into a row, then empty and
   hide `popup.inputControls`. Popup still reads `inputResults` by id.
4. In `onClose`, call `releaseRowIds(popup.content)` and `row.destroy()`. Destroying a select row
   puts the adopted select, and its select2 container, back where it was, so code that reads the
   select after the dialog resolves still finds it.
5. For destructive confirmations, pass `defaultResult: POPUP_RESULT.NEGATIVE` and add `is-destructive`
   to `popup.okButton`.
6. An edit to an upstream-origin call site needs a `SillyBunny:` marker and an entry in
   [upstream-touch-ledger.md](upstream-touch-ledger.md).

```js
export function renameOptions() {
    return {
        tier: 'dialog',
        title: t`Rename`,
        onOpen(popup) {
            const row = createEntryRow({ label: t`Name`, field: 'rename', input: popup.mainInput });
            popup.content.append(createPrefGroup({ field: 'rename-fields', rows: [row] }).section);
            popup.inputControls.style.display = 'none';
        },
        onClose(popup) { releaseRowIds(popup.content); },
    };
}
```

Pick rows by the hierarchy in [Selection Controls](../DESIGN.md#selection-controls) and
[Settings Rows](../DESIGN.md#settings-rows):

| Need | Factory |
|---|---|
| One boolean | `createSwitchRow` |
| Pick several | `createCheckRow` per item, plus Select All above five items |
| Two or three exclusive options | `createToggleRow` (`choices`, `fill`, `inputs`) |
| Four or more exclusive options | `createComboRow`, or `createSelectRow` over an adopted select |
| Text, number, read-only | `createEntryRow` (`floating`, `secret`), `createSpinRow` (`normalize: false` keeps upstream validation), `createPropertyRow` |
| Section, action | `createExpanderRow`, `createButtonRow` (`danger`), `createRow({ activatable: true })` |
| Group of rows | `createPrefGroup({ title, subtitle, rows })`, then use `.section` |

Every factory returns `{ row, setDisabled, setVisible, destroy }`, plus `control` when there is one.
Value rows add `getValue()` and `setValue(value, { silent = true })`.

## Stacking and Pages

- One Alert may open above any surface. It is its own host, never a page. `openDialog` called while an
  `openDialog` frame is on top pushes a page and returns a page handle. `tier` and `size` are ignored
  and the page takes the parent's geometry. `handle.push(spec)` does the same.
- A page handle has `closed`, `close`, `pop` (the same as `close`), `forceClose`, `push` and
  `isOpen`. Its default response is `'cancel'` with responses and `'back'` without.
- Page headers: with explicit responses, Cancel acts as Back and the affirmative stays at the end,
  with no Close. Without responses, Back is at the start and Close at the end.
- A `Popup` Dialog or Window opened over a frame stays its own native `<dialog>`. `framePopup` places
  it over the parent surface (`sb-dialog--page`), makes the parent inert, and shows Back and Close
  like an `openDialog` page. An `openDialog` called while a framed Popup Dialog or Window is on top
  does the same: it presents as a page over that Popup, never as a second visible frame.
- Close walks the chain from the top page down to the chain root, one level at a time
  (`sillybunny-editor/page-chain.js`). Each level closes through its own path: a Popup completes
  with its cancel result, so `onClosing` can veto; an `openDialog` frame runs its root
  `canClose('close')`, not the `canClose` of a page pushed inside it. Each level finishes before the
  next starts. The walk stops at the first level that refuses, which leaves the same state as
  pressing Back that many times.
- Each chain shows one dim. A page over a bottom sheet takes the sheet's shape, grab handle and header
  offset, and a swipe on that handle goes back one level.
- When code removes a level that pages cover, the pages above it close as Back would, from the top.
  A page that refuses stays open on its own, keeps its last position and dims itself.
- Escape pops first. An open search closes before anything else. Then Escape pops the top page
  through that page's `canClose('escape')`. Only the last page asks the root `canClose('escape')`.
  Scrim clicks and swipes take the same path. Menus, pickers and popovers handle Escape first.
  Back, Escape and code resolve an `openDialog` page with `'back'` (`'cancel'` with responses), and a
  chain Close resolves it with `'close'` (`'cancel'` with responses). A Popup page resolves with its
  cancel result either way.
- Each page has `isolation: isolate`, so a `z-index` inside one page cannot paint over another while
  pages slide. Do not depend on z-index across pages.
- A modal `<dialog>` makes everything outside it inert. Mount floating layers that open from a dialog
  with `hostOverlayLayer(layer)`; `releaseOverlayLayers` moves them back on close.

## Selection Mode, Menus and Popovers

See [Selection Mode](../DESIGN.md#selection-mode) and
[Menus and Popovers](../DESIGN.md#menus-and-popovers).

- `createSelectionMode({ root, list, header, actionBar, actions, ... })` needs `root`, `list` and
  `actionBar`, and a standalone `header` unless `headerSlots` is given. Pass `headerSlots` (`header`,
  `headerStart`, `headerEnd`, `titleNode`, and optionally `search` and `closeButton`) to put Cancel,
  Select All and the count in a dialog header. The slots are read when selection starts and are not
  changed. The handle exposes `cancelButton`, `selectAllButton` and `selectionTitle`.
  `iconOnlyAtNarrow: true` hides action labels under the overlay breakpoint; actions keep their
  `aria-label` and `title`.
- `openActionMenu({ trigger, sections, title, bounds, forcePopover, onClose })` opens a popover, or a
  bottom sheet under the overlay breakpoint. A second call for the same trigger closes it. Sections
  are `{ items: [{ label, icon, danger, onSelect }] }`. From a dialog, pass `bounds: dialog.surface`,
  and give every item an explicit `icon`. `openPopover({ trigger, content, title, bounds,
  initialFocus, onClose })` shows an element the same way and returns `{ close, isOpen }`.
- Every bottom sheet has the shared grab handle and a swipe-down that follows the finger, springs
  back when short, and closes through the sheet's normal close path. For a new sheet, use
  `createSheetHandle()` and `bindSheetSwipeClose({ sheet, backdrop, headerSelector, close })` from
  `sillybunny-editor/sheet-gestures.js`, or `bindSheetGestures` for full control.
- `createListEditor` (`list-shell.js`) can fill `dialog.body`. `collapseAt` (default `720`) is the root
  width under which the panes stack; it also collapses at 768px. `isListEditorCollapsed({
  viewportMobile, width, collapseAt })` is the same rule, for code that must agree with the editor.
  `transitionItemSwitch` (default
  `true`) cross-fades the detail when the open item changes. `escapeCloses` (default `true`) closes the
  detail on Escape. The Chat Archive sets both to `false` inside its dialog. See
  [List → Split Editor](../DESIGN.md#list--split-editor).

## Side Panels

Rules: [Side Panels](../DESIGN.md#side-panels). `registerSidePanel({ id, element, title, defaultSide,
onClose })` in `side-panel.js`:

- `id` and `title` are non-empty strings, `defaultSide` is `'left'` or `'right'`, and `onClose` is
  optional. `element` must already be attached. Registering wraps it in a panel shell, and
  `unregister()` puts it back.
- It returns `{ isOpen, open({ opener }), close({ restoreFocus, notify }), moveToOtherSide(),
  unregister() }`. `open` is async because it waits for the lazy stylesheet and the layout.
- The side is saved under the panel `id` in `movingUIState` through
  `configureMovingUIState({ getState, setState })`. The open state is not saved.
- Panels are 280 to 420px wide. When the chat would drop under 360px, the latest open panel becomes a
  sheet and the others close. A sheet closes with a swipe down from its handle or header. Escape
  goes through `closeTopmostSidePanelOnEscape(event)`.
- Registered today: `floatingPrompt` (left), `cfgConfig` (left) and `logprobsViewer` (right) in
  `adapters/side-panels.js`, and `sb-chat-sidebar` (right) in `sillybunny-tabs.js`.

## Breakpoints

From `sillybunny-editor/breakpoints.js`:

- `OVERLAY_SHEET_QUERY` is `(max-width: 450px), (max-height: 360px)`. Alerts, dialogs, windows, menus,
  pickers and popovers become bottom sheets. In CSS, use the same condition in `@media`.
- `LAYOUT_MOBILE_QUERY` is `(max-width: 768px)`. It drives layout only: the settings sidebar, list
  editor collapse and message action row. Touch target size follows `(pointer: coarse)` instead.
- `MOBILE_QUERY` in `sillybunny-action-menu.js` is a deprecated alias of the overlay query.

## Testing Checklist

- Never test against a maintainer's live server. The Playwright base URL falls back to
  `http://127.0.0.1:4444`, the default port of a normal install. Set `SILLYBUNNY_TEST_BASE_URL` to an
  isolated test server (`--port` and `--dataRoot` are server options). Specs that call
  `assertIsolatedServer` refuse port 4444 outside CI.
- Call `protectMaintainerServer(page)` from `tests/helpers/maintainer-server.js` before each test. It
  stubs settings, chat, character, group, preset, secret and agent writes and hides toasts
  (`showToasts(page)` shows them again). Add your own `page.route` after it for any other write or
  destructive endpoint, and assert that Cancel never reaches it. The route added last runs first,
  so end a catch-all handler with `route.fallback()`, not `route.continue()`, to keep the protection
  under it.
- In a route handler that reads the real response, use `fetchJsonOrSkip(route)` or
  `fetchBodyOrSkip(route, readBody)` from `tests/helpers/route-fetch.js`. A plain `route.fetch()`
  throws when the test ends while the request is still in flight.
- The data root keeps the saved `reduced_motion` setting. A spec that asserts motion sets
  `power_user.reduced_motion` to `false` through settings interception. With motion on, a closing
  `dialog.popup` keeps `[open]` with `[closing]` until it is removed, so match `:not([closing])`.
- Check 1440×900 (floating), 390×844 (sheet) and 844×390. At 390px tall a landscape phone is not a
  sheet, because the height query stops at 360px. Use 360px or less to test the landscape sheet.
- The last content is reachable: scroll the body to the end, with and without the keyboard inset, and
  confirm the bottom bar does not cover the last row.
- Switches and checks sit at the row end. Cancel is at the header start and the affirmative response
  at the end, with no Close.
- Destructive defaults: Cancel has focus, Return does not confirm, and Escape, scrim and swipe
  resolve Cancel. Focus returns to the opener, and Escape pops a page before it closes the frame.
- Existing suites: `tests/unit/` has `sillybunny-dialog`, `sillybunny-popup-frame`, `popup-contract`,
  `side-panel` and the `*-dialogs` adapter tests. `tests/*.e2e.js` has `sillybunny-dialog-frame`,
  `sillybunny-dialog-tiers`, `popup-scroll`, `native-dialog-replacements`, `side-panel-engine` and the
  `*-dialogs` specs.
