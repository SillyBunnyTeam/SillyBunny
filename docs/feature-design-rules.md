# Feature-Specific Design Rules

Moved verbatim from `DESIGN.md` on 2026-11-12, when `DESIGN.md` and `DESIGN.json` were limited to patterns. These rules describe single features of the application. Where a rule here differs from `DESIGN.md`, `DESIGN.md` is right.

## Chat Transcript

The chat is the product's core, so its messages have their own pattern.

- **Action row:** Actions sit in the message name row at the inline end; the name truncates before they move. Targets use `--sb-message-hit-size`, icons `--sb-message-glyph-size`, and swipe arrows `--sb-message-icon-size`. A coarse pointer shows Edit, then the menu button; a fine pointer shows Copy, Edit, then the menu button, which is the vertical ellipsis and always last. The set follows the pointer, not the window width. Every chat style keeps this contract; mirrored user rows (echo, tide) anchor the actions and menu to their start edge.
- **Expanded row (fine pointer):** Holding Shift while the pointer or focus is in a message expands its row to every menu action as icons, in menu section order. It stays expanded until the pointer or focus leaves the message or Escape is pressed; Shift does nothing while focus is in a text field. The menu button tooltip carries the hint "Hold shift to expand." The Expand Message Actions setting keeps every row expanded and drops the hint. Section dividers hide once the row wraps; a row that does not fit beside the name moves below it.
- **Message menu:** Every other action, including checkpoint, Delete, and extension buttons, is a labelled row with a dimmed icon and the action's existing title. Sections are split by separators with no headings, in this order: reply actions (Delete + Add Swipe, swipe history, Narrate, Translate, image generation), copy (Copy, Screenshot), chat structure (branch, checkpoint, hide or include), tools (Prompt, agent changes, trackers, companions, card scripts, Embed, media display), other extension buttons, then Delete alone in Destructive Red.
- **Menu surface:** A popover anchored to the menu button, trailing-aligned, that flips above when there is no room below and stays inside the chat width. In the mobile layout (up to `768px` wide, or up to `360px` tall) it is a bottom sheet titled with the message's sender and position, with Close, that traps focus. Focus returns to the menu button. Right-click on the name row, Shift+F10, and the Menu key open the same menu; long-press on message text does not, so text selection keeps working. It closes on action, Escape, outside tap, generation start, and chat change, and the popover also on scroll. Arrow, Home, and End move between rows.
- **Edit row:** Cancel, Confirm, then the edit actions in sections: Copy this message and Add a reasoning block; Move up and Move down; then Delete this message alone in Destructive Red. A coarse pointer puts them behind the menu button; a fine pointer shows them inline after a divider. At the chat edges Move up and Move down stay, disabled: the one exception to omitting items that do not apply. Edit buttons are flat circles whose text colour shows the role: success for Confirm, Destructive Red for Delete, the body colour for Cancel, and Accent otherwise. Cancel is neutral because Warning Yellow means caution, not cancel (HIG UI Styling). Hover and press use a `12%` and `20%` tint of the action's colour. Deviation: several coloured actions share one row; the HIG reserves strong colour for a single suggested or destructive button per view.
- **Delete:** Delete always confirms, regardless of the confirm-deletion setting, with the destructive alert (see Dialogs); Return never confirms a deletion.
- **Labels and touch:** Icon-only buttons keep a `title` or `aria-label`. On touch, press-and-hold shows that label as a tooltip without triggering the action, and fills use `:active` so they do not stick after a tap.
- **Sprite slot:** In Echo, Whisper and Ripple, the large picture slot of a character's message shows the character's current expression sprite when the character has a valid one, and the profile picture when not. The small round avatar in the name row stays the profile picture, and user, system and narrator messages keep theirs.
- **Reasoning:** The header is a libadwaita expander row: neutral raised fill, `10px` radius, no border, inset focus ring. The body keeps the upstream thin left rule in the reasoning ink colour.
- **Conversation layout:** A Fractal-style split view: an opaque pals sidebar (`220–280px`, `--sb-conv-sidebar-bg`: `#2e2e32` in Libadwaita dark, `#ebebed` in light) with its own header bar, and a content column of header bar, search bar, full-width timeline (`20px` gutters) on `--sb-layer-view`, and composer on `--sb-layer-bottombar`. Settings is a third split-view column when the chat area (`#sheld`) is at least `1120px` wide; an overlaid pane over a shade from `670px`, which Escape or a press anywhere outside it closes; and a pushed page in the mobile layout or below `670px`, where the pals, chat and settings are full pages. The pals list stays in recency order; selecting a thread does not move it.
- **Conversation messages:** Messages group on sender change, a 20-minute gap, or a day boundary; only the first of a group shows avatar, name, and locale time. Own bubbles are end-aligned with no avatar (`--sb-conv-bubble-own-bg`); others are start-aligned with a reserved `36px` avatar slot (`--sb-conv-bubble-other-bg`). Outer corners are `18px`, attached corners `6px`. Day dividers sit between calendar days, reactions are toggleable chips under the bubble, and receipts sit under the last own message of a group.
- **Conversation actions:** With a pointer that can hover, an opaque pill toolbar appears on hover or `:focus-within`, overlapping the top-end corner of every bubble, own or not: flat quick reactions, a divider, Reply, Edit, Copy, and the menu button, at the touch-target floor. It hides the name and time it would reach. In a timeline narrower than `512px` its secondary actions leave it for the menu, and below `340px` the reactions too. Shift and Expand Message Actions expand it to every menu action. On a coarse pointer, a vertical-ellipsis trigger beside that corner (`44px` hit area, reporting `aria-expanded`) opens the menu, as a bottom sheet in the mobile layout. Compact mode shrinks the toolbar's icons on a fine pointer; its targets keep their floor. Menu sections: quick reactions; Reply, Edit, and Polish; Copy, Pin, and Branch; Speak and Regenerate; then Delete alone in Destructive Red, confirmed with the same alert.

## Shell

- **Layer 1:** The main chat window is the primary surface with a bottom bar for direct conversation actions.
- **Layer 2:** An always-visible top bar. Start: Backend, Customize, Search, and up to three quick-access slots. Centre: the title, which shows the active character's name by default. End: an extension slot, up to three quick-access slots, the mode switcher (Roleplay or Conversation), Home, and Characters. Quick access is configurable and desktop-only.
- **Layer 3:** Backend and Customize open a full-screen settings page: a sidebar of pages with its own heading and settings search (HIG Sidebars), and a content pane headed by the page title and description. Page labels are nouns in header capitalisation and of similar length. The HIG asks that, in preferences, one page's controls never change the controls on another page (HIG View Switchers). Deviation: the backend chosen in Connections decides which controls Sampling, Presets, and Formatting show (upstream SillyTavern behaviour).
- **Layer 4:** Page content holds the options for that page.
- **Desktop:** Keep the existing top-bar actions and chat-navigation rows visible. Users may hide the Guided Generations and Chat Navigation rows in settings.

## Side Panels

- **Use:** Non-modal utility panes that keep the chat available, such as Author's Note. Panels do not use a scrim or focus trap.
- **Layering:** Docked panels sit over expression sprites and zoomed avatars. In visual-novel mode, the sprite area follows the chat's free area between panels.

## Boxed Lists and Rows

- **Cards:** Home and first-run shortcuts may use a centred icon and text, but stay sparse, labelled, and helpful rather than decorative.
- **Row types:** a profile row adds folders, favourites, and a ⋮ only when it has actions.
- **List rows:** Deviation: with a grip a row has three controls in total, exceeding the boxed-list maximum of two, for consistency with the prompt list; there are never three trailing controls.
- **Reordering:** Deviation: prompt rows still lack move menu items until the libadwaita TODO follow-up; their grip/keyboard reorder remains available.
- **Prompt list:** The prompt editor replaces upstream's Prompt Manager list. The upstream list is still built, hidden, because code and extensions read it, so what an extension draws into it (Bunny Preset Tools' prompt sections, extra row buttons) does not show. This is an accepted compromise of the rebuilt editor (maintainer, 2026-11-20): do not show the upstream list again to bring that content back.

## Colours, Typography and Shapes

- **The chat column** is the raw chat tint on mobile (upstream's rule) and `--sb-chat-view-bg` on desktop, so the bundled 0.9 tints stay opaque and lower tints show the background. The page behind `#sheld` mixes BlurTint toward Body, so the main window stays distinct from the canvas in every theme.
- **Paper Texture:** An opt-in grain over the canvas and chat column. It takes its colours from the active theme and never overrides border or message tints. Deviation: the HIG advises against text over textures or graphical backgrounds; the grain and chat backgrounds stay opt-in and must still meet the Contrast Rule.
- **Toolbars:** The top bar, bottom chat bar, and composer are separated by a `1px` shade line only. The generating state keeps its accent border and progress bar and has no outer glow.
- **Overlay** (`--sb-radius-overlay`, `15px`): popovers, menus, dialogs, windows, shell drawers, toasts, and the composer stack. Bottom sheets round their top corners only. Docked side panels are square.
- **The Single Shell Rule:** there is no Shell Style picker, and stored legacy `sb-theme` values are ignored.
- **Mono Font:** Adwaita Mono for logs, prompt fragments, regex, token diagnostics, and structured output (`--monoFontFamily`).
- **Display:** Home and first-run welcome titles only; never a control label.
- **Content:** The welcome surface may use `20px`.

## Menus, Dialogs and Chips

- **Dialogs, Surface:** the body of a document Window (a notes, editor, or output viewer) uses View.
- **Menus, Icons:** Every command item has an explicit, relevant icon, never the action-menu fallback puzzle-piece glyph.
- **Menus, Menu buttons:** Its tooltip and accessible name name the menu ("Menu", or more specifically "Message Menu").
- **Chips, Use:** In-chat agent controls and metadata, and status chips in list rows; do not turn the bottom bar into a chip collection.
