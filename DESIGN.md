---
name: SillyBunny
description: An LLM frontend designed for roleplay and storywriting that stays out of the user's way until called for.
colors:
  accent: "#82b3ee"
  accent-soft: "#7191b8"
  on-accent: "#000000"
  view: "#1d1d20"
  window: "#222226"
  window-canvas: "#3a3a3e"
  headerbar: "#3a3a3e"
  popover: "#3a3a3e"
  toast: "#525255"
  panel-raised: "#38383c"
  panel-hover: "#434347"
  foreground: "#ffffff"
  dim-foreground: "#c6c6c7"
  shadow-ink: "#000006"
  success: "#78e9ab"
  danger: "#ff938c"
  warning: "#ffc252"
typography:
  display:
    fontFamily: "Adwaita Sans, system-ui, Noto Sans, sans-serif"
    fontSize: "calc(var(--mainFontSize) * 1.81)"
    fontWeight: 800
    lineHeight: 1.12
    letterSpacing: "0"
  headline:
    fontFamily: "Adwaita Sans, system-ui, Noto Sans, sans-serif"
    fontSize: "calc(var(--mainFontSize) * 1.35)"
    fontWeight: 800
    lineHeight: 1.18
    letterSpacing: "0"
  title:
    fontFamily: "Adwaita Sans, system-ui, Noto Sans, sans-serif"
    fontSize: "calc(var(--mainFontSize) * 1.08)"
    fontWeight: 700
    lineHeight: 1.18
    letterSpacing: "0"
  body:
    fontFamily: "Adwaita Sans, system-ui, Noto Sans, sans-serif"
    fontSize: "var(--mainFontSize)"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "0"
  label:
    fontFamily: "Adwaita Sans, system-ui, Noto Sans, sans-serif"
    fontSize: "calc(var(--mainFontSize) * 0.72)"
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: "0"
  mono:
    fontFamily: "Adwaita Mono, Noto Sans Mono, SFMono-Regular, Consolas, monospace"
    fontSize: "calc(var(--mainFontSize) * 0.84)"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  control: "9px"
  card: "12px"
  overlay: "15px"
  alert: "18px"
  sm: "10px"
  md: "14px"
  lg: "16px"
  xl: "20px"
  pill: "999px"
  shell-control: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  "2xl": "24px"
  "3xl": "32px"
  "4xl": "40px"
motion:
  state: "200ms cubic-bezier(0.25, 0.46, 0.45, 0.94)"
  reveal: "250ms cubic-bezier(0.25, 0.1, 0.25, 1)"
  surface: "300ms cubic-bezier(0.25, 0.1, 0.25, 1)"
  spring-dialog: "damping 0.62, mass 1, stiffness 500"
  spring-sheet: "damping 0.8, mass 1, stiffness 400"
  spring-navigation: "damping 1, mass 1, stiffness 1000"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.md}"
    padding: "10px 14px"
    height: "38px"
  button-ghost:
    backgroundColor: "color-mix(in srgb, {colors.foreground} 4%, transparent)"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "10px 14px"
    height: "38px"
  button-suggested:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.pill}"
    size: "38px"
  input-field:
    backgroundColor: "{colors.window}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "12px"
    height: "46px"
  shell-tab-active:
    backgroundColor: "color-mix(in srgb, {colors.foreground} 10%, transparent)"
    textColor: "{colors.foreground}"
    rounded: "{rounded.shell-control}"
    padding: "8px 14px"
    height: "44px"
  card-surface:
    backgroundColor: "color-mix(in srgb, {colors.foreground} 4%, transparent)"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "14px"
  pref-group:
    backgroundColor: "color-mix(in srgb, {colors.foreground} 5%, transparent)"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}; {rounded.card} inside editors"
    border: "1px solid color-mix(in srgb, var(--sb-shell-border) 72%, transparent)"
    padding: "0; rows 6px 16px"
  popover-surface:
    backgroundColor: "{colors.popover}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.overlay}"
    padding: "6px"
  menu-row:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "32px"
  toast:
    backgroundColor: "{colors.toast}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.overlay}"
    padding: "8px 12px"
  chip-enabled:
    backgroundColor: "color-mix(in srgb, {colors.accent} 16%, transparent)"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "6px 8px"
  shell-navigation-control:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.shell-control}"
    minimumHeight: "44px on coarse pointers; 40px on fine pointers"
  shell-icon-control:
    backgroundColor: "color-mix(in srgb, {colors.foreground} 10%, transparent)"
    textColor: "{colors.foreground}"
    rounded: "{rounded.shell-control}"
    size: "44px on coarse pointers; 40px on fine pointers"
  checkbox-checked:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "30%"
    size: "clamp(0.92rem, calc(0.78rem + 0.38vw), calc(var(--mainFontSize) + 0.12rem))"
  radio-checked:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.pill}"
  range:
    backgroundColor: "color-mix(in srgb, {colors.foreground} 16%, transparent)"
    textColor: "{colors.accent}"
    rounded: "{rounded.pill}"
    height: "4px trough; 18px thumb"
  floating-entry-row:
    backgroundColor: "var(--sb-composer-input-bg); suffix outside the field"
    textColor: "{colors.foreground}"
    rounded: "var(--sb-radius-button)"
    padding: "1.45em 12px 0.35em inside the field"
    minimumHeight: "max(48px, 3.4em)"
  toggle-row:
    backgroundColor: "transparent; selected segment var(--sb-flat-selected-bg)"
    textColor: "{colors.foreground}"
    rounded: "{rounded.control}"
    minimumHeight: "44px segments on coarse pointers"
  select-mirror-row:
    backgroundColor: "transparent; whole-row flat hover and active fills"
    textColor: "{colors.foreground}"
    padding: "6px 16px"
  list-row:
    backgroundColor: "color-mix(in srgb, {colors.foreground} 8%, transparent); View in light tone; neutral hover and selection fills"
    textColor: "{colors.foreground}"
    rounded: "{rounded.card}"
    minimumHeight: "52px"
  selection-mode-header:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.control} on response buttons"
---

# Design Reference Documentation

- **GNOME HIG**: https://developer.gnome.org/hig/guidelines.html
- **GNOME Design Patterns**: https://developer.gnome.org/hig/patterns.html
- **GNOME HIG Reference** (keyboard shortcuts, palette, backgrounds): https://developer.gnome.org/hig/reference.html
- **GNOME Design Principles**: https://developer.gnome.org/hig/principles.html
- **libadwaita documentation** (stable): https://gnome.pages.gitlab.gnome.org/libadwaita/doc/1-latest/

**Reference version:** libadwaita 1.7+ (values checked against the 1.10.0 stylesheet); GNOME HIG pages checked 2026-10-19. Where SillyBunny deviates, the deviation is stated next to the value.

SillyBunny follows the HIG unless a rule below says otherwise. Every departure is marked **Deviation:** next to the rule it affects.

# Design System: SillyBunny

## 1. Overview

**"Simple by default, powerful when needed"**

SillyBunny is an LLM roleplay client that best embodies KDE Plasma's driving philosophy alongside the HIG (human interface guidelines) of the GNOME project. Although great inspiration is taken from these projects, SillyBunny still stands on its own with its own personality and branding based on its focus on roleplay and storywriting. The shell is deliberately kept out of the way so the user can focus on the main content until configuration and navigation are needed.

Intuitive wording, tactile and easily glanceable feedback, and deliberate purpose define the shell. Complex configuration remains available to the user if they wish to seek it (as per upstream SillyTavern), but a good default experience is mandatory and implied - the goal is for a new user to navigate the shell with minimal to no difficulty. Configuration remains behind the shell at all times until called for. All elements of the shell must remain themeable with user CSS themes, and be fully compatible with SillyTavern data, presets, extensions, and settings.

The design philosophies of the GNOME project and its HIG should always be taken into consideration. This means accessibility through lack of distractions, animations that guide the user to what is clicked/tapped, responsive layouts, predictable touch targets, and nothing getting in the way of the main user experience. Mobile design must remain purposefully designed alongside the desktop, adapting libadwaita to a smaller and more touch-heavy window.

With this in mind, SillyBunny can inject its own fun in the design too. After all, it is a roleplay and storywriting client at heart. Included tutorial characters are helpful yet creatively fun to interact with.

This project rejects UI creep, nested menu spirals, configuration sprawl, screen bloat, mystery meat navigation, desktop-only assumptions, and generic SaaS polish.

**Key Characteristics:**
- Content-first chat viewport with no unsolicited permanent configuration panels.
- Familiar controls that disclose depth through deliberate input, not visual noise.
- Guided animations that promote accessibility and intuitive motion.
- Stable desktop and mobile interaction vocabulary, safe shell behaviour for WebKit, Gecko, and Chromium browsers.
- Personality expressed through usefulness and built-in assistants and characters.

## 2. Colours

The palette is a neutral base for customisation and exploration: the accent dictates user interaction. Values follow the libadwaita dark style (the bundled Libadwaita theme); Libadwaita Light maps the same roles onto the libadwaita light style. Every role below is derived from the user's theme colours, so the hex values describe the bundled Libadwaita theme only.

### Primary
- **Accent** (`#82b3ee`): `--sb-accent`, a 62/38 mix of the theme quote colour and body colour. With the Libadwaita theme the quote colour is libadwaita blue `#3584e4`, so the derived accent sits close to libadwaita's dark standalone blue. Used for suggested actions, checked checkboxes and radios, the range thumb, focus rings, and the selected-item icon. Use it as a signal, never as ambient ornament.
- **On Accent** (`--sb-on-accent` / `--sb-on-solid-accent`): Text and glyphs on a solid accent fill. Resolves to black or white per theme for contrast. Deviation: libadwaita always uses white on `#3584e4` (about 3.9:1); SillyBunny picks the ink that reaches 4.5:1.
- **Soft Accent** (`#7191b8`): Secondary accent for quiet helper states and badges. Selected backgrounds use neutral fills, not Soft Accent.

### Secondary
These are libadwaita's standalone status colours. The light style uses `#007c3d`, `#c30000`, and `#905400`, switched by `data-sb-surface-tone='light'`.
- **Success Green** (`#78e9ab`): Positive completion and healthy connection feedback. It must not compete with Accent for primary actions.
- **Destructive Red** (`#ff938c`): Destructive actions and errors that require attention.
- **Warning Yellow** (`#ffc252`): Caution and transient operational warnings.

### Layer Ladder
Shell layers are separated by tone first, then by a `1px` shade line or one overlay shadow. Each layer has an `--sb-layer-*` token mixed from theme colours and forced opaque where `rgb(from …)` is supported.

| Layer | Token | Source (dark) | Dark | Light | libadwaita role |
|---|---|---|---|---|---|
| View | `--sb-layer-view` | `--SmartThemeChatTintColor` | `#1d1d20` | `#ffffff` | `view-bg` |
| Chat column (desktop) | `--sb-chat-view-bg` | View at the tint's own alpha, `min(1, alpha / 0.9)`, times the Background Visibility overlay | `#1d1d20` (0.9 maps to opaque) | `#ffffff` (0.9 maps to opaque) | `view-bg` |
| Window (also Dialog and Window overlays) | `--sb-layer-window` | `--SmartThemeBlurTintColor` | `#222226` | `#fafafb` | `window-bg` |
| Page | `--sb-page-bg-source` | BlurTint 88% + Body 12% (light 86/14) | `#3f3f43` | `#dcdcdd` | window behind `#sheld` |
| Canvas | `--sb-layer-canvas` | BlurTint 90% + Body 10% | `#3a3a3e` | `#e4e4e6` | `sidebar-bg` |
| Header bar | `--sb-layer-headerbar` | Same as canvas | `#3a3a3e` | `#e4e4e6` | `headerbar-bg` |
| Bottom bar | `--sb-layer-bottombar` | Same as canvas; light uses BlurTint 95% + Body 5% | `#3a3a3e` | `#efeff0` | bottom toolbar |
| Shell drawer | `--sb-layer-drawer` | Same as header bar; light uses BlurTint | `#3a3a3e` | `#fafafb` | `headerbar-bg` / `dialog-bg` |
| Popover | `--sb-layer-popover` | BlurTint 90% + Body 10%; light uses ChatTint | `#3a3a3e` | `#ffffff` | `popover-bg` |
| Alert | `--sb-layer-dialog` | BlurTint 90% + Body 10%; light uses BlurTint | `#3a3a3e` | `#fafafb` | `dialog-bg` |
| Toast | `--sb-layer-toast` | BlurTint 80% + Body 20%; light uses Body 90% + black 10% | `#525255` | `#2e2e32` | toast `#505053` |

Hex values are what the bundled Libadwaita and Libadwaita Light themes render. Their BlurTint and ChatTint carry 0.9 alpha, which `color-mix()` takes into account before the layer is forced opaque, so the mixes come out a few steps lighter than the same mix of opaque colours (checked in Chromium, 2026-10-19).

- **The chat column** is the raw chat tint on mobile (upstream's rule) and `--sb-chat-view-bg` on desktop, so the bundled 0.9 tints stay opaque and lower tints show the background. The page behind `#sheld` mixes BlurTint toward Body, so the main window stays distinct from the canvas in every theme.
- **Bars:** the top bar is a flat libadwaita headerbar that recedes, so messages, the composer, and the character list carry the visual weight; do not raise it into a heavier, toolbar-style band. The top bar uses Header bar, and the composers and bottom chat bar use Bottom bar. In dark mode both share the Canvas tone, so a light chat tint can never turn a bar white. In light mode Bottom bar is a step between the white View and Header bar, so page, bars, and chat never share one tone.
- **Overlays:** shell drawers continue the top bar and separate from the view by tone and one overlay shadow. Popovers, menus, and alerts share the Canvas tone in dark mode; dialogs and windows use the Window layer, as `AdwDialog` does. Each separates from what is behind it by its border and overlay shadow. In light mode these layers are the lightest and rely on a border and shade.
- **Raised Panel** (`#38383c`) and **Hover Panel** (`#434347`) are `--sb-raised-bg` (10%) and `--sb-raised-hover-bg` (15%) over Window. Raised Panel is a control fill, not a layer.
- **Foreground** (`#ffffff`) and **Dim Foreground** (`#c6c6c7`, `--sb-muted-fg`, 74% body colour). Dim text is never the sole carrier of meaning.
- **Shadow Ink** (`#000006`): Shade and shadow tint only. Never a text colour.
- **Paper Texture:** An opt-in grain over the canvas and chat column. It takes its colours from the active theme and never overrides border or message tints. Deviation: the HIG advises against text over textures or graphical backgrounds; the grain and chat backgrounds stay opt-in and must still meet the Contrast Rule.

### Named Rules
**The Signal Scarcity Rule.** Accent appears for action, selection, focus, or meaningful state. If removing it does not reduce comprehension, remove it.

**The Theme Alias Rule.** New work consumes `SmartTheme*`, `color-*`, `sb-*`, spacing, and radius aliases. Do not hard-code a new color that bypasses saved user themes.

**The Contrast Rule.** Body and placeholder text target at least 4.5:1 contrast; large text targets at least 3:1. Muted text can be quiet, but never illegible. Colour is never the only carrier of information; pair it with text, an icon, or shape (HIG UI Styling). Surfaces stay usable under `prefers-contrast: more` and `forced-colors: active`.

**The Opaque Shell Rule.** Header bars, drawers, popovers, menus, dialogs, and toasts are opaque. No `backdrop-filter` on shell layers; background images may show only through the canvas and the chat column at the theme's own tint alpha.

**The Single Shell Rule.** The shell has one libadwaita direction; there is no Shell Style picker, and stored legacy `sb-theme` values are ignored. UI themes, custom CSS, and the accent colour are the theming surface.

## 3. Typography

**Interface Font:** Adwaita Sans, then `system-ui`, Noto Sans, and the platform sans stack (`--mainFontFamily`).

**Mono Font:** Adwaita Mono for logs, prompt fragments, regex, token diagnostics, and structured output (`--monoFontFamily`).

**Character:** One dependable sans keeps chat, shell navigation, settings, and onboarding in the same voice. Weight and size create hierarchy. libadwaita uses no letter-spacing; new work sets none, and the legacy `--sb-tracking-label` and `--sb-tracking-kicker` tokens stay only until the remaining uppercase labels are reworked. Interface chrome avoids italic and oblique faces (HIG Typography); italics in chat messages are user formatting and are unaffected.

### Hierarchy
| Role | Token | Weight | Size | Line | libadwaita |
|---|---|---|---|---|---|
| Display | `--sb-type-display` | 800 | 1.81 | 1.12 | `.title-1` |
| Headline | `--sb-type-headline` | 800 | 1.35 | 1.18 | `.title-2` |
| Title | `--sb-type-title` | 700 | 1.08 | 1.18 | `.heading` / `.title-4` |
| Body | `--sb-type-body` | 400 | 1.0 | 1.55 | `.body` (1.4) |
| Label | `--sb-type-caption` | 700 | 0.72 | 1.35 | `.caption-heading` |
| Mono | `--monoFontFamily` | 400 | 0.84 | 1.45 | `.monospace` |

- **Display:** Home and first-run welcome titles only; never a control label.
- **Headline:** Shell titles and major opened-panel headings.
- **Title:** Setting groups, action rows, cards, and compact headings. Slightly larger than libadwaita's `.heading` because chat body text runs at `--mainFontSize`.
- **Body:** Chat and settings prose. Deviation: line height 1.55 instead of 1.4 for long-form roleplay reading. Keep prose near 65-75ch where the surface permits.
- **Label:** Compact metadata and state labels; capitalisation follows the Capitalisation Rule. Dimmed labels use `--sb-muted-fg`, the equivalent of `.dimmed` (55% in libadwaita, raised to 74% for contrast). Deviation: kept at 0.72 instead of libadwaita's 0.82 to avoid overflow in tight shell layouts like tab labels and conversation metadata.

### Named Rules
**The Interface Sans Rule.** Use the interface stack for controls, tabs, labels, and dense settings. Decorative type must never make repeated work harder.

**The User Scale Rule.** Product type follows `--mainFontSize` and existing user preferences. Do not add viewport-driven type or a parallel density system.

**The Wrap Safety Rule.** Headings use balanced wrapping where supported, and all labels must tolerate long translations, zoom, and narrow mobile widths without overflow.

**The Capitalisation Rule.** Follow the HIG Writing Style.
- **Header capitalisation** for headings (group, list, page, sheet, and dialog titles), header bar and view titles, view switcher and tab labels, button labels, menu items, tooltips, field labels, and the titles of rows in boxed lists (switch, combo, entry, spin, action, and button rows). Capitalise the first and last word, nouns, verbs, hyphenated words, and every word of four or more letters: "Find and Replace", "Self-Test", "Document Cannot Be Found".
- **Sentence capitalisation** for checkbox and radio labels, drop-down items, placeholders, row subtitles, captions, and body text in dialogs, banners, toasts, and status pages.
- Headings omit articles and auxiliary verbs ("Three Documents Updated"). An informal heading written as a full sentence uses sentence capitalisation and stays bold.
- Never all caps, and no uppercase tracked kickers.
- Group headings are bold (`.heading`). Deviation: a dimmed leading icon on group headings is SillyBunny's; libadwaita group titles have none.
- Resolution: the HIG Writing Style and Drop-Down Lists pages ask for sentence capitalisation on field and drop-down labels, while the Text Fields and Switches pages ask for header capitalisation. Every field label and boxed-list row title uses header capitalisation so a group reads consistently, as GNOME apps commonly do.
- Upstream SillyTavern strings keep their upstream wording and `data-i18n` keys. Existing sentence-case SillyBunny labels move to this rule as each surface is reworked.

## 4. Layout

- **Adaptive sizes (HIG Scaling & Adaptiveness):** Every layout works from `360×294px` (phone) up; the HIG's smallest supported desktop size is `1024×600px`. Content sits in containers with a maximum width so lines and controls do not spread apart on large windows; groups and lists have a minimum and a maximum width. Crossing a breakpoint never makes a control or icon disappear without a transition, and the same functions stay available at every width.
- **Breakpoints:** Overlays become bottom sheets at `max-width: 450px` or `max-height: 360px`, the AdwDialog condition. The shell layout breakpoint is `768px`, because libadwaita leaves layout breakpoints to each app; it is not the overlay breakpoint. A mobile-only surface whose trigger exists only in the `768px` layout keeps its sheet tied to that breakpoint. Implementation: [docs/dialogs.md](docs/dialogs.md#breakpoints).
- **Touch targets:** Interactive controls are at least `44px` on coarse pointers. On fine pointers, shell controls and close buttons may be `40px`, and menu rows `32px`. Target size follows `(pointer: coarse)`, not the viewport width. Deviation: libadwaita controls are `34px`; SillyBunny keeps larger targets for touch.
- **Density:** Compact mode (`--sb-density-scale`) reduces row heights, padding, and message targets (to `40px` at the smallest) without changing hierarchy. Containers pad `12px`, `14px`, `16px`, or `18px` according to density.
- **Mobile:** Preserve the same destinations, ordering, action names, and control shapes as desktop. Use safe-area-aware sheets, comfortable touch targets, and no hover-only discovery. Controls stay usable with the software keyboard open.

### Named Rules
**The WebKit Reliability Rule.** Prefer solid surfaces on mobile. Fixed layers must respect safe areas, keyboard resizing, scrolling, and focus behavior in Safari/WebKit.

## 5. Elevation

SillyBunny uses tonal layering first and restrained shadows second. The main chat surface stays visually calm. A shadow is reserved for an opened shell or an overlay that must sit above the conversation. Resting surfaces never pair a border with a shadow as decoration; overlays (popovers, sheets, drawers, dialogs) keep a `1px` border with one overlay shadow, as libadwaita popovers do.

### Shadow Vocabulary
All shadows mix `--SmartThemeShadowColor`, so themes control the ink.
- **Header bar shade** (`--sb-headerbar-shade`): a `1px` line at the bottom of the top bar and the top of the composer. No blurred shadow.
- **Popover Shadow** (`--sb-shadow-popover`): `0 1px 5px 1px` and `0 2px 14px 3px` at low shade alpha, plus the `1px` border. Menus, dropdowns, pickers, and search results.
- **Dialog Shadow** (`--sb-shadow-dialog`): `0 0 14px 2px` and `0 0 5px 2px` at low shade alpha, plus the `1px` border and, in dark mode, a `1px` inner highlight. Dialogs and shell drawers.
- **Dialog Backdrop** (`--sb-dialog-backdrop`): shade colour at about 50% (dark) or 14% (light). No backdrop blur.
- **Toast Shadow** (`--sb-shadow-toast`): `0 1px 3px 1px` and `0 2px 6px 2px` at low shade alpha.
- **Focus Ring** (`--sb-focus-ring-inset`: `inset 0 0 0 2px` of `--sb-focus-ring`): The only focus treatment for buttons, tabs, and menu rows. Fields draw the same colour as their border plus a `1px` inset, which reads as the same `2px` ring (see Text Fields). Do not stack it with an outline or an outer ring. Checkboxes, radios, and ranges use a `2px` `--sb-focus-ring` outline with an offset instead. Under forced colours every focused element also draws a `Highlight` outline, because forced colours remove shadows. Deviation: the ring is about 55% accent rather than libadwaita's 50% to keep 3:1 against both tones.

### Flat Fill Vocabulary
Flat and raised controls use fills mixed from `--SmartThemeBodyColor`, so they follow light and dark themes without a new color. These are libadwaita's values.
- **Flat:** `--sb-flat-hover-bg` (7%), `--sb-flat-active-bg` (16%), `--sb-flat-selected-bg` (10%), and `--sb-flat-selected-hover-bg` (13%).
- **Raised:** `--sb-raised-bg` (10%), `--sb-raised-hover-bg` (15%), and `--sb-raised-active-bg` (22%; libadwaita uses 30%).
- **Toolbars:** The top bar, bottom chat bar, and composer are separated by a `1px` shade line only. The generating state keeps its accent border and progress bar and has no outer glow.

### Named Rules
**The Layer Before Shadow Rule.** Establish a tonal surface before adding elevation. If a shadow is doing all the work, the surface token is wrong.

**The Flat Toolbar Rule.** Toolbar and navigation buttons are transparent at rest. Hover, press, and selection use neutral fills mixed from the body color, with no borders, bottom stripes, underlines, glows, or hover lift. Hover fills apply only under `(hover: hover)`.

## 6. Shapes

Nothing is larger than `20px`.

- **Control** (`--sb-radius-control`, `9px`, libadwaita `$button_radius`): menu and search result rows, tooltips, segments, and new shell controls that are not pills.
- **Card** (`--sb-radius-card`, `12px`, libadwaita's card radius): groups inside editors, dialogs, windows, and side panels, and the boxed rows of list sidebars.
- **Overlay** (`--sb-radius-overlay`, `15px`): popovers, menus, dialogs, windows, shell drawers, toasts, and the composer stack. Bottom sheets round their top corners only. Docked side panels are square.
- **Alert** (`--sb-radius-alert`, `18px`): alert dialogs.
- **Pill** (`999px`): top-bar destinations, shell section triggers, back and close controls, and chat-navigation actions. Icon-only shell actions are circles. Deviation: libadwaita header-bar buttons are rounded rectangles (`9px`); the HIG reserves pills for a primary text button in open space and circles for clusters of small buttons.
- **Content (until each page is migrated):** content buttons keep `--sb-radius-button` (`14px`), icon-only content controls `10px`, content cards `14px`, and preference groups on settings pages `--sb-radius-lg` (`16px`). The welcome surface may use `20px`.
- **Small controls:** checkboxes are rounded squares (radius `30%` of their size); radios, switches, and selection-mode checks are round.

## 7. Motion

Motion shows where something came from and where it went. It never delays a task.

### Tokens
| Token | Value | Use | libadwaita |
|---|---|---|---|
| `--sb-transition-fast` | `200ms` `--sb-ease-out-quad` | Hover, press, focus, selection, colour and fill changes | `$button_transition`, `$focus_transition` |
| `--sb-transition` | `250ms` `--sb-ease` | Reveals, expanders, height changes, banners, crossfades | GtkRevealer, AdwExpanderRow |
| `--sb-transition-slow` | `300ms` `--sb-ease` | Toasts and large surface fades | AdwToast |
| `--sb-ease-out-quad` | `cubic-bezier(0.25, 0.46, 0.45, 0.94)` | State changes | `$ease-out-quad` |
| `--sb-ease` | `cubic-bezier(0.25, 0.1, 0.25, 1)` | Timed animations | `ADW_EASE` |
| `--sb-ease-out-cubic` | `cubic-bezier(0.33, 1, 0.68, 1)` | Exits and fades | ease-out-cubic |

Springs are sampled from libadwaita's AdwSpringAnimation into CSS `linear()` easings, with a cubic-bezier fallback where `linear()` is unsupported (Safari before 17.2). `public/scripts/sillybunny-motion.js` owns the JS presets.
- **Dialog spring** (0.62, 1, 500): about 510ms, peak 1.08. This is the only motion that overshoots.
- **Sheet spring** (0.8, 1, 400): about 470ms, near-critical.
- **Navigation spring** (1, 1, 1000): about 330ms, critically damped.
- **Closing** uses the clamped spring or `--sb-ease-out-cubic` and never overshoots.

### By Pattern
- **Overlays:** Alert and Dialog open with the Dialog spring, scaling `0.8 → 1` and fading from the centre, and close clamped over 200ms to scale `0.9`. A Window opens with the Sheet spring (`0.96 → 1`) and fades to `0.98` over 200ms. Shell drawers use the Sheet spring with a fade and scale `0.96 → 1` from the trigger, and close with a 200ms fade and scale to `0.98`. Bottom sheets slide up with the Sheet spring and down to close. The backdrop fades with the surface.
- **Popovers and menus:** 200ms fade and scale `0.96 → 1` from the trigger edge; close is a 150ms fade. Deviation: GTK4 popovers do not animate; SillyBunny keeps the short origin cue so the user sees what opened.
- **Pages:** The Navigation spring (`334ms`) pushes and pops dialog pages and mobile section pages. A Popup page pops over 200ms with `--sb-ease-out-cubic`. A List → Split Editor list shrinks to a sidebar while the editor slides in from the right, with continuous compression, and reverses on close; picking another row swaps the editor content without replaying the slide.
- **Toasts:** In over 300ms, sliding from their own height plus a fade. Out over 300ms with a fade and scale to `0.95`.
- **Tabs and expanders:** Tabs and page sections crossfade over 200ms (AdwViewStack). Expanders reveal over 250ms; the chevron rotates over 200ms.
- **Side panels:** The chat shifts over `--sb-transition` (`250ms`) when a panel docks or closes. The panel appears after the chat has settled.

### Named Rules
**The State-Only Motion Rule.** Animate state, origin, and destination only. No decorative choreography, ambient loops, or hover lift.

**The Reduced Motion Rule.** `prefers-reduced-motion: reduce` or the Reduced Motion setting removes movement and scale. State changes become instant or a crossfade of 200ms or less. JS helpers are no-ops under reduced motion.

## 8. Components

Patterns follow the HIG pattern groups. Sizes and corners come from Layout and Shapes.

### Containers

#### Dialogs
- **Implementation:** [docs/dialogs.md](docs/dialogs.md) is the code reference for Alerts, Dialogs, Windows, pages, and side panels: the `openDialog` and `openAlert` APIs, the Popup hook, page chains, adapters, and a testing checklist. Read it before you build or change one.
- **Tiers:** **Alert** is for messages, confirmations, one-field prompts, and at most one boolean option: `300px` preferred and `372px` maximum (`600px` when wide), content-sized and centred, with a centred heading and body. **Dialog** is for forms and action dialogs: `min(640px, 100% - 32px)` wide with a `360px` minimum, a header bar, and one scrolling body. **Window** is for lists, editors, and viewers: `min(max(640px, var(--sheldWidth)), 100% - 32px)` wide. Dialog and Window heights follow their content up to `90dvh`; a Window that fills (document viewers and editors) is `90dvh` tall. How a Popup picks its tier is in the implementation reference.
- **Surface:** An Alert uses the Dialog layer. A Dialog or Window uses the Window layer, as `AdwDialog` uses `window-bg`; a Window header uses Header bar, and the body of a document Window (a notes, editor, or output viewer) uses View. All three have a `1px` border, Dialog Shadow, and a Dialog Backdrop without blur.
- **Headers:** Cancel comes first and the affirmative last, as in GNOME; custom responses sit between them. An explicit-action Dialog or Window puts Cancel at the header start and the affirmative action at the end, with no Close. An immediate-apply surface shows Close at the end. With three or more responses, other responses sit in a bottom bar aligned to the end. Responses use the primary and ghost button families; Close is a flat circle.
- **Pages and stacking:** One Alert may open above any surface. A Dialog or Window opened over another becomes a page in the same frame, never a second visible frame, and the parent becomes inert. A pushed page shows Back at the start. With explicit responses, Cancel acts as Back and the affirmative stays at the end, with no Close; without them, Close sits at the end. Back and Esc pop one page. Close closes the whole frame one page at a time, from the top, and stops at a page that refuses to close. A page over a bottom sheet keeps the sheet's shape and grab handle, and a downward swipe on the handle pops the page.
- **Use (HIG Dialogs):** A dialog opens only in direct response to a deliberate action, never unexpectedly. Prefer inline controls to action dialogs. Alert dialogs carry one to three responses. Action dialogs label the affirmative response with a specific verb ("Save", "Export"), never "OK" or "Done", and keep it insensitive until required options are set. Avoid error dialogs; show non-critical errors inline or in a toast.
- **Keyboard:** Initial focus goes to the control the user is expected to operate first. Esc activates Cancel. Return activates the affirmative response only when it is neither destructive nor irreversible; otherwise there is no default response. On close, focus returns to the opener, or to the nearest visible control when the opener is gone.
- **Destructive actions:** Confirmed with an alert dialog: Cancel first and focused, the destructive response in Destructive Red. Changes inside an editor with explicit save need no confirmation, because Discard restores them. Deviation: the HIG prefers an undo toast to a confirmation dialog wherever the action can be reversed; SillyBunny confirms committed destructive actions, such as message deletion, instead.
- **Sheets:** Under the overlay breakpoint every overlay is a bottom sheet: full width, a grab handle, safe-area padding, and scrolling content. A downward swipe from the handle or header (on an Alert, from the handle or heading) follows the finger, closes the sheet, and springs back when short. An Alert stacks its responses full-width at `44px`, with the affirmative on top and Cancel at the bottom. A Dialog or Window keeps Cancel and the affirmative in its header.

#### Menus and Popovers
- **Surface:** Popover layer, overlay radius, `6px` padding, `1px` border, Popover Shadow.
- **Rows:** `32px` minimum height (`44px` on coarse pointers and in sheets), `0 12px` padding, control radius, and full-opacity labels with dimmed icons. Hover and press use the flat fills; keyboard focus uses the inset focus ring. Deviation: GNOME popover menus show labels only (HIG UI Icons: a control has a label or an icon, not both).
- **Items (HIG Menus):** Verbs for commands and adjectives for settings, in header capitalisation. Keep actions, checkbox items, and radio items in separate sections. Order by importance, task order, or frequency, with the most important items at the top or bottom. No nested submenus. Menus hold three to twelve items. Omit items that do not apply rather than disabling them, and never add commands only to reach three. Destructive items sit last in their own section, in Destructive Red, and always confirm. Deviation: a menu that carries extension items, Move Up and Move Down, or saved views may exceed twelve items.
- **Icons:** Every command item has an explicit, relevant icon, never the action-menu fallback puzzle-piece glyph. Check and radio items use their state indicator.
- **Menu buttons:** Secondary menus use the vertical ellipsis (`view-more-symbolic` in GNOME). Its tooltip and accessible name name the menu ("Menu", or more specifically "Message Menu").
- **Popovers (HIG Popovers):** Small and simple, covering no more than about a third of the window. No Close or Done button. A heading only when the content's purpose is unclear. Esc closes the popover and returns focus to its trigger.
- **One at a time:** Select dropdowns and search results follow the same surface and row rules. A second click on an open trigger, or on a select row's background, closes its popup instead of reopening it. Opening another menu, picker, or popover closes the current one first.
- **Sheets:** Under the overlay breakpoint, menus and pickers become bottom sheets with a grab handle and the same swipe to close as Dialogs. Deviation: GTK popovers stay popovers on mobile.

#### Boxed Lists and Rows
- **Groups:** Preference groups are libadwaita boxed lists (`AdwPreferencesGroup`): a `5%` body-colour tint (`8%` inside dialogs, windows, and side panels; libadwaita dark cards use `8%`), a `1px` border at 72% of `--sb-shell-border`, `1px` separators between rows, and no gap between groups. The bold heading and optional description sit above the list, not inside it. Groups are flat at rest and never take a coloured side stripe.
- **Cards:** Cards are working surfaces, not a repeated icon-heading-text grid; prefer an open list, tab row, or inline section when that is clearer. Home and first-run shortcuts may use a centred icon and text, but stay sparse, labelled, and helpful rather than decorative.
- **Rows:** `44px`–`52px` tall with `6px 16px` padding: the title and an optional dimmed subtitle at the start, the control at the end. Bounded labels and flexible controls keep widths stable across varied label text; controls with an intrinsic width keep it. Expanders put a trailing chevron after any suffix controls, pointing down when collapsed and up when expanded. Row text, subtitles included, keeps at least 4.5:1 contrast; placeholders and secondary text use `--sb-input-placeholder` (78% body colour mixed with theme tint).
- **Row types:** Choose by the Selection Controls hierarchy; the row factories are in the implementation reference. A switch row puts `role="switch"` on its native checkbox and never adds `aria-checked` (ARIA in HTML forbids it on `input type=checkbox`). The whole row toggles its switch or check, and both trail in every surface. A toggle row (`AdwToggleGroup`) is an exclusive choice, not a view switcher: label-only native radio segments in a named `radiogroup` with a neutral selected fill; filled, it puts the title above equal-width segments whose labels wrap at word boundaries. A select row (`AdwComboRow`) shows the value and opens the shared searchable picker, while the adopted native select stays the source of truth; a profile row adds folders, favourites, and a ⋮ only when it has actions.
- **List rows:** In list sidebars, a row carries an optional leading grip and dimmed icon, a title with a one-line description, optional dimmed metadata, then at most a switch and a ⋮. Beside an open detail pane, rows hide their subtitles and ⋮ and keep the `52px` minimum. Deviation: with a grip a row has three controls in total, exceeding the boxed-list maximum of two, for consistency with the prompt list; there are never three trailing controls.
- **Boxed-list rules (HIG Boxed Lists):** A row holds one control, two at most. Clicking the row background activates its control; the control takes keyboard focus, not the row. A button row that opens a new view ends with a trailing arrow instead of an ellipsis. **Deviation:** the HIG reserves boxed lists for small, static sets of rows; the sidebars of List → Split Editor use boxed rows (card radius, `8%` tint, `1px` border) for collections of any size, and load large ones in batches with a Show More row.
- **Reordering:** Rows that can be reordered offer Move Up and Move Down in their menu, which the HIG requires for accessibility, beside drag and grip keyboard actions; all three share one saved order. Omit a move at its boundary and while a search or filter is active, and keep focus on the moved row. Deviation: prompt rows still lack move menu items until the libadwaita TODO follow-up; their grip/keyboard reorder remains available.

#### Header Bars and Toolbars
- **Header bars (HIG Header Bars):** Every top-bar control has a tooltip. Header content updates to match the current view, and essential main-content controls stay labelled and visible. Header actions that do not fit move into the ⋮ menu as space runs out.
- **Toolbar buttons:** Header bar, composer, bottom chat bar, and conversation buttons follow the Flat Toolbar Rule. Raised buttons (shell close, mobile back and section triggers) use a subtle tonal fill at rest. Extension buttons in the composer rows are flat circles; an active one keeps a `1px` inset quote-colour ring as its state cue.
- **Composer:** The bottom bar stays available for writing, keeps the textarea central, and scales to keyboard and safe-area changes without covering chat. On desktop it joins the bottom chat bar into one toolbar stack on the Bottom bar layer, split by a `1px` hairline, unless group speaker controls or the delete dialog sit between them.
- **Bar fields:** Selects, chips, and search fields in a bar are borderless raised or neutral pills with the inset focus ring.

#### List → Split Editor
- **Pattern:** SillyBunny-specific pattern built from Libadwaita parts; `AdwNavigationSplitView` collapse rules. Libadwaita sidebars are not user-resizable and no stock widget animates from a full-width list into a split view.
- **Sidebar:** Resizable sidebar `240–420px`, default `30%`; collapse at viewport `≤768px` or Editor pane `<720px`. These are defaults; a list inside a Window may set a narrower range and an earlier collapse. Collapsed, the editor is a full-screen page with a back button and no sidebar. A list with its own sidebar of locations collapses into three pages: locations, list, and detail.
- **Editor body:** Text-first editors keep the pane from scrolling: text areas take the remaining height (`flex: 1 1 0; min-height: 0`) and scroll internally. Multi-group editors scroll one body container; the shell and detail frame do not scroll. Main text areas there have a minimum height and Expand rather than competing for leftover height; on phones the focused text area stays visible as the visual viewport changes. Header and property controls stay outside the body; avoid nested group scrollers.
- **Explicit save:** The editor header shows an editable title, a dirty indicator, Cancel, and Save. Cancel discards local changes without closing the page. Back, row switches, and navigation ask Cancel · Discard · Save first and keep a recoverable draft.
- **Property bar:** Item properties sit in a bar directly under the header. On collapsed layouts the bar becomes a `44px` summary button that opens a sheet holding the same controls, not copies.
- **Secondary pages:** Settings and overviews that belong to a list open from its ⋮ as detail pages, not as fixed list entries. Each has an in-pane Back and one scrolling body.

#### Selection Mode
- **Use (HIG Selection & Edit Modes):** Entered deliberately, and only offered when at least three actions apply to a selection. Clicking anywhere on a row toggles its selection. The checks are `24px` circles on every device, with a `2px` outline at 60% body colour, filled with Accent and the shared check glyph when selected.
- **Header:** Cancel is at the start, a live selected-count title in the middle, and Select All at the end. Standalone, Cancel uses the secondary editor action (neutral ink, theme border, transparent fill) and Select All is the solid Accent suggested action. Keep labels readable in forced colours and at user font scale.
- **Window header:** Selection mode replaces the header content. Cancel and Select All are raised text buttons (`--sb-raised-bg`, theme border), not a solid Accent button; Close stays visible and other header controls are hidden. An open search closes, and its query returns on exit. When the count does not fit beside the buttons, it moves to a second header row.
- **Action bar:** The action bar sits at the bottom. A consumer may opt in to icon-only actions under the overlay breakpoint; the icons spread evenly, the bar is `44px` tall, and each action keeps its `aria-label` and `title`.
- **Scope:** Select All covers only the current filtered items and counts a duplicated item once. Preserve the existing selection gestures, keyboard behaviour, and return focus across all consumers.

#### Side Panels
- **Implementation:** `registerSidePanel` and its options are in [docs/dialogs.md](docs/dialogs.md#side-panels).
- **Use:** Non-modal utility panes that keep the chat available, such as Author's Note. Panels do not use a scrim or focus trap.
- **Docking:** Dock into the gaps beside the chat. Width is `280–420px`; move the chat as little as possible, never place a panel over the chat column or top bar. When the gap is too small, the chat returns to its normal width and the panels become sheets.
- **Surface:** The Window layer with a `1px` border and square corners. A docked panel has no shadow. A panel sheet follows the Dialog surface.
- **Sides:** Each panel has a default side, and its header menu offers Move to Other Side. Two panels on one side split the available height. Save the side through the existing `movingUIState` keys; opening a panel is not persisted.
- **Sheet:** At most one panel at a time, persistent and non-blocking above the composer, at most `50dvh`; the composer remains visible and usable. It has its own scrolling, a grab handle, and Close.
- **Layering:** Docked panels sit over expression sprites and zoomed avatars. In visual-novel mode, the sprite area follows the chat's free area between panels.
- **Keyboard:** Escape closes through the panel controller. Opening moves focus into the panel; closing returns it to its opener.

### Navigation

#### Shell
- **Layer 1:** The main chat window is the primary surface with a bottom bar for direct conversation actions.
- **Layer 2:** An always-visible top bar. Start: Backend, Customize, Search, and up to three quick-access slots. Centre: the title, which shows the active character's name by default. End: an extension slot, up to three quick-access slots, the mode switcher (Roleplay or Conversation), Home, and Characters. Quick access is configurable and desktop-only.
- **Layer 3:** Backend and Customize open a full-screen settings page: a sidebar of pages with its own heading and settings search (HIG Sidebars), and a content pane headed by the page title and description. Page labels are nouns in header capitalisation and of similar length. The HIG asks that, in preferences, one page's controls never change the controls on another page (HIG View Switchers). Deviation: the backend chosen in Connections decides which controls Sampling, Presets, and Formatting show (upstream SillyTavern behaviour).
- **Layer 4:** Page content holds the options for that page.
- **Desktop:** Keep the existing top-bar actions and chat-navigation rows visible. Users may hide the Guided Generations and Chat Navigation rows in settings.

#### Pages and Sidebars
- **Depth (HIG Navigation, Browsing):** Hierarchies are generally one level deep below a view. A pushed page has its Back control at the top start. Close, where it shows, closes the whole frame.
- **Sidebars and panes (HIG Sidebars, Utility Panes):** A sidebar navigates between locations, such as a conversation list or the list of a List → Split Editor. A utility pane holds tools or details for the main view, such as a settings pane. Both collapse at narrow widths: a sidebar becomes a pushed navigation stack, as `AdwNavigationSplitView` collapses, and a utility pane overlays the content or becomes a page.
- **Active State:** Use a neutral selected fill, with Accent on the icon where it helps. No border, bottom accent stripe, or underline. Never use a thick left or right stripe.

#### Search
- **Behaviour (HIG Search):** Live as the user types, across the whole collection, with a status page when nothing matches. Every item stays reachable without search.
- **Placement:** Search sits in the header, revealed from an icon where space is short; Esc closes an open search before anything else. Filters sit beside the field or in the header, never in the ⋮ menu.
- **Global search:** The entry is a borderless raised pill with the inset focus ring. Results sit in a popover with flat rows, filled only on hover, press, or keyboard selection; group headings are dimmed.

### Controls

#### Buttons
- **Primary:** A libadwaita suggested action: Accent background, `--sb-on-solid-accent` text, `38px` minimum height, and `10px 14px` padding. Hover changes the fill slightly; there is no lift. A view has at most one button in the suggested or destructive style (HIG Buttons). Icon-only suggested actions, such as Send, are solid-accent circles; disabled, they switch to a neutral raised fill with dimmed body ink, never a faded accent.
- **Content:** Outside the top bar, a button shows an icon or a label, not both (HIG Buttons). Labels are short imperative verbs in header capitalisation ("Save", "Update"). A button whose action is unavailable is insensitive instead of showing an error when clicked. No actions on double-click or right-click of a button. Existing buttons that pair an icon with a label move to this rule as each surface is reworked.
- **Secondary / Ghost:** Generic `.menu_button`s use a `4%` body-colour fill (`--sb-button-bg`), Foreground, and the upstream one-pixel theme border, at the same height and padding as the primary family. Hover deepens the fill to `8%`. New shell work should prefer the borderless raised or flat fills.
- **States:** Default, hover, focus-visible, active, disabled, loading, and error are explicit. Focus-visible shows the inset ring with no outer glow. Labels describe the action; icons alone are not enough for essential controls. Selected tabs and nav items use a neutral fill without a bottom accent stripe or inset shadow.

#### Text Fields
- **Style:** Window background (`--sb-input-bg`), one-pixel theme border, `14px` radius, `46px` default height, and `12px` inline padding.
- **Focus:** Accent, as in libadwaita. The border turns `--sb-entry-focus-border` and a `1px` inset `--sb-entry-focus-ring` in the same colour completes a `2px` ring in the focus-ring colour (78% of `--sb-focus-ring`, about 55% accent). The fill does not change. The composer keeps its own accent outline (`--sb-composer-focus-*`).
- **Behaviour (HIG Text Fields):** In forms and preferences, prefer entry rows to standalone fields. A field that holds a setting applies its change on Return or when it loses focus. Validation feedback appears as the field is edited and favours a positive "valid" cue over showing an error while the user is still typing. Placeholders read like labels, or as an instruction ending in an ellipsis for action fields ("Search for a city…"). Typing never starts a network action; connecting and testing stay behind explicit buttons.
- **Floating entry rows:** The title is a linked `<label>` inside a filled field (`--sb-composer-input-bg`, transparent `1px` border, `--sb-radius-button` (`14px`), `max(48px, 3.4em)` minimum height). It floats on focus, a value, or autofill, and the placeholder text shows only on focus. The title is single-line with ellipsis and remains the accessible name. Focus draws on the input, not the row; status and suffix controls stay outside the fill and ring. Existing stacked fields remain until each surface is migrated.
- **Secret fields:** Saved or missing key status is a trailing icon with visually hidden text; an unknown status is hidden. Mask and offer Reveal only where `-webkit-text-security` is supported; never change the input type or invite a password manager. Deviation: this preserves upstream text inputs rather than using a password input; secret rows may exceed the two-control limit to retain entry, reveal, and key management.
- **Help captions:** One-line help is a dimmed caption below the field, linked by `aria-describedby`. Multi-line instructions and lists stay above the field, and visibility-gated warnings keep their gates. Deviation: AdwEntryRow has no subtitle; captions and the focus-only placeholder preserve upstream help and status.
- **Error / Disabled:** Destructive Red uses a readable tint and explicit text; disabled fields preserve label and layout context rather than disappearing.

#### Selection Controls
- **Choosing a control (HIG Switches, Checkboxes, Radio Buttons, Drop-Down Lists, Sliders, Spin Buttons):**
  - A switch is for an option with a clear binary nature, and is preferred to a checkbox for settings.
  - Checkboxes are for lists of independent choices, mixed states, and menu items. Label them by their checked effect and never negatively ("Play alert sound", not "Disable alert sound").
  - Two exclusive options use a segmented toggle or radio buttons, never a drop-down. Small exclusive sets use radio buttons or a segmented toggle; longer sets use a drop-down, with search for long lists.
  - A slider is for a fixed, ordered range with live feedback; pair it with a number field when exact values matter. A spin button is for an exact value, right-aligned.
  - A control that enables others sits directly above the controls it affects.
- **Hierarchy:** One boolean option uses a switch row. A pick-several list uses a check row per item, with Select All when there are more than five items. Two or three exclusive options use a segmented toggle; four or more use a combo or searchable select row.
- **Checkbox:** Rounded square with a `2px` neutral outline at rest. Checked fills solid Accent with a check glyph in `--sb-on-solid-accent`. No highlights, glow, or inner shadow.
- **Radio:** Circle with the same `2px` outline. Checked fills solid Accent with a centered dot in `--sb-on-solid-accent`. Segmented boolean radios keep their overlay input and are styled as the segment instead.
- **Range:** `4px` neutral trough and an `18px` Accent thumb with a `1px` shade. Firefox fills the trough up to the value; WebKit and Blink show the trough only. Hover grows the thumb slightly on hover-capable pointers. On viewports ≤ 620px, a slider row stacks its range and number field under the title.
- **Switch:** A `42×24` pill (`38×22` in compact mode) with `appearance: none` and `-webkit-appearance: none`. Off uses a `16%` body-colour trough; on fills solid Accent with a circular thumb in `--sb-on-solid-accent`. The thumb travels with `inset-inline-*` so RTL mirrors. Reduced motion snaps with no travel.
- **Focus / Disabled:** Small controls use a `2px` focus-ring outline with an offset so the ring stays visible around the control. Disabled controls drop to reduced opacity and a `not-allowed` cursor.

#### Chips
- **Style:** Compact rounded controls at `14px`, `6px 8px` padding, readable text, and a tonal background.
- **State:** Enabled or selected chips use a 16% Accent tint and a status icon. Inactive chips remain legible and low emphasis.
- **Use:** In-chat agent controls and metadata only; do not turn the bottom bar into a chip collection.

### Feedback

#### Toasts
- **Surface:** Toast layer with white ink in both tones, overlay radius, Toast Shadow, no border.
- **Status:** Error, warning, and success toasts keep the toast layer and use the standalone status colour for the icon and title only.
- **Use (HIG Toasts):** Transient and dismissible, for events and completion summaries that only matter while the app is open. A button only when it is directly useful, such as Undo. A toast is never the only place a persistent failure or state is shown.
- **Position:** Deviation: toasts default to the top centre (upstream SillyTavern, adjustable by theme) instead of the bottom of the window.

#### Banners, Status Pages, and Progress
- **Banners (HIG Banners):** For persistent states only, never for events or short-lived states. One short title written as an informal heading, and at most one button. Deviation: a persistent error that one action resolves shows as inline status beside that action instead of a banner, such as a connection error beside Connect.
- **Status pages (HIG Placeholder Pages, `AdwStatusPage`):** Empty views, empty search results, and unavailable states show a symbolic icon, a heading that names the state, an optional line of guidance, and an optional action. Symbolic placeholders stay neutral in colour and tone.
- **Progress (HIG Spinners, Progress Bars):** Show progress for any operation that takes more than about three seconds. A spinner for operations up to about thirty seconds, placed in or next to the control it relates to, shown only after a short delay, and one at a time. A progress bar with text for longer tasks, inline with the content it tracks.

#### Tooltips
- **Surface:** libadwaita OSD tooltip: shadow ink at 80%, white text, control radius, `1px` 10% white border. Used for hover titles and the touch press-and-hold label.
- **Use (HIG Tooltips):** Every top-bar control has one. Elsewhere, use them only where they add information, and if one control in a container has a tooltip, all of them do. Tooltips never carry essential information, since touch and keyboard users may not see them. Text is short and in header capitalisation, and does not repeat a visible label: "Back", "Search", "Main Menu".

### Chat Transcript

The chat is the product's core, so its messages have their own pattern.

- **Action row:** Actions sit in the message name row at the inline end; the name truncates before they move. Targets use `--sb-message-hit-size`, icons `--sb-message-glyph-size`, and swipe arrows `--sb-message-icon-size`. Mobile (`<=768px`) shows Edit, then the menu button; desktop shows Copy, Edit, then the menu button, which is the vertical ellipsis and always last. Every chat style keeps this contract; mirrored user rows (echo, tide) anchor the actions and menu to their start edge.
- **Expanded row (desktop):** Holding Shift while the pointer or focus is in a message expands its row to every menu action as icons, in menu section order. It stays expanded until the pointer or focus leaves the message or Escape is pressed; Shift does nothing while focus is in a text field. The menu button tooltip carries the hint "Hold shift to expand." The Expand Message Actions setting keeps every row expanded and drops the hint. Section dividers hide once the row wraps; a row that does not fit beside the name moves below it.
- **Message menu:** Every other action, including checkpoint, Delete, and extension buttons, is a labelled row with a dimmed icon and the action's existing title. Sections are split by separators with no headings, in this order: reply actions (Delete + Add Swipe, swipe history, Narrate, Translate, image generation), copy (Copy, Screenshot), chat structure (branch, checkpoint, hide or include), tools (Prompt, agent changes, trackers, companions, card scripts, Embed, media display), other extension buttons, then Delete alone in Destructive Red.
- **Menu surface:** A popover anchored to the menu button, trailing-aligned, that flips above when there is no room below and stays inside the chat width. Under the overlay breakpoint it is a bottom sheet titled with the message's sender and position, with Close, that traps focus. Focus returns to the menu button. Right-click on the name row, Shift+F10, and the Menu key open the same menu; long-press on message text does not, so text selection keeps working. It closes on action, Escape, outside tap, generation start, and chat change, and the popover also on scroll. Arrow, Home, and End move between rows.
- **Edit row:** Cancel, Confirm, then the edit actions in sections: Copy this message and Add a reasoning block; Move up and Move down; then Delete this message alone in Destructive Red. Mobile puts them behind the menu button; desktop shows them inline after a divider. At the chat edges Move up and Move down stay, disabled: the one exception to omitting items that do not apply. Edit buttons are flat circles whose text colour shows the role: success for Confirm, Destructive Red for Delete, the body colour for Cancel, and Accent otherwise. Cancel is neutral because Warning Yellow means caution, not cancel (HIG UI Styling). Hover and press use a `12%` and `20%` tint of the action's colour. Deviation: several coloured actions share one row; the HIG reserves strong colour for a single suggested or destructive button per view. Existing edit rows keep the yellow Cancel until they are reworked.
- **Delete:** Delete always confirms, regardless of the confirm-deletion setting, with the destructive alert (see Dialogs); Return never confirms a deletion.
- **Labels and touch:** Icon-only buttons keep a `title` or `aria-label`. On touch, press-and-hold shows that label as a tooltip without triggering the action, and fills use `:active` so they do not stick after a tap.
- **Reasoning:** The header is a libadwaita expander row: neutral raised fill, `10px` radius, no border, inset focus ring. The body keeps the upstream thin left rule in the reasoning ink colour.
- **Conversation layout:** A Fractal-style split view: an opaque pals sidebar (`220–280px`, `--sb-conv-sidebar-bg`: `#2e2e32` in Libadwaita dark, `#ebebed` in light) with its own header bar, and a content column of header bar, search bar, full-width timeline (`20px` gutters) on `--sb-layer-view`, and composer on `--sb-layer-bottombar`. Settings is a third split-view column on desktop and a pushed page on mobile. The pals list stays in recency order; selecting a thread does not move it.
- **Conversation messages:** Messages group on sender change, a 20-minute gap, or a day boundary; only the first of a group shows avatar, name, and locale time. Own bubbles are end-aligned with no avatar (`--sb-conv-bubble-own-bg`); others are start-aligned with a reserved `36px` avatar slot (`--sb-conv-bubble-other-bg`). Outer corners are `18px`, attached corners `6px`. Day dividers sit between calendar days, reactions are toggleable chips under the bubble, and receipts sit under the last own message of a group.
- **Conversation actions:** On desktop, an opaque pill toolbar appears on hover or `:focus-within`, overlapping the top-end corner of every bubble, own or not: flat `28px` quick reactions, a divider, Reply, Edit, Copy, and the menu button. Shift and Expand Message Actions expand it to every menu action. On mobile, a vertical-ellipsis trigger beside that corner (`44px` hit area, reporting `aria-expanded`) opens the menu as a bottom sheet. Compact mode drops the pill to `24px` and the mobile targets to `40px`. Menu sections: quick reactions; Reply, Edit, and Polish; Copy, Pin, and Branch; Speak and Regenerate; then Delete alone in Destructive Red, confirmed with the same alert.

## 9. Do's and Don'ts

### Do:
- **Do** keep main content uninterrupted and let configuration appear only after deliberate input.
- **Do** give every view at most one suggested or destructive button, then place powerful options behind learnable progressive disclosure.
- **Do** preserve SillyTavern-compatible settings, character data, chats, presets, extensions, and migration paths.
- **Do** use `SmartTheme*`, `sb-*`, `color-*`, spacing, and radius tokens so user themes continue to work.
- **Do** keep desktop and mobile gestures, ordering, labels, and action vocabulary consistent.
- **Do** provide visible focus, semantic labels, comfortable touch targets, resilient wrapping, and reduced-motion behavior.
- **Do** use tonal surfaces before shadows and verify text contrast before shipping.
- **Do** make every action possible with the keyboard as well as with a pointer or touch. Custom shortcuts use Ctrl with a letter, never Alt (reserved for access keys) or Super. Esc closes popovers, sheets, and dialogs (HIG Keyboard, Popovers, Windows).
- **Do** test every surface with a high-contrast or forced-colours mode, 200% text size, the keyboard alone, a screen reader, and an on-screen keyboard (HIG Accessibility). Every element has a short, descriptive accessible name.
- **Do** write UI text by the HIG Writing Style: short and neutral, familiar terms over system terms, "your" over "my" when ownership must be stated, no Latin abbreviations ("for example", not "e.g."), and no trailing period on labels, headings, or descriptions. An ellipsis (`…`, U+2026) ends a label only when more input or confirmation follows ("Delete…", not "Preferences…"). Never build one sentence from several strings or controls, so translations stay intact. Use typographic characters: “quotes”, ’ apostrophes, – ranges, × dimensions.
- **Do** translate each new counter or sentence as one string with placeholders, never joined fragments. Use `…`, never three periods, in new labels. Reuse existing upstream strings and keys verbatim, including trailing periods; the punctuation rule applies to new copy. Unsupplied descriptions, help, and dialog bodies use exactly `TODO(copy)`, marked with `data-sb-copy-placeholder="true"` and reported for maintainer replacement; do not draft project prose.

### Don't:
- **Don't** add configuration panels, extra toolbars, or utility panes to the chat viewport unless the user opens them. Navigation sidebars, split views, and utility panes follow the HIG (Navigation): each view keeps one clear subject, and panes collapse or overlay at narrow widths.
- **Don't** create a nested menu spiral: no nested submenus, and hierarchies generally one level deep below a view (HIG Menus, Navigation).
- **Don't** present configuration sprawl, bottom bar bloat, or a dense control wall by default.
- **Don't** interrupt active conversation with a modal for non-critical configuration; try inline or progressive alternatives first.
- **Don't** rely on mystery meat navigation, hover-only discovery, desktop-only assumptions, tiny touch targets, or fragile iOS WebKit behavior.
- **Don't** use generic SaaS polish, sterile upstream-clone blandness, or decorative motion without navigational purpose.
- **Don't** use gradient text, decorative glassmorphism, backdrop blur on shell layers, ambient accent glows, repeating stripe or grid backgrounds, identical repeated card grids, or sketchy illustrations.
- **Don't** use `border-left` or `border-right` greater than `1px` as a colored accent.
- **Don't** pair a `1px` border with a shadow of `16px` blur or more on a resting surface. Overlays may keep one border and one overlay shadow.
- **Don't** use uppercase tracked kickers for group or list headings, or hover lift on buttons.
- **Don't** rely on tooltips, hover, or colour alone to carry essential information.
- **Don't** use radii above `20px` for cards or sections, or let long labels and headings overflow narrow viewports.
- **Don't** introduce new pure black or pure white surfaces, or silently overwrite compatible user configuration.
